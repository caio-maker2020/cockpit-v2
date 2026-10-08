// Guard — camada 2 da sugestão da Operação: o agente de IA (ADR 0041 D10; INV-188).
// Sem rede: todo fetch é FALSO. Rodar:
//   deno test --no-check --allow-read supabase/functions/_shared/operacao-agente-sugestao.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chamarAgenteOperacao,
  codigosPermitidosAgente,
  type EntradaAgenteOperacao,
  montarEntradaAgente,
  resolverModeloAgente,
  validarRespostaAgente,
} from "./operacao-agente-sugestao.ts";
import { AGENTE_OPERACAO_MODEL, AGENTE_OPERACAO_SYSTEM_PROMPT, AGENTE_OPERACAO_VERSION } from "./prompts/agente-operacao.ts";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const DICIO = new Map<number, string>([
  [13, "Chegada na unidade"], [14, "Entrega iniciada"], [15, "Entrega impossib: limit. base"], [21, "Reentrega"],
  [36, "Chegada na base para entrega"], [37, "Problema no veículo"], [41, "Informação complementar"], [56, "Falta info operacional"],
  [1, "Mercadoria entregue"],
]);

function entrada(o: Partial<EntradaAgenteOperacao> = {}): EntradaAgenteOperacao {
  return {
    ...montarEntradaAgente({
      item: {
        op_item_id: "i1", cod_ultima_ocorrencia: 13, data_ultima_ocorrencia: "2026-10-04T10:00:00Z",
        instrucao_ultima_ocorrencia: "aguardando descarga", unidade: "vga", cidade_destino: "Varginha", uf_destino: "MG", pagador: "ACME",
      },
      codigosOperacao: DICIO,
      historico: [],
      agoraMs: AGORA,
    }),
    ...o,
  };
}

/** fetch falso: devolve o texto dado como resposta da Messages API e conta as chamadas. */
function fetchFalso(texto: string, opts: { stop?: string; status?: number } = {}) {
  const chamadas: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f: typeof fetch = (input, init) => {
    chamadas.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const body = opts.status && opts.status >= 400 ? "erro" : JSON.stringify({
      content: [{ type: "text", text: texto }], model: "claude-haiku-5-5", stop_reason: opts.stop ?? "end_turn",
      usage: { input_tokens: 900, output_tokens: 60 },
    });
    return Promise.resolve(new Response(body, { status: opts.status ?? 200 }));
  };
  return { f, chamadas };
}

const ok = (o: Record<string, unknown>) => JSON.stringify({ acao: "lancar_ocorrencia", codigo: 36, texto: "chegou na base de entrega", confianca: 0.72, justificativa: "parada há 3 dias na unidade", ...o });

Deno.test("prompt versionado: o espelho .ts é idêntico ao corpo de prompts/agente-operacao.md (e o modelo bate com o frontmatter)", async () => {
  const md = await Deno.readTextFile(new URL("../../../prompts/agente-operacao.md", import.meta.url));
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert(m, "frontmatter ausente");
  assertEquals(md.slice(m[0].length).replace(/^\n+/, ""), AGENTE_OPERACAO_SYSTEM_PROMPT);
  assert(m[1]!.includes(`model: ${AGENTE_OPERACAO_MODEL}`), "modelo do frontmatter diverge do espelho");
  assert(m[1]!.includes(`version: ${AGENTE_OPERACAO_VERSION}`), "versão do frontmatter diverge do espelho");
});

Deno.test("entrada: só códigos da Operação sem proibidos, sem 41/56 e sem 01; sem CTRC/NF/CNPJ; dias parado", () => {
  const e = entrada();
  assertEquals(e.codigos_operacao.map((c) => c.codigo), [13, 14, 15, 21, 36, 37]);
  assertEquals([e.oc_atual, e.descricao_oc_atual, e.dias_parado, e.unidade], [13, "Chegada na unidade", 3, "VGA"]);
  const s = JSON.stringify(e);
  assert(!/ctrc|"nf"|cnpj/i.test(s), "entrada vazou identificador");
  assertEquals([...codigosPermitidosAgente([49, 54, 59, 33, 44, 6, 9, 16, 41, 56, 36])], [36]);
});

Deno.test("modelo: padrão Haiku 5.5 (decisão do dono 07/10); configurável só dentro da lista fechada", () => {
  assertEquals(AGENTE_OPERACAO_MODEL, "claude-haiku-5-5");
  assertEquals(resolverModeloAgente(undefined), "claude-haiku-5-5");
  assertEquals(resolverModeloAgente(""), "claude-haiku-5-5");
  for (const m of ["claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]) assertEquals(resolverModeloAgente(m), m);
  assertEquals(resolverModeloAgente("claude-opus-5-5"), "claude-haiku-5-5"); // fora da lista (ADR 0041: não bateu o histórico)
  assertEquals(resolverModeloAgente("gpt-qualquer"), "claude-haiku-5-5");
});

Deno.test("sem regra → chama: resposta válida vira sugestão do contrato v2 (base_regra agente_ia, modelo, versao_prompt)", async () => {
  const { f, chamadas } = fetchFalso(ok({}));
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set([36]), fetch: f });
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0]!.body.model, AGENTE_OPERACAO_MODEL);
  assertEquals(chamadas[0]!.body.temperature, 0);
  assertEquals(r.status, "ok");
  const s = r.sugestao!;
  assertEquals([s.acao, s.fonte, s.base_regra, s.codigo, s.lancavel, s.confianca, s.oc_base, s.versao_prompt, s.versao_contrato],
    ["lancar_ocorrencia", "agente_ia", "agente_ia", 36, true, 0.72, 13, AGENTE_OPERACAO_VERSION, 2]);
  assertEquals([r.tokens_entrada, r.tokens_saida], [900, 60]);
});

Deno.test("encaminhar ao Relacionamento: sem código, nunca lançável", async () => {
  const { f } = fetchFalso(JSON.stringify({ acao: "encaminhar_relacionamento", codigo: null, texto: "cliente ausente: combinar reentrega", confianca: 0.9, justificativa: "x" }));
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set([36]), fetch: f });
  assertEquals([r.status, r.sugestao?.acao, r.sugestao?.codigo, r.sugestao?.lancavel], ["ok", "encaminhar_relacionamento", null, false]);
});

Deno.test("código proibido, 41/56, fora da Operação ou a própria oc → DESCARTADO (sem sugestão)", async () => {
  const casos: Array<[Record<string, unknown>, string]> = [
    [{ codigo: 49 }, "codigo_proibido:49"], [{ codigo: 54 }, "codigo_proibido:54"], [{ codigo: 33 }, "codigo_proibido:33"],
    [{ codigo: 6 }, "codigo_proibido:6"], [{ codigo: 41 }, "codigo_texto_da_pessoa:41"], [{ codigo: 11 }, "codigo_fora_da_operacao:11"],
    [{ codigo: 13 }, "repete_oc_atual"], [{ acao: "encaminhar_relacionamento", codigo: 49 }, "encaminhar_com_codigo"],
    [{ codigo: 1 }, "codigo_entrega_e_do_motorista:1"],
    [{ acao: "aguardar", codigo: null, reavaliar_em_horas: 0 }, "reavaliar_invalido"],
    [{ acao: "aguardar", codigo: null }, "reavaliar_invalido"], [{ acao: "aguardar", codigo: 36, reavaliar_em_horas: 4 }, "aguardar_com_codigo"],
    [{ texto: "x".repeat(71) }, "texto_longo"], [{ texto: "" }, "texto_vazio"], [{ confianca: 1.5 }, "confianca_invalida"],
    [{ confianca: "alta" }, "confianca_invalida"], [{ acao: "lancar" }, "acao_desconhecida"],
  ];
  for (const [o, motivo] of casos) {
    const { f } = fetchFalso(ok(o));
    const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set([36]), fetch: f });
    assertEquals([r.status, r.sugestao, r.motivo], ["descartada", null, motivo], JSON.stringify(o));
  }
});

Deno.test("JSON inválido → sem sugestão, com UMA chamada só (sem retry, sem reparo de JSON cortado)", async () => {
  for (const texto of ["não sei", '{"acao": "lancar_ocorrencia", "codigo": 36, "texto": "chegou', "[1,2]", ""]) {
    const { f, chamadas } = fetchFalso(texto);
    const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set(), fetch: f });
    assertEquals(r.status, "descartada", texto);
    assertEquals(r.sugestao, null);
    assertEquals(chamadas.length, 1, "repetiu a chamada");
  }
  // cortado por max_tokens → falha, mesmo que o pedaço parseie
  const { f } = fetchFalso(ok({}), { stop: "max_tokens" });
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set(), fetch: f });
  assertEquals([r.status, r.motivo], ["falha", "resposta_cortada"]);
});

Deno.test("cerca ```json``` é aceita; sem_sugestao é respeitado", () => {
  const ctx = { permitidos: new Set([36]), ocAtual: 13, codigosLancaveisAtivos: new Set<number>(), modelo: "m", versaoPrompt: "v" };
  assertEquals(validarRespostaAgente("```json\n" + ok({}) + "\n```", ctx).status, "ok");
  assertEquals(validarRespostaAgente(JSON.stringify({ acao: "sem_sugestao" }), ctx).status, "sem_sugestao");
});

Deno.test("timeout → falha (sem sugestão), sem esperar a API e sem lançar exceção", async () => {
  let chamadas = 0;
  const lento: typeof fetch = (_i, init) => {
    chamadas++;
    return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  };
  const t0 = Date.now();
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set(), fetch: lento, timeoutMs: 30 });
  assertEquals([r.status, r.motivo, r.sugestao, chamadas], ["falha", "timeout", null, 1]);
  assert(Date.now() - t0 < 2000);
});

Deno.test("erro HTTP / rede → falha, nunca exceção", async () => {
  const { f } = fetchFalso("", { status: 529 });
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set(), fetch: f });
  assertEquals(r.status, "falha");
  const r2 = await chamarAgenteOperacao({
    apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set(), fetch: () => Promise.reject(new TypeError("rede caiu")),
  });
  assertEquals([r2.status, r2.motivo], ["falha", "rede caiu"]);
});

Deno.test("o agente nunca fala com SSW/banco: o fonte só importa o cliente Anthropic e módulos puros", async () => {
  const src = await Deno.readTextFile(new URL("./operacao-agente-sugestao.ts", import.meta.url));
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assertEquals(imports.sort(), ["./anthropic-client.ts", "./operacao-comum.ts", "./operacao-sugestao.ts", "./prompts/agente-operacao.ts"]);
  assert(!/completeJson/.test(src.replace(/\/\/.*$/gm, "")), "usar completeJson repete a chamada e remenda JSON");
});

Deno.test("aguardar (1.1.0): sem código, nunca lançável, com motivo e quando reavaliar", async () => {
  const { f } = fetchFalso(JSON.stringify({
    acao: "aguardar", codigo: null, texto: "comprovante no malote, aguardar chegada", reavaliar_em_horas: 48, confianca: 0.85, justificativa: "j",
  }));
  const r = await chamarAgenteOperacao({ apiKey: "k", entrada: entrada(), codigosLancaveisAtivos: new Set([36]), fetch: f, agora: () => AGORA });
  const s = r.sugestao!;
  assertEquals([r.status, s.acao, s.codigo, s.lancavel, s.reavaliar_em_horas, s.reavaliar_em],
    ["ok", "aguardar", null, false, 48, "2026-10-09T12:00:00.000Z"]);
});

Deno.test("prompt 1.1.0: aguardar, comprovante no malote não é tratativa, encaminhar só com passagem de bastão real, 01 proibida", () => {
  assertEquals(AGENTE_OPERACAO_VERSION, "1.1.0");
  for (const trecho of ['"aguardar"', "comprovante no malote", "49,\n   54, 59, 33, 44, 46, 30, 53, 58", "Nunca** sugira 01", "reavaliar_em_horas"]) {
    assert(AGENTE_OPERACAO_SYSTEM_PROMPT.includes(trecho.replace("\\n", "\n")), `prompt sem: ${trecho}`);
  }
});
