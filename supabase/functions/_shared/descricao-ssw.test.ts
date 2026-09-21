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
      // Caio 2026-09-21 (PRATI): `segregar_ctrc` é flag de CONTROLE — manda o
      // executor marcar o campo f8 da tela 101, NÃO é texto pro setor ler.
      // Fica aqui porque a promessa "não vira texto da ocorrência" está escrita
      // no comentário de `lerMarcacaoSegregar`, e comentário não trava
      // regressão: a de 2026-06-10 (iterar `Object.entries(extras)`) já vazou
      // flag interna pro SSW uma vez.
      segregar_ctrc: true,
    },
  });
  assert(!texto.includes("validar_evidencia"), "não pode vazar validar_evidencia");
  assert(!texto.includes("responder_thread_cliente"), "não pode vazar responder_thread_cliente");
  assert(!texto.includes("segregar_ctrc"), "não pode vazar segregar_ctrc (flag de controle do f8)");
  assert(!texto.includes("[object Object]"), "não pode vazar [object Object]");
  // Igualdade exata: pega também quem ENTENDER errado e adicionar a flag na
  // whitelist com um rótulo bonitinho ("Segregar: true"), caso em que as
  // asserções por nome de chave acima passariam batido.
  assertEquals(texto, `Volumes: 1 | ${BASE_OC44}`);
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

// =============================================================================
// INV-046 — NF 62566 (LARISSA, 2026-07-23): oc 41/56 NUNCA lança sem o texto
// do operador (camada backend fail-closed — front atropelado vira erro
// visível, não lançamento mudo). 3ª regressão da classe aprovação-às-cegas.
// =============================================================================

Deno.test("INV-046 ÂNCORA NF 62566: oc=56 sem texto_descricao → BLOQUEIA", () => {
  assertEquals(camposObrigatoriosAusentes(56, null), ["texto_descricao"]);
  assertEquals(camposObrigatoriosAusentes(56, {}), ["texto_descricao"]);
  assertEquals(camposObrigatoriosAusentes(56, { texto_descricao: "   " }), ["texto_descricao"]);
});

Deno.test("INV-046: oc=56/41 COM texto → libera; 41 sem texto → bloqueia", () => {
  assertEquals(camposObrigatoriosAusentes(56, { texto_descricao: "Rever volume na base X" }), []);
  assertEquals(camposObrigatoriosAusentes(41, { texto_descricao: "Cliente confirmou recebimento parcial" }), []);
  assertEquals(camposObrigatoriosAusentes(41, {}), ["texto_descricao"]);
});

Deno.test("INV-046: oc=44 preservada; demais ocs seguem liberadas sem extras", () => {
  assertEquals(camposObrigatoriosAusentes(44, { quantidade_volumes: 2 }), ["motivo"]);
  assertEquals(camposObrigatoriosAusentes(54, null), []);
  assertEquals(camposObrigatoriosAusentes(21, {}), []);
});
