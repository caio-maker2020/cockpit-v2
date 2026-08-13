// Agregação do placar dos agentes (Caio 2026-08-13).
//
// Definição canônica: o operador é a verdade.
//   agente sugeriu X · operador fez X → seguida (ACERTO)
//   agente sugeriu X · operador fez Y → corrigida (ERRO)
//
// A meta é 95%: quando uma FATIA (agente × oc sugerida) passa disso com volume,
// ela vira candidata a autônoma e os 5% restantes seguem em validação humana.
// Por isso a agregação por fatia importa tanto quanto a global — o número
// global esconde fatias já prontas (ex.: interpretador tem 67% no geral e
// 94,5% quando sugere oc 44, em 711 casos).

import { diasUteisFechados, JANELA_PLACAR_UTEIS } from "./aprendizadoPlacar";

export const META_ACERTO_PCT = 95;
/** Volume mínimo pra uma fatia ser considerada — evita 1/1 = 100%. */
export const VOLUME_MINIMO_FATIA = 30;

export type LinhaPlacar = {
  dia: string;
  agent_name: string;
  fatia_oc_sugerida: number | null;
  seguidas: number;
  corrigidas: number;
  pares: number;
};

export type LinhaErro = {
  agent_name: string;
  oc_sugerida: number | null;
  oc_executada: number | null;
  n: number;
};

export type AgentePlacar = {
  agente: string;
  seguidas: number;
  corrigidas: number;
  pares: number;
  pct: number | null;
  /** vs o período anterior de mesmo tamanho */
  delta: number | null;
  piorErro: LinhaErro | null;
};

export type FatiaPronta = { agente: string; oc: number; pct: number; pares: number };

export type PlacarAgregado = {
  global: { seguidas: number; corrigidas: number; pct: number | null; delta: number | null };
  agentes: AgentePlacar[];
  fatiasProntas: FatiaPronta[];
  /** Quantas ações/semana ainda divergem pra bater a meta — o alvo do loop. */
  acoesParaMeta: number;
};

const pct1 = (s: number, c: number): number | null =>
  s + c > 0 ? Math.round((1000 * s) / (s + c)) / 10 : null;

/**
 * Agrega as linhas diárias em: placar global, por agente (com delta vs período
 * anterior), e as fatias que já batem a meta.
 */
export function agregarPlacar(
  linhas: LinhaPlacar[],
  erros: LinhaErro[],
  agora: Date = new Date(),
  janelaUteis: number = JANELA_PLACAR_UTEIS,
): PlacarAgregado {
  const uteis = diasUteisFechados(janelaUteis * 2, agora);
  const recente = new Set(uteis.slice(0, janelaUteis));
  const anterior = new Set(uteis.slice(janelaUteis, janelaUteis * 2));

  const porAgente = new Map<string, { s: number; c: number; sa: number; ca: number }>();
  const porFatia = new Map<string, { agente: string; oc: number; s: number; c: number }>();
  let gs = 0, gc = 0, gsa = 0, gca = 0;

  for (const l of linhas) {
    const naRecente = recente.has(l.dia);
    const naAnterior = !naRecente && anterior.has(l.dia);
    if (!naRecente && !naAnterior) continue;

    const a = porAgente.get(l.agent_name) ?? { s: 0, c: 0, sa: 0, ca: 0 };
    if (naRecente) {
      a.s += l.seguidas; a.c += l.corrigidas;
      gs += l.seguidas; gc += l.corrigidas;
      if (l.fatia_oc_sugerida != null) {
        const k = `${l.agent_name}|${l.fatia_oc_sugerida}`;
        const f = porFatia.get(k) ?? { agente: l.agent_name, oc: l.fatia_oc_sugerida, s: 0, c: 0 };
        f.s += l.seguidas; f.c += l.corrigidas;
        porFatia.set(k, f);
      }
    } else {
      a.sa += l.seguidas; a.ca += l.corrigidas;
      gsa += l.seguidas; gca += l.corrigidas;
    }
    porAgente.set(l.agent_name, a);
  }

  // pior cluster de erro por agente — o que o loop ataca primeiro
  const piorPorAgente = new Map<string, LinhaErro>();
  for (const e of erros) {
    const atual = piorPorAgente.get(e.agent_name);
    if (!atual || e.n > atual.n) piorPorAgente.set(e.agent_name, e);
  }

  const agentes: AgentePlacar[] = [...porAgente.entries()]
    .map(([agente, v]) => {
      const p = pct1(v.s, v.c);
      const pa = pct1(v.sa, v.ca);
      return {
        agente,
        seguidas: v.s,
        corrigidas: v.c,
        pares: v.s + v.c,
        pct: p,
        delta: p !== null && pa !== null ? Math.round((p - pa) * 10) / 10 : null,
        piorErro: piorPorAgente.get(agente) ?? null,
      };
    })
    .filter((a) => a.pares > 0)
    .sort((x, y) => y.pares - x.pares);

  const fatiasProntas: FatiaPronta[] = [...porFatia.values()]
    .map((f) => ({ agente: f.agente, oc: f.oc, pct: pct1(f.s, f.c) ?? 0, pares: f.s + f.c }))
    .filter((f) => f.pares >= VOLUME_MINIMO_FATIA && f.pct >= META_ACERTO_PCT)
    .sort((a, b) => b.pares - a.pares);

  const pctGlobal = pct1(gs, gc);
  // Quantos acertos a mais seriam necessários pra bater a meta no mesmo volume.
  const total = gs + gc;
  const acoesParaMeta = total > 0
    ? Math.max(0, Math.ceil((META_ACERTO_PCT / 100) * total - gs))
    : 0;

  return {
    global: { seguidas: gs, corrigidas: gc, pct: pctGlobal, delta:
      pctGlobal !== null && pct1(gsa, gca) !== null
        ? Math.round((pctGlobal - (pct1(gsa, gca) as number)) * 10) / 10
        : null },
    agentes,
    fatiasProntas,
    acoesParaMeta,
  };
}
