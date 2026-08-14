// R2 devolução Würth por 2ª recusa (INV-083). Fixture no shape do histórico
// real da NF 677750 (recusa → ciclo → nova recusa) — datas sintéticas.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { detectarSegundaRecusaWurth } from "./wurth-segunda-recusa.ts";

const CICLO_COMPLETO = [
  { data: "12/08/26 23:26", codigo: 10 }, // 2ª recusa
  { data: "12/08/26 08:38", codigo: 14 },
  { data: "10/08/26 09:00", codigo: 21 }, // Würth liberou reentrega
  { data: "26/06/26 14:40", codigo: 54 }, // tratativa da 1ª recusa
  { data: "25/06/26 11:28", codigo: 10 }, // 1ª recusa
  { data: "25/06/26 10:05", codigo: 14 },
];

Deno.test("2 recusas com ciclo entre elas → DETECTA e indica as duas datas", () => {
  const v = detectarSegundaRecusaWurth(CICLO_COMPLETO);
  assert(v.detectada);
  if (v.detectada) {
    assertEquals(v.recusasTs.length, 2);
    assertStringIncludes(v.motivo, "2ª ocorrência 10");
    assertStringIncludes(v.primeiraRecusaBrt, "25/06");
    assertStringIncludes(v.segundaRecusaBrt, "12/08");
  }
});

Deno.test("2 recusas SEM oc 21 entre elas (reentrega por CTRC novo) → detecta igual", () => {
  const v = detectarSegundaRecusaWurth(CICLO_COMPLETO.filter((o) => o.codigo !== 21));
  assert(v.detectada);
});

Deno.test("apenas 1 recusa → não detecta", () => {
  const v = detectarSegundaRecusaWurth([
    { data: "12/08/26 23:26", codigo: 10 },
    { data: "11/08/26 17:02", codigo: 13 },
  ]);
  assertEquals(v.detectada, false);
  assertStringIncludes((v as { motivo: string }).motivo, "exige 2");
});

Deno.test("linha 10 DUPLICADA (mesmo timestamp) conta como UMA recusa", () => {
  const v = detectarSegundaRecusaWurth([
    { data: "12/08/26 23:26", codigo: 10 },
    { data: "12/08/26 23:26", codigo: 10 }, // relistagem do SSW
  ]);
  assertEquals(v.detectada, false);
});

Deno.test("EXCEÇÃO da operadora: 54 lançada DEPOIS da 2ª recusa → desarma (volta ao normal)", () => {
  const v = detectarSegundaRecusaWurth([
    { data: "13/08/26 10:42", codigo: 54 }, // Ingrid notificou mesmo assim
    ...CICLO_COMPLETO,
  ]);
  assertEquals(v.detectada, false);
  assertStringIncludes((v as { motivo: string }).motivo, "exceção");
});

Deno.test("54 da 1ª tratativa (ANTES da 2ª recusa) NÃO desarma", () => {
  // CICLO_COMPLETO já tem a 54 de 26/06 (anterior à recusa de 12/08) — detecta.
  const v = detectarSegundaRecusaWurth(CICLO_COMPLETO);
  assert(v.detectada);
});

Deno.test("3 recusas → detecta e informa o total", () => {
  const v = detectarSegundaRecusaWurth([
    { data: "20/08/26 10:00", codigo: 10 },
    ...CICLO_COMPLETO,
  ]);
  assert(v.detectada);
  if (v.detectada) assertStringIncludes(v.motivo, "3 recusas no total");
});

Deno.test("fail-closed: histórico vazio/nulo ou recusas sem hora → não detecta", () => {
  assertEquals(detectarSegundaRecusaWurth(null).detectada, false);
  assertEquals(detectarSegundaRecusaWurth([]).detectada, false);
  assertEquals(
    detectarSegundaRecusaWurth([
      { data: "12/08/26", codigo: 10 }, // sem hora → parser devolve null
      { data: "25/06/26", codigo: 10 },
    ]).detectada,
    false,
  );
});
