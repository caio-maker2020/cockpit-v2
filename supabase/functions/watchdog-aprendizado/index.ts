// =============================================================================
// watchdog-aprendizado — atestado de vida do Loop de Aprendizado (Fase 1).
//
// Lição da morte do loop de junho/2026 (managed agent instalado 10/06, nunca
// mais rodou, ninguém percebeu): loop de aprendizado sem vigia morre calado.
//
// Este vigia é DELIBERADAMENTE separado do health-check (771 L, sem testes) —
// decisão do plano: zero toque em código quente. Só lê learning_log e alerta.
//
// Regra: se a linha mais recente do learning_log tiver mais de LIMIAR_DIAS,
// (ou a tabela estiver vazia) → e-mail de alerta pro admin via Postmark
// (mesmo padrão From/To do health-check). Roda 1x/dia via cron; enquanto
// estiver vermelho, alerta diário — é um dead-man alarm, repetição é feature.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const LIMIAR_DIAS = 7;
const ALERT_FROM_EMAIL = "relacionamento.farmaceutico@salexpress.com.br";
const ALERT_TO_EMAIL = "caio@salexpress.com.br";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (_req) => {
  const env = Deno.env.toObject();
  const supabaseUrl = env["SUPABASE_URL"];
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from("learning_log")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return json({ ok: false, error: error.message }, 500);

  const ultima = data?.[0]?.created_at as string | undefined;
  const idadeDias = ultima
    ? (Date.now() - new Date(ultima).getTime()) / (24 * 3600 * 1000)
    : Infinity;
  const vivo = idadeDias <= LIMIAR_DIAS;

  if (!vivo) {
    const token = env["POSTMARK_SERVER_TOKEN"];
    if (!token) {
      return json({ ok: false, vivo, error: "POSTMARK_SERVER_TOKEN ausente" }, 500);
    }
    const desc = ultima
      ? `A última atividade do Loop de Aprendizado foi em ${ultima} (${Math.floor(idadeDias)} dias atrás).`
      : "O Loop de Aprendizado nunca registrou atividade (learning_log vazio).";
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
      body: JSON.stringify({
        From: `Cockpit <${ALERT_FROM_EMAIL}>`,
        To: ALERT_TO_EMAIL,
        Subject: "⚠️ Loop de Aprendizado parado — Cockpit",
        TextBody: `${desc}\n\nO cron do agente-aprendizado deveria gravar pelo ` +
          `menos 1 linha por dia. Verifique cron.job e os logs da edge function ` +
          `agente-aprendizado.\n\n— watchdog-aprendizado (alerta diário enquanto parado)`,
        MessageStream: "outbound",
        Tag: "cockpit-alert",
        Headers: [{ Name: "Auto-Submitted", Value: "auto-generated" }],
      }),
    });
    if (!res.ok) {
      return json({ ok: false, vivo, error: `postmark ${res.status}` }, 500);
    }
  }

  return json({ ok: true, vivo, ultima: ultima ?? null });
});
