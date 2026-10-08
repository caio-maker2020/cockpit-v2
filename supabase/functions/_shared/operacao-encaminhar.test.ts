// Guard — encaminhar a nota da Operação ao Relacionamento (ADR 0041 D11; INV-189).
// Trava POR QUE o caminho é "card primeiro (pedido devolver da ponte), 49 depois" e
// não "lançar a 49 e deixar o sync-bastao criar o card". Rodar:
//   deno test --no-check --allow-read supabase/functions/_shared/operacao-encaminhar.test.ts
// (as RPCs estão em supabase/tests/operacao/operacao-sugestao-encaminhar.test.sql)

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirVisibilidadePorSsw } from "./decidir-visibilidade-ssw.ts";
import { type ItemAberto, type PendenciaOperacao, planejarMaterializacao, preservarSugestaoDoAgente } from "./operacao-materializar.ts";
import type { SugestaoOperacao } from "./operacao-sugestao.ts";
import { decidirNascimentoCard, type PendenciaBastaoMin } from "./ponte-operacao-worker.ts";

const CONTA = "ai.salex";
const RELAC = (oc: number) => [11, 21, 49].includes(oc);

Deno.test("RISCO do caminho (a): 49 lançada pela ai.salex é lida como ação do PRÓPRIO Cockpit → a tratativa não reabre", () => {
  // Card do CTRC encerrado (ex.: TRANSFERIDO para a Operação) + 49 nossa no topo do SSW.
  const dv = decidirVisibilidadePorSsw({
    ocorrenciasSsw: [{ codigo: 49, usuario: "AI.SALEX" }, { codigo: 15, usuario: "joao.vga" }],
    ehRelac: RELAC, contaLancamentoCockpit: CONTA, codigoUltimoLancamentoCockpit: 49, sswFresco: true,
  });
  assertEquals([dv.decisao, dv.fonte], ["MANTER_FORA_RELACIONAMENTO", "identidade"]);
});

Deno.test("caminho escolhido (b): o card NASCE antes da 49, ativo e com lock (AVH) — não depende da reabertura", () => {
  const p: PendenciaBastaoMin = {
    id: "b1", ctrc: "VGA123-4", nf: "000555", cod_ultima_ocorrencia: 15, instrucao_ultima_ocorrencia: "cliente ausente",
    data_ultima_ocorrencia: "2026-10-06", pagador: "ACME", cnpj_pagador: "1", cnpj_remetente: "1", base_destino: "VGA",
    responsavel_relacionamento: null, segmento_cliente: null, tipo_documento: "NORMAL", qtd_volumes: 1, atraso_original: 1,
  };
  const d = decidirNascimentoCard({ pendencia: p, ctrcPedido: "VGA123-4", ocsCliente: new Set([54, 59]) });
  assertEquals(d, { cria: true, state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true });
  // extravio e nota entregue não viram card por encaminhamento (a cerca do SQL repete isto)
  assertEquals(decidirNascimentoCard({ pendencia: { ...p, cod_ultima_ocorrencia: 6 }, ctrcPedido: "VGA123-4", ocsCliente: new Set() }).cria, false);
  assertEquals(decidirNascimentoCard({ pendencia: { ...p, cod_ultima_ocorrencia: 1 }, ctrcPedido: "VGA123-4", ocsCliente: new Set() }).cria, false);
});

Deno.test("a mig 436 grava o pedido devolver da ponte com origem cockpit_operacao e NUNCA devolve card_id à Operação", async () => {
  const sql = await Deno.readTextFile(new URL("../../../migration/2026-10-07_436_operacao_encaminhar_relacionamento.sql", import.meta.url));
  assert(/INSERT INTO public\.ponte_operacao_pedidos[\s\S]*'devolver_ao_relacionamento', v_e\.ctrc, 49/.test(sql), "o encaminhamento não é o pedido devolver (49)");
  assert(/'cockpit_operacao', v_e\.id\)/.test(sql), "origem cockpit_operacao ausente");
  assert(!/INSERT INTO public\.cards/i.test(sql), "a 436 não pode criar card direto: o card nasce pelo worker da ponte");
  const doItem = sql.slice(sql.indexOf("FUNCTION public.op_encaminhamentos_do_item"), sql.indexOf("FUNCTION public.op_aceitar_sugestao"));
  assert(!/card_id|card_event_id/.test(doItem), "op_encaminhamentos_do_item expõe o card à Operação");
  const evento = sql.slice(sql.indexOf("PERFORM public.op__evento(v_i.id, 'EncaminhadoAoRelacionamento'"), sql.indexOf("RETURN 'enviado'"));
  assert(evento.length > 50 && !/card/.test(evento), "o evento do item fala do card");
});

// ── materializador: o encaminhado não volta; a sugestão do agente sobrevive na mesma oc ──
const AGORA = Date.parse("2026-10-07T12:00:00Z");
const pend = (ctrc: string, oc = 15): PendenciaOperacao => ({
  id: `b-${ctrc}`, ctrc, nf: "1", filial: "VGA", cod_ultima_ocorrencia: oc, instrucao_ultima_ocorrencia: null,
  data_ultima_ocorrencia: "2026-10-06T10:00:00Z", responsavel_atual: "operacao", pagador: "P", cnpj_pagador: "1", destinatario: "D",
  cidade_destino: "Varginha", uf_destino: "MG", base_destino: "VGA", unidade_origem: null, unidade_destino: "VGA", unidade_atual: "VGA",
  previsao_entrega: null, atraso_original: 1, qtd_volumes: 1,
});
const sugIa = (oc: number, o: Partial<SugestaoOperacao> = {}): SugestaoOperacao => ({
  versao_contrato: 2, acao: "encaminhar_relacionamento", fonte: "agente_ia", base_regra: "agente_ia", regra_id: "agente_ia",
  codigo: null, texto: "cliente ausente", motivo: "m", lancavel: false, confianca: 0.9, casos: null, oc_base: oc,
  versao_regras: "agente:1.0.0", modelo: "claude-haiku-5-5", versao_prompt: "1.1.0", justificativa: "j", ...o,
});
const base = {
  codigosOperacao: new Set([13, 14, 15, 36]), ctrcsComCardAtivo: new Set<string>(), encerradosPorCtrc24h: new Map<string, number>(),
  regrasUnidade: [], codigosLancaveisAtivos: new Set<number>(), agoraMs: AGORA,
};

Deno.test("CTRC com encaminhamento pendente não renasce na fila e o item aberto encerra como encaminhado", () => {
  const p = planejarMaterializacao({
    ...base, pendencias: [pend("ENC-1"), pend("OUTRO-1")], itensAbertos: [], ctrcsEncaminhamentoPendente: new Set(["ENC-1"]),
  });
  assertEquals(p.upserts.map((u) => u.ctrc), ["OUTRO-1"]);
  assertEquals(p.ignorados.encaminhado_relacionamento, 1);
});

Deno.test("sugestão do agente: sobrevive à reescrita do item na MESMA oc, some quando a oc muda; regra vence", () => {
  const aberto: ItemAberto = { id: "i1", ctrc: "A-1", snapshot_hash: "velho", lancamento_ativo: null, cod_ultima_ocorrencia: 15, sugestao: sugIa(15) };
  const mesma = planejarMaterializacao({ ...base, pendencias: [pend("A-1", 15)], itensAbertos: [aberto] });
  assertEquals(mesma.upserts[0]!.sugestao?.fonte, "agente_ia");
  const mudou = planejarMaterializacao({ ...base, pendencias: [pend("A-1", 36)], itensAbertos: [aberto] });
  assertEquals(mudou.upserts[0]!.sugestao, null);
  const comRegra = planejarMaterializacao({
    ...base, pendencias: [pend("A-1", 15)], itensAbertos: [aberto],
    regrasSugestao: [{ id: "r", descricao: "d", quando: { ocs: [15] }, sugerir: { codigo: 36, texto: "chegou na base" } }],
  });
  assertEquals(comRegra.upserts[0]!.sugestao?.fonte, "regra_fixa");
  // o hash ignora a sugestão do agente: gravá-la não faz o materializador reescrever o item
  const h1 = planejarMaterializacao({ ...base, pendencias: [pend("B-1")], itensAbertos: [] }).upserts[0]!.snapshot_hash;
  const semMudanca = planejarMaterializacao({
    ...base, pendencias: [pend("B-1")],
    itensAbertos: [{ id: "i2", ctrc: "B-1", snapshot_hash: h1, lancamento_ativo: null, cod_ultima_ocorrencia: 15, sugestao: sugIa(15) }],
  });
  assertEquals([semMudanca.upserts.length, semMudanca.ignorados.sem_mudanca], [0, 1]);
  // lancavel é recalculado pela lista atual
  assertEquals(preservarSugestaoDoAgente(sugIa(15, { acao: "lancar_ocorrencia", codigo: 36, lancavel: false }), 15, new Set([36]))?.lancavel, true);
  assertEquals(preservarSugestaoDoAgente(sugIa(15, { fonte: "regra_fixa" }), 15, new Set()), null);
});

// ── MODO ESPELHO (ADR 0041 D12): é impossível chegar à ponte ou a cards ─────────────
import { criarRepoMaterializacao, criarRepoSugestaoIa } from "./operacao-repo.ts";
import { rodarMaterializacao } from "./operacao-materializar.ts";
import { rodarSugestaoIa } from "./operacao-sugerir-ia.ts";

/** supabase falso: registra tudo; escrita em ponte_operacao_pedidos/cards/card_events/todos FALHA o teste. */
function supabaseFalso(flagsLigadas: string[]) {
  const escritas: string[] = [];
  const lidas: string[] = [];
  const rpcs: string[] = [];
  const PROIBIDAS = ["ponte_operacao_pedidos", "cards", "card_events", "todos"];
  function construtor(tabela: string, dados: unknown): unknown {
    const resp = { data: dados, error: null };
    const alvo: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resp).then(ok, ko),
      maybeSingle: () => Promise.resolve({ data: Array.isArray(dados) ? (dados[0] ?? null) : dados, error: null }),
    };
    return new Proxy(alvo, {
      get(t, prop: string) {
        if (prop in t) return t[prop];
        if (["insert", "update", "upsert", "delete"].includes(prop)) {
          return () => {
            escritas.push(`${prop}:${tabela}`);
            if (PROIBIDAS.includes(tabela)) throw new Error(`ESCRITA PROIBIDA em ${tabela}`);
            return construtor(tabela, null);
          };
        }
        return () => construtor(tabela, dados);
      },
    });
  }
  const cliente = {
    from(tabela: string) {
      lidas.push(tabela);
      if (tabela === "feature_flags") {
        return {
          select: () => ({ eq: (_c: string, k: string) => ({ maybeSingle: () => Promise.resolve({ data: { enabled: flagsLigadas.includes(k) }, error: null }) }) }),
        };
      }
      if (tabela === "ocorrencias_dicionario") return construtor(tabela, [{ codigo: 15, descricao: "x" }]);
      return construtor(tabela, []);
    },
    rpc(nome: string) {
      rpcs.push(nome);
      const dados: Record<string, unknown> = {
        op_sugestao_ia_candidatos: [], op_encaminhar_auto: 1, op_encaminhamentos_promover: { espelhado: 1 },
        op_ctrcs_encaminhamento_pendente: [], op_ctrcs_no_espelho: [], op_materializar_aplicar: {},
      };
      return Promise.resolve({ data: dados[nome] ?? null, error: null });
    },
  };
  return { cliente, escritas, lidas, rpcs };
}

Deno.test("ESPELHO: a rodada de sugestão/encaminhamento (flags e ponte ligadas) nunca escreve na ponte nem em cards", async () => {
  const sb = supabaseFalso(["operacao_sugestao_ia", "operacao_encaminhar_auto", "ponte_operacao_pedidos", "ponte_operacao_lancar_ssw"]);
  let fetchChamado = 0;
  const r = await rodarSugestaoIa({
    repo: criarRepoSugestaoIa(sb.cliente as never),
    agente: () => {
      fetchChamado++;
      return Promise.reject(new Error("sem candidatos, o agente não roda"));
    },
  });
  assertEquals(r.erros, []);
  assertEquals(fetchChamado, 0);
  assertEquals(sb.escritas, []);
  assert(!sb.lidas.some((t) => ["ponte_operacao_pedidos", "cards", "card_events", "todos"].includes(t)), `tocou ${sb.lidas.join(",")}`);
  // todo efeito passa por RPC da Operação (op_*), que no banco decide espelho × real
  assert(sb.rpcs.length > 0 && sb.rpcs.every((n) => n.startsWith("op_")), sb.rpcs.join(","));
});

Deno.test("ESPELHO: o materializador lê o espelho e não traz de volta, na mesma oc, a nota que foi para ele", async () => {
  const p = planejarMaterializacao({
    ...base, pendencias: [pend("ESP-1", 15), pend("ESP-2", 36)], itensAbertos: [],
    espelhoOcPorCtrc: new Map([["ESP-1", 15], ["ESP-2", 15]]),
  });
  assertEquals(p.upserts.map((u) => u.ctrc), ["ESP-2"]); // ESP-2 mudou de oc: situação nova, volta
  assertEquals(p.ignorados.encaminhado_espelho, 1);
  const sb = supabaseFalso(["operacao_fila"]);
  const r = await rodarMaterializacao({
    repo: criarRepoMaterializacao(sb.cliente as never),
    bastao: { fetchPendenciasDaOperacao: () => Promise.resolve({ pendencias: [], completo: true, erro: null }) },
  });
  assert(sb.rpcs.includes("op_ctrcs_no_espelho"), "materializador não consultou o espelho");
  assertEquals(sb.escritas.filter((e) => /ponte|cards|card_events|todos/.test(e)), []);
  assert(r.erros.every((e) => !/ESCRITA PROIBIDA/.test(e)));
});

Deno.test("ESPELHO: nenhum módulo de produção da Operação cita a ponte ou escreve em cards; a 438 decide pelo modo antes da ponte", async () => {
  const dir = new URL("./", import.meta.url);
  const alvos = ["operacao-agente-sugestao.ts", "operacao-sugerir-ia.ts", "operacao-sugestao.ts", "operacao-materializar.ts", "operacao-repo.ts", "../sugerir-operacao/index.ts"];
  for (const a of alvos) {
    const src = (await Deno.readTextFile(new URL(a, dir))).replace(/\/\/.*$/gm, "");
    assert(!/ponte_operacao_pedidos/.test(src), `${a} cita a ponte`);
    assert(!/from\(\s*["'](cards|card_events|todos)["']\s*\)\s*\.\s*(insert|update|upsert|delete)/.test(src), `${a} escreve no Relacionamento`);
  }
  const sql = await Deno.readTextFile(new URL("../../../migration/2026-10-07_438_operacao_espelho_relacionamento.sql", import.meta.url));
  const prom = sql.slice(sql.indexOf("FUNCTION public.op__promover_encaminhamento"), sql.indexOf("REVOKE ALL ON FUNCTION public.op__checar_encaminhamento"));
  const iEspelho = prom.indexOf("IF v_modo <> 'real' THEN");
  const iPonte = prom.indexOf("INSERT INTO public.ponte_operacao_pedidos");
  assert(iEspelho > 0 && iPonte > iEspelho, "o desvio do espelho tem de vir ANTES de qualquer insert na ponte");
  assert(prom.slice(iEspelho, iPonte).includes("RETURN 'espelhado';"), "o ramo espelho tem de sair sem cair na ponte");
  assert(/CASE WHEN \(SELECT c\.valor FROM public\.op_config c WHERE c\.chave = 'operacao_encaminhar_modo'\) = 'real'\s+THEN 'real' ELSE 'espelho' END/.test(sql),
    "modo ausente/inválido tem de ser espelho (fail-safe)");
  assert(/INSERT INTO public\.op_config \(chave, valor\) VALUES \('operacao_encaminhar_modo', 'espelho'\)/.test(sql), "o modo não nasce espelho");
});
