// ============================================================================
// Cockpit v2 — regras do agente autônomo oc 43
// Duílio 2026-07-29
//
// Pedido: card em oc 43 ("manutenção perecível realizada" — Relacionamento)
// deve lançar autônomo:
//   - oc 49 (tratativa de relacionamento) se a oc IMEDIATAMENTE ANTERIOR à 43
//     no histórico do SSW ∈ OCS_ANTERIOR_LANCA_49 (avarias/extravios/recusas/
//     documentação/agendamento);
//   - oc 55 (autorizar seguir entrega) se a anterior for QUALQUER OUTRA.
//
// Decisões travadas com o operador (2026-07-29):
//   - Sem oc anterior (43 é a 1ª ocorrência) → NÃO lança, deixa pro humano.
//   - Se o SSW já não está mais em 43 (moveu) → NÃO lança (sync reconcilia).
//
// Função pura, testada em oc43-regras.test.ts. Não faz I/O.
// ============================================================================

import type { SswOcorrencia } from "./ssw-internal-client.ts";

/**
 * ocs que, imediatamente ANTES da 43, disparam lançamento de oc 49.
 * Lista literal do Duílio (2026-07-29):
 *   03 Avaria coleta · 06 Extravio transferência · 08 Avaria transferência
 *   09 Extravio coleta · 10 Recusa total · 11 Endereço · 13 Limitação cliente
 *   16 Extravio entrega · 17 Avaria entrega · 18 Sinistrada · 19 Falta volumes
 *   20 Extravio localizado · 23 Documentação · 31 Agendamento · 35 Recusa parcial
 * Qualquer outra oc anterior → oc 55.
 */
export const OCS_ANTERIOR_LANCA_49: ReadonlySet<number> = new Set([
  3, 6, 8, 9, 10, 11, 13, 16, 17, 18, 19, 20, 23, 31, 35,
]);

export const OC_ALVO_43 = 43 as const;

/**
 * Finalizadoras (entregue/baixado/fechado) — se o SSW chegou numa dessas DEPOIS
 * da 43, o lançamento não faz mais sentido (mesmas do OCS_FINALIZADORAS do
 * bastao-rules: 1=entregue, 30, 32).
 */
export const OCS_FINALIZADORAS_POS43: ReadonlySet<number> = new Set([1, 30, 32]);

export type DecisaoOc43 =
  | { acao: "lancar_49"; ocAnterior: number; ocAnteriorDesc: string }
  | { acao: "lancar_55"; ocAnterior: number; ocAnteriorDesc: string }
  | {
    acao: "sem_acao";
    motivo: "sem_oc_anterior" | "oc_pos43_bloqueia" | "sem_oc_43_no_ssw";
    ocRealSsw: number | null;
  };

/**
 * A oc mais recente do SSW (quando ≠ 43) BLOQUEIA o lançamento autônomo?
 * Bloqueia se, depois da 43, o CTRC virou PROBLEMA (∈ OCS_ANTERIOR_LANCA_49 —
 * extravio/avaria/recusa/documentação/...) ou já FINALIZOU (entregue/baixado).
 * TRÂNSITO benigno (5=viagem, 7=chegada, 14=entrega iniciada, 40=redespacho,
 * emissão, etc.) NÃO bloqueia — a 55 é lançada e o tripé barra só os entregues.
 * Duílio 2026-07-31.
 */
export function bloqueiaPos43(oc: number): boolean {
  return OCS_ANTERIOR_LANCA_49.has(oc) || OCS_FINALIZADORAS_POS43.has(oc);
}

/**
 * Acha a oc imediatamente anterior à 43 mais recente no histórico do SSW.
 * `ocs` vem most-recent-first (mesma ordem que `listarOcorrenciasNF`
 * devolve: índice 0 = ocorrência mais recente).
 * Localiza a 43 mais recente e desce pulando 43s repetidas / nulas, devolvendo
 * o primeiro código != 43. Devolve null se a 43 é a primeira (nada antes).
 */
export function acharOcAnteriorA43(
  ocs: readonly SswOcorrencia[],
): { codigo: number; descricao: string } | null {
  const idx43 = ocs.findIndex((o) => o.codigo === OC_ALVO_43);
  if (idx43 === -1) return null;
  for (let i = idx43 + 1; i < ocs.length; i++) {
    const o = ocs[i];
    if (o && o.codigo != null && o.codigo !== OC_ALVO_43) {
      return { codigo: o.codigo, descricao: o.descricao };
    }
  }
  return null;
}

/**
 * Código da ocorrência mais recente no SSW (primeira com código não-nulo).
 * Usado pra reconferir que o card AINDA está em 43 antes de agir (guard de
 * corrida: card=43 no nosso DB mas SSW já avançou → não age).
 */
export function ocRealMaisRecente(ocs: readonly SswOcorrencia[]): number | null {
  const primeira = ocs.find((o) => o.codigo != null);
  return primeira?.codigo ?? null;
}

/**
 * Decide a ação do agente oc 43 a partir do histórico bruto do SSW.
 * Reconfere no SSW ao vivo (não confia no cod_ultima_ocorrencia do card).
 */
export function decidirOc43DoHistorico(ocs: readonly SswOcorrencia[]): DecisaoOc43 {
  const ocReal = ocRealMaisRecente(ocs);
  if (ocReal == null) {
    return { acao: "sem_acao", motivo: "sem_oc_43_no_ssw", ocRealSsw: null };
  }
  // Precisa existir uma 43 no histórico pra decidir pela oc anterior a ela.
  if (!ocs.some((o) => o.codigo === OC_ALVO_43)) {
    return { acao: "sem_acao", motivo: "sem_oc_43_no_ssw", ocRealSsw: ocReal };
  }
  // Guard pós-43 (Duílio 2026-07-31): a decisão é pela oc ANTES da 43, mas se
  // DEPOIS da 43 o SSW virou PROBLEMA ou já FINALIZOU (entregue) → não age.
  // Trânsito normal depois da 43 NÃO bloqueia — lança a 55 assim mesmo.
  if (ocReal !== OC_ALVO_43 && bloqueiaPos43(ocReal)) {
    return { acao: "sem_acao", motivo: "oc_pos43_bloqueia", ocRealSsw: ocReal };
  }
  const anterior = acharOcAnteriorA43(ocs);
  if (anterior == null) {
    return { acao: "sem_acao", motivo: "sem_oc_anterior", ocRealSsw: ocReal };
  }
  if (OCS_ANTERIOR_LANCA_49.has(anterior.codigo)) {
    return { acao: "lancar_49", ocAnterior: anterior.codigo, ocAnteriorDesc: anterior.descricao };
  }
  return { acao: "lancar_55", ocAnterior: anterior.codigo, ocAnteriorDesc: anterior.descricao };
}

/**
 * Texto (instrução SSW) do lançamento autônomo. Vai no campo `descricao` do
 * `lancar_ocorrencia` → Instrução (portal opção 101, latin-1 no submit).
 * Mantido curto e factual. Caio pode ajustar — em shadow mode o texto aparece
 * na recomendação antes de qualquer submit real.
 */
export function textoInstrucaoOc43(
  acao: "lancar_49" | "lancar_55",
  ocAnterior: number,
  ocAnteriorDesc: string,
): string {
  const contexto = `apos oc 43 (manutencao de pereciveis) precedida de oc ${ocAnterior}` +
    (ocAnteriorDesc ? ` (${ocAnteriorDesc})` : "");
  if (acao === "lancar_49") {
    return `Tratativa de relacionamento aberta automaticamente ${contexto}.`;
  }
  return `Autorizado seguir com a entrega ${contexto}.`;
}

/**
 * Monta o `proposta_payload` do lançamento autônomo (49 ou 55) via
 * `lancar_ocorrencia` → executor → envelope `lancarSswPortal` (tripé +
 * idempotência). Espelha a forma do agente-oc13-autonomo.
 *
 * `extras.origem/oc_anterior/acao` são flags INTERNAS — não vazam pra Instrução
 * SSW porque o executor só copia a whitelist EXTRAS_PRA_DESCRICAO_SSW
 * (quantidade_volumes/motivo/filial/texto_complementar). O texto real da oc vai
 * em `args.descricao` (via textoInstrucaoOc43).
 */
export function montarPropostaOc43(params: {
  codigoSsw: 49 | 55;
  nf: string | null;
  cnpjRemetente: string | null;
  ocAnterior: number;
  ocAnteriorDesc: string;
}): Record<string, unknown> {
  const acao = params.codigoSsw === 49 ? "lancar_49" : "lancar_55";
  const descricao = textoInstrucaoOc43(acao, params.ocAnterior, params.ocAnteriorDesc);
  return {
    tool: "lancar_ocorrencia",
    args: {
      codigo_ssw: params.codigoSsw,
      nf: params.nf,
      cnpj_remetente: params.cnpjRemetente,
      descricao,
      extras: {
        origem: "agente-oc43-autonomo",
        oc_anterior: params.ocAnterior,
        acao,
      },
    },
    rationale:
      `Decisão autônoma agente-oc43-autonomo: oc 43 precedida de oc ${params.ocAnterior} → ${acao}.`,
    texto: null,
  };
}
