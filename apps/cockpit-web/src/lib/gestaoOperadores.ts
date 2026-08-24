// =============================================================================
// Gestão Operadores — agregação PURA sobre v_operador_tratativas /
// v_operador_fila_agora (mig 344). Testes em gestaoOperadores.test.ts.
// Regra da casa: horas ÚTEIS (08h–17h30 BRT) — quem entrou às 19h não é
// penalizado pela noite. ≤2h úteis = tratado rápido.
// =============================================================================

export interface LinhaTratativa {
  card_id: string;
  nf: string | null;
  cnpj_pagador: string | null;
  empresa_cliente: string | null;
  operador_id: string;
  dia: string;
  coluna: "aguardando_voce" | "cliente_respondeu";
  entrada_em: string;
  tratado_em: string;
  horas_brutas: number;
  horas_uteis: number;
  foi_aprovacao: boolean;
  oc_entrada?: number | null;
}

export interface LinhaFilaAgora {
  card_id: string;
  nf: string | null;
  cnpj_pagador: string | null;
  empresa_cliente: string | null;
  operador_id: string | null;
  responsavel_relacionamento: string | null;
  coluna: "aguardando_voce" | "cliente_respondeu";
  na_fila_desde: string;
  horas_brutas: number;
  horas_uteis: number;
  parado_mais_1d_util: boolean;
}

export interface ResumoOperador {
  operadorId: string;
  tratadas: number;
  ate2hPct: number | null;
  horasUteisMedia: number | null;
  paradas1d: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function resumoPorOperador(
  tratativas: LinhaTratativa[],
  filaAgora: LinhaFilaAgora[],
): ResumoOperador[] {
  const grupos = new Map<string, LinhaTratativa[]>();
  for (const t of tratativas) grupos.set(t.operador_id, [...(grupos.get(t.operador_id) ?? []), t]);
  const paradasPor = new Map<string, number>();
  for (const f of filaAgora) {
    if (f.parado_mais_1d_util && f.operador_id) {
      paradasPor.set(f.operador_id, (paradasPor.get(f.operador_id) ?? 0) + 1);
    }
  }
  const ids = new Set([...grupos.keys(), ...paradasPor.keys()]);
  return [...ids]
    .map((operadorId) => {
      const ts = grupos.get(operadorId) ?? [];
      const ate2h = ts.filter((t) => t.horas_uteis <= 2).length;
      return {
        operadorId,
        tratadas: ts.length,
        ate2hPct: ts.length > 0 ? round1((100 * ate2h) / ts.length) : null,
        horasUteisMedia: ts.length > 0 ? round1(ts.reduce((a, t) => a + t.horas_uteis, 0) / ts.length) : null,
        paradas1d: paradasPor.get(operadorId) ?? 0,
      };
    })
    .sort((a, b) => b.tratadas - a.tratadas);
}

/** Média do time (mesmo cálculo agregado — nunca média de médias). */
export function mediaDoTime(tratativas: LinhaTratativa[]): { ate2hPct: number | null; horasUteisMedia: number | null } {
  if (tratativas.length === 0) return { ate2hPct: null, horasUteisMedia: null };
  const ate2h = tratativas.filter((t) => t.horas_uteis <= 2).length;
  return {
    ate2hPct: round1((100 * ate2h) / tratativas.length),
    horasUteisMedia: round1(tratativas.reduce((a, t) => a + t.horas_uteis, 0) / tratativas.length),
  };
}

/** Tempo médio (horas úteis) por cliente pagador — pior primeiro, min. volume. */
export function tempoPorCliente(
  tratativas: LinhaTratativa[],
  minCasos = 3,
): Array<{ cliente: string; cnpj: string | null; casos: number; horasUteisMedia: number }> {
  const grupos = new Map<string, { cliente: string; cnpj: string | null; horas: number[] }>();
  for (const t of tratativas) {
    const k = t.cnpj_pagador ?? t.empresa_cliente ?? "sem_cliente";
    const g = grupos.get(k) ?? { cliente: t.empresa_cliente ?? k, cnpj: t.cnpj_pagador, horas: [] };
    g.horas.push(t.horas_uteis);
    grupos.set(k, g);
  }
  return [...grupos.values()]
    .filter((g) => g.horas.length >= minCasos)
    .map((g) => ({
      cliente: g.cliente,
      cnpj: g.cnpj,
      casos: g.horas.length,
      horasUteisMedia: round1(g.horas.reduce((a, b) => a + b, 0) / g.horas.length),
    }))
    .sort((a, b) => b.horasUteisMedia - a.horasUteisMedia);
}

export function filtrarTratativas(
  linhas: LinhaTratativa[],
  f: { operadorId?: string | null; cliente?: string | null; coluna?: string | null },
): LinhaTratativa[] {
  return linhas.filter(
    (l) =>
      (!f.operadorId || l.operador_id === f.operadorId) &&
      (!f.cliente || l.cnpj_pagador === f.cliente || l.empresa_cliente === f.cliente) &&
      (!f.coluna || l.coluna === f.coluna),
  );
}


/** Demanda por ocorrência geradora (Caio 21/08): % dos tratados por oc. */
export function demandaPorOc(
  tratativas: LinhaTratativa[],
): Array<{ oc: number; n: number; pct: number }> {
  const m = new Map<number, number>();
  let total = 0;
  for (const t of tratativas) {
    if (t.oc_entrada == null) continue;
    m.set(t.oc_entrada, (m.get(t.oc_entrada) ?? 0) + 1);
    total += 1;
  }
  return [...m.entries()]
    .map(([oc, n]) => ({ oc, n, pct: total > 0 ? Math.round((1000 * n) / total) / 10 : 0 }))
    .sort((a, b) => b.n - a.n);
}

// =============================================================================
// DRILL DA DEMANDA POR AGENTE (Caio 2026-08-24): clicar numa oc do módulo
// "O que gera a demanda" abre o detalhe por AGENTE — o que foi sugerido e
// seguido exatamente × o que foi corrigido (e o que o operador lançou).
//
// LIGAÇÃO HONESTA (investigação 24/08, oc 20): a chave é POR CARD (cards cuja
// demanda nasceu daquela oc → todos os pares de feedback desses cards), NUNCA
// por agent_feedback.oc_card — oc 20 tinha 1.648 tratativas e só 61 pares por
// oc_card, mas 280 pares por card. E o funil é EXPLÍCITO: nem toda tratativa
// tem recomendação destacada de agente — o detalhe rotula a cobertura em vez
// de fingir igualdade (números = soma das partes).
// =============================================================================

export interface ParFeedbackDemanda {
  agent_name: string;
  oc_sugerida: number | null;
  oc_executada: number | null;
  /** oc do card no momento da sugestão — separa "manter aguardando" (Caio 24/08). */
  oc_card?: number | null;
  veredito: "seguida" | "corrigida";
  card_id: string;
}

export interface DetalheAgenteDemanda {
  agente: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
  /** % de seguidas dos pares DESTE agente (contadores, nunca subtração de %). */
  pctSeguidas: number | null;
  /** seguidas por oc sugerida (= lançada), maior n primeiro. */
  seguidasPorOc: Array<{ oc: number | null; n: number }>;
  /** corrigidas por TROCA exata (sugeriu → lançou), maior n primeiro. */
  trocas: Array<{ sugerida: number | null; executada: number | null; n: number }>;
  /** categoria "sugeriu MANTER aguardando" (sugerida = oc do card ∈ {54,59}) —
   *  fora do % tradicional (Caio 24/08, NF 1502332). */
  manterAguardou: number;
  manterAgiu: Array<{ executada: number | null; n: number }>;
}

/** Par "sugeriu MANTER aguardando": sugerida = oc do card ∈ {54,59}. */
export function ehParManterDemanda(r: Pick<ParFeedbackDemanda, "oc_sugerida" | "oc_card">): boolean {
  return (
    r.oc_sugerida != null && r.oc_card != null && r.oc_sugerida === r.oc_card &&
    (r.oc_card === 54 || r.oc_card === 59)
  );
}

/** Agrupa (PURO) os pares de feedback dos cards da demanda por agente.
 *  Invariantes: seguidas + soma(trocas.n) === pares (sem os "manter");
 *  manterAguardou + soma(manterAgiu.n) = pares "manter" do agente. */
export function detalharDemandaPorAgente(rows: ParFeedbackDemanda[]): DetalheAgenteDemanda[] {
  const porAgente = new Map<string, { seg: Map<string, number>; tro: Map<string, number>; mAguardou: number; mAgiu: Map<string, number> }>();
  for (const r of rows) {
    const cur = porAgente.get(r.agent_name) ?? { seg: new Map(), tro: new Map(), mAguardou: 0, mAgiu: new Map() };
    if (ehParManterDemanda(r)) {
      if (r.veredito === "seguida") cur.mAguardou += 1;
      else cur.mAgiu.set(String(r.oc_executada ?? "sem"), (cur.mAgiu.get(String(r.oc_executada ?? "sem")) ?? 0) + 1);
    } else if (r.veredito === "seguida") {
      const k = String(r.oc_sugerida ?? "sem");
      cur.seg.set(k, (cur.seg.get(k) ?? 0) + 1);
    } else {
      const k = `${r.oc_sugerida ?? "sem"}|${r.oc_executada ?? "sem"}`;
      cur.tro.set(k, (cur.tro.get(k) ?? 0) + 1);
    }
    porAgente.set(r.agent_name, cur);
  }
  return [...porAgente.entries()]
    .map(([agente, v]) => {
      const seguidasPorOc = [...v.seg.entries()]
        .map(([k, n]) => ({ oc: k === "sem" ? null : Number(k), n }))
        .sort((a, b) => b.n - a.n);
      const trocas = [...v.tro.entries()]
        .map(([k, n]) => {
          const [s, e] = k.split("|");
          return { sugerida: s === "sem" ? null : Number(s), executada: e === "sem" ? null : Number(e), n };
        })
        .sort((a, b) => b.n - a.n);
      const seguidas = seguidasPorOc.reduce((s, x) => s + x.n, 0);
      const corrigidas = trocas.reduce((s, x) => s + x.n, 0);
      const pares = seguidas + corrigidas;
      const manterAgiu = [...v.mAgiu.entries()]
        .map(([k, n]) => ({ executada: k === "sem" ? null : Number(k), n }))
        .sort((a, b) => b.n - a.n);
      return {
        agente,
        pares,
        seguidas,
        corrigidas,
        pctSeguidas: pares > 0 ? Math.round((1000 * seguidas) / pares) / 10 : null,
        seguidasPorOc,
        trocas,
        manterAguardou: v.mAguardou,
        manterAgiu,
      };
    })
    .sort((a, b) => (b.pares + b.manterAguardou + b.manterAgiu.reduce((s2, x) => s2 + x.n, 0)) - (a.pares + a.manterAguardou + a.manterAgiu.reduce((s2, x) => s2 + x.n, 0)));
}

/** Quebra uma lista de ids em blocos (PostgREST via .in() estoura URL com
 *  centenas de uuids — oc 20 tem 1.385 cards; blocos de 100 são seguros). */
export function emBlocos<T>(itens: readonly T[], tamanho: number): T[][] {
  const blocos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) blocos.push(itens.slice(i, i + tamanho));
  return blocos;
}
