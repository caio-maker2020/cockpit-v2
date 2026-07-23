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
