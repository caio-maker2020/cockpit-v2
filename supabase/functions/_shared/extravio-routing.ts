// =============================================================================
// extravio-routing — decisão PURA de DESTINO de um card de extravio quando a
// ocorrência ATUAL (verdade do SSW) é conhecida.
//
// Caio 2026-06-24 (REGRA INVIOLÁVEL da aba EXTRAVIOS): um card só pode ficar em
// EXTRAVIO_MONITORADO enquanto a ocorrência ATUAL é 6/9/16. Trocou a oc → o card
// SAI da aba, roteado pela RESPONSABILIDADE da nova oc. A aba mostra só extravios.
//
// Fonte única (INV-008): NÃO duplica o mapa oc→state. Delega a
// `stateFinalAposBastao` (bastao-rules) pra tudo que não é extravio; só adiciona
// a regra "6/9/16 fica na aba". Assim o roteamento de saída do extravio é, por
// construção, idêntico ao do resto do sistema (Pass A, AGUARDANDO_CLIENTE, etc).
//
// Usado por:
//   - reconciliar-extravios-bastao.ts (saída da aba pela verdade do Bastão por NF)
//   - atualizar-card-via-portal-ssw (botão "Forçar Atualização", via SSW)
// =============================================================================

import { stateFinalAposBastao } from "./bastao-rules.ts";

/** Ocorrências de extravio (responsabilidade Perdas). Enquanto a oc atual for
 *  uma destas, o card fica na aba EXTRAVIOS (state EXTRAVIO_MONITORADO). */
export const EXTRAVIO_OCS: ReadonlySet<number> = new Set([6, 9, 16]);

export type DecisaoExtravio =
  | "extravio" // oc ainda 6/9/16 → fica na aba
  | "resolvido" // oc finalizadora (1/30/32) → RESOLVIDO
  | "aguardando_voce" // oc de relacionamento (20/49/54/...) → AGUARDANDO VOCÊ / CLIENTE
  | "transferido"; // oc de outro setor (33/...) → TRANSFERIDO

export interface DestinoExtravio {
  decisao: DecisaoExtravio;
  /** state alvo do card. */
  state: string;
  /** lock_aguardando_validacao alvo. */
  lock: boolean;
}

/**
 * Decide pra onde vai um card de extravio dada a ocorrência ATUAL (verdade do
 * SSW). Puro — sem side-effects nem I/O.
 *
 * @param ocAtual  última ocorrência real (do portal SSW interno).
 * @param temRegra `REGRAS_AUTO_ACAO[ocAtual] != null` — decide, quando a nova oc
 *   é de relacionamento, entre AGUARDANDO_VALIDACAO_HUMANA+lock (tem propostas)
 *   e AGUARDANDO_AGENTE (sem regra). Passado pelo caller pra manter este módulo
 *   leve (sem importar REGRAS_AUTO_ACAO).
 */
export function decidirDestinoExtravio(
  ocAtual: number,
  temRegra: boolean,
): DestinoExtravio {
  if (EXTRAVIO_OCS.has(ocAtual)) {
    return { decisao: "extravio", state: "EXTRAVIO_MONITORADO", lock: false };
  }
  const final = stateFinalAposBastao(ocAtual, temRegra);
  const decisao: DecisaoExtravio = final.state === "RESOLVIDO"
    ? "resolvido"
    : final.state === "TRANSFERIDO"
    ? "transferido"
    // AGUARDANDO_VALIDACAO_HUMANA | AGUARDANDO_AGENTE | AGUARDANDO_CLIENTE (oc=54)
    : "aguardando_voce";
  return { decisao, state: final.state, lock: final.lock };
}
