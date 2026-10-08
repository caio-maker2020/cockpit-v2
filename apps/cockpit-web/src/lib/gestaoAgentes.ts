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
  /** só no drill de corrigidas: o que o operador fez no lugar. Desde 24/08
   *  cada linha é UMA troca exata (não mais a dominante) — o n da linha e o
   *  "ver casos" batem 1:1 (Caio: "quero só os casos daquela troca"). */
  oc_executada?: number | null;
  n: number;          // corrigidas DESTA troca (drill corrigidas) ou seguidas (drill seguidas)
  pares: number;      // seguidas+corrigidas da fatia agente×oc_card×oc_sugerida
  pctSeguidas: number | null;
  /** No drill de corrigidas: % dos pares da fatia que virou ESTA troca (n/pares).
   *  No de seguidas: (pares−seguidas)/pares. Sempre dos contadores,
   *  nunca por subtração de % arredondado (fix 21/08). */
  pctCorrigidas: number | null;
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

/** Drill CORRIGIDAS: uma linha por TROCA EXATA (oc_card × sugerida × executada),
 *  pior primeiro. Somar as linhas de uma fatia = total de corrigidas dela;
 *  o n de cada linha bate 1:1 com o "ver casos" (Caio 24/08). */
export function drillCorrigidas(
  placar: LinhaPlacarGestao[],
  diverg: LinhaDivergencia[],
): FatiaDrill[] {
  const base = paresPorFatia(placar);
  // por troca exata: n + exemplos
  const porTroca = new Map<string, { n: number; exemplos: string[] }>();
  for (const d of diverg) {
    const k = `${chaveFatia(d.agent_name, d.oc_card, d.oc_sugerida)}|${d.oc_executada}`;
    const cur = porTroca.get(k) ?? { n: 0, exemplos: [] };
    cur.n += d.n;
    if (cur.exemplos.length < 3) cur.exemplos.push(...(d.cards_exemplo ?? []));
    porTroca.set(k, cur);
  }
  return [...porTroca.entries()]
    .map(([k, v]) => {
      const [agent_name, occ, sug, exec] = k.split("|");
      const b = base.get(chaveFatia(agent_name!, occ === "sem" ? null : Number(occ), sug === "sem" ? null : Number(sug)));
      const pares = b?.pares ?? v.n;
      return {
        agent_name: agent_name!,
        oc_card: occ === "sem" ? null : Number(occ),
        oc_sugerida: sug === "sem" ? null : Number(sug),
        oc_executada: Number(exec),
        n: v.n,
        pares,
        pctSeguidas: b && b.pares > 0 ? Math.round((1000 * b.seguidas) / b.pares) / 10 : null,
        // % dos pares da fatia que virou ESTA troca — as linhas irmãs + seguidas fecham ~100
        pctCorrigidas: pares > 0 ? Math.round((1000 * v.n) / pares) / 10 : null,
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
        pctCorrigidas: v.pares > 0 ? Math.round((1000 * (v.pares - v.seguidas)) / v.pares) / 10 : null,
      };
    })
    .sort((a, b2) => (b2.pctSeguidas ?? 0) - (a.pctSeguidas ?? 0) || b2.pares - a.pares);
}

/** Régua de autonomia (mesma da mig 340/347): ≥95% e ≥50 pares. */
export function fatiaProntaPraAutonomia(f: FatiaDrill): boolean {
  return (f.pctSeguidas ?? 0) >= 95 && f.pares >= 50 && f.oc_sugerida != null;
}

// =============================================================================
// CATEGORIA "SUGERIU AGUARDAR" (Caio 2026-08-24, NF 1502332): quando o
// interpretador sugere a MESMA oc em que o card está (54/59), o significado é
// "manter aguardando o cliente", não "lançar de novo" — relançar 54 sobre 54 é
// retrabalho. Esses pares saem do % tradicional de seguidas/corrigidas (onde
// liam como "sugestão de lançamento contrariada") e viram categoria própria:
//   aguardou  = operador ignorou/aguardou (seguida-manter)
//   agiu      = operador lançou outra oc  (corrigida-manter)
// Medido 24/08: 100% dos pares sugerida=oc_card eram oc_card ∈ {54,59}.
// =============================================================================

export function ehParManterAguardar(
  ocSugerida: number | null | undefined,
  ocCard: number | null | undefined,
): boolean {
  return (
    ocSugerida != null && ocCard != null && ocSugerida === ocCard &&
    (ocCard === 54 || ocCard === 59)
  );
}

/** Separa (PURO) linhas do placar/divergências em principais × manter-aguardar. */
export function separarManterAguardar<T extends { oc_sugerida: number | null; oc_card?: number | null }>(
  linhas: T[],
): { principais: T[]; manter: T[] } {
  const principais: T[] = [];
  const manter: T[] = [];
  for (const l of linhas) {
    (ehParManterAguardar(l.oc_sugerida, l.oc_card ?? null) ? manter : principais).push(l);
  }
  return { principais, manter };
}

// =============================================================================
// TORRE DE AGENTES (Matheus 08/10): ranking de quem acerta mais/menos + a
// direção da evolução no período. Tudo derivado do placar (sem fonte nova).
// =============================================================================

export type FaixaConfianca = "firme" | "atencao" | "fraco" | "sem_dado";

/** Régua da torre: ≥ meta = firme · ≥80 = atenção · abaixo = fraco. */
export function faixaConfianca(pct: number | null, meta = 95): FaixaConfianca {
  if (pct == null) return "sem_dado";
  if (pct >= meta) return "firme";
  if (pct >= 80) return "atencao";
  return "fraco";
}

export interface LinhaRanking extends TotaisPlacar {
  agent_name: string;
  posicao: number;
  /** % da 1ª metade vs 2ª metade do período (pontos). null sem pares nas duas. */
  delta: number | null;
  pctAntes: number | null;
  pctDepois: number | null;
  serie: Array<{ dia: string; pct: number | null; pares: number }>;
  faixa: FaixaConfianca;
  /** as duas metades comparadas no delta (datas BRT YYYY-MM-DD) */
  janelaAntes: { de: string; ate: string } | null;
  janelaDepois: { de: string; ate: string } | null;
}

/** Ranking: melhor % primeiro; agente com < minPares vai pro fim (amostra fraca). */
export function rankingAgentes(linhas: LinhaPlacarGestao[], minPares = 10, meta = 95): LinhaRanking[] {
  const dias = [...new Set(linhas.map((l) => l.dia))].sort();
  const corte = dias[Math.floor(dias.length / 2)] ?? "";
  const idx = dias.indexOf(corte);
  const janelaAntes = idx > 0 ? { de: dias[0]!, ate: dias[idx - 1]! } : null;
  const janelaDepois = idx >= 0 && dias.length ? { de: corte, ate: dias[dias.length - 1]! } : null;
  const grupos = new Map<string, LinhaPlacarGestao[]>();
  for (const l of linhas) grupos.set(l.agent_name, [...(grupos.get(l.agent_name) ?? []), l]);
  const base = [...grupos.entries()].map(([agent_name, ls]) => {
    const tot = somarPlacar(ls);
    const antes = somarPlacar(ls.filter((l) => l.dia < corte)).pctAcerto;
    const depois = somarPlacar(ls.filter((l) => l.dia >= corte)).pctAcerto;
    return {
      agent_name,
      ...tot,
      pctAntes: antes,
      pctDepois: depois,
      delta: antes != null && depois != null ? Math.round((depois - antes) * 10) / 10 : null,
      serie: seriePorDia(ls),
      faixa: faixaConfianca(tot.pctAcerto, meta),
      janelaAntes,
      janelaDepois,
    };
  });
  return base
    .sort((a, b) => {
      const fa = a.pares >= minPares ? 1 : 0;
      const fb = b.pares >= minPares ? 1 : 0;
      return fb - fa || (b.pctAcerto ?? -1) - (a.pctAcerto ?? -1) || b.pares - a.pares;
    })
    .map((r, i) => ({ ...r, posicao: i + 1 }));
}

/** Segunda-feira (BRT) da semana do dia YYYY-MM-DD. */
export function inicioSemana(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // seg=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export interface PontoSemana { semana: string; pares: number; seguidas: number; pct: number | null }

/** % por semana (seg→dom) por agente — somando contadores. Chave "__todos" = global. */
export function seriePorSemana(linhas: LinhaPlacarGestao[]): Map<string, PontoSemana[]> {
  const acc = new Map<string, Map<string, { pares: number; seguidas: number }>>();
  const somar = (ag: string, sem: string, l: LinhaPlacarGestao) => {
    const m = acc.get(ag) ?? new Map();
    const c = m.get(sem) ?? { pares: 0, seguidas: 0 };
    c.pares += l.pares; c.seguidas += l.seguidas;
    m.set(sem, c); acc.set(ag, m);
  };
  for (const l of linhas) {
    const sem = inicioSemana(l.dia);
    somar(l.agent_name, sem, l);
    somar("__todos", sem, l);
  }
  const out = new Map<string, PontoSemana[]>();
  for (const [ag, m] of acc) {
    out.set(ag, [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([semana, v]) => ({
      semana, ...v, pct: v.pares > 0 ? Math.round((1000 * v.seguidas) / v.pares) / 10 : null,
    })));
  }
  return out;
}

// =============================================================================
// PONTOS (Matheus 08/10): quanto cada troca custa em pontos de acerto.
// Se as n corrigidas desta troca tivessem sido seguidas, o % do agente subiria
// n/pares_do_agente × 100 pts (e o global, n/pares_total × 100). É a régua pra
// decidir o que treinar primeiro: maior ganho de pts com UMA regra.
// =============================================================================

export interface TrocaComPontos {
  agent_name: string;
  oc_card: number | null;
  oc_sugerida: number | null;
  oc_executada: number;
  n: number;
  ptsAgente: number;
  ptsGlobal: number;
  /** % do agente se esta troca virasse seguida */
  pctAgenteSeResolver: number | null;
}

export function pontosPorTroca(placar: LinhaPlacarGestao[], diverg: LinhaDivergencia[]): TrocaComPontos[] {
  const porAg = new Map<string, { seguidas: number; pares: number }>();
  let paresTotal = 0;
  for (const l of placar) {
    const c = porAg.get(l.agent_name) ?? { seguidas: 0, pares: 0 };
    c.seguidas += l.seguidas; c.pares += l.pares; paresTotal += l.pares;
    porAg.set(l.agent_name, c);
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return drillCorrigidas(placar, diverg)
    .map((f) => {
      const ag = porAg.get(f.agent_name);
      const pa = ag?.pares ?? 0;
      return {
        agent_name: f.agent_name,
        oc_card: f.oc_card,
        oc_sugerida: f.oc_sugerida,
        oc_executada: f.oc_executada ?? 0,
        n: f.n,
        ptsAgente: pa > 0 ? r1((100 * f.n) / pa) : 0,
        ptsGlobal: paresTotal > 0 ? r1((100 * f.n) / paresTotal) : 0,
        pctAgenteSeResolver: ag && pa > 0 ? r1((100 * Math.min(pa, ag.seguidas + f.n)) / pa) : null,
      };
    })
    .sort((a, b) => b.ptsGlobal - a.ptsGlobal || b.n - a.n);
}

/** Quantas das maiores trocas (em ordem) bastam pra levar o global à meta. null = nem todas bastam. */
export function trocasAteAMeta(trocas: TrocaComPontos[], pctAtual: number | null, meta = 95): number | null {
  if (pctAtual == null) return null;
  if (pctAtual >= meta) return 0;
  let acc = pctAtual;
  for (let i = 0; i < trocas.length; i++) {
    acc += trocas[i]!.ptsGlobal;
    if (acc >= meta) return i + 1;
  }
  return null;
}

// =============================================================================
// CICLO DE APRENDIZADO (learning_log, mig 197/299 · ADR 0024): em que etapa
// cada melhoria está. Etapas na ordem do loop.
// =============================================================================

export interface ItemLearningLog {
  id: string;
  tipo: string;
  status: string;
  agente_alvo: string | null;
  titulo: string | null;
  resumo: string | null;
  created_at: string;
  detalhes: { mergeado_em?: string | null } | null;
}

export type EtapaCiclo = "padrao" | "pergunta" | "sugerida" | "aprovada" | "no_ar" | "recusada";

export function etapaDoItem(i: ItemLearningLog): EtapaCiclo | null {
  if (i.detalhes?.mergeado_em || i.tipo === "ajuste_aplicado" || i.status === "aplicado") return "no_ar";
  if (i.status === "rejeitado" || i.tipo === "ajuste_rejeitado" || i.status === "revertido") return "recusada";
  if (i.status === "aprovado" || i.tipo === "ajuste_aprovado") return "aprovada";
  if (i.tipo === "ajuste_sugerido") return "sugerida";
  if (i.tipo === "pergunta") return "pergunta";
  if (i.tipo === "padrao_identificado") return "padrao";
  return null;
}

export function contarCiclo(itens: ItemLearningLog[]): Record<EtapaCiclo, number> {
  const c: Record<EtapaCiclo, number> = { padrao: 0, pergunta: 0, sugerida: 0, aprovada: 0, no_ar: 0, recusada: 0 };
  for (const i of itens) {
    const e = etapaDoItem(i);
    if (e) c[e]++;
  }
  return c;
}
