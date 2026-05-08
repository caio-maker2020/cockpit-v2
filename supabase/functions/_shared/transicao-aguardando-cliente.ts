// =============================================================================
// transicao-aguardando-cliente — helpers compartilhados pra decidir e aplicar
// transição de cards em AGUARDANDO_CLIENTE quando a oc real (Bastão+tracking)
// muda.
//
// Regra Caio 2026-05-06: AGUARDANDO_CLIENTE só pode conter cards com oc=54.
// Se Bastão+tracking mostram outra oc, transita conforme:
//   - 54: mantém AGUARDANDO_CLIENTE
//   - 1, 30, 32 (finalizadoras): RESOLVIDO + cancela propostas
//   - oc de relacionamento (não 54): AGUARDANDO_VALIDACAO_HUMANA + lock + flag
//   - oc fora relacionamento (não-finalizadora): TRANSFERIDO (card SAI do Cockpit
//     — sem acionamento de cliente, não há tratativa pendente. Se cliente
//     cobrar depois, vinculador reabre em TRATATIVA_PENDENTE.)
//   - sem info: mantém (sem mexer)
//
// Propostas atuais [21, 44, 55, 56] são preservadas (decisão Caio).
// Exceção: RESOLVIDO cancela tudo (card encerrado).
//
// Usado por:
//  - sync-bastao Pass E (cron 5min)
//  - atualizar-card-via-tracking (botão manual da Larissa)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { OCORRENCIAS_DE_RELACIONAMENTO } from "./bastao-rules.ts";

type SupabaseClient = ReturnType<typeof createClient>;

/** Ocorrências finalizadoras do CT-e (regra Sal Express 2026-05-05). */
export const OCORRENCIAS_FINALIZADORAS_AC: ReadonlySet<number> = new Set([1, 30, 32]);

export type DecisaoTransicaoAC =
  | { tipo: "manter" }
  | { tipo: "resolvido"; oc_final: number }
  | { tipo: "aguardando_voce"; oc_nova: number }
  | { tipo: "transferido"; oc_nova: number }
  | { tipo: "sem_info" };

/**
 * Decide a transição pra um card em AGUARDANDO_CLIENTE baseado na oc real
 * obtida via Bastão+tracking. Pura — sem side-effects.
 *
 * Quando ambas fontes têm dado e divergem: tracking SSW prevalece (mesma
 * regra do Pass A crosscheck — tracking é mais real-time que Bastão).
 */
export function decidirTransicaoAguardandoCliente(args: {
  ocBastao: number | null;
  ocTracking: number | null;
}): DecisaoTransicaoAC {
  const ocReal =
    args.ocTracking != null && args.ocBastao != null && args.ocTracking !== args.ocBastao
      ? args.ocTracking
      : args.ocBastao ?? args.ocTracking ?? null;

  if (ocReal == null) return { tipo: "sem_info" };
  if (ocReal === 54) return { tipo: "manter" };
  if (OCORRENCIAS_FINALIZADORAS_AC.has(ocReal)) {
    return { tipo: "resolvido", oc_final: ocReal };
  }
  if (OCORRENCIAS_DE_RELACIONAMENTO.has(ocReal)) {
    return { tipo: "aguardando_voce", oc_nova: ocReal };
  }
  return { tipo: "transferido", oc_nova: ocReal };
}

/**
 * Aplica decisão da `decidirTransicaoAguardandoCliente` no banco. Idempotente
 * (re-execução com mesmo input não muda estado).
 */
export async function aplicarTransicaoAguardandoCliente(
  supabase: SupabaseClient,
  cardId: string,
  ocAnterior: number | null,
  decisao: DecisaoTransicaoAC,
  actorId = "sync-bastao",
): Promise<void> {
  if (decisao.tipo === "manter" || decisao.tipo === "sem_info") return;

  if (decisao.tipo === "resolvido") {
    await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: "Card RESOLVIDO por oc finalizadora detectada em AGUARDANDO_CLIENTE",
      })
      .eq("card_id", cardId)
      .eq("status", "pendente");
    await supabase
      .from("cards")
      .update({
        state: "RESOLVIDO",
        cod_ultima_ocorrencia: decisao.oc_final,
        bastao_synced_at: new Date().toISOString(),
        lock_aguardando_validacao: false,
        aviso_alteracao_oc: null,
        acao_falhou_motivo: null,
      })
      .eq("id", cardId);
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AguardandoClienteOcMudou",
      actor_type: "system",
      actor_id: actorId,
      payload: {
        oc_anterior: ocAnterior,
        oc_atual: decisao.oc_final,
        state_novo: "RESOLVIDO",
        motivo: "oc finalizadora detectada — card encerrado",
      },
    });
    return;
  }

  if (decisao.tipo === "aguardando_voce") {
    // Caio 2026-05-07: nova oc é de relacionamento — sem aviso amarelo.
    // Cockpit já mostra propostas atuais; alertar só confunde Larissa.
    await supabase
      .from("cards")
      .update({
        state: "AGUARDANDO_VALIDACAO_HUMANA",
        lock_aguardando_validacao: true,
        cod_ultima_ocorrencia: decisao.oc_nova,
        bastao_synced_at: new Date().toISOString(),
        aviso_alteracao_oc: null,
      })
      .eq("id", cardId);
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AguardandoClienteOcMudou",
      actor_type: "system",
      actor_id: actorId,
      payload: {
        oc_anterior: ocAnterior,
        oc_atual: decisao.oc_nova,
        state_novo: "AGUARDANDO_VALIDACAO_HUMANA",
        motivo: "oc de relacionamento detectada — Larissa decide com propostas atuais (não recriadas)",
      },
    });
    return;
  }

  // transferido — sem acionamento do cliente, card sai do Cockpit (TRANSFERIDO).
  // Se cliente cobrar/acionar depois, vinculador reabre como TRATATIVA_PENDENTE
  // (regra existente em vinculador/index.ts no branch "TRANSFERIDO/RESOLVIDO →
  // cliente cobrou"). Limpa avisos pq card sumiu da plataforma.
  await supabase
    .from("cards")
    .update({
      state: "TRANSFERIDO",
      lock_aguardando_validacao: false,
      cod_ultima_ocorrencia: decisao.oc_nova,
      bastao_synced_at: new Date().toISOString(),
      aviso_alteracao_oc: null,
    })
    .eq("id", cardId);
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AguardandoClienteOcMudou",
    actor_type: "system",
    actor_id: actorId,
    payload: {
      oc_anterior: ocAnterior,
      oc_atual: decisao.oc_nova,
      state_novo: "TRANSFERIDO",
      motivo: "oc fora de relacionamento detectada e cliente NAO acionou — card sai do Cockpit. Se cliente cobrar depois, vinculador reabre em TRATATIVA_PENDENTE.",
    },
  });
}
