// Caio 2026-06-10 (NF 156022 OVD/DUILIO): guard de idempotência pra evitar
// reenvio de email quando executor retenta (PGMQ retry, falha SSW pós-email,
// re-aprovação após AcaoRevertidaPosFalha). REGRA: 1 email por todo_id, ponto.
//
// Quando o guard detecta envio prévio, o fluxo continua SEM chamar Gmail API
// — o SSW é lançado normalmente. Cliente recebe 1 email só, mesmo que a oc
// precise ser relançada N vezes por falha técnica.
//
// Cenário-âncora: NF 156022 09/06 — bug `env is not defined` no executor
// causou 3 retries do PGMQ + 1 re-aprovação manual = 4 emails idênticos pro
// cliente. Esse guard impede definitivamente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { hhmmBRT } from "./brt.ts";

type SupabaseClient = ReturnType<typeof createClient>;

export interface EmailJaEnviado {
  gmail_message_id: string;
  gmail_thread_id: string;
  to_email: string | null;
  subject: string | null;
  sent_at: string;
}

/**
 * Verifica se já saiu email pra este todo_id. Retorna o registro do envio
 * anterior se existir, ou null caso contrário.
 *
 * O guard só dá hit pra todos com `todo_id != null` — fluxos legados sem
 * todo_id (raros) seguem comportamento antigo.
 */
export async function verificarEmailJaEnviado(
  supabase: SupabaseClient,
  todoId: string | null | undefined,
): Promise<EmailJaEnviado | null> {
  if (!todoId) return null;

  const { data, error } = await supabase
    .from("cards_emails_outbound")
    .select("gmail_message_id, gmail_thread_id, to_email, subject, sent_at")
    .eq("todo_id", todoId)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[email-idempotencia] lookup falhou pra todo ${todoId}: ${error.message}`);
    return null;
  }

  return (data as EmailJaEnviado | null) ?? null;
}

/**
 * Grava `RespostaEnviadaSkipReenvio` event quando o guard impediu o reenvio.
 * Mantém rastreabilidade no histórico do card pra que operadora veja que o
 * sistema preservou o email original.
 */
export async function registrarEmailSkipReenvio(
  supabase: SupabaseClient,
  params: {
    card_id: string;
    todo_id: string;
    envio_anterior: EmailJaEnviado;
    motivo: string;
  },
): Promise<void> {
  await supabase.from("card_events").insert({
    card_id: params.card_id,
    event_type: "RespostaEnviadaSkipReenvio",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: params.todo_id,
      motivo: params.motivo,
      envio_anterior: {
        gmail_message_id: params.envio_anterior.gmail_message_id,
        gmail_thread_id: params.envio_anterior.gmail_thread_id,
        to_email: params.envio_anterior.to_email,
        subject: params.envio_anterior.subject,
        sent_at: params.envio_anterior.sent_at,
      },
    },
  });
}

/**
 * Formata sufixo informativo pro `rejection_reason` quando o email já foi
 * enviado mas a oc no SSW falhou. Deixa explícito pra operadora que ao
 * re-aprovar, o email NÃO sai de novo — só o SSW é relançado.
 */
export function sufixoRejeicaoEmailJaEnviado(envio: EmailJaEnviado): string {
  const hhmm = `${hhmmBRT(new Date(envio.sent_at).getTime())} BRT`;
  return (
    ` EMAIL JÁ FOI ENVIADO pro cliente${envio.to_email ? ` (${envio.to_email})` : ""}` +
    ` em ${hhmm}. Ao reaprovar, o email NÃO será reenviado — apenas a ocorrência` +
    ` será relançada no SSW.`
  );
}
