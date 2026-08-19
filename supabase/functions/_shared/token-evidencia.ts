// =============================================================================
// token-evidencia — FONTE ÚNICA da validade do link de evidência.
//
// Caio 2026-08-19 (NF 1107188 UNIAO QUIMICA): cliente clicou no link 9 dias
// após o envio e o token (7 dias, hardcoded em 3 functions) já tinha expirado
// — vira demanda de reenvio pra operadora. Decisão do Caio: 30 dias.
//
// A foto NÃO fica armazenada conosco (r-evidencia busca ao vivo no SSW via
// opção 101), então o prazo do token é a ÚNICA trava de longevidade do link.
// Pra mudar o prazo de novo: mude AQUI (e o texto em r-evidencia acompanha
// via VALIDADE_TOKEN_EVIDENCIA_DIAS). Guard: INV-085.
// =============================================================================

export const VALIDADE_TOKEN_EVIDENCIA_DIAS = 30;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** ISO da expiração de um token de evidência criado AGORA. */
export function novaExpiracaoTokenEvidencia(agoraMs: number = Date.now()): string {
  return new Date(agoraMs + VALIDADE_TOKEN_EVIDENCIA_DIAS * MS_POR_DIA).toISOString();
}
