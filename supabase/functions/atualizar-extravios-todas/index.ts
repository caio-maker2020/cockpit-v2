// =============================================================================
// atualizar-extravios-todas — botão "Atualizar todas" da aba EXTRAVIOS
//
// Caio 2026-06-18: força refresh (via SSW) de TODOS os cards EXTRAVIO_MONITORADO
// do operador logado, roteando os que mudaram de oc (relac→Tratativas;
// finalizadora→RESOLVIDO; outro setor→TRANSFERIDO; ainda extravio→fica). Reusa
// atualizar-card-via-portal-ssw por card.
//
// Anti-abuso (cooldown): bloqueia se
//   • último sync-extravios (Bastão) foi há < 20 min, OU
//   • último clique deste operador foi há < 10 min.
// Carimba o clique ANTES de processar (impede duplo-clique / corrida).
//
// Timeout-safe: processa em lotes de 5 em paralelo, com orçamento de tempo
// (~110s). O que não couber fica pro próximo clique / cron de 30min (logado).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const COOLDOWN_BASTAO_MS = 20 * 60_000;   // 20 min pós-sync do Bastão
const COOLDOWN_OPERADOR_MS = 10 * 60_000; // 10 min pós-clique do operador
const LOTE = 5;                           // cards por lote (paralelo)
const ORCAMENTO_MS = 110_000;             // teto de tempo (timeout edge = 150s)

Deno.serve(async (req) => {
  // Trava modo visualização (mig 324): gestor só-leitura (João/Isadora) não
  // executa; service_role e preflight passam direto (sem Authorization → null).
  {
    const travaAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const bloqueio = await bloquearSeModoVisualizacao(req, travaAdmin, corsHeaders);
    if (bloqueio) return bloqueio;
  }
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const startedAt = Date.now();

  try {
    const env = Deno.env.toObject();
    const supabaseUrl = env["SUPABASE_URL"]!;
    const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Resolve operador pelo JWT do front.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: userData } = await supabase.auth.getUser(token);
    const userId = userData?.user?.id;
    if (!userId) return json({ ok: false, error: "não autenticado" }, 401);

    const { data: opRow } = await supabase
      .from("operadores")
      .select("id, nome")
      .eq("user_id", userId)
      .maybeSingle();
    const operador = opRow as { id: string; nome: string } | null;
    if (!operador) return json({ ok: false, error: "operador não encontrado pro usuário" }, 403);

    // 2. Cooldown — vale o MAIOR entre os dois bloqueios.
    const { data: syncRow } = await supabase
      .from("sync_status_global").select("ultimo_sync_extravios").eq("id", 1).maybeSingle();
    const { data: lockRow } = await supabase
      .from("extravios_atualizar_lock").select("ultimo_clique_em").eq("operador_id", operador.id).maybeSingle();

    const ultimoBastao = (syncRow as { ultimo_sync_extravios?: string } | null)?.ultimo_sync_extravios;
    const ultimoClique = (lockRow as { ultimo_clique_em?: string } | null)?.ultimo_clique_em;
    const liberaBastao = ultimoBastao ? new Date(ultimoBastao).getTime() + COOLDOWN_BASTAO_MS : 0;
    const liberaOperador = ultimoClique ? new Date(ultimoClique).getTime() + COOLDOWN_OPERADOR_MS : 0;
    const liberadoEmMs = Math.max(liberaBastao, liberaOperador);

    if (liberadoEmMs > Date.now()) {
      const motivo = liberadoEmMs === liberaBastao ? "sync_bastao" : "clique_operador";
      return json({
        ok: true,
        bloqueado: true,
        motivo,
        liberado_em: new Date(liberadoEmMs).toISOString(),
        segundos_restantes: Math.ceil((liberadoEmMs - Date.now()) / 1000),
      }, 200);
    }

    // 3. Carimba o clique ANTES de processar (anti duplo-clique).
    await supabase.from("extravios_atualizar_lock").upsert({
      operador_id: operador.id,
      ultimo_clique_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "operador_id" });

    // 4. Cards de extravio do operador.
    const { data: cardsRows } = await supabase
      .from("cards")
      .select("id, nf")
      .eq("state", "EXTRAVIO_MONITORADO")
      .eq("assigned_operator_id", operador.id);
    const cards = ((cardsRows ?? []) as Array<{ id: string; nf: string | null }>);

    const resumo = { total: cards.length, processados: 0, deferidos: 0, erros: [] as string[] };

    for (let i = 0; i < cards.length; i += LOTE) {
      if (Date.now() - startedAt > ORCAMENTO_MS) {
        resumo.deferidos = cards.length - i;
        console.log(`[atualizar-extravios-todas] orçamento estourou — ${resumo.deferidos} cards adiados pro próximo ciclo.`);
        break;
      }
      const lote = cards.slice(i, i + LOTE);
      const res = await Promise.allSettled(lote.map((c) =>
        fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/atualizar-card-via-portal-ssw`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${serviceKey}`,
            "apikey": serviceKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_id: c.id }),
          signal: AbortSignal.timeout(45_000),
        }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      ));
      for (let j = 0; j < res.length; j++) {
        const r = res[j];
        if (r.status === "fulfilled") resumo.processados++;
        else resumo.erros.push(`NF ${lote[j].nf}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }

    return json({
      ok: true,
      bloqueado: false,
      duration_ms: Date.now() - startedAt,
      proximo_liberado_em: new Date(Date.now() + COOLDOWN_OPERADOR_MS).toISOString(),
      ...resumo,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("atualizar-extravios-todas fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
