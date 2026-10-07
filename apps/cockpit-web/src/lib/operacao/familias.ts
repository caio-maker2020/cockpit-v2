// =============================================================================
// FAMÍLIA DO PROBLEMA — o que a Operação precisa fazer com a nota, derivado da
// última ocorrência (cod_ultima_ocorrencia). É a visão principal do kanban.
//
// Semântica conferida nas descrições de `ocorrencias_dicionario` (migs 008/204)
// e na fila real (fixture de 300 linhas, 07/10). Tabela PURA; teste trava:
// nenhum código em duas famílias, todo código da Operação do dicionário tem
// família (ou é finalizador/documental, que nunca entra na fila — INV-182).
// =============================================================================
import type { Tone } from "@/components/cockpit/tones";
import type { OpFilaLinha } from "./tipos";

export type FamiliaId =
  | "entrega_impossivel"
  | "pronta_entrega"
  | "reentrega_agendamento"
  | "transferencia"
  | "comprovante"
  | "informacao"
  | "outros";

export interface FamiliaProblema {
  id: FamiliaId;
  titulo: string;
  /** Uma linha: o que a Operação faz com estas notas. */
  acao: string;
  tom: Tone;
  ocs: readonly number[];
}

export const FAMILIAS_PROBLEMA: readonly FamiliaProblema[] = [
  {
    id: "entrega_impossivel",
    titulo: "Entrega impossível",
    acao: "Tentativa falhou: resolver o motivo e programar nova tentativa.",
    tom: "sal",
    // 13 limitação cliente · 15 limitação da base · 24 força maior · 25 feriado
    // 37 problema no veículo · 39 problema com janela
    ocs: [13, 15, 24, 25, 37, 39],
  },
  {
    id: "pronta_entrega",
    titulo: "Pronta para entregar",
    acao: "Está na base ou liberada: colocar em rota e entregar.",
    tom: "emerald",
    // 14 entrega iniciada · 36 chegada na base para entrega
    // 55 autorizado para seguir pra entrega / entrega parcial
    ocs: [14, 36, 55],
  },
  {
    id: "reentrega_agendamento",
    titulo: "Reentrega / Agendamento",
    acao: "Cumprir a data combinada: reentrega, agendamento ou retirada na base.",
    tom: "amber",
    // 21 reentrega pedida · 22 retirada na base · 29 agendamento
    // 52 tratativa para retirada da carga
    ocs: [21, 22, 29, 52],
  },
  {
    id: "transferencia",
    titulo: "Transferência / Redespacho",
    acao: "Carga entre bases ou com parceiro: fazer chegar à base de entrega.",
    tom: "sky",
    // 4 atraso na coleta · 5 início de transferência · 7 chegada para conexão
    // 38 problema na transferência · 40 redespacho final · 48 custo inviável na transferência
    ocs: [4, 5, 7, 38, 40, 48],
  },
  {
    id: "comprovante",
    titulo: "Comprovante",
    acao: "Entregue, mas o comprovante está retido: conferir e baixar.",
    tom: "violet",
    // 12 comprovante retido para conferência
    ocs: [12],
  },
  {
    id: "informacao",
    titulo: "Informação / Cadastro",
    acao: "Falta ou sobra dado: completar a informação para seguir.",
    tom: "slate",
    // 41 informação complementar · 45 carga cubada · 50 manifestação indevida
    // 56 falta de informação operacional
    ocs: [41, 45, 50, 56],
  },
  {
    id: "outros",
    titulo: "Outros",
    acao: "Ocorrência sem família definida: olhar caso a caso.",
    tom: "none",
    ocs: [],
  },
];

const POR_OC = new Map<number, FamiliaId>();
for (const f of FAMILIAS_PROBLEMA) for (const oc of f.ocs) POR_OC.set(oc, f.id);

export function familiaDaOc(oc: number | null | undefined): FamiliaId {
  return (oc != null && POR_OC.get(oc)) || "outros";
}

export function familiaPorId(id: FamiliaId): FamiliaProblema {
  return FAMILIAS_PROBLEMA.find((f) => f.id === id)!;
}

/** Agrupa preservando a ordem de entrada (a fila já chega ordenada por tempo parado). */
export function agruparPorFamilia(linhas: readonly OpFilaLinha[]): Record<FamiliaId, OpFilaLinha[]> {
  const g = Object.fromEntries(FAMILIAS_PROBLEMA.map((f) => [f.id, [] as OpFilaLinha[]])) as Record<FamiliaId, OpFilaLinha[]>;
  for (const l of linhas) g[familiaDaOc(l.cod_ultima_ocorrencia)].push(l);
  return g;
}
