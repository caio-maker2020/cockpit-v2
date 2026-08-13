// Placar da META da aba Aprendizado (Caio 2026-08-13).
//
// Era 30 dias corridos: janela longa demais — uma melhoria real levava semanas
// pra mexer o número e o card não respondia "melhorou?". Agora são 7 dias
// ÚTEIS fechados contra os 7 úteis ANTERIORES (a "última média"), respeitando
// o filtro de agente da aba.
//
// Convenções da janela (as mesmas do dia-a-dia e do performance7u):
//  • fim de semana fora (não há operação);
//  • HOJE fora — o dia ainda está aberto e puxaria o número pra baixo/cima
//    por metade de expediente.

export type LinhaMetricaDiaria = {
  dia: string; // YYYY-MM-DD
  agent_name: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
};

export type TotaisPlacar = {
  pares: number;
  seguidas: number;
  corrigidas: number;
  pct: number | null;
  /** % do período anterior de mesmo tamanho — a base de comparação. */
  pctAnterior: number | null;
  /** pct − pctAnterior (1 casa). null quando falta um dos lados. */
  delta: number | null;
};

export const JANELA_PLACAR_UTEIS = 7;

export function isFimDeSemana(diaIso: string): boolean {
  const dow = new Date(diaIso + "T12:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

/** Os N dias úteis fechados mais recentes (mais novo primeiro), a partir de `agora`. */
export function diasUteisFechados(n: number, agora: Date): string[] {
  const hoje = agora.toISOString().slice(0, 10);
  const out: string[] = [];
  for (let i = 1; out.length < n && i <= n * 3 + 10; i++) {
    const dia = new Date(agora.getTime() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (dia < hoje && !isFimDeSemana(dia)) out.push(dia);
  }
  return out;
}

const pctDe = (s: number, c: number): number | null =>
  s + c > 0 ? Math.round((1000 * s) / (s + c)) / 10 : null;

/**
 * Soma o placar da janela recente e calcula o delta contra a janela anterior.
 * `agente` = "todos" ou o `agent_name` exato (filtro da aba).
 */
export function totaisJanela(
  rows: LinhaMetricaDiaria[],
  agente: string | "todos" = "todos",
  agora: Date = new Date(),
  janelaUteis: number = JANELA_PLACAR_UTEIS,
): TotaisPlacar {
  const uteis = diasUteisFechados(janelaUteis * 2, agora);
  const recente = new Set(uteis.slice(0, janelaUteis));
  const anterior = new Set(uteis.slice(janelaUteis, janelaUteis * 2));

  let pares = 0, seguidas = 0, corrigidas = 0, segAnt = 0, corAnt = 0;
  for (const r of rows) {
    if (agente !== "todos" && r.agent_name !== agente) continue;
    if (recente.has(r.dia)) {
      pares += r.pares;
      seguidas += r.seguidas;
      corrigidas += r.corrigidas;
    } else if (anterior.has(r.dia)) {
      segAnt += r.seguidas;
      corAnt += r.corrigidas;
    }
  }

  const pct = pctDe(seguidas, corrigidas);
  const pctAnterior = pctDe(segAnt, corAnt);
  return {
    pares,
    seguidas,
    corrigidas,
    pct,
    pctAnterior,
    delta: pct !== null && pctAnterior !== null ? Math.round((pct - pctAnterior) * 10) / 10 : null,
  };
}
