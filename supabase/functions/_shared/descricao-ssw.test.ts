// Guard de não-regressão do bug NF 59299 (Larissa, 2026-06-24): a oc=44 chegou
// no SSW com "...DE DEVOLUCAO | VOLUM" — os extras operacionais (Volumes/Motivo/
// Filial) que a operadora preencheu estouravam os 70 chars do campo f6 (a coluna
// "Instrução/Complemento" que o setor de Devolução LÊ) porque eram concatenados
// DEPOIS da boilerplate base. Se voltar a vir base-primeiro, o setor perde a info.
//
// Rodar: deno test supabase/functions/_shared/descricao-ssw.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  camposObrigatoriosAusentes,
  montarDescricaoSsw,
  SSW_F6_MAXLEN,
} from "./descricao-ssw.ts";

const BASE_OC44 = "Cliente autorizou devolução — encaminha pro setor de Devolução";

// --- montarDescricaoSsw: extras operacionais sobrevivem ao f6 (70 chars) ----

Deno.test("oc=44: Volumes e Motivo cabem nos primeiros 70 chars (campo f6 que o setor lê)", () => {
  const texto = montarDescricaoSsw({
    baseDescricao: BASE_OC44,
    extras: { quantidade_volumes: "2", motivo: "DESACORO", filial: "POA" },
  });
  const f6 = texto.slice(0, SSW_F6_MAXLEN);
  assert(f6.includes("Volumes: 2"), `f6 deve mostrar os volumes; veio: "${f6}"`);
  assert(f6.includes("Motivo: DESACORO"), `f6 deve mostrar o motivo; veio: "${f6}"`);
});

Deno.test("oc=44: extras vêm ANTES da boilerplate base (não o contrário)", () => {
  const texto = montarDescricaoSsw({
    baseDescricao: BASE_OC44,
    extras: { quantidade_volumes: "2", motivo: "DESACORO" },
  });
  assert(
    texto.indexOf("Volumes: 2") < texto.indexOf("Cliente autorizou"),
    `extras devem preceder a base; veio: "${texto}"`,
  );
});

Deno.test("sem extras: descrição é só a base", () => {
  assertEquals(montarDescricaoSsw({ baseDescricao: BASE_OC44, extras: null }), BASE_OC44);
  assertEquals(montarDescricaoSsw({ baseDescricao: BASE_OC44, extras: {} }), BASE_OC44);
});

Deno.test("não vaza flags internas pro texto SSW (só whitelist)", () => {
  const texto = montarDescricaoSsw({
    baseDescricao: BASE_OC44,
    extras: {
      quantidade_volumes: "1",
      validar_evidencia: false,
      responder_thread_cliente: { enviar: true, corpo: "x" },
    },
  });
  assert(!texto.includes("validar_evidencia"), "não pode vazar validar_evidencia");
  assert(!texto.includes("responder_thread_cliente"), "não pode vazar responder_thread_cliente");
  assert(!texto.includes("[object Object]"), "não pode vazar [object Object]");
});

Deno.test("texto_descricao (texto livre) substitui a base inteira", () => {
  const texto = montarDescricaoSsw({
    baseDescricao: BASE_OC44,
    extras: { texto_descricao: "Texto livre da operadora", quantidade_volumes: "5" },
  });
  assertEquals(texto, "Texto livre da operadora");
});

// --- camposObrigatoriosAusentes: oc=44 exige volumes + motivo ---------------

Deno.test("oc=44 sem volumes/motivo → bloqueia (lista os ausentes)", () => {
  assertEquals(camposObrigatoriosAusentes(44, {}), ["quantidade_volumes", "motivo"]);
  assertEquals(camposObrigatoriosAusentes(44, { quantidade_volumes: "2" }), ["motivo"]);
  assertEquals(camposObrigatoriosAusentes(44, { quantidade_volumes: "2", motivo: " " }), ["motivo"]);
});

Deno.test("oc=44 com volumes + motivo → libera", () => {
  assertEquals(camposObrigatoriosAusentes(44, { quantidade_volumes: "2", motivo: "DESACORO" }), []);
});

Deno.test("outras ocs não têm campos obrigatórios", () => {
  assertEquals(camposObrigatoriosAusentes(54, {}), []);
  assertEquals(camposObrigatoriosAusentes(33, null), []);
  assertEquals(camposObrigatoriosAusentes(21, undefined), []);
});
