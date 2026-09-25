// =============================================================================
// sync-roteirizador-ponte — puxa GET /v3/ponte/eventos do Roteirizador por
// cursor e registra os eventos nos cards ATIVOS do CTRC (ADR 0034).
//
// Mesmo estilo do sync do Bastão: cron (*/5, mig 410) + invocação manual.
// Gated por feature_flags.roteirizador_ponte_sync_enabled (OFF = devolve
// `skipped: flag_off` antes de qualquer SELECT ou chamada à ponte). Sem env
// ROTEIRIZADOR_API_URL / ROTEIRIZADOR_PONTE_TOKEN = `skipped: ponte_desligada`.
//
// NUNCA cria card, NUNCA muda state/cod_ultima_ocorrencia: só card_events
// RoteirizadorAlertaRota / RoteirizadorContextoRota (decisão em
// _shared/roteirizador-eventos-rotear.ts; por que não abrir card: ADR 0034).
// Idempotente: PK (evento_id, ctrc) em roteirizador_ponte_eventos + RPC
// atômica ponte_roteirizador_registrar_linha.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createRoteirizadorPonteClientFromEnv } from "../_shared/roteirizador-ponte-client.ts";
import { STATES_TERMINAIS_PONTE } from "../_shared/roteirizador-eventos-rotear.ts";
import { type RepoPonte, sincronizarEventosPonte } from "../_shared/sync-roteirizador-ponte-core.ts";

const FLAG_KEY = "roteirizador_ponte_sync_enabled";
// .in() vai na URL do PostgREST — lote conservador (memória "Cadastros .in 414").
const LOTE_IN_CTRC = 100;

Deno.serve(async (req) => {
  const startedAt = Date.now();
  const env = Deno.env.toObject();
  const supabaseUrl = env["SUPABASE_URL"];
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return jsonResp({ ok: true, skipped: "flag_off" }, 200);
  }

  const client = createRoteirizadorPonteClientFromEnv(env);
  if (!client.ligado) {
    return jsonResp({ ok: true, skipped: "ponte_desligada", nota: "ROTEIRIZADOR_API_URL/ROTEIRIZADOR_PONTE_TOKEN ausentes" }, 200);
  }

  const body = await req.json().catch(() => ({})) as { max_paginas?: number };
  const maxPaginas = Number.isFinite(body?.max_paginas) ? Math.max(1, Math.min(50, Number(body.max_paginas))) : undefined;

  const repo: RepoPonte = {
    async lerCursor() {
      const { data, error } = await supabase
        .from("roteirizador_ponte_cursor").select("proximo").eq("id", 1).maybeSingle();
      if (error) throw new Error(`cursor: ${error.message}`);
      return Number((data as { proximo?: number } | null)?.proximo ?? 0);
    },
    async gravarCursor(proximo) {
      const agora = new Date().toISOString();
      const { error } = await supabase.from("roteirizador_ponte_cursor")
        .upsert({ id: 1, proximo, atualizado_em: agora, ultimo_ok_em: agora });
      if (error) throw new Error(`gravar cursor: ${error.message}`);
    },
    async registrarErro(mensagem) {
      await supabase.from("roteirizador_ponte_cursor")
        .update({ ultimo_erro: mensagem.slice(0, 500), ultimo_erro_em: new Date().toISOString() })
        .eq("id", 1);
    },
    async cardsAtivosPorCtrc(ctrcs) {
      const mapa = new Map<string, string>();
      for (let i = 0; i < ctrcs.length; i += LOTE_IN_CTRC) {
        const lote = ctrcs.slice(i, i + LOTE_IN_CTRC);
        const { data, error } = await supabase
          .from("cards")
          .select("id, ctrc, created_at")
          .in("ctrc", lote)
          .not("state", "in", `(${STATES_TERMINAIS_PONTE.join(",")})`)
          .order("created_at", { ascending: false });
        if (error) throw new Error(`cards por ctrc: ${error.message}`);
        for (const c of (data ?? []) as Array<{ id: string; ctrc: string | null }>) {
          const k = (c.ctrc ?? "").trim().toUpperCase();
          // Ordenado do mais recente: o primeiro visto vence.
          if (k && !mapa.has(k)) mapa.set(k, c.id);
        }
      }
      return mapa;
    },
    async registrarLinha(linha, evento) {
      const { data, error } = await supabase.rpc("ponte_roteirizador_registrar_linha", {
        p_evento_id: linha.eventoId,
        p_ctrc: linha.ctrc,
        p_tipo: String(evento.tipo),
        p_classe: linha.classe,
        p_situacao: linha.situacao,
        p_card_id: linha.cardId,
        p_card_event_type: linha.cardEventType,
        p_payload: linha.cardEventPayload,
        p_evento: evento,
      });
      if (error) throw new Error(error.message);
      return String(data);
    },
    async anexarPendentes(janelaHoras) {
      const { data, error } = await supabase.rpc("ponte_roteirizador_anexar_pendentes", {
        p_janela_horas: janelaHoras,
      });
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
  };

  try {
    const resumo = await sincronizarEventosPonte(client, repo, { maxPaginas });
    return jsonResp({ ok: resumo.erro === null, ...resumo, duration_ms: Date.now() - startedAt }, 200);
  } catch (e) {
    return jsonResp({ ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - startedAt }, 500);
  }
});

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
