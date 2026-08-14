// Enxerto da instrução do E-MAIL na proposta 21 (INV-081).
// Caso-âncora REAL: NF 674757 (Würth/Ingrid, 13-14/08/2026) — a Würth mandou
// e-mail com contato/horário/referência novos; o todo 21 do robô (Obs velha da
// intranet, ciclo anterior) foi aprovado às cegas e o SSW recebeu
// "HOR COML S/ ALMOCO | BERENICE" em vez dos dados do e-mail.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirInstrucaoEmail21,
  enxertarInstrucaoEmail21,
  ORIGEM_INSTRUCAO_EMAIL,
} from "./instrucao-email-21.ts";

// O que o interpretador extraiu do e-mail real da 674757 (13/08 16:25 BRT).
const INSTRUCAO_674757 =
  "Falar com Josiele ou Larissa, tel 33 98427-3432, receber das 07:00 às 17:00 — ao lado da prefeitura";

// O todo como o robô da intranet criou (Obs do ciclo ANTERIOR, retorno 31/07).
const PAYLOAD_ROBO = {
  tool: "lancar_ocorrencia",
  acao_key: "lancar_ocorrencia:21",
  recomendada: true,
  args: { codigo_ssw: 21, nf: "674757", descricao: "HOR COML S/ ALMOCO | BERENICE" },
  rationale: 'Retorno na intranet Würth em 2026-07-31 08:25: Solução "Reentrega"',
  texto: "HOR COML S/ ALMOCO | BERENICE",
  meta: {
    origem: "robo-intranet-wurth",
    texto_ssw_sugerido: "HOR COML S/ ALMOCO | BERENICE",
    obs_intranet_original: "REENTREGAR EM HORáRIO COMERCIAL - EVITAR ALMOçO - BERENICE",
  },
};

// ── decisão ──────────────────────────────────────────────────────────────────
Deno.test("decide enxertar quando decisão final é 21 com instrução preenchida", () => {
  assertEquals(
    decidirInstrucaoEmail21({ oc_sugerida: 21, instrucao_reentrega_sugerida: INSTRUCAO_674757 }),
    INSTRUCAO_674757,
  );
});

Deno.test("NÃO enxerta: oc≠21, instrução vazia/ausente, sugestão nula", () => {
  assertEquals(decidirInstrucaoEmail21({ oc_sugerida: 54, instrucao_reentrega_sugerida: "x" }), null);
  assertEquals(decidirInstrucaoEmail21({ oc_sugerida: 21, instrucao_reentrega_sugerida: "  " }), null);
  assertEquals(decidirInstrucaoEmail21({ oc_sugerida: 21 }), null);
  assertEquals(decidirInstrucaoEmail21(null), null);
});

// ── enxerto (REGRESSÃO NF 674757) ────────────────────────────────────────────
Deno.test("REGRESSÃO 674757: e-mail sobrescreve a Obs velha da intranet no args.descricao", () => {
  const novo = enxertarInstrucaoEmail21(PAYLOAD_ROBO, INSTRUCAO_674757, "2026-08-13T19:27:45.000Z");
  const args = novo["args"] as Record<string, unknown>;
  const meta = novo["meta"] as Record<string, unknown>;
  // o texto que vai pro SSW agora vem do E-MAIL (contato/horário/referência)
  assert(args["descricao"] !== "HOR COML S/ ALMOCO | BERENICE");
  assertStringIncludes(String(args["descricao"]), "JOSIELE");
  assertStringIncludes(String(args["descricao"]), "98427");
  // origem marcada pro chip do front
  assertEquals(meta["origem_instrucao"], ORIGEM_INSTRUCAO_EMAIL);
  // auditoria: original do e-mail + o que estava lá antes (e de quem era)
  assertEquals(meta["instrucao_email_original"], INSTRUCAO_674757);
  const anterior = meta["instrucao_anterior"] as Record<string, unknown>;
  assertEquals(anterior["descricao"], "HOR COML S/ ALMOCO | BERENICE");
  assertEquals(anterior["origem"], "robo-intranet-wurth");
  // rationale ganha o contexto sem perder o histórico da intranet
  assertStringIncludes(String(novo["rationale"]), "Intranet Würth".replace("Intranet", "intranet"));
  assertStringIncludes(String(novo["rationale"]), "E-mail do cliente");
});

Deno.test("preserva o resto do payload (tool/acao_key/recomendada/nf)", () => {
  const novo = enxertarInstrucaoEmail21(PAYLOAD_ROBO, INSTRUCAO_674757, null);
  assertEquals(novo["tool"], "lancar_ocorrencia");
  assertEquals(novo["acao_key"], "lancar_ocorrencia:21");
  assertEquals(novo["recomendada"], true);
  assertEquals((novo["args"] as Record<string, unknown>)["nf"], "674757");
  assertEquals((novo["args"] as Record<string, unknown>)["codigo_ssw"], 21);
});

Deno.test("texto do SSW sem boilerplate; contato+tel sobrevivem aos primeiros 70 (f6)", () => {
  const novo = enxertarInstrucaoEmail21(PAYLOAD_ROBO, INSTRUCAO_674757, null);
  const texto = String((novo["args"] as Record<string, unknown>)["descricao"]);
  // o texto inteiro vai no observ (≤500); a coluna que a Operação lê é o corte
  // de 70 do f6 — o que importa é o ESSENCIAL caber nesse prefixo.
  const f6 = texto.slice(0, 70);
  assertStringIncludes(f6, "JOSIELE");
  assertStringIncludes(f6, "98427-3432");
  assert(texto.length <= 500);
  assert(!/REENTREGA AUTORIZADA/i.test(texto)); // boilerplate proibido (NF 669899)
  assert(!/BOA TARDE|POR FAVOR|GENTILEZA/i.test(texto)); // cortesia removida
});

Deno.test("cortesia no início não queima o orçamento do f6", () => {
  const novo = enxertarInstrucaoEmail21(
    PAYLOAD_ROBO,
    "Boa tarde! Por favor, entregar na Rua das Acácias, 123 — falar com João",
    null,
  );
  const texto = String((novo["args"] as Record<string, unknown>)["descricao"]);
  assert(texto.startsWith("ENTREGAR NA RUA DAS ACACIAS"), texto);
});

Deno.test("payload sem meta/args prévios não explode (todo genérico do menu)", () => {
  const novo = enxertarInstrucaoEmail21(
    { tool: "lancar_ocorrencia", args: { codigo_ssw: 21, nf: "1", descricao: "Reentrega solicitada pelo cliente" } },
    "Rua Nova, 45 — falar com João, tel (31) 99999-0000",
    null,
  );
  const meta = novo["meta"] as Record<string, unknown>;
  assertEquals(meta["origem_instrucao"], ORIGEM_INSTRUCAO_EMAIL);
  const anterior = meta["instrucao_anterior"] as Record<string, unknown>;
  assertEquals(anterior["origem"], null);
  assertStringIncludes(String((novo["args"] as Record<string, unknown>)["descricao"]), "JOAO");
});
