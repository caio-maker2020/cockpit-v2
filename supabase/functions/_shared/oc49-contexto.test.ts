// Guard INV-113 (Caio 27/08): regras A/B da oc 49 + cerca nunca-misturar.
// Âncora = NF 25021 (timeline REAL): 21 liberada em 18/08, sem 14 depois,
// 46→49 em 24/08 → relançar 21. O bug original sugeriu 54+RECUSA_TOTAL com
// o texto da 49 da indenização como "motivo".
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analisarContextoOc49,
  ehParDeIndenizacao,
  TEXTO_SSW_RELANCAR_21,
  type OcTimeline,
} from "./oc49-contexto.ts";

// fixture do set de relacionamento (fonte real: OCORRENCIAS_DE_RELACIONAMENTO
// em bastao-rules.ts — não importado aqui pelo side-effect de env no top-level)
const RELACIONAMENTO: ReadonlySet<number> = new Set([3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 57]); // espelho do dicionário prod 27/08

const oc = (codigo: number, data: string, instrucao = ""): OcTimeline => ({ codigo, data, instrucao });

// Timeline real da NF 25021 (CTRC AMB481811-3)
const NF25021: OcTimeline[] = [
  oc(2, "31/07/26 18:53"), oc(9, "31/07/26 22:53", "1"),
  oc(5, "02/08/26 12:18"), oc(36, "03/08/26 03:13"), oc(6, "03/08/26 10:09"),
  oc(49, "07/08/26 08:16", "PRAZO DE PERDAS EXPIRADO"), oc(54, "07/08/26 08:27"),
  oc(55, "07/08/26 17:27"), oc(14, "11/08/26 09:27"),
  oc(10, "12/08/26 19:55", "NAO RECEBE FALTANDO VOLUMES"), oc(56, "13/08/26 16:21", "RESSALVA"),
  oc(49, "17/08/26 07:38"), oc(54, "17/08/26 16:53"),
  oc(21, "18/08/26 16:27", "CLIENTE CONFIRMA REENTREGA"),
  oc(41, "21/08/26 10:39", "SEGUIRA NA SEGUNDA FEIRA"),
  oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41", "DESCRICAO, VALOR E ROMANEIO"),
];

Deno.test("ÂNCORA NF 25021: 21 liberada, sem 14 depois, 46→49 → relançar 21", () => {
  const d = analisarContextoOc49(NF25021, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo, "relancar_liberacao");
  assertEquals(d?.tipo === "relancar_liberacao" && d.codigo, 21);
  assertEquals(d?.tipo === "relancar_liberacao" && d.textoSsw, TEXTO_SSW_RELANCAR_21);
});

Deno.test("insucesso ANTES da 21 não anula (ciclo tem prioridade — a 10 de 12/08 já foi tratada)", () => {
  // é a própria âncora: a recusa 10 vem antes da 21 e a regra dispara mesmo assim
  const d = analisarContextoOc49(NF25021, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo, "relancar_liberacao");
});

Deno.test("oc 14 DEPOIS da liberação → regra A não dispara (saiu pra entrega)", () => {
  const t = [...NF25021, oc(14, "25/08/26 08:00")];
  const d = analisarContextoOc49(t, "26/08/26 10:00", RELACIONAMENTO);
  // sem A; e sem B (última fora do par = 14) → null
  assertEquals(d, null);
});

Deno.test("oc de RELACIONAMENTO entre a 21 e a 49 quebra a cadeia (ciclo novo)", () => {
  const t = [
    oc(21, "18/08/26 16:27"),
    oc(35, "20/08/26 09:00"), // recusa parcial = relacionamento → ciclo novo
    oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41"),
  ];
  // sem A; B: anterior fora do par = 35 (não é 54/59) → null
  assertEquals(analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO), null);
});

Deno.test("49 informativa no meio NÃO quebra a cadeia da regra A", () => {
  const t = [
    oc(21, "18/08/26 16:27"),
    oc(49, "20/08/26 09:00", "COBRANDO"),
    oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41"),
  ];
  const d = analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo, "relancar_liberacao");
});

Deno.test("55 no ciclo → relança 55 com o texto dela", () => {
  const t = [oc(55, "20/08/26 10:00"), oc(46, "24/08/26 09:00"), oc(49, "24/08/26 09:02")];
  const d = analisarContextoOc49(t, "24/08/26 09:02", RELACIONAMENTO);
  assertEquals(d?.tipo === "relancar_liberacao" && d.codigo, 55);
  assertEquals(d?.tipo === "relancar_liberacao" && d.textoSsw, "SEGUIR COM A CARGA");
});

Deno.test("REGRA B: 54 imediatamente antes do par 46+49 (mesmo dia) → relançar 54", () => {
  const t = [oc(10, "10/08/26 09:00"), oc(54, "12/08/26 10:00"), oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41")];
  const d = analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo, "relancar_pos_indenizacao");
  assertEquals(d?.tipo === "relancar_pos_indenizacao" && d.codigo, 54);
});

Deno.test("REGRA B: 59 imediatamente antes do par → relançar 59", () => {
  const t = [oc(59, "20/08/26 10:00"), oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41")];
  const d = analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo === "relancar_pos_indenizacao" && d.codigo, 59);
});

Deno.test("REGRA B exige MESMO DIA: 46 de 5 dias antes não é o par → null", () => {
  const t = [oc(54, "12/08/26 10:00"), oc(46, "19/08/26 09:00"), oc(49, "24/08/26 17:41")];
  // A: sem 21/55; B: 46 não é do mesmo dia da 49 → null (vai pra IA)
  assertEquals(analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO), null);
});

Deno.test("nunca-misturar: par 46+49 mesmo dia detectado", () => {
  assertEquals(ehParDeIndenizacao(NF25021, "24/08/26 17:41"), true);
  assertEquals(ehParDeIndenizacao(NF25021, "17/08/26 07:38"), false);
});

Deno.test("regra A vence a B quando as duas casariam (ordem obrigatória)", () => {
  const t = [oc(54, "16/08/26 10:00"), oc(21, "18/08/26 16:27"), oc(46, "24/08/26 17:39"), oc(49, "24/08/26 17:41")];
  const d = analisarContextoOc49(t, "24/08/26 17:41", RELACIONAMENTO);
  assertEquals(d?.tipo, "relancar_liberacao");
});
