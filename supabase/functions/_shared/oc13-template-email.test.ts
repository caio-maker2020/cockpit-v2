// Guard NF 153826 (Caio 2026-08-25): feriado/local fechado NUNCA sai como
// "problema com endereço" no fluxo oc13.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ehMotivoLocalFechado, sugerirTemplateEmailOc13, TEMPLATE_LOCAL_FECHADO } from "./oc13-template-email.ts";

Deno.test("NF 153826 (âncora): 'FERIADO MUNICIPAL .' + foto destinatario → template local fechado", () => {
  assertEquals(sugerirTemplateEmailOc13("FERIADO MUNICIPAL .", "destinatario"), TEMPLATE_LOCAL_FECHADO);
});

Deno.test("variações de local fechado → template novo", () => {
  for (const m of ["LOJA FECHADA", "estabelecimento fechado", "CLIENTE AUSENTE", "FORA DO HORARIO DE EXPEDIENTE", "PONTO FACULTATIVO", "HORARIO DE ALMOCO", "ENCERRADO"]) {
    assertEquals(sugerirTemplateEmailOc13(m, "destinatario"), TEMPLATE_LOCAL_FECHADO, m);
  }
});

Deno.test("foto classificada local_fechado com motivo genérico → template novo", () => {
  assertEquals(sugerirTemplateEmailOc13("1 (SSWMOBILE) GPS (116m).", "local_fechado"), TEMPLATE_LOCAL_FECHADO);
});

Deno.test("motivos explícitos preservados (zero regressão)", () => {
  assertEquals(sugerirTemplateEmailOc13("NUMERO NAO EXISTE NA RUA", "destinatario"), "PROBLEMAS_COM_ENDERECO");
  assertEquals(sugerirTemplateEmailOc13("CLIENTE NAO ACEITOU A MERCADORIA", "destinatario"), "RECUSA_TOTAL");
  assertEquals(sugerirTemplateEmailOc13("RECUSA PARCIAL DE 2 VOLUMES", "destinatario"), "RECUSA_PARCIAL");
  assertEquals(sugerirTemplateEmailOc13("FALTA DE VOLUME", "destinatario"), "FALTA_DE_VOLUME");
});

Deno.test("fallback residual segue endereço (só o ramo novo foi autorizado — Caio 25/08)", () => {
  assertEquals(sugerirTemplateEmailOc13("MOTIVO QUALQUER SEM PADRAO", "destinatario"), "PROBLEMAS_COM_ENDERECO");
  assertEquals(sugerirTemplateEmailOc13("", "sem_foto"), "PROBLEMAS_COM_ENDERECO");
});

Deno.test("ehMotivoLocalFechado não dispara em falso ('fechamento do pedido' não é loja fechada)", () => {
  assertEquals(ehMotivoLocalFechado("NUMERO NAO EXISTE"), false);
  assertEquals(ehMotivoLocalFechado("RECUSA TOTAL"), false);
});
