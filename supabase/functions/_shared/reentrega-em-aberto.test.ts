// Guard R5 anti-veto (playbook 02/09): parser de reentrega em aberto (Duilio p11).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reentregaEmAberto } from "./reentrega-em-aberto.ts";

Deno.test("R5 p11: CTRC emitido sem andamento depois = EM ABERTO", () => {
  assertEquals(reentregaEmAberto([
    { codigo: 21, instrucao: "REENTREGA SOLICITADA" },
    { codigo: null, instrucao: "CTRC OVD452891-3 EMITIDO PARA REENTREGA" },
  ]), true);
});

Deno.test("R5 p11: oc 14 depois da emissão = andamento → NÃO está em aberto", () => {
  assertEquals(reentregaEmAberto([
    { codigo: 21, instrucao: "" },
    { codigo: null, instrucao: "CTRC PDV455763-8 EMITIDO PARA REENTREGA" },
    { codigo: 14, instrucao: "ENTREGA INICIADA" },
  ]), false);
});

Deno.test("R5 p11: reentrega AUTOMÁTICA pós-13 (sem 21) conta pela linha sem código", () => {
  assertEquals(reentregaEmAberto([
    { codigo: 13, instrucao: "NAO LOCALIZADO" },
    { codigo: null, instrucao: "CTRC ABC123 EMITIDO PARA REENTREGA" },
  ]), true);
});

Deno.test("R5 p11: sem emissão nenhuma → false (âncora NF 26033: card 13 sem reentrega)", () => {
  assertEquals(reentregaEmAberto([
    { codigo: 13, instrucao: "ENTREGA IMPOSSIBILITADA" },
    { codigo: 54, instrucao: "AGUARDANDO RETORNO" },
  ]), false);
});
