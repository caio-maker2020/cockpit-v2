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
