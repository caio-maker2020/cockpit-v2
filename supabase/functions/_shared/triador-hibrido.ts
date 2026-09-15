// =============================================================================
// triador-hibrido — Haiku porteiro + Sonnet juiz (Caio 15/09: "vamos fazer
// hibrido + tranca do aceite").
//
// Desenho (decisão do Caio após a sombra de 454 pares, 14-15/09):
//   1. Haiku 4.5 classifica TODA mensagem (0,68c/chamada vs 2,08c do Sonnet).
//   2. Se o Haiku rotular 'reentrega' — o ÚNICO rótulo que arma sugestão de
//      ação (proposta "Lançar 21" no vinculador) — o Sonnet re-classifica e a
//      palavra final (tipo + cliente_autorizou_reentrega) é DELE. O aceite do
//      cliente nunca é lido só pelo Haiku.
//   3. Tranca do aceite (no vinculador): a proposta de 21 só arma com
//      cliente_autorizou_reentrega === true (interpretação do LLM sobre o
//      e-mail — "pode seguir", "autorizado", "favor reentregar"...). Sem
//      aceite lido → nada arma + evento SugestaoReentregaSuprimidaSemAceite.
//
// Ponto cego aceito pelo Caio: ~2,4% (11/454 na sombra) em que o Sonnet diria
// 'reentrega' e o Haiku não — sugestão a MENOS (nunca ação a mais); o fluxo
// de card (interpretador R1-R6) segue sugerindo 21 normalmente.
// Flag OFF → comportamento antigo (Sonnet em tudo). Rollback sem deploy.
// Economia projetada no volume de 15/09 (341 msgs): ~US$ 3,15/dia útil.
// =============================================================================

export const TRIADOR_HIBRIDO_FLAG = "triador_hibrido_haiku_enabled" as const;
export const TRIADOR_HIBRIDO_MODEL_TRIAGEM = "claude-haiku-4-5" as const;

/** O rótulo do Haiku exige arbitragem do Sonnet? (só o que arma ação) */
export function precisaArbitroSonnet(tipoHaiku: string | null | undefined): boolean {
  return tipoHaiku === "reentrega";
}
