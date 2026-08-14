// Guard de ciclo do retorno da intranet Würth (INV-071).
// Caso-âncora REAL: NF 677750 (Würth/Ingrid, 13/08/2026) — o robô sugeriu oc 21
// lendo a resposta da oc 13 (12/08 08:39) como se fosse resposta da oc 10
// (12/08 23:26). Mesmo DIA — só a HORA separa os dois ciclos.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  avaliarCicloRetornoWurth,
  parseDataSolucaoWurth,
  resolverGatilhoCiclo,
} from "./wurth-ciclo.ts";

// Histórico SSW real da NF 677750 (mais-recente-primeiro, como o SSW devolve).
const HISTORICO_677750 = [
  { data: "13/08/26 10:42", codigo: 54 },
  { data: "12/08/26 23:26", codigo: 10 },
  { data: "12/08/26 08:38", codigo: 14 },
  { data: "11/08/26 17:52", codigo: null },
  { data: "11/08/26 17:02", codigo: 13 },
  { data: "11/08/26 12:54", codigo: 14 },
  { data: "11/08/26 09:37", codigo: 20 },
  { data: "10/08/26 14:27", codigo: 6 },
];

// ── parser da Data Solução ───────────────────────────────────────────────────
Deno.test("parseDataSolucaoWurth lê o formato real 'YYYY-MM-DD HH:MM' como BRT", () => {
  const r = parseDataSolucaoWurth("2026-08-12 08:39")!;
  assert(r != null);
  assertEquals(r.temHora, true);
  assertEquals(new Date(r.ts).toISOString(), "2026-08-12T11:39:00.000Z"); // BRT+3
});

Deno.test("parseDataSolucaoWurth tolera dd/mm/yyyy e data sem hora", () => {
  assertEquals(parseDataSolucaoWurth("12/08/2026 08:39")!.ts, parseDataSolucaoWurth("2026-08-12 08:39")!.ts);
  assertEquals(parseDataSolucaoWurth("2026-08-12")!.temHora, false);
  assertEquals(parseDataSolucaoWurth(""), null);
  assertEquals(parseDataSolucaoWurth("lixo"), null);
});

// ── âncora do ciclo ──────────────────────────────────────────────────────────
Deno.test("gatilho = oc do lançamento (10) com HORA, mesmo com card já em oc 54", () => {
  const g = resolverGatilhoCiclo({
    historicoSsw: HISTORICO_677750,
    bastaoOcNoLancamento: 10,
    codUltimaOcorrencia: 54,
    dataUltimaOcorrencia: "2026-08-13",
  });
  assertEquals(g.fonte, "historico_ssw");
  assertEquals(g.codigo, 10);
  assertEquals(g.temHora, true);
  assertEquals(new Date(g.ts!).toISOString(), "2026-08-13T02:26:00.000Z"); // 12/08 23:26 BRT
});

Deno.test("sem snapshot do lançamento e card em oc 54 → cai na oc de gatilho mais recente (10, não a 54)", () => {
  const g = resolverGatilhoCiclo({
    historicoSsw: HISTORICO_677750,
    bastaoOcNoLancamento: null,
    codUltimaOcorrencia: 54,
  });
  assertEquals(g.codigo, 10);
  assertEquals(g.fonte, "historico_ssw");
});

Deno.test("sem histórico SSW → fallback pela data do Bastão (só DIA)", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: [], codUltimaOcorrencia: 10, dataUltimaOcorrencia: "2026-08-12" });
  assertEquals(g.fonte, "bastao_dia");
  assertEquals(g.temHora, false);
});

Deno.test("sem histórico e sem data do Bastão → indeterminado", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: null, codUltimaOcorrencia: 10 });
  assertEquals(g.fonte, "indeterminado");
  assertEquals(g.ts, null);
});

// ── a regra ──────────────────────────────────────────────────────────────────
Deno.test("REGRESSÃO NF 677750: retorno de 12/08 08:39 é DESCARTADO contra a oc 10 de 12/08 23:26", () => {
  const g = resolverGatilhoCiclo({
    historicoSsw: HISTORICO_677750,
    bastaoOcNoLancamento: 10,
    codUltimaOcorrencia: 54,
  });
  const v = avaliarCicloRetornoWurth("2026-08-12 08:39", g);
  assertEquals(v.descartar, true);
  assertEquals(v.precisao, "hora");
  assertStringIncludes(v.motivo, "ciclo anterior");
});

Deno.test("retorno POSTERIOR à ocorrência-gatilho passa (mesmo antes da 54 ser lançada)", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: HISTORICO_677750, bastaoOcNoLancamento: 10 });
  // Würth responde 13/08 07:00 — depois da recusa (12/08 23:26), antes da 54 (13/08 10:42)
  const v = avaliarCicloRetornoWurth("2026-08-13 07:00", g);
  assertEquals(v.descartar, false);
  assertEquals(v.precisao, "hora");
});

Deno.test("empate exato no minuto NÃO descarta (só estritamente anterior)", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: HISTORICO_677750, bastaoOcNoLancamento: 10 });
  assertEquals(avaliarCicloRetornoWurth("2026-08-12 23:26", g).descartar, false);
});

Deno.test("fail-open: gatilho indeterminado nunca descarta", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: null, codUltimaOcorrencia: 10 });
  const v = avaliarCicloRetornoWurth("2026-08-12 08:39", g);
  assertEquals(v.descartar, false);
  assertEquals(v.precisao, "indeterminado");
  assertStringIncludes(v.motivo, "guard não aplicado");
});

Deno.test("fail-open: Data Solução ilegível nunca descarta", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: HISTORICO_677750, bastaoOcNoLancamento: 10 });
  assertEquals(avaliarCicloRetornoWurth("", g).descartar, false);
});

Deno.test("comparação por DIA (fallback Bastão): dia anterior descarta, mesmo dia passa", () => {
  const g = resolverGatilhoCiclo({ historicoSsw: [], codUltimaOcorrencia: 10, dataUltimaOcorrencia: "2026-08-12" });
  assertEquals(avaliarCicloRetornoWurth("2026-08-11 16:00", g).descartar, true);
  // mesmo dia sem hora do gatilho: não dá pra reprovar — é o limite conhecido do
  // fallback, e a razão de o robô puxar o histórico SSW antes de decidir.
  assertEquals(avaliarCicloRetornoWurth("2026-08-12 08:39", g).descartar, false);
});
