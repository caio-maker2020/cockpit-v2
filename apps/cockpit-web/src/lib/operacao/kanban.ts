// =============================================================================
// Kanban da Operação — colunas como VISÃO do estado (nenhum estado novo), no
// mesmo molde do KANBAN_COLUMNS do Inbox: lista ordenada, o primeiro `match`
// que casa ganha (exclusividade: cada item cai em exatamente uma coluna).
// =============================================================================
import type { Tone } from "@/components/cockpit/tones";
import type { OpFilaLinha } from "./tipos";

export type ColunaKanbanOpId = "nova" | "assumida" | "na_fila_ssw" | "lancada" | "confirmada" | "problema";

export interface ColunaKanbanOp {
  id: ColunaKanbanOpId;
  titulo: string;
  tom: Tone;
  vazio: string;
  match: (l: OpFilaLinha) => boolean;
}

const st = (l: OpFilaLinha) => l.lancamento_status;

export const COLUNAS_KANBAN_OP: ColunaKanbanOp[] = [
  {
    id: "problema",
    titulo: "Não confirmado / Erro",
    tom: "sal-deep",
    vazio: "Nenhum lançamento com problema.",
    match: (l) => st(l) === "nao_confirmado" || st(l) === "erro" || st(l) === "recusado",
  },
  {
    id: "na_fila_ssw",
    titulo: "Na fila do SSW",
    tom: "amber",
    vazio: "Nenhum pedido esperando o SSW.",
    match: (l) => st(l) === "fila" || st(l) === "lancando",
  },
  {
    id: "lancada",
    titulo: "Lançada",
    tom: "slate",
    vazio: "Nada aguardando confirmação.",
    match: (l) => st(l) === "lancado",
  },
  {
    id: "confirmada",
    titulo: "Confirmada",
    tom: "emerald",
    vazio: "Nenhum lançamento confirmado ainda.",
    match: (l) => st(l) === "confirmado",
  },
  {
    id: "assumida",
    titulo: "Assumida",
    tom: "slate",
    vazio: "Ninguém assumiu nada ainda.",
    match: (l) => !!l.assumido_por,
  },
  {
    id: "nova",
    titulo: "Nova",
    tom: "sal",
    vazio: "Nenhuma nota nova parada.",
    match: () => true,
  },
];

/** Ordem de exibição (a de cima é a ordem de decisão). */
export const ORDEM_COLUNAS_KANBAN_OP: ColunaKanbanOpId[] = [
  "nova",
  "assumida",
  "na_fila_ssw",
  "lancada",
  "confirmada",
  "problema",
];

export function colunaDoItem(l: OpFilaLinha): ColunaKanbanOpId {
  return (COLUNAS_KANBAN_OP.find((c) => c.match(l)) ?? COLUNAS_KANBAN_OP[COLUNAS_KANBAN_OP.length - 1]!).id;
}

/** Agrupa preservando a ordem de entrada (a fila já chega ordenada por tempo parado). */
export function agruparKanban(linhas: readonly OpFilaLinha[]): Record<ColunaKanbanOpId, OpFilaLinha[]> {
  const g: Record<ColunaKanbanOpId, OpFilaLinha[]> = {
    nova: [],
    assumida: [],
    na_fila_ssw: [],
    lancada: [],
    confirmada: [],
    problema: [],
  };
  for (const l of linhas) g[colunaDoItem(l)].push(l);
  return g;
}

export function colunaPorId(id: ColunaKanbanOpId): ColunaKanbanOp {
  return COLUNAS_KANBAN_OP.find((c) => c.id === id)!;
}
