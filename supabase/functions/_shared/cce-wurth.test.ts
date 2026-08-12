import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AVISO_CCE, ehEmailCce, montarAvisosCce, obsIndicaCce } from "./cce-wurth.ts";

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

Deno.test("obsIndicaCce: gatilho pela Obs da intranet", () => {
  assertEquals(obsIndicaCce("CCE ENVIADA -ATT ELAINE"), true);
  assertEquals(obsIndicaCce("segue carta de correção"), true);
  assertEquals(obsIndicaCce("REENTREGAR EM HORÁRIO COMERCIAL"), false);
  assertEquals(obsIndicaCce(""), false);
});

Deno.test("montarAvisosCce: as DUAS mensagens (Caio 2026-08-12)", () => {
  const a = montarAvisosCce("670979", true);
  assertEquals(a.trocarEndereco.includes("670979") && a.trocarEndereco.includes("CORRIJA O ENDEREÇO"), true);
  assertEquals(a.anexo.includes("anexei"), true);
});

Deno.test("montarAvisosCce: quando NÃO achou o e-mail, avisa pra procurar manual", () => {
  const a = montarAvisosCce("670979", false);
  assertEquals(a.anexo.includes("NÃO localizei"), true);
  assertEquals(a.anexo.includes("manualmente"), true);
});
