import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehEmailCce, AVISO_CCE } from "./cce-wurth.ts";

Deno.test("detecta CCE por assunto ou corpo (real: 'SEGUE CCE - CPD')", () => {
  assertEquals(ehEmailCce("SEGUE CCE - CPD: 670979", "seguiremos com a entrega conforme CCE"), true);
  assertEquals(ehEmailCce("Carta de Correção NF 670979", ""), true);
  assertEquals(ehEmailCce(null, "segue a carta de correção eletrônica"), true);
});

Deno.test("não confunde com e-mail comum", () => {
  assertEquals(ehEmailCce("Recusa Total NF 123", "cliente recusou"), false);
  assertEquals(ehEmailCce("acesso ao sistema", "cce" in {} ? "x" : ""), false);
});

Deno.test("aviso deixa claro que a correção do endereço é manual", () => {
  assertEquals(AVISO_CCE.includes("CORRIGIR O ENDEREÇO NO SSW"), true);
});
