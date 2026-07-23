// =============================================================================
// Contexto de INDENIZAÇÃO no histórico (Caio 2026-07-23, NF 1100040 LARISSA).
//
// A regra da separação 54/59 (13/07) mapeou "extravio parcial → 54 (tratativa)"
// SEM olhar a trilha: quando a esteira JÁ entrou em indenização (oc 59 lançada
// pedindo romaneio/descrição+valor, ou instrução cobrando ROMANEIO), destacar
// 54 manda a operadora pra porta errada — o certo é seguir cobrando os
// documentos com a 59. Caso âncora: 1100040 (59 às 14:30 "aguardando romaneio
// + descrição/valor" → 46 análise ressarcimento → 49 "AG DESCRICAO E VALOR")
// e o agente destacou 54+EXTRAVIO_PARCIAL.
//
// Sinais (conservadores, anti-falso-positivo):
//   1. FORTE: oc 59 existe no histórico (nós mesmos abrimos o trilho);
//   2. EXPLÍCITO: instrução da oc atual menciona ROMANEIO.
// "VALOR"/"DESCRIÇÃO" sozinhos NÃO contam (aparecem em instruções de
// tratativa comum — ex.: "extravio 2 volumes valor R$...").
// =============================================================================

export function temContextoIndenizacao(
  ocorrencias: ReadonlyArray<{ codigo: number | null }> | null | undefined,
  instrucaoOcAtual: string | null | undefined,
): boolean {
  if ((ocorrencias ?? []).some((o) => Number(o.codigo) === 59)) return true;
  return /ROMANEIO/i.test(instrucaoOcAtual ?? "");
}

// =============================================================================
// RELANÇAMENTO 59 SEM E-MAIL (Caio 2026-07-23, NF 1100040 — 2ª regra).
//
// Processo de indenização/perdas: lança oc 46 pra sinalizar que o processo
// começou e RELANÇA a 49 cobrando pendências — que às vezes JÁ FORAM pedidas
// ao cliente (o e-mail foi junto da 59 anterior). Detecção pelo formato do
// histórico: se a 59 foi lançada IMEDIATAMENTE antes da(s) 46 e da 49 atual
// (cadeia 49 ← [46...] ← 59, sem nada no meio), o cliente já foi cobrado →
// a sugestão certa é RELANÇAR 59 SEM e-mail (não duplicar cobrança).
// Âncora literal: 1100040 = 49(17:44) ← 46(17:42) ← 59(14:30).
// Qualquer outra oc no meio (ex.: 49 ← 20 ← 59) quebra a cadeia → não é
// recobrança do processo → segue o fluxo normal (59 + e-mail).
//
// PREMISSA DE ORDEM: `ocorrencias` vem MAIS RECENTE PRIMEIRO (formato do
// historico_ssw/portal). O caller não deve reordenar.
// =============================================================================

export function ehRelancamento59SemEmail(
  ocorrencias: ReadonlyArray<{ codigo: number | null }> | null | undefined,
): boolean {
  const ocs = ocorrencias ?? [];
  let i = 0;
  // pula a(s) 49 do topo (a atual — pode haver mais de uma re-lançada)
  while (i < ocs.length && Number(ocs[i]?.codigo) === 49) i++;
  if (i === 0) return false; // topo não é 49 → fora do formato
  // atravessa só 46 (sinalização do processo de indenização)
  while (i < ocs.length && Number(ocs[i]?.codigo) === 46) i++;
  // o próximo elo tem que ser a 59 (o pedido já feito ao cliente)
  return i < ocs.length && Number(ocs[i]?.codigo) === 59;
}
