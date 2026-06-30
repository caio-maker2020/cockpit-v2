// =============================================================================
// forcar-lancamento-ctrc-baixado.ts — injeta a flag de override da checagem (c)
// de localização do guard tripé no proposta_payload de um todo.
//
// Caio 2026-06-30 (NF 5631361): o agente autônomo de ressarcimento (round-trip
// 54→46→49) precisa relançar a oc 54 MESMO com o CTRC baixado/entregue — a
// entrega aconteceu, mas a tratativa de ressarcimento segue aberta. O executor já
// suporta isso lendo `proposta_payload.args.extras.forcar_lancamento_ctrc_baixado`
// (executor/index.ts:901) e repassando `permitirLocalizacaoBaixada` ao envelope.
//
// A flag dispensa SÓ a checagem (c) de localização. (a) CTRC e (b) NF do guard
// tripé (validar-tripe-ssw.ts) seguem validados e invioláveis (proteção NF 142371).
// NÃO é flag global — é por-todo, só para os todos que o detector confirmou como
// round-trip de ressarcimento.
// =============================================================================

/** Extras que autorizam o lançamento da oc 54 sobre CTRC baixado, no round-trip
 *  de ressarcimento (origem/motivo para auditoria). */
export const FORCAR_CTRC_BAIXADO_RESSARC54: Readonly<Record<string, unknown>> = {
  forcar_lancamento_ctrc_baixado: true,
  forcar_lancamento_origem: "ressarcimento_relancar_54",
  forcar_lancamento_motivo: "round-trip 54->46->49; ressarcimento em aberto",
};

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Retorna uma CÓPIA do proposta_payload com os `extras` de força mesclados em
 * `args.extras` (preserva tool/meta/args e quaisquer extras já existentes — ex.:
 * skip_evidencia). Não muta a entrada. Cobre tanto o todo novo quanto o reusado
 * do menu (que pode vir sem args/extras).
 */
export function aplicarForcarCtrcBaixado(
  payload: Record<string, unknown> | null | undefined,
  force: Record<string, unknown> = FORCAR_CTRC_BAIXADO_RESSARC54 as Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = ehObjeto(payload) ? { ...payload } : {};
  const args: Record<string, unknown> = ehObjeto(base["args"]) ? { ...(base["args"] as Record<string, unknown>) } : {};
  const extras: Record<string, unknown> = ehObjeto(args["extras"]) ? { ...(args["extras"] as Record<string, unknown>) } : {};
  args["extras"] = { ...extras, ...force };
  base["args"] = args;
  return base;
}

/** True se o payload já carrega a flag de força (idempotência — evita UPDATE à toa). */
export function jaForcaCtrcBaixado(payload: Record<string, unknown> | null | undefined): boolean {
  if (!ehObjeto(payload)) return false;
  const args = payload["args"];
  if (!ehObjeto(args)) return false;
  const extras = args["extras"];
  if (!ehObjeto(extras)) return false;
  return extras["forcar_lancamento_ctrc_baixado"] === true;
}
