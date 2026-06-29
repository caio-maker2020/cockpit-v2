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
import { horaBRT, diaSemanaBRT, ymdBRT, nowBRT } from "../_shared/brt.ts";
import { naoRebaixarPorLancamento54 } from "../_shared/lag-lancamento-54.ts";

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
 try {
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
    checkSyncBastaoNaoCompleta(supabase),
    checkPgmqAcumulada(supabase),
    checkCardsTravados(supabase),
    checkAguardandoClienteOcRelacionamento(supabase),
    checkExecutorErros(supabase),
    checkVinculadorErros(supabase),
    checkRpaOpc455Parado(supabase),
    checkDlqMensagensCliente(supabase),
    checkPropostasRecuperadasPeloCron(supabase),
    checkCapacidadeEstresse(supabase),
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

  // Resumo diário às 8h BRT (janela de 5min pra cobrir o cron).
  const brtAgora = nowBRT();
  if (brtAgora.getUTCHours() === 8 && brtAgora.getUTCMinutes() < 5) {
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
 } catch (err) {
  // Sem try/catch o gateway devolvia "Internal Server Error" plain — invisível.
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "").slice(0, 1500) : "";
  console.error("health-check fatal:", msg, stack);
  return new Response(JSON.stringify({ ok: false, error: msg, stack }), {
    status: 500, headers: { "Content-Type": "application/json" },
  });
 }
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

/**
 * Sync-bastao RODA mas NÃO COMPLETA (ponto cego — Claude/Caio 2026-06-19).
 *
 * O `checkSyncBastaoSemRodar` acima lê `sync_status_global`, que é marcado no
 * INÍCIO de cada run. Logo, enquanto o cron CONTINUA DISPARANDO a cada 5min, ele
 * fica VERDE — mesmo que 100% das runs estejam estourando o timeout 150s e
 * nenhum card novo apareça. Foi exatamente o que aconteceu por ~3 dias sem
 * ninguém ser avisado. Este check fecha o buraco: olha `sync_runs.status` e
 * dispara quando há runs RECENTES mas NENHUMA chegou a `succeeded`.
 *
 * Threshold: ≥3 runs começaram nos últimos 20min e ZERO completaram. Com cron de
 * 5min isso = 3-4 ciclos seguidos sem sucesso (problema persistente, não pico).
 */
const SYNC_NAO_COMPLETA_JANELA_MIN = 20;
async function checkSyncBastaoNaoCompleta(s: SupabaseClient): Promise<Alerta[]> {
  const cutoff = new Date(Date.now() - SYNC_NAO_COMPLETA_JANELA_MIN * 60_000).toISOString();
  const { data: recentes, error } = await s
    .from("sync_runs")
    .select("status, started_at, duration_ms, summary")
    .gt("started_at", cutoff)
    .order("started_at", { ascending: false });
  if (error) {
    console.error(`checkSyncBastaoNaoCompleta: ${error.message}`);
    return [];
  }
  const rows = (recentes ?? []) as Array<{ status: string; started_at: string; duration_ms: number | null; summary: Record<string, unknown> | null }>;
  const total = rows.length;
  const sucesso = rows.filter((r) => r.status === "succeeded").length;
  // Só alerta se houve atividade suficiente E nenhuma run completou.
  if (total < 3 || sucesso > 0) return [];

  // Última conclusão (pra dizer há quanto tempo o sync REALMENTE não termina).
  const { data: ultSucc } = await s
    .from("sync_runs")
    .select("started_at")
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(1);
  const ultSuccEm = (ultSucc as Array<{ started_at: string }> | null)?.[0]?.started_at ?? null;
  const minDesdeSucesso = ultSuccEm
    ? Math.floor((Date.now() - new Date(ultSuccEm).getTime()) / 60_000)
    : null;
  const ultErro = (rows.find((r) => r.status === "failed")?.summary as { error?: string } | null)?.error ?? null;
  const timeouts = rows.filter((r) => r.status === "running").length; // nunca finalizaram = timeout
  const falhas = rows.filter((r) => r.status === "failed").length;

  return [{
    tipo: "sync_nao_completa",
    chave: "sync-bastao",
    titulo: `sync-bastao RODA mas NÃO COMPLETA (${total} runs, 0 sucesso em ${SYNC_NAO_COMPLETA_JANELA_MIN}min)`,
    detalhes:
      `O QUE: o cron sync-bastao está DISPARANDO normalmente (${total} runs nos últimos ` +
      `${SYNC_NAO_COMPLETA_JANELA_MIN}min) mas NENHUMA chegou a "succeeded" ` +
      `(${timeouts} timeout/running, ${falhas} failed). ` +
      (minDesdeSucesso != null
        ? `Última conclusão de verdade foi há ${minDesdeSucesso} min.`
        : `Não há registro de NENHUMA conclusão.`) +
      `\n\nPOR QUE: cards novos do Bastão (oc de relacionamento, exceção oc=13) ` +
      `podem NÃO estar aparecendo pros operadores. ` +
      (ultErro ? `Último erro registrado: "${ultErro}". ` : `Provável timeout 150s do Edge Function. `) +
      `Este alerta cobre o PONTO CEGO do monitor "sync_parou" (que só vê se a run ` +
      `COMEÇOU, não se TERMINOU).\n\n` +
      `SOLUÇÕES: 1) Supabase → Functions → sync-bastao → Logs (procurar IDLE_TIMEOUT / fatal); ` +
      `2) sync_runs: ver summary->>'error' da última failed e debug_sync_passes (qual pass estoura); ` +
      `3) se for timeout, aplicar/ajustar o deadline global dos passes; ` +
      `4) confirmar Bastão API no ar.`,
    payload: { runs_janela: total, sucesso, timeouts, falhas, minutos_desde_ultimo_sucesso: minDesdeSucesso, ultimo_erro: ultErro },
    cooldown_horas: 1,
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

/**
 * Cards em EXECUTANDO_ACAO há mais de 30min.
 *
 * Caio 2026-06-29 (NF 296312, mig 279): a causa NÃO é o Pass C — é o EXECUTOR /
 * RECONCILIAÇÃO. aprovar_e_executar move o card pra EXECUTANDO_ACAO e enfileira
 * a mensagem do executor; se a mensagem se perde, o card congela. Quem resolve
 * é o watchdog `reconciliar_execucoes_presas` (cron 5min, threshold 15min), que
 * re-enfileira (só-SSW idempotente) ou reverte p/ humano. Se um card APARECE
 * aqui (>30min), é porque o watchdog também NÃO resolveu — investigar o
 * reconciliador (ver card_events Execucao*).
 */
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
      `NFs: ${data.map((c) => c.nf).join(", ")}. O EXECUTOR não finalizou a ação ` +
      `e o watchdog reconciliar_execucoes_presas (cron 5min) também NÃO resolveu — ` +
      `checar card_events ExecucaoPresaDetectada/ExecucaoReenfileirada/` +
      `ExecucaoRevertidaPorWatchdog e os logs do executor (mensagem_lida vs ` +
      `processamento_concluido). NÃO é o Pass C do sync-bastao.`,
    payload: { cards: data.map((c) => ({ id: c.id, nf: c.nf })) },
  }];
}

/**
 * WATCHDOG INV-019 (Caio 2026-06-24, NF 175621) — INDEPENDENTE do sync-bastao.
 *
 * Regra inviolável: card em AGUARDANDO_CLIENTE só pode ter oc=54. Se a oc real
 * virou OUTRA oc de relacionamento (≠54), o card TEM que estar em AGUARDANDO VOCÊ.
 * O Pass A move na hora + o sweep `selfHealAguardandoClienteOcRelacionamento` é a
 * rede de segurança dentro do sync-bastao. ESTE check é o watchdog num PROCESSO
 * SEPARADO (cron health-check 5min): se ALGUM card violar a regra por mais de
 * 15min (= o sweep teve ≥2 ciclos pra curar e NÃO curou), manda e-mail pro Caio.
 *
 * Por que num processo separado: o bug de 2026-06-22 foi enforcement acoplado a
 * UM código (Pass E) que foi desligado em silêncio. Vigiar o RESULTADO (cards
 * presos) de fora torna impossível um futuro desligamento passar despercebido —
 * se o healer parar/for removido, este alerta dispara em ≤20min.
 *
 * Lista de ocs = espelha a regra de relacionamento ≠54 (INV-019 / verify-cockpit).
 * Cooldown 1h. Caso âncora: NF 175621 (oc=49 parada 5 dias, 52 cards).
 */
async function checkAguardandoClienteOcRelacionamento(s: SupabaseClient): Promise<Alerta[]> {
  const OCS_RELAC_SEM_54 = [3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52];
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: cand } = await s
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, updated_at, bastao_data_ultima_ocorrencia")
    .eq("state", "AGUARDANDO_CLIENTE")
    .in("cod_ultima_ocorrencia", OCS_RELAC_SEM_54)
    .lt("updated_at", cutoff);
  if (!cand || cand.length === 0) return [];
  // Exclui LAG: card que lançou 54 pelo Cockpit e o Bastão ainda mostra a oc
  // ANTERIOR (data <= data do lançamento de 54). Esses ficam CERTOS em
  // AGUARDANDO_CLIENTE — não são violação (Caio 2026-06-24, NF 175621). Senão o
  // watchdog spammaria e-mail em todo card recém-lançado. Ver lag-lancamento-54.ts.
  const data: Array<{ id: string; nf: string; cod_ultima_ocorrencia: number | null }> = [];
  for (const c of cand) {
    const ehLag = await naoRebaixarPorLancamento54(
      s,
      c.id as string,
      (c.bastao_data_ultima_ocorrencia as string | null) ?? null,
    );
    if (!ehLag) data.push(c as { id: string; nf: string; cod_ultima_ocorrencia: number | null });
  }
  if (data.length === 0) return [];
  return [{
    tipo: "inv019_aguardando_cliente_oc_relacionamento",
    chave: "inv019_violacao",
    titulo: `🚨 INV-019 VIOLADA: ${data.length} card(s) AGUARDANDO_CLIENTE com oc de relacionamento ≠54 (deveriam estar em AGUARDANDO VOCÊ)`,
    detalhes:
      `NFs: ${data.map((c) => `${c.nf}(oc${c.cod_ultima_ocorrencia})`).join(", ")}. ` +
      `Estes cards de relacionamento estão INVISÍVEIS pro operador (sem tratativa). ` +
      `O Pass A E o sweep selfHealAguardandoClienteOcRelacionamento do sync-bastao ` +
      `falharam (>15min sem curar). AÇÃO: verificar se o sweep foi removido/quebrado ` +
      `no sync-bastao e rodar /verify-cockpit (INV-019). Backfill manual: mover pra ` +
      `AGUARDANDO_VALIDACAO_HUMANA + lock.`,
    payload: { cards: data.map((c) => ({ id: c.id, nf: c.nf, oc: c.cod_ultima_ocorrencia })) },
    cooldown_horas: 1,
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
  // Tudo em BRT: dia-da-semana E hora no fuso de Brasília (antes o dia vinha de
  // getUTCDay → sexta 22h BRT contava como sábado e suprimia o alerta).
  const brtHora = horaBRT();
  const brtDia = diaSemanaBRT(); // 0=dom, 6=sáb
  const ehDiaUtil = brtDia >= 1 && brtDia <= 5;
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

/**
 * INV-016 (NF 761583, 2026-06-23): mensagens de CLIENTE presas no dead_letter.
 *
 * O triador classifica TODA mensagem via LLM. Quando a Anthropic 529, a resposta
 * do cliente vai pro DLQ → card não aparece como "CLIENTE RESPONDEU" e fica sem
 * propostas. O cron `reprocessar-dlq` (2min) drena o DLQ de volta; transientes
 * somem rápido. Só alerta se a mensagem TRAVOU (esgotou MAX_REPROCESS=4) OU está
 * presa há > 8min (reprocessador não conseguiu escoar = problema sustentado:
 * Anthropic fora há tempo, ou bug no pipeline). Caio PRECISA saber — é resposta
 * de cliente que pode estar invisível pro operador.
 */
const DLQ_CLIENTE_IDADE_MAX_MIN = 8;
async function checkDlqMensagensCliente(s: SupabaseClient): Promise<Alerta[]> {
  const { data, error } = await s.rpc("dlq_resumo_cliente");
  if (error) {
    console.error(`dlq_resumo_cliente: ${error.message}`);
    return [];
  }
  const rows = (data ?? []) as Array<{ source_queue: string; total: number; travadas: number; mais_antiga: string | null }>;
  if (rows.length === 0) return [];

  const totalMsgs = rows.reduce((a, r) => a + Number(r.total ?? 0), 0);
  const totalTravadas = rows.reduce((a, r) => a + Number(r.travadas ?? 0), 0);
  const maisAntiga = rows
    .map((r) => r.mais_antiga)
    .filter((x): x is string => !!x)
    .sort()[0] ?? null;
  const idadeMin = maisAntiga ? Math.floor((Date.now() - new Date(maisAntiga).getTime()) / 60_000) : 0;

  // Transitório (reprocessador ainda escoando, < 8min e nada travado) = silêncio.
  if (totalTravadas === 0 && idadeMin < DLQ_CLIENTE_IDADE_MAX_MIN) return [];

  const porFila = rows.map((r) => `${r.source_queue}: ${r.total} (${r.travadas} travadas)`).join(", ");
  return [{
    tipo: "dlq_cliente_presa",
    chave: "agent_intake_specialist",
    titulo: `${totalMsgs} mensagem(ns) de cliente presa(s) no DLQ (${totalTravadas} travada(s))`,
    detalhes:
      `O QUE: respostas de clientes que o pipeline não conseguiu processar estão no ` +
      `dead_letter há até ${idadeMin}min (${porFila}). Causa típica: Anthropic 529 ` +
      `derrubando o triador (classifica via LLM).\n\n` +
      `POR QUE IMPORTA (INV-016): cliente respondeu mas o card pode NÃO estar ` +
      `aparecendo como "CLIENTE RESPONDEU" pro operador, OU está sem os botões de ação. ` +
      `Regra inviolável: cliente respondeu → SEMPRE visível no Cockpit.\n\n` +
      `AUTO-CURA: o cron reprocessar-dlq (2min) re-enfileira automaticamente. As ` +
      `${totalTravadas} "travada(s)" esgotaram ${4} tentativas — precisam de olhar manual ` +
      `(Supabase → Functions → triador/vinculador → logs; ou reprocessar à mão).`,
    payload: { total: totalMsgs, travadas: totalTravadas, idade_min: idadeMin, por_fila: rows },
    cooldown_horas: 1,
  }];
}

/**
 * INV-016: a rede de segurança de propostas (cron-ia-resposta-pendentes) teve
 * que RECRIAR propostas pra cards em CLIENTE RESPONDEU sem botões. Isso só
 * acontece quando o caminho PRIMÁRIO (vinculador/scan-email) falhou. O operador
 * já foi desbloqueado (propostas existem), MAS Caio precisa saber que o caminho
 * principal está falhando — pode indicar Anthropic instável ou bug.
 */
async function checkPropostasRecuperadasPeloCron(s: SupabaseClient): Promise<Alerta[]> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await s
    .from("card_events")
    .select("card_id, payload, created_at")
    .eq("event_type", "PropostasRecuperadasPeloCron")
    .gte("created_at", cutoff)
    .limit(50);
  const eventos = (data ?? []) as Array<{ card_id: string; payload: Record<string, unknown> | null }>;
  if (eventos.length === 0) return [];

  const nfs = eventos
    .map((e) => (e.payload?.["nf"] as string | null) ?? null)
    .filter((x): x is string => !!x);
  return [{
    tipo: "propostas_recuperadas_cron",
    chave: "ultimos_30min",
    titulo: `Rede de segurança recriou propostas em ${eventos.length} card(s) (caminho primário falhou)`,
    detalhes:
      `O QUE: ${eventos.length} card(s) ficaram em "CLIENTE RESPONDEU" SEM nenhuma ` +
      `proposta — o caminho primário (vinculador/scan-email) não criou os botões e ` +
      `a rede de segurança (cron) precisou recriar. NFs: ${nfs.join(", ") || "(sem nf)"}.\n\n` +
      `POR QUE IMPORTA (INV-016): o operador foi desbloqueado (já tem os botões), mas ` +
      `o caminho principal está falhando repetidamente — provável Anthropic instável ` +
      `(triador/interpretador 529) ou mensagens caindo no DLQ. Verifique o alerta ` +
      `"dlq_cliente_presa" e os logs do triador.`,
    payload: { total: eventos.length, nfs },
    cooldown_horas: 1,
  }];
}

/**
 * Capacidade do banco (pós-apagão 2026-06-23, mig 243). Lê o último snapshot de
 * capacity_snapshots e alerta quando um EIXO de crescimento fica VERMELHO:
 *   - PESSOAS vermelho (conexões >= 80% do teto) -> alavanca "MAIS ESCRITÓRIO"
 *     (subir compute do Supabase = mais RAM = mais conexões).
 *   - ROBÔS vermelho (>= 5% de "job startup timeout") -> alavanca "SEPARAR OS
 *     ROBÔS" (réplica de leitura / workers dedicados).
 * Só VERMELHO dispara email; amarelo é pra acompanhar no painel visual
 * (monitor-capacidade.html). Cooldown 4h enquanto o eixo seguir vermelho.
 */
async function checkCapacidadeEstresse(s: SupabaseClient): Promise<Alerta[]> {
  const { data, error } = await s
    .from("capacity_snapshots")
    .select("ts, conn_pct, conn_max, cron_timeout_pct, operadores_ativos, cron_jobs_ativos, status_pessoas, status_robos")
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return [];
  const snap = data as {
    conn_pct: number; conn_max: number; cron_timeout_pct: number;
    operadores_ativos: number; cron_jobs_ativos: number;
    status_pessoas: string; status_robos: string;
  };
  const alertas: Alerta[] = [];
  if (snap.status_pessoas === "vermelho") {
    alertas.push({
      tipo: "capacidade_pessoas",
      chave: "conexoes",
      titulo: `Capacidade PESSOAS no vermelho — conexões em ${snap.conn_pct}% de ${snap.conn_max}`,
      detalhes:
        `O EIXO PESSOAS (mais operadores) bateu no vermelho: a lotação de conexões está ` +
        `em ${snap.conn_pct}% do teto (${snap.conn_max}), com ${snap.operadores_ativos} ` +
        `operadores ativos.\n\nALAVANCA: MAIS ESCRITÓRIO — subir o plano de compute do ` +
        `Supabase (mais RAM = mais conexões). Abra o painel monitor-capacidade.html.`,
      payload: { conn_pct: snap.conn_pct, conn_max: snap.conn_max, operadores: snap.operadores_ativos },
      cooldown_horas: 4,
    });
  }
  if (snap.status_robos === "vermelho") {
    alertas.push({
      tipo: "capacidade_robos",
      chave: "workers",
      titulo: `Capacidade ROBÔS no vermelho — ${snap.cron_timeout_pct}% de falha de worker`,
      detalhes:
        `O EIXO ROBÔS (mais regras/automações) bateu no vermelho: ${snap.cron_timeout_pct}% ` +
        `das execuções de cron falharam por "job startup timeout" (worker starvation), com ` +
        `${snap.cron_jobs_ativos} automações ativas.\n\nALAVANCA: SEPARAR OS ROBÔS — réplica ` +
        `de leitura / workers dedicados pra automação não disputar com o atendimento. ` +
        `Abra o painel monitor-capacidade.html.`,
      payload: { cron_timeout_pct: snap.cron_timeout_pct, jobs: snap.cron_jobs_ativos },
      cooldown_horas: 4,
    });
  }
  return alertas;
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
  // Idempotência: só envia 1 resumo por dia (dia civil de Brasília).
  const hoje = ymdBRT();
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
