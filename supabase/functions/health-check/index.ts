// =============================================================================
// health-check — verifica saúde do Cockpit e envia email se algo estiver fora
// do ar. Roda a cada 5min via cron.
//
// 6 checks executados em paralelo. Cada check pode produzir 0+ alertas.
// Cada alerta tem (tipo, chave) — cooldown de 1h evita re-enviar o mesmo.
//
// Email: Postmark transactional via mesmo POSTMARK_SERVER_TOKEN do
// enviar-resposta. From: relacionamento.farmaceutico@salexpress.com.br
// (Sender Signature já verificada). To: caio@salexpress.com.br.
//
// Resumo diário: às 11h UTC (8h BRT), envia 1 email "tudo verde" se
// não houver alertas. Confirma que o monitor mesmo está vivo.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

interface Alerta {
  tipo: string;
  chave: string;
  titulo: string;
  detalhes: string;
  payload: Record<string, unknown>;
  cooldown_horas?: number;  // override do COOLDOWN_HOURS padrão por tipo
}

const COOLDOWN_HOURS = 1;
const ALERT_FROM_EMAIL = "relacionamento.farmaceutico@salexpress.com.br";
const ALERT_TO_EMAIL = "caio@salexpress.com.br";

serve(async (_req) => {
  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const postmarkToken = env["POSTMARK_SERVER_TOKEN"];
  if (!postmarkToken) {
    return new Response(
      JSON.stringify({ ok: false, error: "POSTMARK_SERVER_TOKEN ausente" }),
      { status: 500 },
    );
  }

  const checks = await Promise.allSettled([
    checkCronFalhou(supabase),
    checkSyncBastaoSemRodar(supabase),
    checkPgmqAcumulada(supabase),
    checkCardsTravados(supabase),
    checkExecutorErros(supabase),
    checkVinculadorErros(supabase),
    checkRpaOpc455Parado(supabase),
  ]);

  const alertas: Alerta[] = [];
  for (const c of checks) {
    if (c.status === "fulfilled") alertas.push(...c.value);
    else console.error("check failed:", c.reason);
  }

  // Aplica cooldown: filtra alertas já enviados nas últimas COOLDOWN_HOURS
  const aEnviar: Alerta[] = [];
  for (const a of alertas) {
    const { data } = await supabase
      .from("alertas_enviados")
      .select("id, enviado_em")
      .eq("tipo", a.tipo)
      .eq("chave", a.chave)
      .gt("enviado_em", new Date(Date.now() - (a.cooldown_horas ?? COOLDOWN_HOURS) * 3600 * 1000).toISOString())
      .limit(1);
    if (!data || data.length === 0) aEnviar.push(a);
  }

  let enviados = 0;
  for (const a of aEnviar) {
    const ok = await enviarAlerta(supabase, postmarkToken, a);
    if (ok) enviados++;
  }

  // Resumo diário (8h BRT = 11h UTC, janela de 5min ao redor pra cobrir o cron)
  const agora = new Date();
  const horaUtc = agora.getUTCHours();
  const minutoUtc = agora.getUTCMinutes();
  if (horaUtc === 11 && minutoUtc < 5) {
    await maybeEnviarResumoDiario(supabase, postmarkToken, alertas.length);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      checks_run: checks.length,
      alertas_detectados: alertas.length,
      alertas_enviados: enviados,
      em_cooldown: alertas.length - enviados,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

// =============================================================================
// Checks — cada um retorna 0+ alertas
// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;

/** Cron jobs com >= 3 falhas nas últimas 30min */
async function checkCronFalhou(s: SupabaseClient): Promise<Alerta[]> {
  const { data, error } = await s.rpc("cron_jobs_recent_failures", {
    p_minutes: 30,
    // Caio 2026-06-09: threshold subido 3 → 5 pra reduzir ruído de "job
    // startup timeout" do pg_cron (pico de carga / cold start). 5 falhas em
    // 30min ainda indica problema persistente, mas evita email em transients.
    p_min_failures: 5,
  });

  if (error) {
    console.error(`cron_jobs_recent_failures: ${error.message}`);
    return [];
  }

  const rows = (data ?? []) as Array<{ jobname: string; failures: number; last_error: string }>;
  return rows.map((row) => ({
    tipo: "cron_failed",
    chave: row.jobname,
    titulo: `Cron ${row.jobname} falhou ${row.failures}x em 30min`,
    detalhes: `Último erro: ${row.last_error ?? "(sem mensagem)"}`,
    payload: { jobname: row.jobname, failures: row.failures, last_error: row.last_error },
  }));
}

/**
 * Sync-bastao não roda há tempo demais.
 *
 * Cadência real do cron `sync-bastao-every-30min` é 30min (mig 097, 2026-05-14
 * — era 2min). O `sync_status_global` é marcado no INÍCIO de cada run (fix
 * 2026-06-09), então o gap normal entre marcações é ~30min. Threshold de 15min
 * (legado da cadência antiga de 2-5min) disparava falso-positivo TODO ciclo.
 * 40min = só alerta quando uma run inteira foi pulada (travou de verdade).
 * Caio 2026-06-12.
 */
const SYNC_BASTAO_MAX_MIN = 40;
async function checkSyncBastaoSemRodar(s: SupabaseClient): Promise<Alerta[]> {
  const { data } = await s.rpc("minutos_desde_ultimo_sync_bastao");
  const minutos = typeof data === "number" ? data : null;
  if (minutos == null || minutos <= SYNC_BASTAO_MAX_MIN) return [];
  return [{
    tipo: "sync_parou",
    chave: "sync-bastao",
    titulo: `sync-bastao não roda há ${minutos} minutos`,
    detalhes:
      `O cron roda a cada 30min. Se passou de ${SYNC_BASTAO_MAX_MIN}min, uma run ` +
      `inteira foi pulada — algo travou (Edge Function timeout, Bastão API fora, ` +
      `etc). Verifique no painel Supabase → Functions → sync-bastao → logs.`,
    payload: { minutos_sem_rodar: minutos },
  }];
}

/** pgmq queue size > 50 */
async function checkPgmqAcumulada(s: SupabaseClient): Promise<Alerta[]> {
  const queues = ["agent_executor", "respostas_envio"];
  const alertas: Alerta[] = [];
  for (const q of queues) {
    try {
      const { data } = await s.rpc("pgmq_queue_length", { p_queue: q });
      const n = typeof data === "number" ? data : 0;
      if (n > 50) {
        alertas.push({
          tipo: "pgmq_acumulada",
          chave: q,
          titulo: `Queue pgmq.${q} com ${n} mensagens acumuladas`,
          detalhes:
            `Queue normal trabalha com 0-5 mensagens. ${n} indica que o ` +
            `consumer (executor / enviar-resposta) parou de processar.`,
          payload: { queue: q, length: n },
        });
      }
    } catch {
      // RPC pode não existir ainda — skip silencioso
    }
  }
  return alertas;
}

/** Cards em EXECUTANDO_ACAO há mais de 30min (Pass C deveria ter resolvido) */
async function checkCardsTravados(s: SupabaseClient): Promise<Alerta[]> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await s
    .from("cards")
    .select("id, nf, updated_at")
    .eq("state", "EXECUTANDO_ACAO")
    .lt("updated_at", cutoff);
  if (!data || data.length === 0) return [];
  return [{
    tipo: "card_travado",
    chave: "executando_acao_30min",
    titulo: `${data.length} card(s) em EXECUTANDO_ACAO há mais de 30min`,
    detalhes:
      `NFs: ${data.map((c) => c.nf).join(", ")}. Pass C do sync-bastao ` +
      `deveria ter movido pra RESOLVIDO ou BLOQUEADO_POR_ERRO. ` +
      `Provável: oc esperada não chegou no Bastão (delay externo OU executor ` +
      `não conseguiu lançar).`,
    payload: { cards: data.map((c) => ({ id: c.id, nf: c.nf })) },
  }];
}

/**
 * RPA OPC 455 (importador externo de chave_cte) parado há mais de 6h em
 * horário comercial BRT (seg-sex 8-18). Caio 2026-06-03: RPA é processo
 * externo (servidor próprio do sócio). Quando para, cards criados ficam sem
 * chave_cte → operadora não consegue lançar oc no SSW pela plataforma →
 * retrabalho. Caso âncora: RPA parou em 01/06, 74 cards (24%) criados em
 * 48h sem chave. Larissa descobriu pela NF 1013137.
 *
 * Cooldown 4h: enquanto RPA não voltar, manda 1 email a cada 4h (não a cada
 * 5min do health-check). Horário comercial: BRT fixo -03, sem DST, sem feriado.
 */
async function checkRpaOpc455Parado(s: SupabaseClient): Promise<Alerta[]> {
  const agora = new Date();
  const utcHora = agora.getUTCHours();
  const utcDia = agora.getUTCDay(); // 0=dom, 6=sáb
  const brtHora = (utcHora - 3 + 24) % 24;
  const ehDiaUtil = utcDia >= 1 && utcDia <= 5;
  const ehHorarioComercial = ehDiaUtil && brtHora >= 8 && brtHora < 18;
  if (!ehHorarioComercial) return [];

  const { data } = await s
    .from("nf_chave_cte")
    .select("imported_at")
    .eq("imported_via", "rpa_opc455")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ultimoImport = (data as { imported_at?: string } | null)?.imported_at;
  if (!ultimoImport) return [];

  const horasDesdeUltimo = (Date.now() - new Date(ultimoImport).getTime()) / 3600_000;
  if (horasDesdeUltimo < 6) return [];

  const { count: cardsSemChave } = await s
    .from("cards")
    .select("id", { count: "exact", head: true })
    .gte("created_at", ultimoImport)
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA");

  return [{
    tipo: "rpa_opc455_parado",
    chave: "imported_via_rpa_opc455",
    titulo: `RPA OPC 455 sem rodar há ${Math.floor(horasDesdeUltimo)}h`,
    detalhes:
      `Última importação de chave_cte via rpa_opc455: ${ultimoImport}. ` +
      `Aproximadamente ${cardsSemChave ?? "?"} card(s) AGUARDANDO_VALIDACAO_HUMANA ` +
      `criados desde então podem estar sem chave_cte → operadora bloqueada de ` +
      `aprovar ações no SSW. AÇÃO: verificar servidor/cron do RPA externo e forçar ` +
      `atualização.`,
    payload: {
      ultimo_import_em: ultimoImport,
      horas_desde_ultimo: Math.round(horasDesdeUltimo * 10) / 10,
      cards_sem_chave_estimado: cardsSemChave ?? null,
    },
    cooldown_horas: 4,
  }];
}

/** Última execução do executor errou */
async function checkExecutorErros(s: SupabaseClient): Promise<Alerta[]> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await s
    .from("card_events")
    .select("id, created_at, payload")
    .eq("event_type", "AcaoExecutada")
    .gte("created_at", cutoff)
    .filter("payload->>sucesso", "eq", "false")
    .limit(5);
  if (!data || data.length === 0) return [];
  return [{
    tipo: "executor_erro",
    chave: "ultima_30min",
    titulo: `${data.length} execução(ões) do executor falharam em 30min`,
    detalhes:
      `Verifique card_events.AcaoExecutada com payload.sucesso=false. ` +
      `Causas comuns: SSW API 500, chave_cte inválida, codigo_api desconhecido.`,
    payload: { eventos: data.map((e) => e.id) },
  }];
}

/** Vinculador com erro repetido */
async function checkVinculadorErros(s: SupabaseClient): Promise<Alerta[]> {
  // por enquanto sem implementação específica — placeholder pra crescer
  return [];
}

// =============================================================================
// Envio de email
// =============================================================================

async function enviarAlerta(
  s: SupabaseClient,
  token: string,
  a: Alerta,
): Promise<boolean> {
  // Subject sem tags em colchetes (filtros de spam pioram score com [TAG])
  const subject = `Cockpit · ${a.titulo}`;
  const textBody = formatBody(a);
  const htmlBody = formatHtml(a);

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
      ReplyTo: ALERT_TO_EMAIL,             // responde pra ele mesmo (auto-loop = ok)
      Subject: subject,
      TextBody: textBody,
      HtmlBody: htmlBody,                  // versão HTML melhora deliverability
      MessageStream: "outbound",
      Tag: "cockpit-alert",
      Metadata: { tipo: a.tipo, chave: a.chave },
      Headers: [
        // Sinaliza pro Gmail/Outlook que é mensagem automática legítima
        { Name: "Auto-Submitted", Value: "auto-generated" },
        // Indica que é internal/transactional (não bulk marketing)
        { Name: "X-Auto-Response-Suppress", Value: "All" },
        // Anti-spam: declara que não é newsletter (sem unsubscribe é OK pra alerts)
        { Name: "Precedence", Value: "auto_reply" },
      ],
    }),
  });

  const responseBody = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(responseBody); } catch { /* ignore */ }

  if (!res.ok) {
    console.error(`Postmark falhou ${res.status}: ${responseBody}`);
    return false;
  }

  const messageId = (parsed?.["MessageID"] as string | undefined) ?? null;

  await s.from("alertas_enviados").insert({
    tipo: a.tipo,
    chave: a.chave,
    payload: { titulo: a.titulo, detalhes: a.detalhes, ...a.payload },
    postmark_id: messageId,
  });

  return true;
}

function formatBody(a: Alerta): string {
  const linhas = [
    a.titulo,
    "",
    a.detalhes,
    "",
    "----- detalhes técnicos -----",
    `tipo: ${a.tipo}`,
    `chave: ${a.chave}`,
    `payload: ${JSON.stringify(a.payload, null, 2)}`,
    "",
    "----- ",
    "Cockpit Monitor — alerta automático",
    "Cooldown de 1h: este alerta não será re-enviado nesse período.",
  ];
  return linhas.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatHtml(a: Alerta): string {
  const titulo = escapeHtml(a.titulo);
  const detalhes = escapeHtml(a.detalhes);
  const payload = escapeHtml(JSON.stringify(a.payload, null, 2));
  const tipo = escapeHtml(a.tipo);
  const chave = escapeHtml(a.chave);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>${titulo}</title></head>
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px;font-size:16px;color:#C8102E">${titulo}</h2>
  <p style="margin:0 0 24px">${detalhes}</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
  <p style="margin:0;color:#666;font-size:12px"><strong>tipo:</strong> ${tipo}<br><strong>chave:</strong> ${chave}</p>
  <pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:11px;overflow:auto;color:#333">${payload}</pre>
  <p style="margin:24px 0 0;color:#999;font-size:11px">Cockpit Monitor · alerta automático · cooldown 1h por (tipo, chave)</p>
</body>
</html>`;
}

async function maybeEnviarResumoDiario(
  s: SupabaseClient,
  token: string,
  alertasHoje: number,
): Promise<void> {
  // Idempotência: só envia 1 resumo por dia
  const hoje = new Date().toISOString().slice(0, 10);
  const { data: jaEnviado } = await s
    .from("alertas_enviados")
    .select("id")
    .eq("tipo", "resumo_diario")
    .eq("chave", hoje)
    .limit(1);
  if (jaEnviado && jaEnviado.length > 0) return;

  // Conta alertas das últimas 24h pra incluir no resumo
  const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: alerts24h } = await s
    .from("alertas_enviados")
    .select("tipo, chave, enviado_em")
    .gt("enviado_em", ontem)
    .neq("tipo", "resumo_diario")
    .order("enviado_em", { ascending: false });

  const total = alerts24h?.length ?? 0;
  const tudoVerde = total === 0 && alertasHoje === 0;

  const subject = tudoVerde
    ? "[COCKPIT-DAILY] ✓ Tudo verde nas últimas 24h"
    : `[COCKPIT-DAILY] ${total} alerta(s) nas últimas 24h`;

  const linhas = [
    tudoVerde
      ? "Tudo verde. Nenhum alerta nas últimas 24h."
      : `${total} alerta(s) registrados nas últimas 24h:`,
    "",
  ];

  if (alerts24h && alerts24h.length > 0) {
    for (const a of alerts24h) {
      linhas.push(`  · ${a.enviado_em.slice(0, 16)} — ${a.tipo}/${a.chave}`);
    }
    linhas.push("");
  }

  linhas.push("Cockpit Monitor — resumo diário automático.");

  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: `Cockpit Monitor <${ALERT_FROM_EMAIL}>`,
      To: ALERT_TO_EMAIL,
      Subject: subject,
      TextBody: linhas.join("\n"),
      MessageStream: "outbound",
      Tag: "cockpit-daily",
    }),
  });

  if (!res.ok) {
    console.error(`Resumo diário falhou: ${res.status}`);
    return;
  }

  await s.from("alertas_enviados").insert({
    tipo: "resumo_diario",
    chave: hoje,
    payload: { tudo_verde: tudoVerde, total_24h: total },
  });
}
