// =============================================================================
// FONTE ÚNICA DO EFEITO: "resposta de cliente acorda o card" (INV-042 / INV-067)
//
// Par do `decidirAcionamentoPorRespostaCliente` (que decide SE aciona). Este
// arquivo executa O QUE acontece quando aciona. Os dois SEMPRE andam juntos.
//
// POR QUE EXISTE (Caio 2026-08-11, após NFs 306856/74790/439189/5726093):
//   O efeito do acionamento vivia inline dentro do vinculador. Quando foi
//   preciso um segundo caller (o reconciliador de respostas pendentes), copiar
//   o bloco recriaria EXATAMENTE o bug que originou o INV-042 — o vinculador
//   tinha duas cópias divergentes da decisão e a divergência engoliu respostas.
//   Regra: quem precisar acordar um card por resposta de cliente CHAMA AQUI.
//   Nunca reimplemente o UPDATE de `cliente_respondeu_em` fora deste arquivo.
//
// Semântica preservada do vinculador (não mudar sem caso âncora):
//   • `cliente_respondeu_em` = agora → front rende o selo "📬 CLIENTE RESPONDEU"
//     mesmo se a IA falhar (Caio 2026-05-06).
//   • `ia_sugestao_oc_resposta` = null → sugestão antiga aponta pra mensagem
//     antiga; zerar sinaliza retry pro cron (Caio 2026-05-11, NF 920161).
//   • state só muda quando NÃO era AGUARDANDO_VALIDACAO_HUMANA — re-resposta em
//     card já em AVH atualiza carimbo sem mexer no estado (Caio 2026-05-19).
//   • chamada SÍNCRONA ao interpretador: fire-and-forget falhava em silêncio
//     (Caio 2026-05-06). Falha da IA não derruba o acionamento — o card já está
//     visível como respondido e o cron re-tenta em ≤1min.
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { atualizarPropostasAposRespostaCliente } from "./propostas-pos-resposta-cliente.ts";

// deno-lint-ignore no-explicit-any
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export interface AcionarRespostaClienteParams {
  cardId: string;
  /** `messages_inbox.id` da resposta que disparou. Null quando desconhecida. */
  messageId?: string | null;
  /** Estado do card ANTES do acionamento (vai pro evento de auditoria). */
  stateAnterior?: string | null;
  canal?: string | null;
  remetente?: string | null;
  /** Quem acionou: "vinculador" | "reconciliador-resposta-pendente" | … */
  actorId: string;
  motivoCancelamentoAgendadas?: string;
  /** Campos extras no payload do `RetornoClienteEmAguardo`. */
  payloadExtra?: Record<string, unknown>;
  /**
   * Move o card pra AGUARDANDO_VALIDACAO_HUMANA + lock?
   * Default: `stateAnterior !== "AGUARDANDO_VALIDACAO_HUMANA"` — a regra do
   * caminho por thread do vinculador, que cobre inclusive o terminal
   * transitório. O scan-email passa `false` fora de AGUARDANDO_CLIENTE de
   * propósito: lá o card pode estar em EXTRAVIO_MONITORADO/EM_TRIAGEM e mover
   * mudaria o fluxo de extravio, que ninguém pediu pra mexer.
   */
  moverParaValidacao?: boolean;
  /**
   * Chama o interpretador de forma SÍNCRONA? Default true (comportamento do
   * vinculador). O scan-email passa `false` porque re-enfileira a mensagem no
   * pipeline normal — lá a interpretação é assíncrona por decisão do Caio
   * (2026-06-23), fora do caminho crítico.
   */
  chamarInterpretador?: boolean;
}

export interface AcionarRespostaClienteResult {
  acoesCanceladas: number;
  propostas: unknown;
  interpretadorOk: boolean;
  stateNovo: string | null;
}

/**
 * Executa o acionamento completo. Idempotente por construção: rodar duas vezes
 * apenas re-carimba e re-interpreta (mesmo resultado), nunca duplica ação SSW.
 */
export async function acionarRespostaCliente(
  supabase: SupabaseClient,
  p: AcionarRespostaClienteParams,
): Promise<AcionarRespostaClienteResult> {
  const updatePayload: Record<string, unknown> = {
    cliente_respondeu_em: new Date().toISOString(),
    ia_sugestao_oc_resposta: null,
  };
  const mover = p.moverParaValidacao ?? (p.stateAnterior !== "AGUARDANDO_VALIDACAO_HUMANA");
  if (mover) {
    updatePayload.state = "AGUARDANDO_VALIDACAO_HUMANA";
    updatePayload.lock_aguardando_validacao = true;
    updatePayload.acao_executada_em = null;
  }
  await supabase.from("cards").update(updatePayload).eq("id", p.cardId);

  const { data: nCanc } = await supabase.rpc("cancelar_acoes_agendadas_do_card", {
    p_card_id: p.cardId,
    p_motivo: p.motivoCancelamentoAgendadas ?? "cliente respondeu",
  });

  const propostasInfo = await atualizarPropostasAposRespostaCliente(supabase, p.cardId);

  let interpretadorOk = false;
  if (p.chamarInterpretador !== false) {
    try {
      const iaResp = await fetch(
      `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/interpretador-resposta-cliente`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
          "apikey": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_id: p.cardId, message_id: p.messageId ?? undefined }),
        signal: AbortSignal.timeout(60_000),
      },
      );
      interpretadorOk = iaResp.ok;
      if (!iaResp.ok) {
      console.warn(
        `interpretador-resposta-cliente HTTP ${iaResp.status}: ${(await iaResp.text()).slice(0, 200)}`,
      );
    }
    } catch (err) {
      console.warn(
        `interpretador-resposta-cliente sync fetch falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await supabase.from("card_events").insert({
    card_id: p.cardId,
    event_type: "RetornoClienteEmAguardo",
    actor_type: "system",
    actor_id: p.actorId,
    payload: {
      message_id: p.messageId ?? null,
      previous_state: p.stateAnterior ?? null,
      new_state: mover ? "AGUARDANDO_VALIDACAO_HUMANA" : (p.stateAnterior ?? null),
      lock_aguardando_validacao: mover,
      canal: p.canal ?? null,
      remetente: p.remetente ?? null,
      acoes_canceladas: typeof nCanc === "number" ? nCanc : 0,
      propostas: propostasInfo,
      interpretador_disparado: p.chamarInterpretador !== false,
      ...(p.payloadExtra ?? {}),
    },
  });

  return {
    acoesCanceladas: typeof nCanc === "number" ? nCanc : 0,
    propostas: propostasInfo,
    interpretadorOk,
    stateNovo: mover ? "AGUARDANDO_VALIDACAO_HUMANA" : (p.stateAnterior ?? null),
  };
}
