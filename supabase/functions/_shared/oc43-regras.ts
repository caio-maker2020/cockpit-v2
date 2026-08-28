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

// ============================================================================
// REGRA V2 (Caio 2026-08-28) — substitui o ramo-49 genérico. Plano aprovado:
//
//   anterior ∈ {6,9,16} (extravio)      → EXTRAVIO_MONITORADO com o relógio
//                                          contando da DATA DO EXTRAVIO original
//                                          (nada é lançado; o fluxo de extravio
//                                          — D4/prazo de perdas — assume);
//   anterior ∈ OCS_RELANCA_POS_43       → RELANÇA A MESMA oc, herdando a
//                                          instrução original + sufixo rastreável.
//                                          49 relançada herda o texto da 49
//                                          original (nunca o carimbo); 54/59
//                                          relançam SEM e-mail (já foi enviado);
//                                          a leitura de evidência acha a foto da
//                                          linha ORIGINAL por construção
//                                          (verificar-evidencia, caso NF 29326);
//   anterior operacional/trânsito       → 55 (igual hoje);
//   sem anterior / SSW saiu da 43       → sem ação (igual hoje).
//
// Exceção deliberada do Caio (ADR): esta automação PODE relançar oc de
// relacionamento — a regra "Cockpit nunca lança oc de relacionamento" vale pro
// agente de SUGESTÕES, não pra este trilho.
// ============================================================================

/** Extravios: nada de lançamento — volta pro trilho de extravio monitorado. */
export const OCS_EXTRAVIO_POS43: ReadonlySet<number> = new Set([6, 9, 16]);

/** Anteriores que RELANÇAM a própria oc (relacionamento + 13/31 por ordem do
 *  Caio 28/08 — B1/B2/B3). */
export const OCS_RELANCA_POS_43: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 13, 17, 18, 19, 20, 23, 26, 28, 31, 35, 49, 54, 57, 59,
]);

/** Relançamentos de 54/59 NUNCA reenviam e-mail (B3 — cliente já notificado). */
export const OCS_RELANCA_SEM_EMAIL: ReadonlySet<number> = new Set([54, 59]);

export const SUFIXO_RELANCAMENTO_43 = " — RELANCADA POS MANUTENCAO PERECIVEL (OC 43)";

export type DecisaoOc43V2 =
  | { acao: "relancar"; oc: number; instrucaoOriginal: string; textoLancamento: string; ocAnteriorDesc: string }
  | { acao: "lancar_55"; ocAnterior: number; ocAnteriorDesc: string }
  | { acao: "extravio_monitorado"; ocExtravio: number; dataOriginal: string; descricao: string }
  | DecisaoOc43 & { acao: "sem_acao" };

/** Igual a acharOcAnteriorA43, mas devolve a ocorrência INTEIRA (instrução,
 *  data) — a v2 precisa herdar texto e relógio da original. */
export function acharOcAnteriorA43Full(
  ocs: readonly SswOcorrencia[],
): SswOcorrencia | null {
  const idx43 = ocs.findIndex((o) => o.codigo === OC_ALVO_43);
  if (idx43 === -1) return null;
  for (let i = idx43 + 1; i < ocs.length; i++) {
    const o = ocs[i];
    if (o && o.codigo != null && o.codigo !== OC_ALVO_43) return o;
  }
  return null;
}

/** Sanitiza a instrução herdada: remove HTML/comentários do portal e limita
 *  ao espaço do campo Instrução (500 - sufixo). */
function herdarInstrucao(instrucao: string, descricao: string): string {
  const limpa = (instrucao || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = limpa.length >= 4 ? limpa : (descricao || "").trim();
  const teto = 500 - SUFIXO_RELANCAMENTO_43.length;
  return base.slice(0, Math.max(0, teto));
}

export function decidirOc43V2(ocs: readonly SswOcorrencia[]): DecisaoOc43V2 {
  const ocReal = ocRealMaisRecente(ocs);
  if (ocReal == null) {
    return { acao: "sem_acao", motivo: "sem_oc_43_no_ssw", ocRealSsw: null };
  }
  if (!ocs.some((o) => o.codigo === OC_ALVO_43)) {
    return { acao: "sem_acao", motivo: "sem_oc_43_no_ssw", ocRealSsw: ocReal };
  }
  if (ocReal !== OC_ALVO_43 && bloqueiaPos43(ocReal)) {
    return { acao: "sem_acao", motivo: "oc_pos43_bloqueia", ocRealSsw: ocReal };
  }
  const anterior = acharOcAnteriorA43Full(ocs);
  if (anterior == null || anterior.codigo == null) {
    return { acao: "sem_acao", motivo: "sem_oc_anterior", ocRealSsw: ocReal };
  }
  if (OCS_EXTRAVIO_POS43.has(anterior.codigo)) {
    return {
      acao: "extravio_monitorado",
      ocExtravio: anterior.codigo,
      dataOriginal: anterior.data,
      descricao: anterior.descricao,
    };
  }
  if (OCS_RELANCA_POS_43.has(anterior.codigo)) {
    const instrucaoOriginal = herdarInstrucao(anterior.instrucao, anterior.descricao);
    return {
      acao: "relancar",
      oc: anterior.codigo,
      instrucaoOriginal,
      textoLancamento: instrucaoOriginal + SUFIXO_RELANCAMENTO_43,
      ocAnteriorDesc: anterior.descricao,
    };
  }
  return { acao: "lancar_55", ocAnterior: anterior.codigo, ocAnteriorDesc: anterior.descricao };
}
