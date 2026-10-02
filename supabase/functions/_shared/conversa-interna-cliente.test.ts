// Guard da cerca "conversa do lado do cliente" (Carlos 02/10, NF 1042798
// PRATI). Se esta cerca sumir, e-mail entre colegas do cliente volta a virar
// oc 56 lançada sozinha no SSW pela janela de veto. E se ela CRESCER além da
// 56, decisões legítimas ("@Paula, segue o romaneio", "Devolução autorizada.
// @Estoque recepcionar") deixam de sair como hoje — ensaio A/B de 02/10.
// Rodar: deno test supabase/functions/_shared/conversa-interna-cliente.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aplicarCercaConversaInterna,
  cercaConversaAgiu,
  conversaInternaBloqueiaVeto,
  ehAcao56,
  lerMarcaConversaInterna,
  motivoConversaInterna,
  normalizarPedidoDirigidoA,
} from "./conversa-interna-cliente.ts";

// Nomes FICTÍCIOS (LGPD); o caso é o da NF 1042798.
const DETALHE_1042798 = "Ana (PRATI) pede ao Bruno (PRATI) a evidência de erro cliente";

// ── Sinal 1: leitura do modelo ───────────────────────────────────────────────
Deno.test("NF 1042798: outra_pessoa + 56 → 54 e a janela de veto NÃO arma nem o aguardar", () => {
  const r = aplicarCercaConversaInterna({
    ocSugerida: 56,
    pedidoDirigidoA: "outra_pessoa",
    detalhe: DETALHE_1042798,
    ocDoCard: 54,
    mencoesSoForaDaSal: true,
  });
  assertEquals(r.oc, 54);
  assertEquals(r.marca, { detectada: true, rebaixou_de: 56, detalhe: DETALHE_1042798, mencoes_so_fora_da_sal: true });
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_ocorrencia:56"), true);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "ignorar_e_aguardar:54"), true);
  assertEquals(cercaConversaAgiu(r.marca, r.oc), true);
});

Deno.test("trilho da indenização: outra_pessoa + 56 com card em 59 → aguardar é 59", () => {
  assertEquals(
    aplicarCercaConversaInterna({ ocSugerida: 56, pedidoDirigidoA: "outra_pessoa", ocDoCard: 59 }).oc,
    59,
  );
});

// ── Sinal 2: menções (independe do modelo) ───────────────────────────────────
Deno.test("NF 1042798 com o modelo ERRANDO (56, sal_e_outra_pessoa) + só @Bruno → 56 mantida, mas NÃO sai sozinha", () => {
  const r = aplicarCercaConversaInterna({
    ocSugerida: 56,
    pedidoDirigidoA: "sal_e_outra_pessoa",
    ocDoCard: 54,
    mencoesSoForaDaSal: true,
  });
  assertEquals(r.oc, 56);
  assertEquals(r.marca, { detectada: false, rebaixou_de: null, detalhe: "", mencoes_so_fora_da_sal: true });
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_ocorrencia:56"), true);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_oc_e_enviar_email:56"), true);
  assertEquals(cercaConversaAgiu(r.marca, r.oc), true);
  assertStringIncludes(motivoConversaInterna(r.marca!, "CARLA"), "a 56 não sai sozinha");
});

// ── O que NÃO pode mudar em relação a hoje ───────────────────────────────────
Deno.test("NF 5634829: outra_pessoa + 55 (autorização no texto citado) → 55 e autônomo COMO HOJE", () => {
  const r = aplicarCercaConversaInterna({ ocSugerida: 55, pedidoDirigidoA: "outra_pessoa", ocDoCard: 54 });
  assertEquals(r.oc, 55);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_ocorrencia:55"), false);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_oc_e_enviar_email:55"), false);
  assertEquals(cercaConversaAgiu(r.marca, r.oc), false);
});

Deno.test("'@Paula, segue o romaneio' / '@Rita, tratar como devolução' (outra_pessoa) → 33/44 como hoje", () => {
  for (const oc of [33, 44, 21, 59]) {
    const r = aplicarCercaConversaInterna({ ocSugerida: oc, pedidoDirigidoA: "outra_pessoa", ocDoCard: 54, mencoesSoForaDaSal: true });
    assertEquals(r.oc, oc);
    assertEquals(conversaInternaBloqueiaVeto(r.marca, `lancar_ocorrencia:${oc}`), false);
    assertEquals(cercaConversaAgiu(r.marca, r.oc), false);
  }
});

Deno.test("outra_pessoa + 54 escolhido PELO MODELO → aguardar e 54+e-mail como hoje (NF 1042798 em 15/09)", () => {
  const r = aplicarCercaConversaInterna({ ocSugerida: 54, pedidoDirigidoA: "outra_pessoa", ocDoCard: 54 });
  assertEquals(r.oc, 54);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "ignorar_e_aguardar:54"), false);
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_oc_e_enviar_email:54"), false);
  assertEquals(cercaConversaAgiu(r.marca, r.oc), false);
});

Deno.test("Autoglass/AGV 'Devolução autorizada. @Estoque recepcionar' (sal_e_outra_pessoa) → intocado", () => {
  for (const p of ["sal_express", "sal_e_outra_pessoa", "indefinido"] as const) {
    const r = aplicarCercaConversaInterna({ ocSugerida: 44, pedidoDirigidoA: p, ocDoCard: 54 });
    assertEquals(r, { oc: 44, marca: null });
    assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_ocorrencia:44"), false);
  }
});

Deno.test("56 dirigida à Sal ('não consigo abrir a ressalva') sem menções → 56 e autônomo como hoje", () => {
  const r = aplicarCercaConversaInterna({ ocSugerida: 56, pedidoDirigidoA: "sal_express", ocDoCard: 54, mencoesSoForaDaSal: false });
  assertEquals(r, { oc: 56, marca: null });
  assertEquals(conversaInternaBloqueiaVeto(r.marca, "lancar_ocorrencia:56"), false);
});

Deno.test("campo ausente ou inválido (modelo antigo / degradado) e sem menções → comportamento de hoje", () => {
  assertEquals(normalizarPedidoDirigidoA(undefined), null);
  assertEquals(normalizarPedidoDirigidoA("COLEGA"), null);
  assertEquals(normalizarPedidoDirigidoA(1), null);
  assertEquals(normalizarPedidoDirigidoA("outra_pessoa"), "outra_pessoa");
  const r = aplicarCercaConversaInterna({ ocSugerida: 56, pedidoDirigidoA: null, ocDoCard: 54 });
  assertEquals(r, { oc: 56, marca: null });
  assertEquals(conversaInternaBloqueiaVeto(null, "lancar_ocorrencia:56"), false);
});

Deno.test("marca persistida: ida e volta pelo jsonb, forma inválida = sem marca", () => {
  const r = aplicarCercaConversaInterna({
    ocSugerida: 56,
    pedidoDirigidoA: "outra_pessoa",
    detalhe: "  x \n y ",
    ocDoCard: 54,
  });
  assertEquals(lerMarcaConversaInterna({ oc_sugerida: 54, conversa_interna_cliente: r.marca }), {
    detectada: true,
    rebaixou_de: 56,
    detalhe: "x y",
    mencoes_so_fora_da_sal: false,
  });
  assertEquals(lerMarcaConversaInterna(null), null);
  assertEquals(lerMarcaConversaInterna({ oc_sugerida: 56 }), null);
  assertEquals(lerMarcaConversaInterna({ conversa_interna_cliente: { detectada: "sim" } }), null);
  assertEquals(
    lerMarcaConversaInterna({ conversa_interna_cliente: { detectada: true, rebaixou_de: null, detalhe: "" } })
      ?.mencoes_so_fora_da_sal,
    false,
  );
  assertEquals(ehAcao56("lancar_ocorrencia:56"), true);
  assertEquals(ehAcao56("lancar_ocorrencia:560"), false);
  assertEquals(ehAcao56(null), false);
});

Deno.test("motivo do banner (56 rebaixada) explica e diz que não sai sozinho", () => {
  const r = aplicarCercaConversaInterna({
    ocSugerida: 56,
    pedidoDirigidoA: "outra_pessoa",
    detalhe: DETALHE_1042798,
    ocDoCard: 54,
  });
  const m = motivoConversaInterna(r.marca!, "CARLA");
  assertStringIncludes(m, "Conversa INTERNA do cliente (Ana (PRATI) pede ao Bruno");
  assertStringIncludes(m, "IA havia sugerido oc 56");
  assertStringIncludes(m, "não sai sozinho");
});
