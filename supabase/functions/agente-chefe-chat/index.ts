// =============================================================================
// agente-chefe-chat — a engine do chat fluido da aba Aprendizado (Fase 1).
//
// POST { sessao_id?, mensagem, imagens? }
//   → valida gestor → grava a fala → loop agêntico (Claude + ferramentas de
//     leitura + registrar_aprendizado) → grava a resposta → { ok, sessao_id }.
// O front recebe as mensagens por Realtime (tabela aprendizado_chat_mensagens);
// a resposta também volta no body pra render imediato.
//
// Guardrails: flag aprendizado_chat_enabled (kill-switch sem deploy); só
// gestor (Caio/Isadora) ou service_role (testes/CHAT 2); ferramentas nunca
// tocam SSW/cards/deploy; mensagens append-only.
//
// Latência (pedido do Caio 08/08): Opus + snapshot de métricas pré-injetado
// (1ª resposta sem rodada de ferramenta) + respostas curtas + máx 5 rodadas.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  executarTurnoChat,
  historicoParaMensagens,
  montarSnapshotMetricas,
  montarSystemPrompt,
  type MsgChatRow,
} from "../_shared/aprendizado-chat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  try {
    const env = Deno.env.toObject();
    const SUPABASE_URL = env["SUPABASE_URL"]!;
    const SERVICE_ROLE = env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const ANON = env["SUPABASE_ANON_KEY"]!;
    const ANTHROPIC_KEY = env["ANTHROPIC_API_KEY"];
    if (!ANTHROPIC_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY ausente" }, 500);

    const svc = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Kill-switch ─────────────────────────────────────────────────────────
    const { data: flag } = await svc
      .from("feature_flags")
      .select("enabled")
      .eq("key", "aprendizado_chat_enabled")
      .maybeSingle();
    if ((flag as { enabled?: boolean } | null)?.enabled !== true) {
      return json({ ok: false, error: "chat desligado (feature flag)" }, 403);
    }

    // ── Autentica: gestor via JWT, ou service_role (testes / CHAT 2) ────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    let nomeGestor = "Gestão";
    let operadorId: string | null = null;

    if (token && token !== SERVICE_ROLE) {
      const userClient = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userRes } = await userClient.auth.getUser();
      const userId = userRes?.user?.id ?? null;
      if (!userId) return json({ ok: false, error: "não autenticado" }, 401);
      const { data: op } = await svc
        .from("operadores")
        .select("id, nome, papel")
        .eq("user_id", userId)
        .maybeSingle();
      if (!op || (op as { papel?: string }).papel !== "gestor") {
        return json({ ok: false, error: "acesso restrito à gestão" }, 403);
      }
      operadorId = (op as { id: string }).id;
      const nome = (op as { nome?: string }).nome ?? "Gestão";
      nomeGestor = nome.split(" ")[0].charAt(0) + nome.split(" ")[0].slice(1).toLowerCase();
    } else if (token !== SERVICE_ROLE) {
      return json({ ok: false, error: "Authorization obrigatório" }, 401);
    }

    const body = await req.json().catch(() => null) as
      | { sessao_id?: string; mensagem?: string; imagens?: string[] }
      | null;
    const mensagem = body?.mensagem?.trim();
    if (!mensagem) return json({ ok: false, error: "mensagem vazia" }, 400);
    if (mensagem.length > 4000) return json({ ok: false, error: "mensagem longa demais (máx 4000)" }, 400);

    // ── Sessão: usa a informada ou abre uma nova (CHAT 1) ───────────────────
    let sessaoId = body?.sessao_id ?? null;
    let tipoSessao: "isadora_iniciou" | "agente_iniciou" = "isadora_iniciou";
    if (sessaoId) {
      const { data: sess } = await svc
        .from("aprendizado_chat_sessoes")
        .select("id, tipo, status")
        .eq("id", sessaoId)
        .maybeSingle();
      if (!sess) return json({ ok: false, error: "sessão não encontrada" }, 404);
      if ((sess as { status: string }).status !== "aberta") {
        return json({ ok: false, error: "sessão encerrada" }, 409);
      }
      tipoSessao = (sess as { tipo: typeof tipoSessao }).tipo;
    } else {
      const { data: nova, error: sessErr } = await svc
        .from("aprendizado_chat_sessoes")
        .insert({
          tipo: "isadora_iniciou",
          criado_por: operadorId,
          titulo: mensagem.slice(0, 80),
        })
        .select("id")
        .single();
      if (sessErr || !nova) return json({ ok: false, error: `sessão: ${sessErr?.message}` }, 500);
      sessaoId = (nova as { id: string }).id;
    }

    // ── Grava a fala da gestão ──────────────────────────────────────────────
    const { error: msgErr } = await svc.from("aprendizado_chat_mensagens").insert({
      sessao_id: sessaoId,
      papel: "gestor",
      operador_id: operadorId,
      conteudo: mensagem,
      imagens: body?.imagens ?? null,
    });
    if (msgErr) return json({ ok: false, error: `mensagem: ${msgErr.message}` }, 500);

    // ── Contexto: histórico + snapshot fresco ───────────────────────────────
    const [{ data: histRows }, snapshot] = await Promise.all([
      svc
        .from("aprendizado_chat_mensagens")
        .select("papel, conteudo")
        .eq("sessao_id", sessaoId)
        .order("created_at", { ascending: true })
        .limit(60),
      montarSnapshotMetricas(svc),
    ]);
    const mensagens = historicoParaMensagens((histRows ?? []) as MsgChatRow[]);
    const system = montarSystemPrompt({ nomeGestor, snapshotMetricas: snapshot, tipoSessao });

    // ── Turno de conversa (loop compartilhado — testado em integração) ──────
    const turno = await executarTurnoChat({
      supabase: svc,
      anthropicKey: ANTHROPIC_KEY,
      system,
      mensagens,
      contextoRegistro: {
        sessaoId: sessaoId!,
        nomeGestor,
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_ROLE,
      },
    });
    const respostaFinal = turno.resposta;
    const ferramentasUsadas = turno.ferramentas_usadas;

    // ── Grava a resposta do agente ──────────────────────────────────────────
    await svc.from("aprendizado_chat_mensagens").insert({
      sessao_id: sessaoId,
      papel: "agente",
      conteudo: respostaFinal,
      dados: ferramentasUsadas.length > 0 ? { ferramentas: ferramentasUsadas } : null,
    });

    return json({ ok: true, sessao_id: sessaoId, resposta: respostaFinal });
  } catch (err) {
    console.error("agente-chefe-chat:", err);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
