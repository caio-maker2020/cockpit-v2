// =============================================================================
// Gestão Agentes — agregação PURA das views da Fase 1 (mig 344).
// Regra de ouro: % é sempre seguidas/pares somados no período (nunca média de
// médias diárias). Testes em gestaoAgentes.test.ts.
// =============================================================================

export interface LinhaPlacarGestao {
  dia: string; // YYYY-MM-DD (BRT)
  agent_name: string;
  oc_sugerida: number | null;
  oc_card?: number | null;
  modo: string | null;
  operador_id: string | null;
  operador_nome: string | null;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  pares: number;
}

export interface LinhaDivergencia {
  dia: string;
  agent_name: string;
  oc_sugerida: number;
  oc_executada: number;
  oc_card?: number | null;
  operador_id: string | null;
  operador_nome: string | null;
  n: number;
  ultimo_em: string;
  cards_exemplo: string[] | null;
}

export interface FiltroGestao {
  agente?: string | null;
  operadorId?: string | null;
}

export function filtrarPlacar<T extends { agent_name: string; operador_id: string | null }>(
  linhas: T[],
  f: FiltroGestao,
): T[] {
  return linhas.filter(
    (l) =>
      (!f.agente || l.agent_name === f.agente) &&
      (!f.operadorId || l.operador_id === f.operadorId),
  );
}

export interface TotaisPlacar {
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  pares: number;
  /** null quando não há pares (sem dado ≠ 0%). */
  pctAcerto: number | null;
}

export function somarPlacar(linhas: LinhaPlacarGestao[]): TotaisPlacar {
  const t = linhas.reduce(
    (acc, l) => ({
      seguidas: acc.seguidas + l.seguidas,
      corrigidas: acc.corrigidas + l.corrigidas,
      abstencoes: acc.abstencoes + l.abstencoes,
      pares: acc.pares + l.pares,
    }),
    { seguidas: 0, corrigidas: 0, abstencoes: 0, pares: 0 },
  );
  return { ...t, pctAcerto: t.pares > 0 ? Math.round((1000 * t.seguidas) / t.pares) / 10 : null };
}

/** Série diária pro gráfico (dias sem dado ficam de fora — o gráfico interpola). */
export function seriePorDia(linhas: LinhaPlacarGestao[]): Array<{ dia: string; pct: number | null; pares: number }> {
  const porDia = new Map<string, { seguidas: number; pares: number }>();
  for (const l of linhas) {
    const cur = porDia.get(l.dia) ?? { seguidas: 0, pares: 0 };
    cur.seguidas += l.seguidas;
    cur.pares += l.pares;
    porDia.set(l.dia, cur);
  }
  return [...porDia.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dia, v]) => ({ dia, pct: v.pares > 0 ? Math.round((1000 * v.seguidas) / v.pares) / 10 : null, pares: v.pares }));
}

/** Placar por agente (D1 detalhe) — ordenado por volume. */
export function porAgente(linhas: LinhaPlacarGestao[]): Array<{ agent_name: string } & TotaisPlacar> {
  const grupos = new Map<string, LinhaPlacarGestao[]>();
  for (const l of linhas) {
    grupos.set(l.agent_name, [...(grupos.get(l.agent_name) ?? []), l]);
  }
  return [...grupos.entries()]
    .map(([agent_name, ls]) => ({ agent_name, ...somarPlacar(ls) }))
    .sort((a, b) => b.pares - a.pares);
}

/** Placar por fatia agente+oc (D4). */
export function porFatia(linhas: LinhaPlacarGestao[]): Array<{ agent_name: string; oc_sugerida: number | null } & TotaisPlacar> {
  const grupos = new Map<string, LinhaPlacarGestao[]>();
  for (const l of linhas) {
    const k = `${l.agent_name}|${l.oc_sugerida ?? "sem"}`;
    grupos.set(k, [...(grupos.get(k) ?? []), l]);
  }
  return [...grupos.entries()]
    .map(([, ls]) => ({ agent_name: ls[0]!.agent_name, oc_sugerida: ls[0]!.oc_sugerida, ...somarPlacar(ls) }))
    .sort((a, b) => b.pares - a.pares);
}

/** Matriz de divergência (D2): sugerida→executada agregada, pior primeiro. */
export function matrizDivergencia(
  linhas: LinhaDivergencia[],
): Array<{ agent_name: string; oc_sugerida: number; oc_executada: number; n: number; ultimo_em: string; cards_exemplo: string[] }> {
  const grupos = new Map<string, { agent_name: string; oc_sugerida: number; oc_executada: number; n: number; ultimo_em: string; cards_exemplo: string[] }>();
  for (const l of linhas) {
    const k = `${l.agent_name}|${l.oc_sugerida}|${l.oc_executada}`;
    const cur = grupos.get(k);
    if (!cur) {
      grupos.set(k, {
        agent_name: l.agent_name,
        oc_sugerida: l.oc_sugerida,
        oc_executada: l.oc_executada,
        n: l.n,
        ultimo_em: l.ultimo_em,
        cards_exemplo: l.cards_exemplo ?? [],
      });
    } else {
      cur.n += l.n;
      if (l.ultimo_em > cur.ultimo_em) cur.ultimo_em = l.ultimo_em;
      if (cur.cards_exemplo.length < 3) cur.cards_exemplo.push(...(l.cards_exemplo ?? []));
    }
  }
  return [...grupos.values()].sort((a, b) => b.n - a.n);
}

/** Data BRT (YYYY-MM-DD) de N dias atrás — pro filtro de período. */
export function diaBrtAtras(dias: number, agora: Date = new Date()): string {
  const brtMs = agora.getTime() - 3 * 60 * 60 * 1000;
  const d = new Date(brtMs - dias * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}


// =============================================================================
// DRILL por fatia (Caio 21/08 v2): "oc geradora → sugestão → o que o operador
// fez", agrupado por agente. Substitui o módulo "Onde está a confusão".
// =============================================================================

export interface FatiaDrill {
  agent_name: string;
  oc_card: number | null;
  oc_sugerida: number | null;
  /** só no drill de corrigidas: o que o operador fez no lugar (top 1). */
  oc_executada?: number | null;
  n: number;          // corrigidas (drill corrigidas) ou seguidas (drill seguidas)
  pares: number;      // seguidas+corrigidas da fatia agente×oc_card×oc_sugerida
  pctSeguidas: number | null;
  cards_exemplo?: string[];
}

const chaveFatia = (a: string, occ: number | null | undefined, sug: number | null) =>
  `${a}|${occ ?? "sem"}|${sug ?? "sem"}`;

/** Pares/seguidas por fatia agente×oc_card×oc_sugerida (base dos 2 drills). */
function paresPorFatia(placar: LinhaPlacarGestao[]): Map<string, { seguidas: number; pares: number }> {
  const m = new Map<string, { seguidas: number; pares: number }>();
  for (const l of placar) {
    const k = chaveFatia(l.agent_name, l.oc_card, l.oc_sugerida);
    const cur = m.get(k) ?? { seguidas: 0, pares: 0 };
    cur.seguidas += l.seguidas;
    cur.pares += l.pares;
    m.set(k, cur);
  }
  return m;
}

/** Drill CORRIGIDAS: pior fatia primeiro, com a troca dominante do operador. */
export function drillCorrigidas(
  placar: LinhaPlacarGestao[],
  diverg: LinhaDivergencia[],
): FatiaDrill[] {
  const base = paresPorFatia(placar);
  // por fatia: total corrigidas + execução dominante
  const porFatia = new Map<string, { n: number; exec: Map<number, number>; exemplos: string[] }>();
  for (const d of diverg) {
    const k = chaveFatia(d.agent_name, d.oc_card, d.oc_sugerida);
    const cur = porFatia.get(k) ?? { n: 0, exec: new Map(), exemplos: [] };
    cur.n += d.n;
    cur.exec.set(d.oc_executada, (cur.exec.get(d.oc_executada) ?? 0) + d.n);
    if (cur.exemplos.length < 3) cur.exemplos.push(...(d.cards_exemplo ?? []));
    porFatia.set(k, cur);
  }
  return [...porFatia.entries()]
    .map(([k, v]) => {
      const [agent_name, occ, sug] = k.split("|");
      const b = base.get(k);
      const topExec = [...v.exec.entries()].sort((a, b2) => b2[1] - a[1])[0];
      return {
        agent_name,
        oc_card: occ === "sem" ? null : Number(occ),
        oc_sugerida: sug === "sem" ? null : Number(sug),
        oc_executada: topExec ? topExec[0] : null,
        n: v.n,
        pares: b?.pares ?? v.n,
        pctSeguidas: b && b.pares > 0 ? Math.round((1000 * b.seguidas) / b.pares) / 10 : null,
        cards_exemplo: v.exemplos.slice(0, 3),
      };
    })
    .sort((a, b2) => b2.n - a.n);
}

/** Drill SEGUIDAS: melhor fatia primeiro — candidatas a autônomo no topo. */
export function drillSeguidas(placar: LinhaPlacarGestao[]): FatiaDrill[] {
  const base = paresPorFatia(placar);
  return [...base.entries()]
    .filter(([, v]) => v.seguidas > 0)
    .map(([k, v]) => {
      const [agent_name, occ, sug] = k.split("|");
      return {
        agent_name,
        oc_card: occ === "sem" ? null : Number(occ),
        oc_sugerida: sug === "sem" ? null : Number(sug),
        n: v.seguidas,
        pares: v.pares,
        pctSeguidas: v.pares > 0 ? Math.round((1000 * v.seguidas) / v.pares) / 10 : null,
      };
    })
    .sort((a, b2) => (b2.pctSeguidas ?? 0) - (a.pctSeguidas ?? 0) || b2.pares - a.pares);
}

/** Régua de autonomia (mesma da mig 340/347): ≥95% e ≥50 pares. */
export function fatiaProntaPraAutonomia(f: FatiaDrill): boolean {
  return (f.pctSeguidas ?? 0) >= 95 && f.pares >= 50 && f.oc_sugerida != null;
}
