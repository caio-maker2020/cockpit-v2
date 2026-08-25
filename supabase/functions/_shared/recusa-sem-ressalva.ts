// =============================================================================
// recusa-sem-ressalva (Caio 2026-08-25, NF 234381): quando a oc 49 traz a
// informação de que o DESTINATÁRIO RECUSOU SEM REGISTRAR RESSALVA, o e-mail ao
// pagador deve dizer exatamente isso — nunca o texto genérico de "recusa
// total" (o agente confundia e a operadora tinha que voltar pra 56).
// Regra do Caio: etapa 1 (oc 10 sem detalhe) → 56 apurar; etapa 2 (49 com a
// info da ressalva) → 54 + e-mail com o template específico.
// =============================================================================

export const TEMPLATE_RECUSA_SEM_RESSALVA = "RECUSA_SEM_RESSALVA";

/** PURO: a instrução da 49 diz que o destinatário recusou sem ressalvar? */
export function ehRecusaSemRessalva(instrucao: string | null | undefined): boolean {
  if (!instrucao) return false;
  return /sem\s+ressalva|n[aã]o\s+(fez|registrou|quis\s+fazer)\s+(a\s+)?ressalva|recus(ou|a)[^.]*ressalv|n[ãa]o\s+quis\s+ressalvar/i
    .test(instrucao);
}
