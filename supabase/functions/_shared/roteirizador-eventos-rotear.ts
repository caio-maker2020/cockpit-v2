// =============================================================================
// roteirizador-eventos-rotear — decisão PURA de roteamento dos eventos da ponte
// (GET /v3/ponte/eventos) para o Cockpit. ADR 0034.
//
// Classes:
//   ALERTA   = nota_removida / nota_nao_coube COM motivo (a nota não vai ser
//              entregue como planejado — o Relacionamento precisa saber antes
//              da ocorrência chegar pelo SSW/Bastão).
//   CONTEXTO = rota_aprovada, nota_seguida, nota_fora_da_doca, e removida/
//              nao_coube SEM motivo — só enriquece o card ("saiu hoje no carro X").
//   IGNORADO = tipo fora do contrato ou evento sem CTRC.
//
// Destino:
//   card ATIVO com o CTRC  → card_event no card (ALERTA: RoteirizadorAlertaRota;
//                            CONTEXTO: RoteirizadorContextoRota). Não muda state.
//   sem card ativo, ALERTA → fica registrado como `aguardando_card` e é anexado
//                            quando o card do CTRC aparecer (janela de 72h).
//   sem card, CONTEXTO     → `sem_card` (registrado, nada a anexar).
//
// POR QUE NÃO ABRIR CARD / NÃO MANDAR PRO INTAKE (triador/vinculador):
//   - INV-001 + ADR 0004: card nasce do Bastão (16 ocs de relacionamento) ou de
//     MENSAGEM DO CLIENTE. Evento da rota não é nenhum dos dois; empurrá-lo como
//     "mensagem" pro triador fabricaria card com texto sintético, fora do
//     escopo do Relacionamento, e sem guard anti-loop (INV-040).
//   - Nota removida da rota vira ocorrência no SSW (lançada pela base) → o
//     Bastão traz o card se for de relacionamento → o alerta pendente é anexado.
//   - Terminal não ressuscita (INV-042): só card ATIVO recebe evento.
// =============================================================================

import type { EventoPonte } from "./roteirizador-ponte-client.ts";

export const EVENTO_CARD_ALERTA = "RoteirizadorAlertaRota" as const;
export const EVENTO_CARD_CONTEXTO = "RoteirizadorContextoRota" as const;

export const TIPOS_EVENTO_CONHECIDOS = new Set([
  "rota_aprovada",
  "nota_seguida",
  "nota_removida",
  "nota_nao_coube",
  "nota_fora_da_doca",
]);

/** Estados em que o card NÃO recebe evento da ponte (terminal não ressuscita). */
export const STATES_TERMINAIS_PONTE = ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"] as const;

/** Janela pra anexar alerta pendente num card que apareceu depois. */
export const JANELA_ALERTA_PENDENTE_HORAS = 72;

export type ClasseEvento = "alerta" | "contexto" | "ignorado";
export type SituacaoLinha = "aplicado" | "aguardando_card" | "sem_card" | "ignorado";

export function normalizarCtrc(ctrc: string | null | undefined): string | null {
  const s = (ctrc ?? "").trim().toUpperCase();
  return s ? s : null;
}

export function classificarEvento(ev: Pick<EventoPonte, "tipo" | "motivo">): ClasseEvento {
  if (!TIPOS_EVENTO_CONHECIDOS.has(String(ev.tipo))) return "ignorado";
  const temMotivo = typeof ev.motivo === "string" && ev.motivo.trim().length > 0;
  if ((ev.tipo === "nota_removida" || ev.tipo === "nota_nao_coube") && temMotivo) return "alerta";
  return "contexto";
}

/** CTRCs que o evento toca (rota_aprovada: `ctrcs`; demais: `ctrc`). Dedupe + normaliza. */
export function ctrcsDoEvento(ev: Pick<EventoPonte, "tipo" | "ctrc" | "ctrcs">): string[] {
  const brutos = ev.tipo === "rota_aprovada"
    ? [...(Array.isArray(ev.ctrcs) ? ev.ctrcs : []), ...(ev.ctrc ? [ev.ctrc] : [])]
    : [ev.ctrc];
  const out = new Set<string>();
  for (const c of brutos) {
    const n = normalizarCtrc(c);
    if (n) out.add(n);
  }
  return [...out];
}

export interface LinhaEvento {
  eventoId: number;
  /** '' quando o evento não traz CTRC (linha só pra registrar o ignorado). */
  ctrc: string;
  classe: ClasseEvento;
  cardId: string | null;
  /** null = não grava card_event agora. */
  cardEventType: typeof EVENTO_CARD_ALERTA | typeof EVENTO_CARD_CONTEXTO | null;
  cardEventPayload: Record<string, unknown> | null;
  situacao: SituacaoLinha;
}

export function payloadCardEvent(ev: EventoPonte, ctrc: string, classe: ClasseEvento): Record<string, unknown> {
  return {
    origem: "ponte_roteirizador",
    evento_id: ev.id,
    tipo: ev.tipo,
    classe,
    ctrc,
    data_ref: ev.dataRef ?? null,
    rota_nome: ev.rotaNome ?? null,
    motivo: ev.motivo ?? null,
    foto_evidencia_url: ev.fotoEvidenciaUrl ?? null,
    ator: ev.ator ?? null,
    ...(ev.tipo === "rota_aprovada" ? { total_notas_na_rota: ctrcsDoEvento(ev).length } : {}),
  };
}

/**
 * Pura: evento + mapa CTRC→card ativo → linhas a gravar (1 por CTRC tocado).
 * `cardAtivoPorCtrc` só deve conter cards fora de STATES_TERMINAIS_PONTE.
 */
export function rotearEvento(ev: EventoPonte, cardAtivoPorCtrc: Map<string, string>): LinhaEvento[] {
  const classe = classificarEvento(ev);
  const ctrcs = ctrcsDoEvento(ev);
  if (classe === "ignorado" || ctrcs.length === 0) {
    return [{
      eventoId: ev.id, ctrc: ctrcs[0] ?? "", classe: "ignorado", cardId: null,
      cardEventType: null, cardEventPayload: null, situacao: "ignorado",
    }];
  }
  return ctrcs.map((ctrc) => {
    const cardId = cardAtivoPorCtrc.get(ctrc) ?? null;
    const payload = payloadCardEvent(ev, ctrc, classe);
    if (cardId) {
      return {
        eventoId: ev.id, ctrc, classe, cardId,
        cardEventType: classe === "alerta" ? EVENTO_CARD_ALERTA : EVENTO_CARD_CONTEXTO,
        cardEventPayload: payload,
        situacao: "aplicado" as const,
      };
    }
    return {
      eventoId: ev.id, ctrc, classe, cardId: null,
      cardEventType: null,
      // O payload vai junto pra linha pendente: é o que será anexado depois.
      cardEventPayload: classe === "alerta" ? payload : null,
      situacao: classe === "alerta" ? "aguardando_card" as const : "sem_card" as const,
    };
  });
}

/**
 * Pura: próximo cursor. Só avança se TODAS as linhas da página foram gravadas;
 * nunca anda pra trás; ignora `proximo` menor que o atual.
 */
export function proximoCursor(atual: number, pagina: { proximo: number }, todasGravadas: boolean): number {
  if (!todasGravadas) return atual;
  return Number.isFinite(pagina.proximo) && pagina.proximo > atual ? pagina.proximo : atual;
}
