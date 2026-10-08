// =============================================================================
// FAMÍLIA DO PROBLEMA — o que a Operação precisa fazer com a nota, derivado da
// última ocorrência (cod_ultima_ocorrencia). É a visão principal do kanban.
//
// Famílias REDEFINIDAS pelo Caio em 08/10/2026 (dono do produto), substituindo a
// semântica inferida do dicionário na proposta original do PR #41:
//   - "Pronta para entregar" junta tudo cuja próxima ocorrência natural é a 14
//     (saída para entrega): 13, 15, 55, 21, 7, 36, 39.
//   - "Agendamento" é só a 29.
//   - "Necessita informação" é só a 56; a próxima ocorrência quase sempre é a 49,
//     devolvendo ao Relacionamento a informação que falta.
//   - "Comprovante retido" (12), "Redespacho" (40) e "Informação" (41) ficam sós.
//   - "Entrega impossível" NÃO se aplica (removida).
//   - O resto (4, 5, 14, 22, 24, 25, 27, 37, 38, 45, 48, 50, 51, 52) cai em "Outros"
//     por decisão explícita — o teste trava a lista. A 14 (entrega iniciada) é a
//     PRÓXIMA oc de "Pronta para entregar", não uma família: nota em 14 já saiu.
// Tabela PURA; teste trava: nenhum código em duas famílias, e todo código da
// Operação do dicionário tem família ou está na lista explícita de "Outros".
// =============================================================================
import type { Tone } from "@/components/cockpit/tones";
import type { OpFilaLinha } from "./tipos";

export type FamiliaId =
  | "pronta_entrega"
  | "agendamento"
  | "necessita_informacao"
  | "comprovante"
  | "redespacho"
  | "informacao"
  | "outros";

export interface FamiliaProblema {
  id: FamiliaId;
  titulo: string;
  /** Uma linha: o que a Operação faz com estas notas. */
  acao: string;
  tom: Tone;
  ocs: readonly number[];
  /** A ocorrência que naturalmente vem a seguir (quando a família tem uma). */
  proximaOc?: number;
}

export const FAMILIAS_PROBLEMA: readonly FamiliaProblema[] = [
  {
    id: "pronta_entrega",
    titulo: "Pronta para entregar",
    acao: "Colocar em rota: a próxima ocorrência natural é a 14 (saída para entrega).",
    tom: "emerald",
    // 13 limitação cliente · 15 limitação da base · 55 autorizado a seguir
    // 21 reentrega solicitada · 7 chegada na base para conexão
    // 36 chegada na base para entrega · 39 problema com janela
    ocs: [13, 15, 55, 21, 7, 36, 39],
    proximaOc: 14,
  },
  {
    id: "agendamento",
    titulo: "Agendamento",
    acao: "Cumprir a data agendada com o cliente.",
    tom: "amber",
    // 29 agendamento de entrega
    ocs: [29],
  },
  {
    id: "necessita_informacao",
    titulo: "Necessita informação",
    acao: "Falta informação operacional: na maioria das vezes vira 49, devolvendo ao Relacionamento o que falta.",
    tom: "sal",
    // 56 falta de informação operacional ou indevida
    ocs: [56],
    proximaOc: 49,
  },
  {
    id: "comprovante",
    titulo: "Comprovante retido",
    acao: "Entregue, mas o comprovante está retido: conferir e baixar.",
    tom: "violet",
    // 12 comprovante retido para conferência
    ocs: [12],
  },
  {
    id: "redespacho",
    titulo: "Redespacho",
    acao: "Carga com parceiro de redespacho: acompanhar até a entrega final.",
    tom: "sky",
    // 40 redespacho final
    ocs: [40],
  },
  {
    id: "informacao",
    titulo: "Informação",
    acao: "Informação complementar registrada: conferir se exige ação.",
    tom: "slate",
    // 41 informação complementar
    ocs: [41],
  },
  {
    id: "outros",
    titulo: "Outros",
    acao: "Ocorrência sem família definida: olhar caso a caso.",
    tom: "none",
    ocs: [],
  },
];

/** Códigos da Operação que ficam em "Outros" DE PROPÓSITO (Caio 08/10). */
export const OCS_EM_OUTROS_DE_PROPOSITO: readonly number[] = [4, 5, 14, 22, 24, 25, 27, 37, 38, 45, 48, 50, 51, 52];

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
