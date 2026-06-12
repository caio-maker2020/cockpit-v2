// =============================================================================
// validar-chave-cte-card — guard obrigatório ANTES de chamar SSW pra lançar oc.
//
// Regra crítica Caio 2026-05-28 (NF 142371 oc=54 falhou "DOCUMENTO BAIXADO OU
// ENTREGUE" porque executor lançou no CTRC OVD399372-8 cancelado em vez do
// OVD396328-4 registrado no card):
//
//   "O CTRC correto é SEMPRE o que está registrado no card da tratativa.
//    Qualquer outro CTRC encontrado via busca por NF deve ser ignorado."
//
// Este helper valida que a `chaveCTe` que está prestes a ser enviada ao SSW
// corresponde ao `card.ctrc`. Se não corresponder, retorna `ok:false` e o
// caller DEVE abortar o lançamento (reverter_acao_falhou + card_event +
// erros_lancamento_ssw). NUNCA chama SSW com chave que falhou o guard.
//
// Fluxo de validação (em nf_chave_cte):
//   1. Procura a row WHERE chave_cte = chaveCTe.
//   2. Confirma que `nfc.ctrc` (normalizado) bate com `ctrcCard` (normalizado).
//   3. Confirma que `tipo_documento` NÃO está em ('CANCELADO',
//      'SUBSTITUTO_CANCELADO').
//
// Se card.ctrc for null (RPA Bastão não populou), o guard é "fail-open" só
// pra ocs raras onde o CTRC genuinamente não existe — mas registra warning.
// Caio prefere lançar do que travar nesses casos. Pra ocs do dia-a-dia
// (Bastão sempre traz ctrc) o guard é estrito.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export type ValidacaoChaveCteResult =
  | { ok: true; motivo: "match_exato" | "card_sem_ctrc_fail_open" }
  | {
      ok: false;
      motivo:
        | "chave_nao_encontrada_em_nf_chave_cte"
        | "ctrc_diverge_do_card"
        | "tipo_documento_cancelado";
      detalhe: string;
      ctrc_card: string | null;
      ctrc_encontrado_na_chave: string | null;
      tipo_documento: string | null;
    };

function normalizarCtrc(s: string | null | undefined): string | null {
  if (!s) return null;
  const trim = s.trim().toUpperCase();
  return trim.length === 0 ? null : trim;
}

/**
 * Valida que a chave CT-e prestes a ser enviada ao SSW corresponde ao CTRC
 * registrado no card. Se NÃO corresponde, retorna ok:false e o caller DEVE
 * abortar antes de chamar SSW.
 *
 * @param chaveCTe   chave fiscal de 44 dígitos que vai pra `cte.chaveCTe`
 * @param ctrcCard   `card.ctrc` (CTRC registrado no card — fonte canônica)
 * @param nf         NF do card (pra log)
 */
export async function validarChaveCteCorrespondeCtrcDoCard(
  supabase: SupabaseClient,
  chaveCTe: string,
  ctrcCard: string | null | undefined,
  nf: string | null | undefined,
): Promise<ValidacaoChaveCteResult> {
  const ctrcCardNorm = normalizarCtrc(ctrcCard ?? null);

  const { data, error } = await supabase
    .from("nf_chave_cte")
    .select("ctrc, tipo_documento, cnpj_pagador")
    .eq("chave_cte", chaveCTe)
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      motivo: "chave_nao_encontrada_em_nf_chave_cte",
      detalhe: `SELECT nf_chave_cte falhou: ${error.message}`,
      ctrc_card: ctrcCardNorm,
      ctrc_encontrado_na_chave: null,
      tipo_documento: null,
    };
  }

  if (!data) {
    return {
      ok: false,
      motivo: "chave_nao_encontrada_em_nf_chave_cte",
      detalhe:
        `chave_cte ...${chaveCTe.slice(-12)} não está em nf_chave_cte. ` +
        `Nunca enviar pro SSW sem validação. nf=${nf ?? "?"}`,
      ctrc_card: ctrcCardNorm,
      ctrc_encontrado_na_chave: null,
      tipo_documento: null,
    };
  }

  const ctrcEncontrado = normalizarCtrc(
    (data as { ctrc?: string | null }).ctrc ?? null,
  );
  const tipo = ((data as { tipo_documento?: string | null }).tipo_documento ?? null);
  const tipoUpper = tipo ? tipo.trim().toUpperCase() : null;

  if (tipoUpper === "CANCELADO" || tipoUpper === "SUBSTITUTO_CANCELADO") {
    return {
      ok: false,
      motivo: "tipo_documento_cancelado",
      detalhe:
        `chave_cte ...${chaveCTe.slice(-12)} (CTRC ${ctrcEncontrado ?? "?"}) ` +
        `tem tipo_documento=${tipo}. SSW recusaria com "DOCUMENTO BAIXADO/CANCELADO".`,
      ctrc_card: ctrcCardNorm,
      ctrc_encontrado_na_chave: ctrcEncontrado,
      tipo_documento: tipo,
    };
  }

  // Card sem CTRC populado: fail-open. RPA Bastão raramente deixa em branco;
  // quando deixa, é melhor lançar que travar (Caio 2026-05-28).
  if (!ctrcCardNorm) {
    return { ok: true, motivo: "card_sem_ctrc_fail_open" };
  }

  if (ctrcEncontrado !== ctrcCardNorm) {
    return {
      ok: false,
      motivo: "ctrc_diverge_do_card",
      detalhe:
        `card.ctrc=${ctrcCardNorm} mas chave_cte ...${chaveCTe.slice(-12)} ` +
        `pertence ao CTRC ${ctrcEncontrado ?? "?"}. ` +
        `Lançar nesse CTRC viola regra crítica (CLAUDE.md). nf=${nf ?? "?"}`,
      ctrc_card: ctrcCardNorm,
      ctrc_encontrado_na_chave: ctrcEncontrado,
      tipo_documento: tipo,
    };
  }

  return { ok: true, motivo: "match_exato" };
}
