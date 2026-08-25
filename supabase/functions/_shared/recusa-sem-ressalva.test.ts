import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehRecusaSemRessalva } from "./recusa-sem-ressalva.ts";

Deno.test("NF 234381 (âncora): 'CLIENTE NAO FEZ A RESSALVA SO FALOU QUE NAO IA RECEBER FALTANDO 4 VOL' → true", () => {
  assertEquals(ehRecusaSemRessalva("CLIENTE NAO FEZ A RESSALVA SO FALOU QUE NAO IA RECEBER FALTANDO 4 VOL"), true);
});

Deno.test("variações → true", () => {
  for (const s of ["RECUSOU SEM RESSALVA", "NAO REGISTROU A RESSALVA", "cliente não quis ressalvar", "RECUSA SEM RESSALVA NO CANHOTO"]) {
    assertEquals(ehRecusaSemRessalva(s), true, s);
  }
});

Deno.test("não dispara em falso", () => {
  for (const s of ["RECUSA TOTAL DA MERCADORIA", "FALTA DE VOLUME", "FERIADO MUNICIPAL", "", "CLIENTE FEZ A RESSALVA NO CANHOTO"]) {
    assertEquals(ehRecusaSemRessalva(s), false, s);
  }
});
