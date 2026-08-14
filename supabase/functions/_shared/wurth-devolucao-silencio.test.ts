// R1 devolução Würth por silêncio (INV-082). Fixture baseada no shape real da
// NF 378673 (oc 11 → 54, histórico SSW com hora) — datas sintéticas.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acharData54DoCiclo,
  avaliarSilencioParaDevolucao,
  DIAS_SILENCIO_PARA_DEVOLUCAO,
} from "./wurth-devolucao-silencio.ts";
import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

// Ciclo: oc 11 em 01/08 10:00, Ingrid lança 54 em 01/08 15:00.
const HIST_OC11 = [
  { data: "01/08/26 15:00", codigo: 54 },
  { data: "01/08/26 10:00", codigo: 11 },
  { data: "01/08/26 08:30", codigo: 14 },
  { data: "30/07/26 09:00", codigo: 7 },
];
const CARD_BASE = {
  historicoSsw: HIST_OC11,
  bastaoOcNoLancamento: 11,
  codUltimaOcorrencia: 54,
  clienteRespondeuEm: null,
};
const T54 = parseSswDataHoraBrt("01/08/26 15:00")!;
const DIA = 24 * 60 * 60 * 1000;

Deno.test("10 dias de silêncio total → SUGERE 44 com motivo completo", () => {
  const v = avaliarSilencioParaDevolucao(CARD_BASE, [], T54 + 10 * DIA + 60_000);
  assert(v.sugerir);
  if (v.sugerir) {
    assertEquals(v.gatilho.codigo, 11);
    assertEquals(v.diasSemRetorno, 10);
    assertStringIncludes(v.motivo, "sem NENHUM retorno");
  }
});

Deno.test("9 dias → NÃO sugere (aguarda o décimo)", () => {
  const v = avaliarSilencioParaDevolucao(CARD_BASE, [], T54 + 9 * DIA);
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "aguarda 10");
  assertEquals(DIAS_SILENCIO_PARA_DEVOLUCAO, 10);
});

Deno.test("cliente respondeu por e-mail depois da 54 → NÃO sugere", () => {
  const v = avaliarSilencioParaDevolucao(
    { ...CARD_BASE, clienteRespondeuEm: new Date(T54 + 2 * DIA).toISOString() },
    [],
    T54 + 12 * DIA,
  );
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "respondeu por e-mail");
});

Deno.test("resposta por e-mail ANTERIOR à 54 (ciclo velho) não conta — sugere", () => {
  const v = avaliarSilencioParaDevolucao(
    { ...CARD_BASE, clienteRespondeuEm: new Date(T54 - 5 * DIA).toISOString() },
    [],
    T54 + 11 * DIA,
  );
  assert(v.sugerir);
});

Deno.test("retorno na intranet POSTERIOR ao gatilho → NÃO sugere (não é silêncio)", () => {
  const linha = { emp: "24", nf: "999", data: "01/08/2026", cgc: "", razaoSocial: "", telefone: "", solucao: "Reentrega", dataSolucao: "2026-08-05 09:00", obs: "X" };
  const v = avaliarSilencioParaDevolucao(CARD_BASE, [linha], T54 + 12 * DIA);
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "há retorno da Würth na intranet");
});

Deno.test("linha da intranet de CICLO ANTERIOR não conta como retorno — sugere e vira evidência", () => {
  const linhaVelha = { emp: "24", nf: "999", data: "10/07/2026", cgc: "", razaoSocial: "", telefone: "", solucao: "Reentrega", dataSolucao: "2026-07-10 08:00", obs: "ciclo velho" };
  const v = avaliarSilencioParaDevolucao(CARD_BASE, [linhaVelha], T54 + 11 * DIA);
  assert(v.sugerir);
  if (v.sugerir) assertEquals(v.linhasCicloAnterior.length, 1);
});

Deno.test("sem 54 lançada após a oc 11 → regra NÃO arma", () => {
  const v = avaliarSilencioParaDevolucao(
    { ...CARD_BASE, historicoSsw: HIST_OC11.filter((o) => o.codigo !== 54) },
    [],
    T54 + 20 * DIA,
  );
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "sem oc 54");
});

Deno.test("54 ANTERIOR à oc 11 (ciclo velho) não abre contagem", () => {
  const hist = [
    { data: "01/08/26 10:00", codigo: 11 },
    { data: "20/07/26 12:00", codigo: 54 }, // 54 de ciclo anterior
  ];
  assertEquals(acharData54DoCiclo(hist, parseSswDataHoraBrt("01/08/26 10:00")!), null);
});

Deno.test("re-lançamento de 54 NÃO reseta o prazo (vale a PRIMEIRA pós-gatilho)", () => {
  const hist = [
    { data: "08/08/26 09:00", codigo: 54 }, // re-aguardar
    { data: "01/08/26 15:00", codigo: 54 }, // primeira — abre a contagem
    { data: "01/08/26 10:00", codigo: 11 },
  ];
  const v = avaliarSilencioParaDevolucao({ ...CARD_BASE, historicoSsw: hist }, [], T54 + 10 * DIA + 60_000);
  assert(v.sugerir);
  if (v.sugerir) assertEquals(v.data54Ts, T54);
});

Deno.test("gatilho ≠ oc 11 (ex.: oc 10) → R1 não se aplica", () => {
  const hist = [
    { data: "01/08/26 15:00", codigo: 54 },
    { data: "01/08/26 10:00", codigo: 10 },
  ];
  const v = avaliarSilencioParaDevolucao({ ...CARD_BASE, historicoSsw: hist, bastaoOcNoLancamento: 10 }, [], T54 + 15 * DIA);
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "só vale pra oc 11");
});

Deno.test("fail-closed: sem histórico SSW → NÃO sugere", () => {
  const v = avaliarSilencioParaDevolucao({ ...CARD_BASE, historicoSsw: null }, [], T54 + 15 * DIA);
  assertEquals(v.sugerir, false);
});

Deno.test("fail-closed: linha da intranet com data ilegível → NÃO sugere", () => {
  const linha = { emp: "24", nf: "999", data: "", cgc: "", razaoSocial: "", telefone: "", solucao: "Reentrega", dataSolucao: "???", obs: "" };
  const v = avaliarSilencioParaDevolucao(CARD_BASE, [linha], T54 + 12 * DIA);
  assertEquals(v.sugerir, false);
  assertStringIncludes((v as { motivo: string }).motivo, "ilegível");
});
