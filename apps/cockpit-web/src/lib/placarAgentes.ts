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
  /** a oc do card quando o agente opinou — é o que torna o erro explicável */
  oc_card?: number | null;
  oc_sugerida: number | null;
  oc_executada: number | null;
  n: number;
};

/**
 * O detalhe que abre ao clicar no agente (Caio 2026-08-13): performance de CADA
 * ocorrência que ele sugere, e — quando erra — o que o operador fez no lugar.
 * É daqui que nasce a pergunta pro agente-chefe: "quando o card está em oc 11 e
 * você sugere 56, a Larissa faz 54 em 62 casos. Por quê?"
 */
export type DivergenciaOc = { ocExecutada: number; ocCard: number | null; n: number };

export type OcDoAgente = {
  oc: number;
  seguidas: number;
  corrigidas: number;
  pares: number;
  pct: number | null;
  /** o que o operador fez no lugar, do mais frequente pro menos */
  divergencias: DivergenciaOc[];
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
  /** quebra por ocorrência sugerida — o drill-down da lane */
  porOc: OcDoAgente[];
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

/** Abaixo disso o percentual existe mas não decide nada — e o painel diz isso. */
export const VOLUME_CONFIAVEL = 20;

export type Veredito =
  | { tipo: "pronto"; texto: string }
  | { tipo: "perto"; texto: string }
  | { tipo: "atencao"; texto: string }
  | { tipo: "pouco"; texto: string };

/**
 * Traduz o número num veredito em português — o painel precisa ser lido por
 * quem nunca viu a métrica. Volume baixo vence o percentual: 1 acerto em 1 ação
 * não é "100% pronto pra autonomia", é dado insuficiente.
 */
export function vereditoDoAgente(pct: number | null, pares: number): Veredito {
  if (pct === null || pares < VOLUME_CONFIAVEL) return { tipo: "pouco", texto: "volume baixo" };
  if (pct >= META_ACERTO_PCT) return { tipo: "pronto", texto: "pronto pra soltar" };
  const falta = Math.round(META_ACERTO_PCT - pct);
  return {
    tipo: falta <= 15 ? "perto" : "atencao",
    texto: `${falta} pts da meta`,
  };
}

/** Junta a performance de cada oc sugerida com as trocas que o operador fez. */
function montarPorOc(
  agente: string,
  ocs: Map<number, { s: number; c: number }> | undefined,
  erros: LinhaErro[],
): OcDoAgente[] {
  if (!ocs) return [];
  return [...ocs.entries()]
    .map(([oc, v]) => ({
      oc,
      seguidas: v.s,
      corrigidas: v.c,
      pares: v.s + v.c,
      pct: pct1(v.s, v.c),
      divergencias: erros
        .filter((e) => e.agent_name === agente && e.oc_sugerida === oc && e.oc_executada != null)
        .map((e) => ({ ocExecutada: e.oc_executada as number, ocCard: e.oc_card ?? null, n: e.n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 4),
    }))
    .filter((o) => o.pares > 0)
    // pior primeiro: é onde o gestor precisa olhar
    .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
}

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
  // mesma fatia, indexada por agente — alimenta o detalhe que abre no clique
  const ocsPorAgente = new Map<string, Map<number, { s: number; c: number }>>();
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

        const m = ocsPorAgente.get(l.agent_name) ?? new Map<number, { s: number; c: number }>();
        const o = m.get(l.fatia_oc_sugerida) ?? { s: 0, c: 0 };
        o.s += l.seguidas; o.c += l.corrigidas;
        m.set(l.fatia_oc_sugerida, o);
        ocsPorAgente.set(l.agent_name, m);
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
        porOc: montarPorOc(agente, ocsPorAgente.get(agente), erros),
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

/**
 * Monta a pergunta que vai pro chat do agente-chefe a partir dos números de uma
 * ocorrência (Caio 2026-08-13). O gestor não deve precisar reescrever o que o
 * painel já sabe — o botão entrega contexto + números + o pedido de explicação.
 *
 * Fecha o ciclo do loop: o placar mede, aponta a divergência, e a conversa que
 * ajusta o agente começa já ancorada em caso concreto.
 */
export function montarPerguntaDaOc(agenteAmigavel: string, o: OcDoAgente): string {
  const linhas: string[] = [];
  linhas.push(
    `Sobre o agente "${agenteAmigavel}": quando ele sugere oc ${o.oc}, o operador segue em ` +
      `${o.pct ?? 0}% dos casos (${o.seguidas} de ${o.pares}).`,
  );

  if (o.divergencias.length > 0) {
    linhas.push("");
    linhas.push("O que o operador fez no lugar:");
    for (const d of o.divergencias) {
      const onde = d.ocCard != null ? `com o card em oc ${d.ocCard}` : "em outros casos";
      linhas.push(`• ${onde}, lançou oc ${d.ocExecutada} — ${d.n}x`);
    }
  }

  linhas.push("");
  linhas.push(
    o.pct !== null && o.pct < META_ACERTO_PCT
      ? "Por que o agente escolhe essa ocorrência nesses casos, e o que eu preciso te explicar pra ele passar a sugerir o que o operador faz?"
      : "Essa fatia está acima da meta. O que ainda falta pra liberar como autônoma com segurança?",
  );
  return linhas.join("\n");
}
