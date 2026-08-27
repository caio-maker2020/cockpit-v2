// Guard INV-117 (Caio 27/08, NF 1011929 "41 + e-mail"): a IA da 49 NUNCA
// sugere lançar oc de relacionamento e e-mail só acompanha 54/59.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sanitizarLeituraIa49, type LeituraIa49 } from "./oc49-ia.ts";

const base: LeituraIa49 = {
  leitura_do_contexto: "x", origem_da_49: "operacao", acao_sugerida_oc: 56,
  enviar_email_cliente: false, corpo_email: null, texto_ssw_sugerido: "T",
  alerta_divergencia: null, confianca: 0.8, o_que_falta: null,
};

Deno.test("oc de relacionamento (10/11/35/49...) nunca passa — vira null", () => {
  for (const oc of [10, 11, 13, 19, 35, 49, 20, 46]) {
    const r = sanitizarLeituraIa49({ ...base, acao_sugerida_oc: oc });
    assertEquals(r.leitura.acao_sugerida_oc, null);
    assertEquals(r.ajustes[0], `oc_nao_lancavel_pelo_cockpit:${oc}`);
  }
});

Deno.test("caso real NF 1011929: '41 + e-mail' → 41 fica, e-mail cai", () => {
  const r = sanitizarLeituraIa49({ ...base, acao_sugerida_oc: 41, enviar_email_cliente: true, corpo_email: "olá" });
  assertEquals(r.leitura.acao_sugerida_oc, 41);
  assertEquals(r.leitura.enviar_email_cliente, false);
  assertEquals(r.leitura.corpo_email, null);
  assertEquals(r.ajustes, ["email_so_com_54_59:41"]);
});

Deno.test("54/59 + e-mail passam intactos; 21/55/56 sem e-mail passam", () => {
  for (const oc of [54, 59]) {
    const r = sanitizarLeituraIa49({ ...base, acao_sugerida_oc: oc, enviar_email_cliente: true, corpo_email: "c" });
    assertEquals(r.ajustes.length, 0);
    assertEquals(r.leitura.enviar_email_cliente, true);
  }
  for (const oc of [21, 55, 56, 33, 44]) {
    assertEquals(sanitizarLeituraIa49({ ...base, acao_sugerida_oc: oc }).ajustes.length, 0);
  }
});

Deno.test("null (decisão humana) passa limpo", () => {
  assertEquals(sanitizarLeituraIa49({ ...base, acao_sugerida_oc: null }).ajustes.length, 0);
});
