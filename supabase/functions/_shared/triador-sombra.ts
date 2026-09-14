// =============================================================================
// triador-sombra — Haiku 4.5 × Sonnet 4.6 no triador (Caio 15/09, 1 dia).
//
// Contexto: o triador roda Sonnet violando a convenção nº 7 do CLAUDE.md
// ("Haiku pra triagem/classificação") e é a maior fatia da conta (~US$ 5,8/dia
// útil). Antes de trocar, SOMBRA de 1 dia: o Haiku lê o MESMO e-mail com o
// MESMO prompt e os MESMOS pós-processos (filtro anti-alucinação + regex
// fallback), a decisão real segue 100% Sonnet, e cada par vai pra
// triador_sombra_haiku pro veredito no fim do dia.
//
// Critério combinado com o Caio: concordância ≥95% no tipo e ≥98% nas NFs →
// troca; abaixo → mantém Sonnet e revisamos as divergências caso a caso.
// =============================================================================

export const TRIADOR_SOMBRA_MODEL = "claude-haiku-4-5" as const;
export const TRIADOR_SOMBRA_FLAG = "triador_sombra_haiku_enabled" as const;

export interface TriagemComparavel {
  tipo: string;
  risco: string;
  nfs: readonly string[];
  ctrcs: readonly string[];
}

export interface DiffTriagem {
  diverge_tipo: boolean;
  diverge_risco: boolean;
  diverge_nfs: boolean;
  diverge_ctrcs: boolean;
  diverge: boolean;
}

function setIgual(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map((x) => x.trim()));
  const sb = new Set(b.map((x) => x.trim()));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** PURA: compara a triagem do Sonnet (real) com a do Haiku (sombra).
 *  NFs/CTRCs como CONJUNTO (ordem não importa). */
export function compararTriagem(sonnet: TriagemComparavel, haiku: TriagemComparavel): DiffTriagem {
  const d = {
    diverge_tipo: sonnet.tipo !== haiku.tipo,
    diverge_risco: sonnet.risco !== haiku.risco,
    diverge_nfs: !setIgual(sonnet.nfs, haiku.nfs),
    diverge_ctrcs: !setIgual(sonnet.ctrcs, haiku.ctrcs),
  };
  return { ...d, diverge: d.diverge_tipo || d.diverge_risco || d.diverge_nfs || d.diverge_ctrcs };
}
