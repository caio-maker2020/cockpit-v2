// =============================================================================
// atualizar-estado-tratativa — o WORKER da memória do card (F1 do plano 17/09).
//
// Cron 1/min (mig 404). 1ª linha: flag estado_tratativa_worker_enabled — OFF =
// inerte (dirty acumula sem dano; rollback de 1 clique). Por tick:
//   1. claim atômico de até 20 cards dirty (RPC SKIP LOCKED);
//   2. + backfill preguiçoso: até 5 cards ATIVOS sem memória ainda;
//   3. recompute determinístico (lib pura) — grava só se hash_fontes mudou;
//   4. resumo Haiku SÓ se flag resumo ON e houver TEXTO novo desde resumo_de_rev
//      (dirty vindo só de oc/execução reaproveita o resumo anterior — TRACE).
// NUNCA insere card_events. NUNCA toca outra coluna. Custo logado como
// 'estado-tratativa' no anthropic_usage_log.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { makeUsageRecorder } from "../_shared/anthropic-usage-logger.ts";
import {
  ESTADO_RESUMO_MAX_TOKENS,
  ESTADO_RESUMO_MODEL,
  ESTADO_RESUMO_SYSTEM,
} from "../_shared/prompts/estado-resumo-haiku.ts";
import {
  type EstadoTratativa,
  type FatoConfirmado,
  hashFontes,
  idDoFato,
  montarEstado,
  type TipoFato,
} from "../_shared/estado-tratativa.ts";
import { carregarFontes, persistirEstado } from "../_shared/estado-tratativa-carregar.ts";

const BATCH_DIRTY = 20;
const BATCH_BACKFILL = 5;
const STATES_ATIVOS = [
  "AGUARDANDO_AGENTE", "AGUARDANDO_VALIDACAO_HUMANA", "AGUARDANDO_CLIENTE",
  "EXECUTANDO_ACAO", "AGUARDANDO_TERCEIRO", "TRATATIVA_PENDENTE", "ACAO_EXECUTADA",
];

interface ResumoLlm {
  resumo: string;
  fatos_texto: Array<{ fato: string; detalhe: string; tipo: string; fonte_ref: string }>;
  divida: string[];
}

serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

  const { data: flag } = await supabase.from("feature_flags")
    .select("enabled").eq("key", "estado_tratativa_worker_enabled").maybeSingle();
  if ((flag as { enabled?: boolean } | null)?.enabled !== true) {
    return json({ ok: true, skip: "flag off" });
  }
  const { data: flagLlm } = await supabase.from("feature_flags")
    .select("enabled").eq("key", "estado_tratativa_resumo_llm_enabled").maybeSingle();
  const llmLigado = (flagLlm as { enabled?: boolean } | null)?.enabled === true;

  // 1. dirty (claim atômico) + 2. backfill preguiçoso de ativos sem memória
  const { data: dirtyIds } = await supabase.rpc("claim_estado_tratativa_dirty", { p_limit: BATCH_DIRTY });
  const ids = new Set<string>(((dirtyIds ?? []) as string[]).map(String));
  const { data: semMemoria } = await supabase.from("cards").select("id")
    .in("state", STATES_ATIVOS).is("estado_tratativa", null)
    .order("last_event_at", { ascending: false }).limit(BATCH_BACKFILL);
  for (const r of (semMemoria ?? []) as Array<{ id: string }>) ids.add(r.id);

  const anthropic = llmLigado
    ? createAnthropicClient({
      env: readAnthropicEnvFromProcess(Deno.env.toObject()),
      onUsage: makeUsageRecorder(supabase, {
        functionName: "estado-tratativa", agentName: "estado-tratativa",
      }),
    })
    : null;

  let recomputados = 0, resumidos = 0, pulados = 0;
  const erros: string[] = [];

  for (const cardId of ids) {
    try {
      const carga = await carregarFontes(supabase, cardId, "worker");
      if (!carga) continue;
      const { fontes, anterior } = carga;
      if (anterior && anterior.hash_fontes === hashFontes(fontes) && anterior.resumo != null) {
        pulados++;
        continue; // nada mudou de verdade (dirty por evento irrelevante)
      }
      let novo = montarEstado(fontes, anterior);

      // resumo Haiku: só com texto novo (resposta do cliente / histórico com
      // instrução nova) desde a rev do último resumo — senão reaproveita.
      const textoNovo =
        anterior?.resumo == null ||
        (fontes.clienteRespondeuEm != null &&
          anterior?.gerado_por?.llm_em != null &&
          fontes.clienteRespondeuEm > anterior.gerado_por.llm_em) ||
        (anterior?.gerado_por?.llm_em == null);
      if (anthropic && textoNovo) {
        const r = await resumir(supabase, anthropic, cardId, novo, fontes.historicoSsw);
        if (r) {
          const fatosLlm: FatoConfirmado[] = r.fatos_texto.slice(0, 5).map((f) => {
            const tipo = (["recebimento_doc","promessa","endereco","recusa","avaria","prazo","contato","autorizacao","outro"]
              .includes(f.tipo) ? f.tipo : "outro") as TipoFato;
            const semId = {
              fato: f.fato.slice(0, 60), detalhe: f.detalhe.slice(0, 200), tipo,
              fonte: { tipo: "email" as const, ref: f.fonte_ref.slice(0, 120) },
              origem: "llm" as const, em: novo.atualizado_em,
            };
            return { id: idDoFato(semId), ...semId };
          });
          const jaTem = new Set(novo.fatos_confirmados.map((x) => x.id));
          novo = {
            ...novo,
            resumo: r.resumo.slice(0, 600),
            resumo_de_rev: novo.rev,
            fatos_confirmados: [...novo.fatos_confirmados, ...fatosLlm.filter((f) => !jaTem.has(f.id))].slice(0, 20),
            divida: r.divida.slice(0, 5).map((t) => ({ texto: t.slice(0, 200), origem: "llm" as const, em: novo.atualizado_em })),
            gerado_por: { ...novo.gerado_por, llm_modelo: ESTADO_RESUMO_MODEL, llm_em: new Date().toISOString() },
          };
          resumidos++;
        }
      }
      await persistirEstado(supabase, cardId, novo, anterior?.rev ?? null);
      recomputados++;
    } catch (e) {
      erros.push(`${cardId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return json({ ok: true, claim: ids.size, recomputados, resumidos, pulados, erros: erros.slice(0, 5) });
});

async function resumir(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  anthropic: ReturnType<typeof createAnthropicClient>,
  cardId: string,
  estado: EstadoTratativa,
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null; data: string | null }>,
): Promise<ResumoLlm | null> {
  try {
    const { data: emails } = await supabase.from("messages_inbox")
      .select("remetente, conteudo, recebido_em")
      .eq("card_id", cardId)
      .order("recebido_em", { ascending: false }).limit(3);
    const blocosEmail = ((emails ?? []) as Array<{ remetente: string; conteudo: string; recebido_em: string }>)
      .map((m, i) => `[email:${i}] de ${m.remetente} em ${m.recebido_em?.slice(0, 16)}:\n${String(m.conteudo ?? "").slice(0, 1200)}`)
      .join("\n---\n");
    const linhasHist = historico.slice(0, 10)
      .map((o, i) => `[oc:${i}] ${o.data?.slice(0, 16) ?? "?"} oc=${o.codigo} ${String(o.instrucao ?? "").slice(0, 200)}`)
      .join("\n");
    const estadoCompacto = JSON.stringify({
      situacao: estado.situacao, ciclo: estado.ciclo_atual,
      ja_feito: estado.ja_feito_no_ciclo.map((a) => ({ oc: a.codigo_oc, em: a.em.slice(0, 10) })),
      aguardando: estado.aguardando, pendencias: estado.pendencias_dossie, alertas: estado.alertas,
      fatos: estado.fatos_confirmados.filter((f) => f.origem !== "llm").map((f) => f.detalhe),
    });
    return await anthropic.completeJson<ResumoLlm>({
      model: ESTADO_RESUMO_MODEL,
      system: ESTADO_RESUMO_SYSTEM,
      messages: [{
        role: "user",
        content: `ESTADO ESTRUTURADO (verdade verificada):\n${estadoCompacto}\n\nOCORRÊNCIAS RECENTES:\n${linhasHist}\n\nE-MAILS RECENTES:\n${blocosEmail || "(nenhum)"}`,
      }],
      maxTokens: ESTADO_RESUMO_MAX_TOKENS,
      temperature: 0,
      meta: { messageId: cardId },
    });
  } catch (e) {
    console.warn(`[estado-tratativa] resumo falhou (${cardId}): ${e instanceof Error ? e.message : e}`);
    return null;   // resumo é display: falha nunca derruba o recompute
  }
}
