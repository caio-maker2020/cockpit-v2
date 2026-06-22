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
