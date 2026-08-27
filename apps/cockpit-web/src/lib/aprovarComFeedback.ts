// =============================================================================
// aprovarComFeedback — wrapper da RPC aprovar_e_executar (Caio 27/08).
//
// Quando o agente NÃO reconheceu a 49, a RPC recusa com
// FEEDBACK_OC49_OBRIGATORIO. Este wrapper: detecta o erro → abre o modal
// obrigatório (4 perguntas) → registrado o feedback, RE-TENTA a aprovação —
// tudo numa jornada só (~20s). Qualquer outro erro passa direto pro caller.
// Uso: substituir `supabase.rpc("aprovar_e_executar", params)` por
// `aprovarEExecutarComFeedback(params)` — assinatura de retorno idêntica.
// =============================================================================
import { supabase } from "@/lib/supabase";
import { useFeedbackOc49Store } from "@/stores/useFeedbackOc49Store";

export const MARCA_FEEDBACK_OBRIGATORIO = "FEEDBACK_OC49_OBRIGATORIO";

interface ParamsAprovar {
  p_todo_id: string;
  p_extras?: Record<string, unknown>;
}

export async function aprovarEExecutarComFeedback(
  params: ParamsAprovar,
): Promise<{ data: unknown; error: { message: string } | null }> {
  if (!supabase) return { data: null, error: { message: "Supabase indisponível" } };
  const r1 = await supabase.rpc("aprovar_e_executar", params as never);
  if (!r1.error || !r1.error.message?.includes(MARCA_FEEDBACK_OBRIGATORIO)) {
    return { data: r1.data ?? null, error: r1.error ?? null };
  }

  // trava disparou → resolve card/NF pelo todo e abre o modal obrigatório
  const { data: todo } = await supabase
    .from("todos").select("card_id").eq("id", params.p_todo_id).maybeSingle();
  const cardId = (todo as { card_id?: string } | null)?.card_id ?? null;
  if (!cardId) return { data: null, error: r1.error };
  const { data: card } = await supabase
    .from("cards").select("nf").eq("id", cardId).maybeSingle();
  const nf = (card as { nf?: string } | null)?.nf ?? "?";

  const registrou = await useFeedbackOc49Store.getState().abrir(cardId, nf);
  if (!registrou) {
    return { data: null, error: { message: "Aprovação cancelada — o feedback do caso é obrigatório." } };
  }
  const r2 = await supabase.rpc("aprovar_e_executar", params as never);
  return { data: r2.data ?? null, error: r2.error ?? null };
}
