// Guard R6 anti-veto (playbook 02/09): terminal/setor — âncoras NFs 1034543 e 70120.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { devolucaoEmCurso, ultimaOcIndicaEncerramento } from "./estado-terminal-ssw.ts";

Deno.test("R6a (NF 1034543): SSW já entregue → encerramento detectado", () => {
  assertEquals(ultimaOcIndicaEncerramento([
    { codigo: 14, instrucao: "SAIDA PARA ENTREGA" },
    { codigo: 1, instrucao: "MERCADORIA ENTREGUE" },
  ]), true);
  assertEquals(ultimaOcIndicaEncerramento([
    { codigo: null, instrucao: "ENTREGA REALIZADA CONFORME COMPROVANTE" },
  ]), true);
  assertEquals(ultimaOcIndicaEncerramento([
    { codigo: 54, instrucao: "AGUARDANDO RETORNO" },
  ]), false);
});

Deno.test("R6b (NF 70120, Duilio p12): oc 30 com reversa = devolução em curso", () => {
  assertEquals(devolucaoEmCurso([
    { codigo: 30, instrucao: "CTE FINALIZADO - CTE REVERSA JA EMITIDO" },
  ]), true);
  assertEquals(devolucaoEmCurso([
    { codigo: null, instrucao: "CTRC REVERSA POE123456-7 EMITIDO" },
  ]), true);
  assertEquals(devolucaoEmCurso([
    { codigo: 30, instrucao: "CTE FINALIZADO POR ENTREGA" },
    { codigo: 54, instrucao: "AGUARDANDO RETORNO" },
  ]), false);
});
