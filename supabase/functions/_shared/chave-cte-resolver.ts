// =============================================================================
// chave-cte-resolver — helper canônico pra resolver e persistir chave_cte
// no agent_state do card.
//
// Regra Caio 2026-05-06: TODO card criado (qualquer fonte: Bastão, tracking
// SSW, vinculador) deve passar por aqui imediatamente após INSERT. Se NF +
// CNPJ_pagador disponíveis → lookup em `nf_chave_cte` (RPA OPC 455).
//   - Achou: popula `agent_state.chave_cte` + `sem_chave_cte=false`
//   - Não achou: `sem_chave_cte=true` + card_event documentando
// Sem chave → executor não consegue lançar oc no SSW. RPC aprovar_e_executar
// agora bloqueia aprovação quando sem_chave_cte=true (migration 052).
//
// Pass F do sync-bastao chama esse helper periodicamente em cards
// `sem_chave_cte=true` pra resolver chaves que o RPA importou depois.
//
// Reusa: RPC `lookup_chave_cte` em migration 020 (com normalização CNPJ).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface ResolverChaveCteResult {
  chave: string | null;
  semChaveCte: boolean;
  jaTinha: boolean;
}

/**
 * Tenta resolver chave_cte pra um card. Idempotente — se já tem chave
 * em agent_state, pula. Atualiza tabela cards (agent_state.chave_cte +
 * sem_chave_cte) e registra card_event.
 */
export async function resolverEPersistirChaveCte(
  supabase: SupabaseClient,
  cardId: string,
  nf: string | null,
  cnpjPagador: string | null,
  agentStateAtual: Record<string, unknown> | null,
): Promise<ResolverChaveCteResult> {
  const agentState = agentStateAtual ?? {};
  const chaveExistente = agentState["chave_cte"] as string | undefined;

  // Idempotência: se já tem chave válida no agent_state, não mexe.
  if (chaveExistente && chaveExistente.length > 0) {
    return { chave: chaveExistente, semChaveCte: false, jaTinha: true };
  }

  // Sem dados pra lookup — marca sem_chave_cte=true
  if (!nf || !cnpjPagador) {
    await supabase
      .from("cards")
      .update({ sem_chave_cte: true })
      .eq("id", cardId);
    return { chave: null, semChaveCte: true, jaTinha: false };
  }

  let chave: string | null = null;
  try {
    const { data } = await supabase.rpc("lookup_chave_cte", {
      p_nf: nf,
      p_cnpj_pagador: cnpjPagador,
    });
    // RPC retorna TABLE(chave_cte, cnpj_remetente, cnpj_destinatario, ctrc,
    // data_emissao) — pode vir como array de records ou record único.
    const row = Array.isArray(data) ? data[0] : data;
    if (row && typeof (row as Record<string, unknown>).chave_cte === "string") {
      chave = (row as Record<string, unknown>).chave_cte as string;
    }
  } catch (err) {
    console.error(`lookup_chave_cte falhou pra card ${cardId} nf=${nf}:`, err);
    chave = null;
  }

  await supabase
    .from("cards")
    .update({
      agent_state: { ...agentState, chave_cte: chave },
      sem_chave_cte: !chave,
    })
    .eq("id", cardId);

  if (chave) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "ChaveCteResolvida",
      actor_type: "system",
      actor_id: "chave-cte-resolver",
      payload: {
        nf,
        cnpj_pagador: cnpjPagador,
        chave_cte: chave,
        len: chave.length,
        tipo: chave.length === 50 ? "rps" : "cte",
      },
    });
  } else {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "CardSemChaveCte",
      actor_type: "system",
      actor_id: "chave-cte-resolver",
      payload: {
        nf,
        cnpj_pagador: cnpjPagador,
        motivo: "lookup_chave_cte retornou null — RPA OPC 455 ainda não importou OU NF é RPS sem chave em nf_chave_cte",
      },
    });
  }

  return { chave, semChaveCte: !chave, jaTinha: false };
}
