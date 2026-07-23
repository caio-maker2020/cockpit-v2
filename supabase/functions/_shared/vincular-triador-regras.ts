// =============================================================================
// vincular-triador-regras.ts — F5: regras PURAS do casador triador→card.
//
// O triador classifica a mensagem ANTES do card existir, então agent_runs
// fica com card_id NULL (5.3k runs órfãos — auditoria 2026-07-17). Este
// módulo decide, pra cada run, qual card corresponde: primeiro NF extraída
// que tenha card criado numa janela em torno da classificação (o vinculador
// cria/anexa o card segundos depois; a folga pra trás cobre anexação a card
// pré-existente).
//
// Zero toque no fluxo de ingestão — roda em lote, de fora (cron).
// Rodar testes: deno test supabase/functions/_shared/vincular-triador-regras.test.ts
// =============================================================================

export interface CardCandidato {
  id: string;
  created_at: string;
}

const ANTES_MS = 6 * 60 * 60 * 1000; // card já existia (mensagem anexada)
const DEPOIS_MS = 6 * 60 * 60 * 1000; // card criado após a classificação

export function nfsDoOutputTriador(output: unknown): string[] {
  const nfs = (output as { nfs?: unknown } | null)?.nfs;
  if (!Array.isArray(nfs)) return [];
  return nfs
    .map((n) => String(n).trim())
    .filter((n) => /^\d{3,}$/.test(n));
}

/**
 * Escolhe o card do run: entre os candidatos das NFs extraídas, o de
 * created_at mais PRÓXIMO do started_at dentro da janela [-6h, +6h].
 */
export function escolherCardParaRun(
  nfs: string[],
  candidatosPorNf: Map<string, CardCandidato[]>,
  startedAt: string,
): string | null {
  const t0 = new Date(startedAt).getTime();
  let melhor: { id: string; dist: number } | null = null;
  for (const nf of nfs) {
    for (const c of candidatosPorNf.get(nf) ?? []) {
      const t = new Date(c.created_at).getTime();
      const delta = t - t0;
      if (delta < -ANTES_MS || delta > DEPOIS_MS) continue;
      const dist = Math.abs(delta);
      if (!melhor || dist < melhor.dist) melhor = { id: c.id, dist };
    }
  }
  return melhor?.id ?? null;
}
