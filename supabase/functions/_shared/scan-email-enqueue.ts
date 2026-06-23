// =============================================================================
// scan-email-enqueue — enfileira o scan de e-mail pré-existente no NASCIMENTO
// do card, sem bloquear o caminho de criação.
//
// Caio 2026-06-22. Chamado por sync-bastao, sync-extravios-bastao e
// criar-card-via-ssw logo após o card_event de criação. O trabalho pesado
// (busca no Gmail) roda no edge scan-email-pre-card via cron — aqui é só o
// pgmq.send O(1), local e barato. NUNCA lança (é enriquecimento; não pode
// derrubar o sync, que tem deadline apertado). Gated pela flag global, lida
// no máximo 1x a cada 30s (memo) — nada de query por card no hot path.
// =============================================================================
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface ScanEmailPreCardPayload {
  card_id: string;
  nf?: string | null;
  cnpj_pagador?: string | null;
  assigned_operator_id?: string | null;
  origem?: string; // 'bastao' | 'extravio' | 'email_ssw'
}

let flagCache: { v: boolean; exp: number } | null = null;
const FLAG_TTL_MS = 30_000;
// Opção 1 só "daqui pra frente": surfar SÓ dispara pra e-mail dos últimos N dias
// (o poll lista o inbox de 30d; sem isso, a 1ª passada draga o backlog inteiro).
const RECENCIA_DIAS = 2;

async function flagOn(supabase: SupabaseClient<any, any, any>): Promise<boolean> {
  const now = Date.now();
  if (flagCache && flagCache.exp > now) return flagCache.v;
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("enabled")
      .eq("key", "scan_email_pre_card_enabled")
      .maybeSingle();
    const v = (data as { enabled?: boolean } | null)?.enabled === true;
    flagCache = { v, exp: now + FLAG_TTL_MS };
    return v;
  } catch {
    return false; // falha lendo flag = trata como OFF (best-effort)
  }
}

export async function enfileirarScanEmailPreCard(
  supabase: SupabaseClient<any, any, any>,
  payload: ScanEmailPreCardPayload,
): Promise<void> {
  try {
    if (!payload?.card_id) return;
    if (!(await flagOn(supabase))) return;
    await supabase.rpc("enqueue_to_pgmq", {
      queue_name: "scan_email_pre_card",
      payload,
    });
  } catch (e) {
    console.log(
      `[scan-email-pre-card] enqueue best-effort falhou (card=${payload?.card_id}): ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

/** Flag global memoizada — pro poll decidir se roda o gatilho de thread divergente. */
export async function scanEmailFlagAtiva(supabase: SupabaseClient<any, any, any>): Promise<boolean> {
  return await flagOn(supabase);
}

/**
 * Opção 1 (Caio 2026-06-23): gatilho por e-mail NOVO. Chamado pelo gmail-poll
 * quando um e-mail não casa com nenhum card. Acha um card ATIVO do operador com
 * a NF do assunto (sem e-mail rastreado) e, se casar, enfileira um scan FOCADO
 * só nessa thread (thread_hint) — contexto card_em_espera. Zero varredura
 * retroativa: só a thread do e-mail que acabou de chegar. Best-effort, nunca lança.
 */
export async function surfarThreadDivergenteSeCasar(
  supabase: SupabaseClient<any, any, any>,
  args: { operadorId: string; subject: string | null; threadId: string; recebidoMs?: number | null },
): Promise<boolean> {
  try {
    if (!args.operadorId || !args.threadId) return false;
    // Recência: ignora e-mail antigo (backlog). Só dispara pra mensagem recente.
    if (args.recebidoMs && args.recebidoMs < Date.now() - RECENCIA_DIAS * 86_400_000) return false;
    if (!(await flagOn(supabase))) return false;

    // NFs candidatas do assunto (sequências 4-9 dígitos, normalizadas sem zeros à esquerda).
    const nfs = [
      ...new Set(
        (args.subject?.match(/\d{4,9}/g) ?? [])
          .map((n) => n.replace(/^0+/, ""))
          .filter((n) => n.length >= 4),
      ),
    ];
    if (nfs.length === 0) return false;

    const { data } = await supabase.rpc("buscar_card_para_thread_divergente", {
      p_operador: args.operadorId,
      p_nfs: nfs,
    });
    const cardId = typeof data === "string" ? data : null;
    if (!cardId) return false;

    await supabase.rpc("enqueue_to_pgmq", {
      queue_name: "scan_email_pre_card",
      payload: { card_id: cardId, contexto: "card_em_espera", thread_hint: args.threadId },
    });
    return true;
  } catch (e) {
    console.log(`[scan-email-pre-card] surfarThreadDivergente best-effort falhou: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
