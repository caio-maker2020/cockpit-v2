// =============================================================================
// TORRE DO RELACIONAMENTO — o Inbox lido como uma torre de agentes, para a operadora.
// Mesmo fluxo da tela da Operação (docs/RELACIONAMENTO-TELA.md):
//   agente lê → regras (firme: o robô age sozinho se ninguém vetar; dúvida: vem para você)
//   → especialistas (um por tipo de caso) → conselheiro (sinais de risco) → você confirma.
//
// Nada aqui muda regra: as colunas continuam as do KANBAN_COLUMNS (types.ts), com o mesmo
// "primeiro match ganha" e a mesma ordenação de antes (movida do Inbox sem alteração).
// As ETAPAS só agrupam colunas para a barra de topo. Tudo puro e testado.
// =============================================================================
import { KANBAN_COLUMNS, type CardTipo, type CardWithRelations, type KanbanColumnId } from "@/lib/types";

/** Card do Inbox (o enriquecimento que o Inbox já fazia). */
export interface CardInbox extends CardWithRelations {
  pendentes_count: number;
  possivel_resposta_outra_thread?: boolean;
}

/**
 * Agrupa por coluna do kanban. MESMA regra e MESMA ordenação do Inbox (movida para cá):
 *  - "possível resposta em outra thread" é puxado para Cliente respondeu;
 *  - veto_janela: quem vence primeiro no topo;
 *  - validacao / cliente_respondeu: do mais velho para o mais novo;
 *  - o resto: com pendência primeiro, depois atividade mais recente.
 */
export function agruparInbox(
  cards: readonly CardInbox[],
  respostaOutraThread: ReadonlySet<string> | null | undefined,
): Map<KanbanColumnId, CardInbox[]> {
  const map = new Map<KanbanColumnId, CardInbox[]>();
  KANBAN_COLUMNS.forEach((c) => map.set(c.id, []));
  const outras = respostaOutraThread ?? new Set<string>();
  for (const card of cards) {
    const enriched: CardInbox = outras.has(card.id) ? { ...card, possivel_resposta_outra_thread: true } : card;
    const colId: KanbanColumnId | undefined = enriched.possivel_resposta_outra_thread
      ? "cliente_respondeu"
      : KANBAN_COLUMNS.find((c) => c.match(enriched))?.id;
    if (colId) map.get(colId)!.push(enriched);
  }
  const OLDEST_FIRST: KanbanColumnId[] = ["validacao", "cliente_respondeu"];
  map.forEach((arr, colId) => {
    if (colId === "veto_janela") {
      arr.sort((a, b) => {
        const at = a.acao_autonoma?.executar_em ? new Date(a.acao_autonoma.executar_em).getTime() : Infinity;
        const bt = b.acao_autonoma?.executar_em ? new Date(b.acao_autonoma.executar_em).getTime() : Infinity;
        return at - bt;
      });
      return;
    }
    if (OLDEST_FIRST.includes(colId)) {
      arr.sort((a, b) => {
        const ad = a.bastao_data_ultima_ocorrencia ?? null;
        const bd = b.bastao_data_ultima_ocorrencia ?? null;
        if (ad !== bd) {
          if (ad == null) return 1;
          if (bd == null) return -1;
          return ad < bd ? -1 : 1;
        }
        const at = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
        return at - bt;
      });
      return;
    }
    arr.sort((a, b) => {
      const ap = a.pendentes_count > 0 ? 1 : 0;
      const bp = b.pendentes_count > 0 ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const at = a.last_event_at ? new Date(a.last_event_at).getTime() : 0;
      const bt = b.last_event_at ? new Date(b.last_event_at).getTime() : 0;
      return bt - at;
    });
  });
  return map;
}

/** sessionStorage: a ordem do fluxo do Inbox, para j/k e "próximo card" dentro do card aberto. */
export const CHAVE_ORDEM_CARDS = "relacionamento.ordem.v1";

// --------------------------------------------------------------------------- Etapas (barra de topo)

export type EtapaRelId = "voce" | "robo" | "agente" | "cliente" | "feitas";

export interface EtapaRel {
  id: EtapaRelId;
  titulo: string;
  curto: string;
  dica: string;
  cor: string;
  colunas: readonly KanbanColumnId[];
}

/** Ordem do fluxo: o que depende de você primeiro, o que já foi por último. */
export const ETAPAS_REL: readonly EtapaRel[] = [
  {
    id: "voce",
    titulo: "Aguardando você",
    curto: "Aguardando você",
    dica: "Dúvida: o agente propõe, você valida. Inclui quem o cliente respondeu.",
    cor: "var(--signal)",
    colunas: ["validacao", "cliente_respondeu"],
  },
  {
    id: "robo",
    titulo: "Trilho autônomo",
    curto: "Trilho autônomo",
    dica: "Regra firme: o robô age sozinho na hora marcada se ninguém vetar.",
    cor: "#6D28D9",
    colunas: ["veto_janela", "veto_executada"],
  },
  {
    id: "agente",
    titulo: "Para fazer",
    curto: "Para fazer",
    dica: "O agente ainda está lendo o caso e montando a proposta.",
    cor: "var(--c-ink-mute)",
    colunas: ["para_fazer"],
  },
  {
    id: "cliente",
    titulo: "Aguardando cliente",
    curto: "Aguardando cliente",
    dica: "Notificamos o cliente; o card volta quando ele responder.",
    cor: "var(--warning)",
    colunas: ["cliente"],
  },
  {
    id: "feitas",
    titulo: "Ação executada / Ação confirmada",
    curto: "Ação executada",
    dica: "Ação lançada no SSW (esperando o Bastão) ou já confirmada.",
    cor: "var(--positive)",
    colunas: ["acao_executada", "executada"],
  },
];

export function etapaDaColuna(id: KanbanColumnId): EtapaRelId | null {
  return ETAPAS_REL.find((e) => e.colunas.includes(id))?.id ?? null;
}

export function contagemPorEtapa(grupos: ReadonlyMap<KanbanColumnId, readonly CardInbox[]>): Record<EtapaRelId, number> {
  const r = { voce: 0, robo: 0, agente: 0, cliente: 0, feitas: 0 } as Record<EtapaRelId, number>;
  for (const e of ETAPAS_REL) for (const c of e.colunas) r[e.id] += grupos.get(c)?.length ?? 0;
  return r;
}

/** Colunas na ordem do fluxo (as do trilho só para quem está no piloto ou tem card nelas). */
export function colunasNaOrdem(mostrarTrilho: boolean): KanbanColumnId[] {
  return ETAPAS_REL.flatMap((e) => (e.id === "robo" && !mostrarTrilho ? [] : [...e.colunas]));
}

/** Ordem de navegação (j/k e "próximo card"): coluna a coluna, na ordem do fluxo. */
export function ordemDosCards(grupos: ReadonlyMap<KanbanColumnId, readonly CardInbox[]>, colunas: readonly KanbanColumnId[]): string[] {
  return colunas.flatMap((c) => (grupos.get(c) ?? []).map((x) => x.id));
}

// --------------------------------------------------------------------------- Certeza em palavras

export type NivelCerteza = "alta" | "media" | "baixa";
export const ROTULO_CERTEZA: Record<NivelCerteza, string> = { alta: "certeza alta", media: "certeza média", baixa: "certeza baixa" };

/** 0–1 → alta (≥ 0,85), média (≥ 0,65), baixa. A tela não mostra porcentagem. */
export function nivelDaConfianca(c: number | null | undefined): NivelCerteza | null {
  if (typeof c !== "number" || !Number.isFinite(c)) return null;
  const v = c > 1 ? c / 100 : c;
  return v >= 0.85 ? "alta" : v >= 0.65 ? "media" : "baixa";
}

// --------------------------------------------------------------------------- Torre: resumo, especialistas, conselheiro, registro

const ROTULO_TIPO: Record<CardTipo, string> = {
  rastreamento: "Rastreamento",
  reentrega: "Reentrega",
  devolucao: "Devolução",
  avaria: "Avaria",
  extravio: "Extravio",
  inversao: "Inversão",
  cobranca: "Cobrança",
  outros: "Outros",
};
export const rotuloTipo = (t: CardTipo | null | undefined) => (t ? ROTULO_TIPO[t] : "Sem tipo");

export interface EspecialistaRel {
  tipo: CardTipo | null;
  titulo: string;
  total: number;
  comVoce: number;
  robo: number;
  status: "livre" | "em_dia" | "precisa_voce";
}

export interface ResumoRel {
  total: number;
  porEtapa: Record<EtapaRelId, number>;
  certeza: Record<NivelCerteza, number>;
  riscoAlto: number;
  especialistas: EspecialistaRel[];
}

export function resumirRel(grupos: ReadonlyMap<KanbanColumnId, readonly CardInbox[]>): ResumoRel {
  const porEtapa = contagemPorEtapa(grupos);
  const certeza = { alta: 0, media: 0, baixa: 0 } as Record<NivelCerteza, number>;
  const esp = new Map<string, EspecialistaRel>();
  let total = 0;
  let riscoAlto = 0;
  for (const [col, cards] of grupos) {
    const etapa = etapaDaColuna(col);
    for (const c of cards) {
      total++;
      if (c.risco === "alto") riscoAlto++;
      const n = nivelDaConfianca(c.ia_sugestao_oc_resposta?.confianca);
      if (n) certeza[n]++;
      const k = c.tipo ?? "_";
      const e = esp.get(k) ?? { tipo: c.tipo ?? null, titulo: rotuloTipo(c.tipo), total: 0, comVoce: 0, robo: 0, status: "livre" as const };
      e.total++;
      if (etapa === "voce") e.comVoce++;
      if (etapa === "robo") e.robo++;
      esp.set(k, e);
    }
  }
  const especialistas = [...esp.values()]
    .map((e) => ({ ...e, status: (e.total === 0 ? "livre" : e.comVoce > 0 ? "precisa_voce" : "em_dia") as EspecialistaRel["status"] }))
    .sort((a, b) => b.comVoce - a.comVoce || b.total - a.total);
  return { total, porEtapa, certeza, riscoAlto, especialistas };
}

export interface AvisoRel {
  id: string;
  tom: "critico" | "atencao" | "info";
  titulo: string;
  detalhe: string;
  cards: string[];
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** Sinais que o conselheiro destaca (os mesmos sinais que o card já mostra, somados). */
export function avisosRel(cards: readonly CardInbox[], paradoMais1dUtil: (c: CardInbox) => boolean): AvisoRel[] {
  const avisos: AvisoRel[] = [];
  const add = (id: string, tom: AvisoRel["tom"], filtro: (c: CardInbox) => boolean, titulo: (n: number) => string, detalhe: string) => {
    const lista = cards.filter(filtro).map((c) => c.id);
    if (lista.length) avisos.push({ id, tom, titulo: titulo(lista.length), detalhe, cards: lista });
  };
  add("falhou", "critico", (c) => !!c.acao_falhou_motivo, (n) => `${plural(n, "ação não executou", "ações não executaram")} no SSW`, "Confira o motivo no card antes de tentar de novo.");
  add("parados", "atencao", paradoMais1dUtil, (n) => `${plural(n, "card parado", "cards parados")} há mais de 1 dia útil`, "Os mais esquecidos primeiro: o relógio do card fica em vermelho.");
  add("outra-thread", "atencao", (c) => !!c.possivel_resposta_outra_thread, (n) => `${plural(n, "possível resposta", "possíveis respostas")} em outra conversa`, "O cliente pode ter respondido por outro e-mail. Valide e adote a conversa.");
  add("oc-alterada", "info", (c) => !!c.aviso_alteracao_oc, (n) => `${plural(n, "ocorrência mudou", "ocorrências mudaram")} desde a proposta`, "A proposta do agente pode ter ficado velha.");
  add("risco", "info", (c) => c.risco === "alto", (n) => `${plural(n, "card", "cards")} com risco alto`, "Prazo ou cliente sensível: olhe com calma.");
  add("sem-chave", "info", (c) => !!c.sem_chave_cte, (n) => `${plural(n, "card", "cards")} sem chave do CT-e`, "Sem a chave, algumas ações não vão ao SSW.");
  return avisos;
}

/** O aviso que vale para cada card (o mais grave primeiro). */
export function avisoPorCard(avisos: readonly AvisoRel[]): Map<string, AvisoRel> {
  const m = new Map<string, AvisoRel>();
  for (const a of avisos) if (a.tom !== "info") for (const id of a.cards) if (!m.has(id)) m.set(id, a);
  return m;
}

export interface EventoRel {
  id: string;
  em: string;
  quem: string;
  texto: string;
  tipo: "cliente" | "robo" | "sistema";
}

const nf = (c: CardInbox) => (c.nf ? `NF ${c.nf}` : c.ctrc ? `CTRC ${c.ctrc}` : "card sem NF");

/** O que aconteceu no turno, derivado dos próprios cards (mais recente primeiro). */
export function registroRel(cards: readonly CardInbox[], limite = 8): EventoRel[] {
  const ev: EventoRel[] = [];
  for (const c of cards) {
    if (c.cliente_respondeu_em) ev.push({ id: `resp-${c.id}`, em: c.cliente_respondeu_em, quem: "Cliente", tipo: "cliente", texto: `respondeu sobre a ${nf(c)}.` });
    if (c.acao_executada_em) ev.push({ id: `exec-${c.id}`, em: c.acao_executada_em, quem: "Sistema", tipo: "sistema", texto: `lançou a ação da ${nf(c)} no SSW.` });
    if (c.acao_autonoma?.executar_em && (c.acao_autonoma.status === "pendente" || c.acao_autonoma.status === "executando"))
      ev.push({ id: `robo-${c.id}`, em: c.acao_autonoma.executar_em, quem: "Robô", tipo: "robo", texto: `vai agir na ${nf(c)} se ninguém vetar.` });
  }
  return ev.sort((a, b) => Date.parse(b.em) - Date.parse(a.em)).slice(0, limite);
}
