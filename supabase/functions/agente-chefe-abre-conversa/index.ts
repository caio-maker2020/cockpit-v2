// =============================================================================
// agente-chefe-abre-conversa — CHAT 2 (Fase 3 do plano aprovado 08/08).
//
// O agente-chefe ABRE a conversa do dia com a gestão: puxa o pior descasamento
// da semana (com ferramentas reais), formula a pauta e deixa a primeira
// mensagem esperando a Isadora — que responde pelo chat normal.
//
// Chamada: POST sem body (cron 06:30 em dia útil, ou manual). Idempotente:
// se já existe conversa aberta iniciada pelo agente, não abre outra.
// Guardrails: flag aprendizado_chat_enabled; só service_role; fim de semana
// não abre (sem operação).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  executarTurnoChat,
  montarMudancasAplicadas,
  montarSnapshotMetricas,
  montarSystemPrompt,
} from "../_shared/aprendizado-chat.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  try {
    const env = Deno.env.toObject();
    const SUPABASE_URL = env["SUPABASE_URL"]!;
    const SERVICE_ROLE = env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const ANTHROPIC_KEY = env["ANTHROPIC_API_KEY"];
    if (!ANTHROPIC_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY ausente" }, 500);

    // só service_role (cron/manual) — claim dentro do JWT, como no chat
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claimRole = (() => {
      try {
        return JSON.parse(atob(token.split(".")[1] ?? ""))?.role as string | undefined ?? null;
      } catch {
        return null;
      }
    })();
    if (token !== SERVICE_ROLE && claimRole !== "service_role") {
      return json({ ok: false, error: "só chamada interna" }, 403);
    }

    const svc = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Kill-switch
    const { data: flag } = await svc
      .from("feature_flags")
      .select("enabled")
      .eq("key", "aprendizado_chat_enabled")
      .maybeSingle();
    if ((flag as { enabled?: boolean } | null)?.enabled !== true) {
      return json({ ok: true, skip: "flag desligada" });
    }

    // Fim de semana não tem operação — sem pauta (BRT = UTC-3)
    const diaSemanaBrt = new Date(Date.now() - 3 * 3600_000).getUTCDay();
    const forcado = new URL(req.url).searchParams.get("forcar") === "1";
    if (!forcado && (diaSemanaBrt === 0 || diaSemanaBrt === 6)) {
      return json({ ok: true, skip: "fim de semana" });
    }

    // Idempotência: já há conversa aberta iniciada pelo agente? não duplica.
    const { data: aberta } = await svc
      .from("aprendizado_chat_sessoes")
      .select("id")
      .eq("tipo", "agente_iniciou")
      .eq("status", "aberta")
      .limit(1)
      .maybeSingle();
    if (aberta) return json({ ok: true, skip: "já existe conversa aberta do agente", sessao_id: (aberta as { id: string }).id });

    // Monta a pauta com o próprio cérebro do chat (ferramentas reais)
    const snapshot = await montarSnapshotMetricas(svc);
    const mudancas = await montarMudancasAplicadas(svc);
    const system = montarSystemPrompt({
      nomeGestor: "Isadora",
      snapshotMetricas: snapshot,
      tipoSessao: "agente_iniciou",
      mudancasAplicadas: mudancas,
    });
    const turno = await executarTurnoChat({
      supabase: svc,
      anthropicKey: ANTHROPIC_KEY,
      system,
      mensagens: [{
        role: "user",
        content:
          "[sistema] Abra a conversa do dia com a Isadora. Use as ferramentas pra achar o descasamento " +
          "mais valioso (o padrão em que corrigir a regra mais sobe a taxa), cumprimente em 1 linha, " +
          "apresente o padrão com números e NFs em tabela, e termine com A pergunta direta. NUNCA escolha padrão coberto por mudança já aplicada usando casos antigos — só se casos PÓS-mudança mostrarem problema (e aí o assunto é adesão do time).",
      }],
      contextoRegistro: {
        sessaoId: "abertura-dia",
        nomeGestor: "Isadora",
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_ROLE,
      },
    });

    const hoje = new Date(Date.now() - 3 * 3600_000);
    const titulo = `Pauta do dia ${String(hoje.getUTCDate()).padStart(2, "0")}/${String(hoje.getUTCMonth() + 1).padStart(2, "0")}`;
    const { data: sess, error: sessErr } = await svc
      .from("aprendizado_chat_sessoes")
      .insert({ tipo: "agente_iniciou", titulo })
      .select("id")
      .single();
    if (sessErr || !sess) return json({ ok: false, error: `sessão: ${sessErr?.message}` }, 500);
    const sessaoId = (sess as { id: string }).id;

    await svc.from("aprendizado_chat_mensagens").insert({
      sessao_id: sessaoId,
      papel: "agente",
      conteudo: turno.resposta,
      dados: { abertura_diaria: true, ferramentas: turno.ferramentas_usadas },
    });

    return json({ ok: true, sessao_id: sessaoId, titulo });
  } catch (err) {
    console.error("agente-chefe-abre-conversa:", err);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
