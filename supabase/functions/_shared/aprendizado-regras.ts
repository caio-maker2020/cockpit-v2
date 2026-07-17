// =============================================================================
// aprendizado-regras.ts — regras PURAS do orquestrador agente-aprendizado.
//
// Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
// "As perguntas são riqueza" (Caio): o produto primário do orquestrador é a
// pergunta profunda ancorada em evidência, respondível em 1 clique, nunca
// repetida. Este módulo decide O QUE perguntar; a edge function decide quando
// e grava. Zero I/O aqui — tudo testável.
//
// Regras duras (herdadas do managed agent aposentado, spec §4.5):
//   - pergunta só com evidência mínima (>= MIN_CORRIGIDAS casos);
//   - nunca re-perguntar chave já aberta/respondida (dedup por chave_padrao);
//   - nunca inventar o porquê do operador (motivos só se registrados).
//
// Rodar testes: deno test supabase/functions/_shared/aprendizado-regras.test.ts
// =============================================================================

export interface ParFeedback {
  agent_name: string;
  veredito: string; // seguida | corrigida | abstencao | rejeitada | nao_rodou
  origem: string; // implicit | explicit | popup | outcome | audit | backfill
  oc_card: number | null;
  oc_sugerida: number | null;
  oc_executada: number | null;
  reason_text: string | null;
  operador_card: string | null;
  nf: string | null;
  decidido_em: string;
}

export interface TrocaFrequente {
  ocExecutada: number | null;
  casos: number;
  nfsExemplo: string[];
}

export interface GrupoSugestao {
  agentName: string;
  ocSugerida: number | null;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  /** corrigidas / (seguidas + corrigidas) — abstenção fora do denominador (spec §9) */
  taxaCorrecao: number;
  trocas: TrocaFrequente[];
  operadoresTop: { operador: string; casos: number }[];
  motivosRegistrados: string[];
}

export interface PerguntaMontada {
  chavePadrao: string;
  titulo: string;
  oQueAconteceu: string;
  oQueSugiro: string;
  pergunta: string;
  opcoes: string[];
  casosAncora: string[];
  numeros: Record<string, number>;
  agenteAlvo: string;
}

/** Nomes amigáveis dos agentes pro texto do painel (linguagem simples, spec §6). */
export const AGENTE_NOME_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "agente de recusas (ocorrências padrão)",
  "interpretador-resposta-cliente": "leitor de respostas do cliente",
  "agente-oc13-autonomo": "agente de limitação do cliente (oc 13)",
  "agente-extravio-d4": "agente de extravios (D+4)",
  "agente-ressarcimento-relancar-54": "agente de ressarcimento (relançar 54)",
};

const MAX_NFS_EXEMPLO = 5;
const MAX_TROCAS = 4;
const MAX_OPERADORES = 3;
const MAX_MOTIVOS = 5;

export function nomeOc(oc: number | null, nomes: Record<number, string>): string {
  if (oc === null) return "(sem código)";
  const nome = nomes[oc];
  return nome ? `${oc} — ${nome}` : `${oc}`;
}

/** Agrupa os pares por (agente × oc sugerida), com trocas, operadores e motivos. */
export function agruparPorSugestao(pares: ParFeedback[]): GrupoSugestao[] {
  const grupos = new Map<string, GrupoSugestao>();
  const trocasPorGrupo = new Map<string, Map<string, TrocaFrequente>>();
  const opsPorGrupo = new Map<string, Map<string, number>>();

  for (const p of pares) {
    const k = `${p.agent_name}|${p.oc_sugerida ?? "sem"}`;
    let g = grupos.get(k);
    if (!g) {
      g = {
        agentName: p.agent_name,
        ocSugerida: p.oc_sugerida,
        pares: 0,
        seguidas: 0,
        corrigidas: 0,
        abstencoes: 0,
        taxaCorrecao: 0,
        trocas: [],
        operadoresTop: [],
        motivosRegistrados: [],
      };
      grupos.set(k, g);
      trocasPorGrupo.set(k, new Map());
      opsPorGrupo.set(k, new Map());
    }
    g.pares += 1;
    if (p.veredito === "seguida") g.seguidas += 1;
    else if (p.veredito === "corrigida" || p.veredito === "rejeitada") {
      g.corrigidas += 1;
      const tk = String(p.oc_executada ?? "nada");
      const tmap = trocasPorGrupo.get(k)!;
      let t = tmap.get(tk);
      if (!t) {
        t = { ocExecutada: p.oc_executada, casos: 0, nfsExemplo: [] };
        tmap.set(tk, t);
      }
      t.casos += 1;
      if (p.nf && t.nfsExemplo.length < MAX_NFS_EXEMPLO) t.nfsExemplo.push(p.nf);
      if (p.operador_card) {
        const omap = opsPorGrupo.get(k)!;
        omap.set(p.operador_card, (omap.get(p.operador_card) ?? 0) + 1);
      }
      const motivo = (p.reason_text ?? "").trim();
      if (motivo && g.motivosRegistrados.length < MAX_MOTIVOS &&
        !g.motivosRegistrados.includes(motivo)) {
        g.motivosRegistrados.push(motivo);
      }
    } else {
      g.abstencoes += 1;
    }
  }

  for (const [k, g] of grupos) {
    const avaliadas = g.seguidas + g.corrigidas;
    g.taxaCorrecao = avaliadas > 0 ? g.corrigidas / avaliadas : 0;
    g.trocas = [...trocasPorGrupo.get(k)!.values()]
      .sort((a, b) => b.casos - a.casos)
      .slice(0, MAX_TROCAS);
    g.operadoresTop = [...opsPorGrupo.get(k)!.entries()]
      .map(([operador, casos]) => ({ operador, casos }))
      .sort((a, b) => b.casos - a.casos)
      .slice(0, MAX_OPERADORES);
  }

  return [...grupos.values()].sort((a, b) => b.corrigidas - a.corrigidas);
}

export function chavePergunta(g: GrupoSugestao): string {
  return `${g.agentName}:sug${g.ocSugerida ?? "sem"}`;
}

/**
 * Seleciona os grupos que merecem virar pergunta:
 *   - evidência mínima (corrigidas >= minCorrigidas) E taxa de correção
 *     relevante (>= minTaxa);
 *   - nunca uma chave já perguntada (dedup — "nunca re-perguntar");
 *   - diversidade: 1 pergunta por agente antes de repetir agente;
 *   - no máximo maxPerguntas.
 */
export function selecionarPerguntas(
  grupos: GrupoSugestao[],
  opts: {
    maxPerguntas?: number;
    minCorrigidas?: number;
    minTaxa?: number;
    chavesJaPerguntadas?: Set<string>;
  } = {},
): GrupoSugestao[] {
  const max = opts.maxPerguntas ?? 3;
  const minCorrigidas = opts.minCorrigidas ?? 5;
  const minTaxa = opts.minTaxa ?? 0.3;
  const jaPerguntadas = opts.chavesJaPerguntadas ?? new Set<string>();

  const elegiveis = grupos.filter((g) =>
    g.corrigidas >= minCorrigidas &&
    g.taxaCorrecao >= minTaxa &&
    !jaPerguntadas.has(chavePergunta(g))
  );

  const escolhidos: GrupoSugestao[] = [];
  // passada 1: diversidade por agente
  const agentesUsados = new Set<string>();
  for (const g of elegiveis) {
    if (escolhidos.length >= max) break;
    if (agentesUsados.has(g.agentName)) continue;
    escolhidos.push(g);
    agentesUsados.add(g.agentName);
  }
  // passada 2: completa com os maiores restantes
  for (const g of elegiveis) {
    if (escolhidos.length >= max) break;
    if (!escolhidos.includes(g)) escolhidos.push(g);
  }
  return escolhidos;
}

function pct(n: number): number {
  return Math.round(n * 100);
}

/**
 * Monta a pergunta em linguagem simples (contrato spec §6: o que aconteceu /
 * o que eu sugiro / pergunta 1-clique / detalhe técnico fica no jsonb).
 * NUNCA inventa motivo do operador — motivos só aparecem se registrados.
 */
export function montarPergunta(
  g: GrupoSugestao,
  nomesOc: Record<number, string>,
): PerguntaMontada {
  const agente = AGENTE_NOME_AMIGAVEL[g.agentName] ?? g.agentName;
  const sug = nomeOc(g.ocSugerida, nomesOc);
  const taxa = pct(g.taxaCorrecao);
  const trocaTop = g.trocas[0];

  const titulo = g.ocSugerida === null
    ? `No ${agente}, o time resolve de um jeito que a IA não previu em ${taxa}% dos casos avaliados`
    : `Quando o ${agente} sugere "${sug}", o time faz outra coisa em ${taxa}% dos casos`;

  const listaTrocas = g.trocas
    .filter((t) => t.ocExecutada !== null)
    .map((t) => `"${nomeOc(t.ocExecutada, nomesOc)}" (${t.casos}x)`)
    .join(", ");

  const oQueAconteceu = [
    `De ${g.seguidas + g.corrigidas} sugestões avaliadas, o time seguiu ${g.seguidas} e corrigiu ${g.corrigidas}.`,
    listaTrocas
      ? `No lugar da sugestão, o que o time mais lançou foi: ${listaTrocas}.`
      : `Nas correções, o time rejeitou a sugestão sem lançar outro código no lugar.`,
  ].join(" ");

  const oQueSugiro = trocaTop && trocaTop.ocExecutada !== null && trocaTop.casos / Math.max(g.corrigidas, 1) >= 0.5
    ? `Se existir uma regra clara de quando usar "${nomeOc(trocaTop.ocExecutada, nomesOc)}", eu consigo propor a mudança na sugestão e reduzir essas correções.`
    : `As correções vão pra caminhos diferentes — se vocês me explicarem o que decide entre eles, eu consigo propor uma sugestão melhor pra cada situação.`;

  const pergunta = trocaTop && trocaTop.ocExecutada !== null
    ? `O que faz o time escolher "${nomeOc(trocaTop.ocExecutada, nomesOc)}" em vez de "${sug}"? Existe uma regra que a IA deveria conhecer?`
    : `O que o time olha pra decidir o que fazer nesses casos em que corrige a IA?`;

  const opcoes = [
    "Sim — existe uma regra clara (vou descrever na resposta)",
    "Depende do caso — quero ver os exemplos antes de responder",
    "O time é que está corrigindo errado — a sugestão da IA estava certa",
    "Outro (explico na resposta)",
  ];

  const casosAncora = [
    ...new Set(g.trocas.flatMap((t) => t.nfsExemplo)),
  ].slice(0, MAX_NFS_EXEMPLO);

  return {
    chavePadrao: chavePergunta(g),
    titulo,
    oQueAconteceu,
    oQueSugiro,
    pergunta,
    opcoes,
    casosAncora,
    numeros: {
      pares: g.pares,
      seguidas: g.seguidas,
      corrigidas: g.corrigidas,
      abstencoes: g.abstencoes,
      taxa_correcao_pct: taxa,
    },
    agenteAlvo: g.agentName,
  };
}

// ============================== resumo semanal ==============================

export interface MetricaAgenteSemana {
  agentName: string;
  pares: number;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
}

export interface ComparativoSemanal {
  agentName: string;
  agenteAmigavel: string;
  paresAtual: number;
  pctAcertoAtual: number | null;
  pctAcertoAnterior: number | null;
  deltaPontos: number | null;
}

export function compararSemanas(
  atual: MetricaAgenteSemana[],
  anterior: MetricaAgenteSemana[],
): ComparativoSemanal[] {
  const pctDe = (m?: MetricaAgenteSemana): number | null => {
    if (!m) return null;
    const avaliadas = m.seguidas + m.corrigidas;
    return avaliadas > 0 ? Math.round((100 * m.seguidas) / avaliadas * 10) / 10 : null;
  };
  const antMap = new Map(anterior.map((m) => [m.agentName, m]));
  return atual
    .map((m) => {
      const pctA = pctDe(m);
      const pctB = pctDe(antMap.get(m.agentName));
      return {
        agentName: m.agentName,
        agenteAmigavel: AGENTE_NOME_AMIGAVEL[m.agentName] ?? m.agentName,
        paresAtual: m.pares,
        pctAcertoAtual: pctA,
        pctAcertoAnterior: pctB,
        deltaPontos: pctA !== null && pctB !== null
          ? Math.round((pctA - pctB) * 10) / 10
          : null,
      };
    })
    .sort((a, b) => b.paresAtual - a.paresAtual);
}
