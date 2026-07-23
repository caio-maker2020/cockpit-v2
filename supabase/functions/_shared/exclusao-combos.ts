// =============================================================================
// exclusao-combos — resolução determinística da exclusão mútua entre os 3 combos
// de indenização que o interpretador-resposta-cliente pode sugerir:
//
//   - combo 33+44  = devolução + romaneio JÁ ANEXADO (inicia ressarcimento via 33).
//   - oc 33 solo   = extravio TOTAL (não há volume pra devolver).
//   - combo 44+59  = extravio PARCIAL + devolução autorizada + romaneio AINDA não
//                    veio (devolve 44 + abre 59 + e-mail PEDE romaneio/descrição/valor).
//
// Os três são mutuamente exclusivos. Esta função é a AUTORIDADE determinística
// (independe de o prompt do LLM acertar). Regra crítica: se o romaneio JÁ veio na
// resposta, NUNCA é 44+59 (é 33+44) — protege a âncora do 33+44 (NF 66193).
//
// Função PURA, testada em exclusao-combos.test.ts (convenção nº 8). Caio 2026-07-15.
// =============================================================================

export interface CombosBrutos {
  sugere_combo_33_44: boolean;
  sugere_oc33_solo: boolean;
  sugere_combo_44_59: boolean;
  /** Romaneio veio nesta resposta do cliente (evidencias_recebidas.romaneio presente)? */
  romaneio_veio: boolean;
}

export interface CombosResolvidos {
  combo3344: boolean;
  oc33Solo: boolean;
  combo4459: boolean;
}

export function resolverExclusaoCombos(i: CombosBrutos): CombosResolvidos {
  let combo3344 = i.sugere_combo_33_44 === true;
  let oc33Solo = i.sugere_oc33_solo === true;
  let combo4459 = i.sugere_combo_44_59 === true;

  // 1. combo 33+44 x oc33_solo: solo (extravio total) é mais conservador — vence.
  if (combo3344 && oc33Solo) combo3344 = false;

  // 2. Guard semântico: 44+59 é o caso SEM romaneio. Se o romaneio JÁ veio, não é 44+59.
  if (combo4459 && i.romaneio_veio) combo4459 = false;

  // 3. 44+59 x oc33_solo: total não tem devolução → solo vence.
  if (combo4459 && oc33Solo) combo4459 = false;

  // 4. 44+59 x 33+44: contextos opostos (romaneio ausente x presente); nunca coexistem.
  //    Chegando aqui, 44+59 só sobrevive se o romaneio NÃO veio (passo 2) — então ele é
  //    o contexto correto e prevalece sobre um 33+44 marcado por engano.
  if (combo4459 && combo3344) combo3344 = false;

  return { combo3344, oc33Solo, combo4459 };
}
