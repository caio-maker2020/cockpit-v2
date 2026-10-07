// Guard — worker dos lançamentos da Operação (ADR 0041 D7; INV-159, INV-183, INV-184, INV-186).
// O "mundo" em memória reproduz a semântica das RPCs da mig 430 (reserva com janela
// de 60 s e teto 3, quarentena, finalizar só `lancando`, expirar, confirmar só depois
// de 90 min). A mesma semântica é provada no SQL em supabase/tests/operacao/operacao-rpcs.test.sql.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-lancamentos-worker.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LancarSswPortalOperacaoResult } from "./lancar-ssw-portal-operacao.ts";
import {
  CONFIRMACAO_MAX_TENTATIVAS,
  CONFIRMACAO_TIMEOUT_MIN,
  LIMITE_SSW_POR_MINUTO,
  TETO_SSW_POR_MINUTO,
  vagasDeLancamentoOp,
} from "./operacao-comum.ts";
import {
  type CercaNaHora,
  decidirConfirmacao,
  type DepsWorkerOp,
  interpretarResultado,
  type LancamentoRow,
  type LeituraUltimaOc,
  recusaPelaCerca,
  type RepoLancamentosOp,
  rodarWorkerLancamentosOperacao,
} from "./operacao-lancamentos-worker.ts";

const T0 = Date.parse("2026-10-07T12:00:00Z");

type L = LancamentoRow & { reservado_em: number | null; finalizado_em: number | null; categoria_erro: string | null; solicitado_em: number; tentada_em: number | null };

class Mundo implements RepoLancamentosOp {
  agora = T0;
  flags: Record<string, boolean> = { operacao_lancar_ssw: true };
  /** Sobrepõe a leitura da flag de lançamento (n = nº da leitura, começa em 1). */
  flagPorLeitura: ((n: number) => boolean) | null = null;
  leituras = 0;
  lancs: L[] = [];
  cerca = new Map<string, Partial<CercaNaHora>>();
  log: string[] = [];
  add(id: string, o: Partial<L> = {}): void {
    this.lancs.push({
      id, op_item_id: `item-${id}`, ctrc: `C${id}-1`, nf: "1001", codigo_oc: 36, texto_operador: "chegou",
      texto_ssw: "chegou (Operação VGA por Joao)", solicitado_por: "m1", solicitado_por_nome: "Joao", status: "fila",
      lancado_em: null, confirmacao_tentativas: 0, reservado_em: null, finalizado_em: null, categoria_erro: null,
      solicitado_em: this.agora - 60_000, tentada_em: null, ...o,
    });
  }
  get(id: string) { return this.lancs.find((l) => l.id === id)!; }
  flagLigada(key: string) {
    if (key === "operacao_lancar_ssw") {
      this.leituras++;
      if (this.flagPorLeitura) return Promise.resolve(this.flagPorLeitura(this.leituras));
    }
    return Promise.resolve(this.flags[key] ?? false);
  }
  expirar(ttlHoras: number, travadoMin: number) {
    let n = 0;
    for (const l of this.lancs) {
      if (l.status === "lancando" && l.reservado_em! < this.agora - travadoMin * 60_000) { l.status = "erro"; l.categoria_erro = "lancamento_interrompido"; n++; }
      else if (l.status === "fila" && l.solicitado_em < this.agora - ttlHoras * 3600_000) { l.status = "erro"; l.categoria_erro = "expirado"; n++; }
    }
    return Promise.resolve(n);
  }
  reservar(limite: number, _ttl: number, quarentenaMin: number) {
    const quarentena = this.lancs.some((l) => l.categoria_erro === "sessao_invalida" && l.finalizado_em! > this.agora - quarentenaMin * 60_000);
    const naJanela = this.lancs.filter((l) => l.reservado_em !== null && l.reservado_em > this.agora - 60_000).length;
    const vagas = vagasDeLancamentoOp({ limitePorMinuto: limite, reservadosNaJanela: naJanela, emQuarentena: quarentena });
    const out = this.lancs.filter((l) => l.status === "fila").slice(0, vagas);
    for (const l of out) { l.status = "lancando"; l.reservado_em = this.agora; }
    return Promise.resolve(out.map((l) => ({ ...l })));
  }
  devolverParaFila(ids: string[]) {
    for (const id of ids) { const l = this.get(id); if (l.status === "lancando") { l.status = "fila"; l.reservado_em = null; } }
    this.log.push(`devolver:${ids.join(",")}`);
    return Promise.resolve();
  }
  cercaNaHora(l: LancamentoRow) {
    return Promise.resolve({ cardAtivo: false, codigoAtivo: true, itemAberto: true, nfItem: "1001", ...(this.cerca.get(l.id) ?? {}) });
  }
  finalizar(id: string, r: { status: "lancado" | "recusado" | "erro"; categoria: string | null }) {
    const l = this.get(id);
    if (l.status !== "lancando") return Promise.resolve(false);
    l.status = r.status;
    l.categoria_erro = r.categoria;
    if (r.status === "lancado") l.lancado_em = new Date(this.agora).toISOString();
    else l.finalizado_em = this.agora;
    this.log.push(`finalizar:${id}:${r.status}`);
    return Promise.resolve(true);
  }
  aConfirmar(timeoutMin: number, limite: number) {
    const t = Math.max(timeoutMin, 90);
    return Promise.resolve(this.lancs.filter((l) => l.status === "lancado" && Date.parse(l.lancado_em!) < this.agora - t * 60_000
      && (l.tentada_em === null || l.tentada_em < this.agora - 30 * 60_000)).slice(0, limite).map((l) => ({ ...l })));
  }
  registrarConfirmacao(id: string, r: { resultado: "confirmado" | "nao_confirmado" | "tentar_de_novo" }) {
    const l = this.get(id);
    this.log.push(`confirmacao:${id}:${r.resultado}`);
    if (r.resultado === "tentar_de_novo") { l.confirmacao_tentativas++; l.tentada_em = this.agora; }
    else l.status = r.resultado;
    return Promise.resolve();
  }
}

function deps(m: Mundo, over: Partial<DepsWorkerOp> & { resultado?: (l: string) => LancarSswPortalOperacaoResult; leitura?: LeituraUltimaOc } = {}) {
  const ssw: Array<{ em: number; ctrc: string; nf: string; codigo: number; texto: string }> = [];
  const leituras: string[] = [];
  const d: DepsWorkerOp = {
    repo: m,
    lancar: (a) => {
      ssw.push({ em: m.agora, ctrc: a.item.ctrc, nf: a.item.nf, codigo: a.codigoSsw, texto: a.textoSsw });
      return Promise.resolve(over.resultado?.(a.lancamentoId) ?? { ok: true, protocolo: "SEQ", idempotent_skip: false, acao_id: `a-${a.lancamentoId}` });
    },
    lerUltimaOc: (nf, ctrc) => { leituras.push(`${nf}/${ctrc}`); return Promise.resolve(over.leitura ?? { sucesso: true, oc: 36 }); },
    usuarioServico: "ai.salex",
    ...over,
  };
  return { d, ssw, leituras };
}

Deno.test("FLAG OFF: nada roda — nem prazos, nem reserva, nem leitura do SSW", async () => {
  const m = new Mundo();
  m.flags.operacao_lancar_ssw = false;
  m.add("1");
  const { d, ssw, leituras } = deps(m);
  const r = await rodarWorkerLancamentosOperacao(d);
  assertEquals(r.skipped, "flag_off");
  assertEquals([ssw.length, leituras.length, m.get("1").status], [0, 0, "fila"]);
});

Deno.test("VAZÃO: no máximo LIMITE por janela de 60 s, um por vez, mesmo chamando o worker várias vezes", async () => {
  const m = new Mundo();
  for (let i = 1; i <= 7; i++) m.add(String(i));
  const { d, ssw } = deps(m);
  await rodarWorkerLancamentosOperacao(d);
  await rodarWorkerLancamentosOperacao(d);
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(ssw.length, LIMITE_SSW_POR_MINUTO);
  m.agora += 61_000;
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(ssw.length, 2 * LIMITE_SSW_POR_MINUTO);
  // limite errado não passa do teto
  m.agora += 61_000;
  const { d: d2, ssw: ssw2 } = deps(m, { limitePorMinuto: 50 });
  await rodarWorkerLancamentosOperacao(d2);
  assertEquals(ssw2.length, TETO_SSW_POR_MINUTO);
});

Deno.test("CTRC, NF e texto vão do PEDIDO confirmado (sem o worker inventar nada)", async () => {
  const m = new Mundo();
  m.add("1", { ctrc: "VGA9-9", nf: null, texto_ssw: "texto confirmado na prévia" });
  m.cerca.set("1", { nfItem: "777" });
  const { d, ssw } = deps(m);
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(ssw, [{ em: T0, ctrc: "VGA9-9", nf: "777", codigo: 36, texto: "texto confirmado na prévia" }]);
});

Deno.test("cerca relida na hora: card ativo, código fora da lista, item fechado ou sem NF → recusado sem SSW", async () => {
  const m = new Mundo();
  m.add("1"); m.add("2");
  m.cerca.set("1", { cardAtivo: true });
  m.cerca.set("2", { codigoAtivo: false });
  const { d, ssw } = deps(m);
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(ssw.length, 0);
  assertEquals([m.get("1").status, m.get("1").categoria_erro], ["recusado", "card_relacionamento_ativo"]);
  assertEquals([m.get("2").status, m.get("2").categoria_erro], ["recusado", "codigo_saiu_da_lista"]);
  assertEquals(recusaPelaCerca({ cardAtivo: false, codigoAtivo: true, itemAberto: false, nfItem: "1" }, { codigo_oc: 36, nf: "1" })?.categoria, "item_encerrado");
  assertEquals(recusaPelaCerca({ cardAtivo: false, codigoAtivo: true, itemAberto: true, nfItem: null }, { codigo_oc: 36, nf: null })?.categoria, "sem_nf_para_tripe");
});

Deno.test("FREIO: flag desligada no meio da rodada → próximo não sai, reservados voltam para a fila", async () => {
  const m = new Mundo();
  m.add("1"); m.add("2");
  // leitura 1 = início da rodada; 2 = antes do 1º lançamento; 3 = antes do 2º (desligada)
  m.flagPorLeitura = (n) => n < 3;
  const { d, ssw } = deps(m);
  const r = await rodarWorkerLancamentosOperacao(d);
  assertEquals(ssw.length, 1);
  assertEquals(m.get("2").status, "fila");
  assert(r.falhas.some((f) => f.includes("desligada no meio")));
});

Deno.test("login recusado → quarentena: o resto volta para a fila e nada sai por 30 min", async () => {
  const m = new Mundo();
  m.add("1"); m.add("2"); m.add("3");
  const sessao: LancarSswPortalOperacaoResult = { ok: false, error: "login", categoria: "sessao_invalida", acao_id: "x" };
  const { d, ssw } = deps(m, { resultado: () => sessao });
  const r = await rodarWorkerLancamentosOperacao(d);
  assert(r.quarentena);
  assertEquals(ssw.length, 1);
  assertEquals(m.get("2").status, "fila");
  m.agora += 10 * 60_000;
  const ok = deps(m);
  await rodarWorkerLancamentosOperacao(ok.d);
  assertEquals(ok.ssw.length, 0, "dentro da quarentena nada sai");
  m.agora += 25 * 60_000;
  await rodarWorkerLancamentosOperacao(ok.d);
  assert(ok.ssw.length > 0, "depois da quarentena volta a sair");
});

Deno.test("NUNCA relança às cegas: interrompido vira erro e não volta à fila; erro e recusa não são refeitos", async () => {
  const m = new Mundo();
  m.add("1");
  const { d, ssw } = deps(m, { lancar: () => Promise.reject(new Error("isolate morreu")) });
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(m.get("1").status, "lancando");
  m.agora += 16 * 60_000;
  const de = deps(m);
  await rodarWorkerLancamentosOperacao(de.d);
  assertEquals([m.get("1").status, m.get("1").categoria_erro], ["erro", "lancamento_interrompido"]);
  m.agora += 120 * 60_000;
  await rodarWorkerLancamentosOperacao(de.d);
  assertEquals(de.ssw.length + ssw.length, 0, "o interrompido nunca voltou ao SSW");
});

Deno.test("resultado do envelope → status (tripé/código/texto = recusa; resto = erro; ok = lançado aguardando confirmação)", () => {
  assertEquals(interpretarResultado(36, { ok: true, protocolo: "S", idempotent_skip: false, acao_id: "a" }).status, "lancado");
  assertEquals(interpretarResultado(36, { ok: true, protocolo: "S", idempotent_skip: true, acao_id: "a" }).status, "lancado");
  for (const c of ["guard_tripe", "guard_codigo", "texto_obrigatorio"] as const) {
    assertEquals(interpretarResultado(36, { ok: false, error: "x", categoria: c }).status, "recusado");
  }
  for (const c of ["ssw_erro", "db_erro", "outro"] as const) assertEquals(interpretarResultado(36, { ok: false, error: "x", categoria: c }).status, "erro");
  assert(interpretarResultado(36, { ok: false, error: "x", categoria: "sessao_invalida" }).quarentena);
});

Deno.test("CONFIRMAÇÃO: só depois de 90 min, no máximo 1 leitura por rodada, e nunca relança", async () => {
  const m = new Mundo();
  m.add("1", { status: "lancado", lancado_em: new Date(T0 - 30 * 60_000).toISOString() });
  m.add("2", { status: "lancado", lancado_em: new Date(T0 - 100 * 60_000).toISOString() });
  m.add("3", { status: "lancado", lancado_em: new Date(T0 - 200 * 60_000).toISOString() });
  const { d, leituras, ssw } = deps(m, { leitura: { sucesso: true, oc: 21 } });
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(leituras.length, 1, "uma leitura do SSW por rodada");
  assertEquals(ssw.length, 0, "confirmação nunca lança");
  assertEquals(m.get("1").status, "lancado", "antes de 90 min não pergunta ao SSW");
  assertEquals(CONFIRMACAO_TIMEOUT_MIN, 90);
});

Deno.test("decidirConfirmacao: última oc = lançada → confirmado; histórico recente pela conta de serviço → confirmado; outra → nao_confirmado; falha → tenta de novo até o limite", () => {
  assertEquals(decidirConfirmacao({ codigo: 36, leitura: { sucesso: true, oc: 36 }, tentativasAntes: 0 }).resultado, "confirmado");
  assertEquals(decidirConfirmacao({
    codigo: 36, tentativasAntes: 0, usuarioServico: "ai.salex",
    leitura: { sucesso: true, oc: 14, ocorrencias: [{ codigo: 14, usuario: "joao", data: null }, { codigo: 36, usuario: "AI.SALEX", data: null }] },
  }).resultado, "confirmado");
  assertEquals(decidirConfirmacao({
    codigo: 36, tentativasAntes: 0, usuarioServico: "ai.salex",
    leitura: { sucesso: true, oc: 14, ocorrencias: [{ codigo: 14, usuario: "x", data: null }, { codigo: 36, usuario: "outra.pessoa", data: null }] },
  }).resultado, "nao_confirmado");
  assertEquals(decidirConfirmacao({ codigo: 36, leitura: { sucesso: false, motivo: "ssw_erro" }, tentativasAntes: 0 }).resultado, "tentar_de_novo");
  assertEquals(decidirConfirmacao({ codigo: 36, leitura: { sucesso: false, motivo: "ssw_erro" }, tentativasAntes: CONFIRMACAO_MAX_TENTATIVAS - 1 }).resultado, "nao_confirmado");
  for (const r of [decidirConfirmacao({ codigo: 36, leitura: { sucesso: true, oc: 1 }, tentativasAntes: 0 })]) {
    assert(!/relan[cç]ad[oa] agora/i.test(r.detalhe));
  }
});

Deno.test("leitura falhou: espaça 30 min entre tentativas", async () => {
  const m = new Mundo();
  m.add("1", { status: "lancado", lancado_em: new Date(T0 - 100 * 60_000).toISOString() });
  const { d, leituras } = deps(m, { leitura: { sucesso: false, motivo: "ssw_erro" } });
  await rodarWorkerLancamentosOperacao(d);
  m.agora += 60_000;
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(leituras.length, 1);
  m.agora += 30 * 60_000;
  await rodarWorkerLancamentosOperacao(d);
  assertEquals(leituras.length, 2);
});

Deno.test("estático: o worker e a edge só chegam ao SSW pelo envelope da Operação; freio dentro do laço", async () => {
  const w = await Deno.readTextFile(new URL("./operacao-lancamentos-worker.ts", import.meta.url));
  const e = await Deno.readTextFile(new URL("../processar-lancamentos-operacao/index.ts", import.meta.url));
  for (const src of [w, e]) {
    assert(!/from\s+["'][^"']*ssw-internal-client/.test(src), "importa o cliente SSW direto");
    assert(!/from\s+["'][^"']*\/lancar-ssw-portal\.ts["']/.test(src), "usa o envelope do Relacionamento");
  }
  assert(e.includes('import { criarRepoAcoesOperacao, lancarSswPortalOperacao, lerUltimaOcOperacao } from "../_shared/lancar-ssw-portal-operacao.ts"'));
  assert(w.includes("if (!(await freioLiberadoOp(repo))) {"));
});
