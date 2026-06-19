// =============================================================================
// sync-bastao — Edge Function (Deno runtime)
//
// 3 passes em ordem:
//   Pass A — discover: importa pendências do Bastão filtradas por
//            OCORRENCIAS_DE_RELACIONAMENTO + BASTAO_TEST_FILTER_OPERATOR.
//            Cria card OU atualiza dados sincronizados.
//   Pass B — release: cards ativos no Cockpit cuja pendência no Bastão
//            (lookup por NF) saiu do escopo do Relacionamento → fecha card
//            como RESOLVIDO + grava DevolvidoParaOperacao.
//   Pass C — verify: todos.status='executando' → checa se a ocorrência
//            esperada (proposta_payload.args.codigo) já apareceu no Bastão.
//
// IMPORTANTE — Bastão regenera os UUIDs de pendências.id a cada update
// (DELETE + INSERT no upstream a cada ~40min). Por isso o match Cockpit ↔ Bastão
// é feito por (nf, ctrc), não por bastao_pendencia_id. O campo
// bastao_pendencia_id em cards continua sendo populado pra debug e auditoria,
// mas não é chave estável.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";
import {
  OCORRENCIAS_DE_RELACIONAMENTO,
  isOcorrenciaDeRelacionamentoCtx,
  VERIFICATION_TIMEOUT_MINUTES,
  isOcorrenciaDeRelacionamento,
  stateFinalAposBastao,
} from "../_shared/bastao-rules.ts";
import { proporAutoAcaoSeAplicavel, REGRAS_AUTO_ACAO } from "../_shared/regras-auto-acao.ts";
// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao"): tracking SSW público
// foi substituído pelo SSW interno (opção 101). Imports antigos do
// ssw-tracking-client removidos. Pass B e Pass E agora usam descobrirUltimaOcSsw.
import { descobrirUltimaOcSsw } from "../_shared/ssw-internal-client.ts";
import { confirmarAcaoExecutadaViaSsw } from "../_shared/confirmar-acao-executada-ssw.ts";
import {
  aplicarTransicaoAguardandoCliente,
  decidirTransicaoAguardandoCliente,
} from "../_shared/transicao-aguardando-cliente.ts";
import { resolverEPersistirChaveCte } from "../_shared/chave-cte-resolver.ts";
import { resolverCamposAtribuicaoDoCard } from "../_shared/operador-resolver.ts";
import {
  OCS_EXTRAVIO,
  analisarExtravio,
  montarAvisoExtravio,
  resolverEmailDestino,
  snapshotExtravio,
  upsertPropostas as upsertPropostasExtravio,
} from "../_shared/extravio-enrichment.ts";
import { verificarEvidenciaESinalizar } from "../_shared/verificar-evidencia.ts";
import {
  loadOcsBloqueadasTracking,
  type OcsBloqueadasTracking,
} from "../_shared/ocs-bloqueadas-tracking.ts";
import { clampOcAoDicionario } from "../_shared/safe-oc-update.ts";

interface PassASummary {
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
}

interface PassBSummary {
  checked: number;
  released: number;
  not_found_in_bastao: number;
}

interface PassCSummary {
  pending: number;
  confirmed: number;
  timed_out: number;
  still_waiting: number;
}

interface PassDSummary {
  checked: number;
  aviso_disparado: number;
  sem_pendencia_no_bastao: number;
}

interface PassESummary {
  checked: number;
  mantido_em_54: number;
  resolvido_finalizadora: number;
  movido_aguardando_voce: number;
  movido_transferido: number;
  sem_info: number;
  /** Caio 2026-05-13: Pass E roda a cada 8h. Quando pula, marca true. */
  pulado_por_cadencia: boolean;
  /** Timestamp ISO da última execução completa (não pulada). Lido pelo próximo sync. */
  last_full_run_at: string | null;
}

interface PassFSummary {
  checked: number;
  resolvido: number;
  ainda_sem_chave: number;
}

interface PassGSummary {
  checked: number;
  liberados: number;
  ainda_aguardando: number;
  bastao_sem_dado: number;
}

interface PassHSummary {
  checked: number;
  liberados: number;
  ssw_indisponivel: number;
  ainda_em_grace: number;
  // Caio 2026-06-15: SSW confirmou que a oc pretendida NÃO foi lançada →
  // card revertido pro operador (não conta como liberado nem indisponível).
  revertidos_nao_lancada: number;
}

interface SyncSummary {
  pass_a: PassASummary;
  pass_b: PassBSummary;
  pass_c: PassCSummary;
  pass_d: PassDSummary;
  pass_e: PassESummary;
  pass_f: PassFSummary;
  pass_g: PassGSummary;
  pass_h: PassHSummary;
  errors: Array<{ pass: string; ref: string; message: string }>;
  duration_ms: number;
}

// Caio 2026-06-19 (FIX timeout 150s — estrutural): DEADLINE GLOBAL do sync.
// Os passes A-H rodam em série; vários (B/C/D/E/G) fazem 1 chamada SSW/Bastão por
// card pros cards que saíram do Bastão (confirmação pra soltar). Com backlog, a
// SOMA estourava os 150s e a run morria no meio de um pass (cauda perdida pro
// ciclo). Cada loop de pass respeita este deadline: processa o que cabe, DEFERE o
// resto pro próximo ciclo (latência, nunca perda). Reserva ~20s pro fechamento
// (summary + sync_runs + registrar_sync_concluido).
let _syncDeadlineMs = Number.POSITIVE_INFINITY;
export function syncDeadlineExcedido(): boolean {
  return Date.now() > _syncDeadlineMs;
}

// Caio 2026-06-19 (Fix B — raiz Extravios + rede de segurança geral): self-heal
// dos cards PRESOS. Assinatura do bug: card em AGUARDANDO_VALIDACAO_HUMANA + lock
// + oc COM regra + ZERO propostas ativas. Origem clássica: transição
// Extravios→relacionamento (oc=20 saindo da aba Extravios cancela as propostas de
// extravio; a recriação de relacionamento é DEFERIDA pra confirmar a oc no SSW —
// proteção NF 761333 — e se o passo deferido não roda, o card fica travado e vazio:
// NF 30159/427148). Em vez de forçar a recriação inline (arriscado, Bastão pode
// divergir), uma varredura barata recupera QUALQUER card com essa assinatura,
// independente de como travou. Roda 1x por sync (cedo, após Pass A), bounded pelo
// deadline. Conjunto pequeno (só lockados) → custo baixo. Complementa o Fix A
// (resgate via botão ATUALIZAR) e o alerta health-check.
async function selfHealCardsPresos(
  supabase: SupabaseClient,
  excecoesOc13: ReadonlySet<string>,
): Promise<number> {
  if (syncDeadlineExcedido()) return 0;
  const ocsComRegra = Object.keys(REGRAS_AUTO_ACAO).map((k) => Number(k));
  const { data: lockados, error } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, agent_state")
    .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
    .eq("lock_aguardando_validacao", true)
    .in("cod_ultima_ocorrencia", ocsComRegra)
    .limit(200);
  if (error || !lockados) return 0;
  let curados = 0;
  for (const c of lockados as Array<Record<string, unknown>>) {
    if (syncDeadlineExcedido()) break;
    const cardId = c["id"] as string;
    const { count } = await supabase
      .from("todos")
      .select("id", { count: "exact", head: true })
      .eq("card_id", cardId)
      .in("status", ["pendente", "aprovado"]);
    if ((count ?? 0) > 0) continue; // tem proposta ativa — card saudável
    try {
      await proporAutoAcaoSeAplicavel(supabase, {
        cardId,
        cardNf: (c["nf"] as string | null) ?? null,
        cardCtrc: (c["ctrc"] as string | null) ?? null,
        codUltimaOc: c["cod_ultima_ocorrencia"] as number | null,
        agentState: (c["agent_state"] ?? {}) as Record<string, unknown>,
        cardState: "AGUARDANDO_VALIDACAO_HUMANA",
        cardLock: true,
        excecoesOc13,
        actorId: "sync-bastao/self-heal-presos",
      });
      curados++;
    } catch (e) {
      console.warn(`[self-heal] nf ${c["nf"]} falhou (não bloqueia): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (curados > 0) {
    console.log(`[self-heal] ${curados} card(s) preso(s) (AVH+lock sem propostas) recuperado(s).`);
  }
  return curados;
}

serve(async (req) => {
  const startedAt = Date.now();
  _syncDeadlineMs = startedAt + 130_000;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Camada 6: telemetria — insere linha em sync_runs no início, atualiza
  // no fim com summary + status. Sempre tenta inserir, mesmo se algo
  // explodir depois.
  let syncRunId: string | null = null;
  try {
    const { data } = await supabase
      .from("sync_runs")
      .insert({ status: "running" })
      .select("id")
      .single();
    syncRunId = (data as { id: string } | null)?.id ?? null;
  } catch (_e) {
    // não-fatal: se a tabela ainda não existe, segue
  }

  // Caio 2026-06-09: marca cache `sync_status_global` no INÍCIO também (não
  // só no fim). Edge demora 2-3min em algumas runs e era cortada pelo Supabase
  // timeout (~150s) ANTES de chegar no registrar_sync_bastao_concluido() do
  // fim. Resultado: monitor health-check.checkSyncBastaoSemRodar acreditava
  // que sync parou há horas/dias quando na verdade só não conseguia gravar.
  // Marca no início garante que o cache atualiza mesmo se a edge for cortada.
  // No fim, registra de novo com runtime_ms real pra precisão.
  try {
    await supabase.rpc("registrar_sync_bastao_concluido", { p_runtime_ms: null });
  } catch (e) {
    console.warn("registrar_sync_bastao_concluido (início) falhou (não-fatal):", e instanceof Error ? e.message : String(e));
  }

  try {
    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    const errors: SyncSummary["errors"] = [];

    // Caio 2026-05-13 (Fase 3): tracking SSW público REMOVIDO. Passes B e E
    // agora usam SSW interno (opção 101) via descobrirUltimaOcSsw on-demand.
    // Sem mais buildTrackingResolver / tracking_credentials.

    // Caio 2026-05-07: lista de ocs bloqueadas pro tracking do cliente
    // (ex: 49, 56, 44). Lista mantida pra controle interno (alguns helpers
    // ainda usam pra UI / rotulagem), mas Pass A/B/E não dependem mais dela.
    const ocsBloqueadasTracking = await loadOcsBloqueadasTracking(supabase);

    // Caio 2026-05-19: CNPJs onde oc=13 vira caso de relacionamento (exceção).
    // 12 CNPJs em 4 grupos (F E F, União Química, O.V.D., Ferramentas Gerais).
    // Carregado 1x e passado pros Passes A/B/D que decidem se importam o card.
    const excecoesOc13 = await loadExcecoesOc13(supabase);
    // Caio 2026-05-20: CNPJs em cnpjs_excluidos_cockpit não viram card.
    // Caso âncora AMPLA SLI TRANS (cliente de operador demitido).
    const cnpjsExcluidos = await loadCnpjsExcluidos(supabase);

    // Observabilidade do sync (2026-06-19): timing por pass → debug_sync.passes_ms.
    const _passesMs: Record<string, number> = {};
    let _tPass = Date.now();
    const _mark = async (nome: string) => {
      _passesMs[nome] = Date.now() - _tPass;
      _tPass = Date.now();
      await supabase.from("sync_status_global")
        .update({ debug_sync_passes: _passesMs }).eq("id", 1).then(() => {}, () => {});
    };

    const passARes = await runPassA(supabase, bastao, ocsBloqueadasTracking, excecoesOc13, cnpjsExcluidos, errors);
    await _mark("A");
    const passA = passARes.summary;
    // Fix B (2026-06-19): recupera cards presos vazios (AVH+lock sem propostas) —
    // roda cedo, logo após o Pass A, pra garantir tempo dentro do deadline. O nº
    // de curados é logado dentro da função.
    await selfHealCardsPresos(supabase, excecoesOc13);
    await _mark("selfHeal");
    const passB = await runPassB(supabase, bastao, excecoesOc13, errors, passARes.pulledNfs);
    await _mark("B");
    const passC = await runPassC(supabase, bastao, errors);
    await _mark("C");
    const passD = await runPassD(supabase, bastao, excecoesOc13, errors);
    await _mark("D");
    const passE = await runPassE(supabase, bastao, ocsBloqueadasTracking, errors);
    await _mark("E");
    const passF = await runPassF(supabase, errors);
    await _mark("F");
    // Caio 2026-05-07: Pass G libera cards em ACAO_EXECUTADA. Pass A só pega
    // pendências do Bastão filtradas por OCS_RELACIONAMENTO — então cards
    // lançados com oc fora do escopo (ex: 56) ficavam presos. Pass G busca
    // direto por NF (sem filtro) e libera quando Bastão.oc == card.oc.
    const passG = await runPassG(supabase, bastao, errors);

    // Caio 2026-05-13 (Fase 2 plano "hoje-usamos-o-bastao"): Pass H consulta
    // SSW interno (opção 101) on-time pra liberar cards em ACAO_EXECUTADA
    // sem esperar latência RPA Bastão. Roda APÓS Pass G — se G já liberou,
    // card sai do SELECT de H (filtro state=ACAO_EXECUTADA). Pass G fica
    // como backup nos primeiros 14 dias do rollout (fase 3 remove).
    const passH = await runPassH(supabase, errors);

    const duration_ms = Date.now() - startedAt;
    const summary: SyncSummary = {
      pass_a: passA, pass_b: passB, pass_c: passC, pass_d: passD,
      pass_e: passE, pass_f: passF, pass_g: passG, pass_h: passH,
      errors,
      duration_ms,
    };

    // Camada 3: persiste cada erro em sync_errors e, se >=3, abre alerts
    // (nunca mais ficam só no JSON do response — Caio vê no banner do front).
    if (errors.length > 0) {
      const rows = errors.map((e) => {
        const nfMatch = e.ref.match(/^(\d+)\//) ?? e.ref.match(/^(\d+)$/);
        return {
          pass: e.pass,
          ref: e.ref,
          nf: nfMatch ? nfMatch[1] : null,
          message: e.message,
        };
      });
      await supabase.from("sync_errors").insert(rows);

      if (errors.length >= 3) {
        await supabase.from("alerts").insert({
          tipo: "sync_bastao_erros_em_lote",
          severidade: "error",
          mensagem: `sync-bastao retornou ${errors.length} erros nesta execução. Ver tabela sync_errors.`,
          metadata: { errors_count: errors.length, duration_ms, sample: errors.slice(0, 5) },
        });
      }
    }

    // Camada 6: atualiza sync_runs com summary final.
    if (syncRunId) {
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms,
          summary,
          errors_count: errors.length,
          status: "succeeded",
        })
        .eq("id", syncRunId);
    }

    console.log("Sync done:", JSON.stringify(summary));

    // Cache do "última sync" pro header do front (mig 167) — evita 6k SELECTs
    // pesados em cards.bastao_synced_at (planning 900ms por causa dos 25 índices).
    try {
      await supabase.rpc("registrar_sync_bastao_concluido", {
        p_runtime_ms: summary.duration_ms ?? null,
      });
    } catch (e) {
      console.warn("registrar_sync_bastao_concluido falhou (não-fatal):", e instanceof Error ? e.message : String(e));
    }
    // Caio 2026-06-18 (ADR 0005): sync único também é o sync de extravios →
    // carimba o timestamp que dirige o cooldown de 20min do "Atualizar todas".
    try {
      await supabase.rpc("registrar_sync_extravios_concluido");
    } catch (_e) { /* não-fatal */ }

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync-bastao fatal:", message);

    if (syncRunId) {
      await supabase
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          status: "failed",
          summary: { error: message },
        })
        .eq("id", syncRunId);
    }

    await supabase.from("alerts").insert({
      tipo: "sync_bastao_fatal",
      severidade: "error",
      mensagem: `sync-bastao falhou catastroficamente: ${message}`,
      metadata: { duration_ms: Date.now() - startedAt },
    });

    return new Response(
      JSON.stringify({ error: message, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// =============================================================================
// PASS A — discover
// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type BastaoClient = ReturnType<typeof createBastaoClient>;

/**
 * Ocorrências finalizadoras do CT-e (regra Sal Express 2026-05-05). Quando
 * uma dessas oc é lançada, a NF some do Bastão pendência. Sync-bastao Pass B
 * consulta SSW interno (opção 101) pra confirmar; se última oc bate, fecha
 * card RESOLVIDO.
 *  - 30: finaliza CT-e
 *  - 01: entrega normal (finaliza)
 *  - 32: finaliza CT-e
 */
const OCORRENCIAS_FINALIZADORAS: ReadonlySet<number> = new Set([1, 30, 32]);

// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
// `buildTrackingResolver`, `TrackingResolver`, `SswTrackingClient` e
// `fetchOcDoTracking` REMOVIDOS. Substituídos por `descobrirUltimaOcSsw`
// importado de _shared/ssw-internal-client.ts. SSW interno cobre 100% das
// ocs (público ocultava 31) e elimina dependência de tracking_credentials.

/**
 * Caio 2026-05-19: carrega CNPJs onde oc=13 vira caso de relacionamento.
 * Tabela `cliente_config_oc13` (migration 121). Set pequeno (~12 CNPJs),
 * carregado 1x por sync e passado pros Passes A/B/D.
 *
 * Erro = retorna Set vazio (comportamento legacy, conservador).
 */
async function loadExcecoesOc13(supabase: SupabaseClient): Promise<ReadonlySet<string>> {
  try {
    const { data, error } = await supabase
      .from("cliente_config_oc13")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error) {
      console.warn(`[sync-bastao] loadExcecoesOc13 falhou: ${error.message} — Set vazio (legacy).`);
      return new Set<string>();
    }
    const set = new Set<string>();
    for (const r of (data ?? []) as Array<{ cnpj_pagador: string }>) {
      if (r.cnpj_pagador) set.add(r.cnpj_pagador);
    }
    return set;
  } catch (e) {
    console.warn(`[sync-bastao] loadExcecoesOc13 throw: ${e instanceof Error ? e.message : String(e)} — Set vazio (legacy).`);
    return new Set<string>();
  }
}

/**
 * Caio 2026-05-20: carrega CNPJs marcados pra NÃO virarem card no Cockpit.
 * Tabela `cnpjs_excluidos_cockpit` (migration 140). Caso âncora: AMPLA SLI
 * TRANS (21280493000130) — cliente de operador demitido, sem responsável.
 * Pass A skipa upsert pra esses CNPJs (não cria nem atualiza card).
 *
 * Mesmo pattern de loadExcecoesOc13 — Set pequeno, 1× por sync.
 * Erro = Set vazio (conservador: prefere recriar que sumir indevido).
 */
async function loadCnpjsExcluidos(supabase: SupabaseClient): Promise<ReadonlySet<string>> {
  try {
    const { data, error } = await supabase
      .from("cnpjs_excluidos_cockpit")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error) {
      console.warn(`[sync-bastao] loadCnpjsExcluidos falhou: ${error.message} — Set vazio.`);
      return new Set<string>();
    }
    const set = new Set<string>();
    for (const r of (data ?? []) as Array<{ cnpj_pagador: string }>) {
      if (r.cnpj_pagador) set.add(r.cnpj_pagador);
    }
    return set;
  } catch (e) {
    console.warn(`[sync-bastao] loadCnpjsExcluidos throw: ${e instanceof Error ? e.message : String(e)} — Set vazio.`);
    return new Set<string>();
  }
}

async function runPassA(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  ocsBloqueadasTracking: OcsBloqueadasTracking,
  excecoesOc13: ReadonlySet<string>,
  cnpjsExcluidos: ReadonlySet<string>,
  errors: SyncSummary["errors"],
): Promise<{ summary: PassASummary; pulledNfs: Set<string> }> {
  // Camada 5c: operadores ativos no Cockpit (cockpit_ativo=true). Substitui
  // o hardcode BASTAO_TEST_FILTER_OPERATOR="LARISSA". Quando subir outro
  // operador, basta UPDATE operadores SET cockpit_ativo=true WHERE nome=...
  const { data: operadoresAtivos } = await supabase
    .from("operadores")
    .select("nome, carteira, segmentos")
    .eq("cockpit_ativo", true)
    .eq("ativo", true);
  const nomesOperadores = (operadoresAtivos ?? [])
    .map((r) => (r as { nome: string }).nome)
    .filter((n): n is string => !!n);

  // Caio 2026-06-16: EXCEÇÃO Curva F (043). Operadores cujo segmento inclui
  // "043" (ISA/Karol) tocam TODOS os clientes <20k/mês — a planilha só lista os
  // de maior demanda. Pra eles, o sync ignora a allowlist por carteira e puxa
  // 100% do que o Bastão aponta como segmento 043 OU responsável = nome desses
  // operadores. (Os demais operadores seguem 100% por allowlist de carteira.)
  const responsaveisCurvaF = (operadoresAtivos ?? [])
    .filter((r) => ((r as { segmentos?: string[] | null }).segmentos ?? []).includes("043"))
    .map((r) => (r as { nome: string }).nome)
    .filter((n): n is string => !!n);

  // Caio 2026-06-16 (onboarding rápido + allowlist): o Cockpit só puxa clientes
  // que estão na carteira de algum operador ATIVO (= planilha do operador).
  // Cliente fora de toda carteira NÃO entra — entra quando um operador o assumir.
  // RELAXA INV-003 conscientemente (decisão Caio 2026-06-16). Benefícios:
  // (1) onboarding determinístico — adiciona carteira do operador → cards dele
  //     aparecem; (2) reduz drasticamente o volume do sync → não estoura 150s.
  const cnpjsAllowlist = Array.from(
    new Set(
      (operadoresAtivos ?? []).flatMap(
        (r) => ((r as { carteira?: string[] | null }).carteira ?? []),
      ),
    ),
  );

  // Caio 2026-06-18 (ADR 0005, sync único): puxa extravio (6/9/16) junto com
  // relacionamento quando a flag está ON. OFF → comportamento idêntico ao legado
  // (extravio nem é puxado). Mesma filtragem por allowlist/carteira + curvaF.
  const { data: flagExtravios } = await supabase
    .from("feature_flags").select("enabled").eq("key", "extravios_cockpit_enabled").maybeSingle();
  const extraviosEnabled = (flagExtravios as { enabled?: boolean } | null)?.enabled === true;

  const _tA0 = Date.now(); // Observabilidade do sync (2026-06-19): timing por fase
  const pendencias = await bastao.fetchPendenciasDoCockpit({
    cnpjsAllowlist,
    excecoesOc13Cnpjs: [...excecoesOc13],
    excecaoFullPull: { segmentoPrefixos: ["043"], responsaveis: responsaveisCurvaF },
    ocsExtras: extraviosEnabled ? [6, 9, 16] : null,
  });
  const _tPull = Date.now(); // observabilidade: marco pós-pull
  console.log(
    `[A] Bastão retornou ${pendencias.length} pendências (allowlist=${cnpjsAllowlist.length} CNPJs de ${nomesOperadores.length} operadores ativos, ` +
    `exceção CurvaF/043 + responsáveis=[${responsaveisCurvaF.join(",")}], ` +
    `${excecoesOc13.size} CNPJs excecao oc=13). ` +
    `${ocsBloqueadasTracking.size} ocs bloqueadas pro tracking (lista mantida pra UI/labels).`,
  );

  // Caio 2026-06-16: pré-fetch dos cards existentes por NF em LOTE (1 query
  // chunked em vez de 1 SELECT por pendência = N+1). Onboarding em massa não
  // estoura mais o timeout 150s. Map nf -> card mais recente (replica o
  // `.eq(nf).order(created_at desc).limit(1)` que era inline em upsert).
  const SELECT_CARD_FIELDS =
    "id, nf, created_at, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state, bastao_pendencia_id, lock_aguardando_validacao, aviso_alteracao_oc, agent_state, cliente_respondeu_em, acao_executada_em, bastao_oc_no_lancamento, bastao_updated_at_no_lancamento, responsavel_relacionamento, historico_ssw, historico_ssw_atualizado_em";
  const nfsUnicas = Array.from(
    new Set(pendencias.map((p) => normalizeNf(p.nf)).filter((n): n is string => !!n)),
  );
  // deno-lint-ignore no-explicit-any
  const prefetchedByNf = new Map<string, any>();
  for (let i = 0; i < nfsUnicas.length; i += 200) {
    const chunk = nfsUnicas.slice(i, i + 200);
    const { data: cardsBatch, error: batchErr } = await supabase
      .from("cards")
      .select(SELECT_CARD_FIELDS)
      .in("nf", chunk)
      .order("created_at", { ascending: false });
    if (batchErr) throw new Error(`[A] prefetch cards by nf: ${batchErr.message}`);
    for (const row of (cardsBatch ?? []) as Array<{ nf?: string }>) {
      const nf = row.nf;
      if (nf && !prefetchedByNf.has(nf)) prefetchedByNf.set(nf, row); // 1º = mais recente (ordenado desc)
    }
  }

  const summary: PassASummary = {
    pulled: pendencias.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  // Caio 2026-06-11 (NF 1012717): reconciliações SSW divergentes (caras) são
  // DEFERIDAS pra depois do loop. O loop só faz reopen/state/proposta-barata →
  // processa as ~534 pendências rápido, garantindo INV-003 antes do timeout.
  const reconciliacoesDeferidas: ReconciliacaoDeferida[] = [];
  const inicioPassA = Date.now();

  // Caio 2026-06-18 (ADR 0005): processa RELACIONAMENTO antes de EXTRAVIO. Se o
  // loop estourar o timeout 150s, a cauda dropada é extravio (barato, recriado no
  // próximo ciclo) — NUNCA relacionamento (protege INV-003).
  const pendenciasOrdenadas = extraviosEnabled
    ? [...pendencias].sort((a, b) => {
        const ax = a.cod_ultima_ocorrencia != null && OCS_EXTRAVIO.has(a.cod_ultima_ocorrencia) ? 1 : 0;
        const bx = b.cod_ultima_ocorrencia != null && OCS_EXTRAVIO.has(b.cod_ultima_ocorrencia) ? 1 : 0;
        return ax - bx;
      })
    : pendencias;

  // Caio 2026-06-19 (FIX timeout 150s): processa o loop em LOTES PARALELOS em vez
  // de sequencial. O trabalho por-card é só DB (SSW é deferido pós-loop), e cada
  // card é independente (1 pendência por NF → rows distintas, sem contenção). Era
  // 624 escritas DB uma-a-uma (~100s+) → agora ~8 concorrentes (corta ~8×). A
  // lógica por-card (upsertCardFromPendencia/handleExtravioPendencia) é idêntica.
  // Lotes em ordem (relacionamento antes de extravio) preservam INV-003 se a
  // cauda for cortada.
  const CONC_PASS_A = 8;
  for (let i = 0; i < pendenciasOrdenadas.length; i += CONC_PASS_A) {
    const lote = pendenciasOrdenadas.slice(i, i + CONC_PASS_A);
    const resultados = await Promise.allSettled(lote.map((p) => {
      // RAMO ISOLADO de extravio (ADR 0005): oc ∈ {6,9,16} → handleExtravioPendencia
      // (short-circuit, não passa pela lógica de relacionamento). Gated pela flag.
      const ehExtravio = extraviosEnabled &&
        p.cod_ultima_ocorrencia != null && OCS_EXTRAVIO.has(p.cod_ultima_ocorrencia);
      return ehExtravio
        ? handleExtravioPendencia(supabase, p, prefetchedByNf)
        : upsertCardFromPendencia(supabase, p, ocsBloqueadasTracking, excecoesOc13, cnpjsExcluidos, reconciliacoesDeferidas, prefetchedByNf);
    }));
    for (let j = 0; j < resultados.length; j++) {
      const r = resultados[j];
      if (r.status === "fulfilled") {
        if (r.value === "created") summary.created++;
        else if (r.value === "updated") summary.updated++;
        else summary.unchanged++;
      } else {
        const p = lote[j]!;
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const ref = `${p.nf ?? "?"}/${p.ctrc ?? "?"}`;
        console.error(`[A] Erro pendência ${ref}: ${message}`);
        errors.push({ pass: "A", ref, message });
      }
    }
  }

  // 2º passo — reconciliações SSW divergentes DEFERIDAS (Caio 2026-06-11,
  // NF 1012717). Reopen/state já foram commitados no loop acima pra TODAS as
  // pendências → INV-003 garantida mesmo se este passo estourar. Orçamento:
  // pára ao atingir RECONC_BUDGET_MS de Pass A; as restantes seguem
  // divergentes → reaparecem no próximo sync. Sem cap silencioso (loga adiadas).
  // Caio 2026-06-19: reduzido de 110s → 50s. As reconciliações SSW deferidas
  // (2 raspagens por card divergente) cresceram e sozinhas estouravam os 150s do
  // sync ANTES dele chegar nos passes seguintes (timeout há ~3 dias). O reopen/
  // state já foi commitado no loop principal (INV-003, NF 1012717) — deferir a
  // reconciliação cara é só LATÊNCIA (vai pro próximo ciclo), nunca sumiço.
  const RECONC_BUDGET_MS = 50_000;
  let reconciliadas = 0;
  for (const ctx of reconciliacoesDeferidas) {
    if (Date.now() - inicioPassA > RECONC_BUDGET_MS) {
      console.warn(
        `[A] orçamento de reconciliação esgotado: ${reconciliacoesDeferidas.length - reconciliadas} de ${reconciliacoesDeferidas.length} adiadas pro próximo sync.`,
      );
      break;
    }
    try {
      await processarReconciliacaoDeferida(supabase, ctx, excecoesOc13);
      reconciliadas++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[A] reconciliação deferida erro nf ${ctx.nf}: ${message}`);
      errors.push({ pass: "A", ref: `${ctx.nf}/${ctx.ctrc ?? "?"}`, message });
    }
  }
  console.log(
    `[A] reconciliações deferidas: ${reconciliadas}/${reconciliacoesDeferidas.length} processadas.`,
  );
  // Observabilidade do sync (2026-06-19): timing por fase do Pass A → sobrevive ao kill.
  await supabase.from("sync_status_global").update({
    debug_sync: {
      pull_ms: _tPull - _tA0,
      prefetch_ms: inicioPassA - _tPull,
      mainloop_ms: Date.now() - inicioPassA,
      pulled: pendencias.length,
      deferidas: reconciliacoesDeferidas.length,
      reconciliadas,
      writes: summary.created + summary.updated,
      unchanged: summary.unchanged,
    },
  }).eq("id", 1).then(() => {}, () => {});

  // Caio 2026-06-19 (opção B): devolve o conjunto de NFs que o Pass A puxou do
  // Bastão neste ciclo. O Pass B usa pra PULAR esses cards (ainda no escopo) sem
  // refazer 619 consultas single-NF — corta o gargalo do dia a dia (150s).
  return { summary, pulledNfs: new Set(nfsUnicas) };
}

type UpsertResult = "created" | "updated" | "unchanged";

// Estados de relacionamento ATIVO — transição deles → extravio é "suspeita"
// (interrompe uma tratativa). Outros (TRANSFERIDO/TRATATIVA_PENDENTE) são
// re-adoção normal, sem flag.
const RELACIONAMENTO_ATIVO_EXTRAVIO = new Set([
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_VALIDACAO_HUMANA",
  "AGUARDANDO_AGENTE",
]);
// Estados que NÃO devem ser tocados pelo ramo de extravio (ação in-flight /
// intervenção humana). INV-007.
const SKIP_EXTRAVIO = new Set([
  "ACAO_EXECUTADA",
  "EXECUTANDO_ACAO",
  "BLOQUEADO_POR_ERRO",
  "ESCALADO_HUMANO",
]);

/**
 * Caio 2026-06-18 (ADR 0005): RAMO ISOLADO de extravio do sync único. NÃO passa
 * pela lógica de relacionamento (stateFinalAposBastao etc.). O card segue a
 * última oc (regra inviolável). Detecta transição suspeita relacionamento→
 * extravio: card laranja (mudanca_suspeita) + banner; respeita o lock de
 * AGUARDANDO_VOCÊ (fica lockado até o OK do operador) e a janela 60min
 * pós-lançamento (não flipa por oc stale do Bastão logo após um lançamento).
 */
async function handleExtravioPendencia(
  supabase: SupabaseClient,
  p: BastaoPendencia,
  // deno-lint-ignore no-explicit-any
  prefetchedByNf: Map<string, any>,
): Promise<UpsertResult> {
  const nf = normalizeNf(p.nf);
  if (!nf) return "unchanged";
  const existing = prefetchedByNf.get(nf) ?? null;

  const ext = analisarExtravio(p);
  const aviso = montarAvisoExtravio(ext);
  const snapshot = snapshotExtravio(p);
  const atribuicao = await resolverCamposAtribuicaoDoCard(supabase, {
    responsavelNome: p.responsavel_relacionamento,
    cnpjPagador: p.cnpj_pagador,
    segmentoCodigo: p.segmento_cliente,
  });
  // INV-004: preserva chave_cte se já resolvida.
  const chaveExistente = (existing?.agent_state as Record<string, unknown> | undefined)?.["chave_cte"];
  const agentStateFinal: Record<string, unknown> = chaveExistente
    ? { ...snapshot, chave_cte: chaveExistente }
    : snapshot;

  // (a) sem card OU terminal → cria card de extravio (terminal não bloqueia:
  // extravio que re-ocorre cria card novo, uniq_cards_nf_active libera terminais).
  const ehTerminal = existing && (existing.state === "RESOLVIDO" || existing.state === "CANCELADO");
  if (!existing || ehTerminal) {
    const email = await resolverEmailDestino(supabase, p.cnpj_pagador);
    const { data: ins, error: insErr } = await supabase.from("cards").insert({
      nf,
      ctrc: p.ctrc,
      canal_origem: "sistema",
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: atribuicao.responsavel_relacionamento,
      assigned_operator_id: atribuicao.assigned_operator_id,
      state: "EXTRAVIO_MONITORADO",
      lock_aguardando_validacao: false,
      risco: "baixo",
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_pendencia_id: p.id,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      tipo_cte: p.tipo_documento,
      qtde_volumes: p.qtd_volumes,
      agent_state: snapshot,
      aviso_alteracao_oc: aviso,
    }).select("id").single();
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") return "unchanged"; // corrida
      throw new Error(`[A-extravio] INSERT cards nf ${nf}: ${insErr.message}`);
    }
    const cardId = (ins as { id: string }).id;
    await supabase.from("card_events").insert({
      card_id: cardId, event_type: "ExtravioImportado", actor_type: "system",
      actor_id: "sync-bastao", payload: snapshot,
    });
    await upsertPropostasExtravio(supabase, cardId, p, nf, email, ext.template);
    return "created";
  }

  // (b) já é EXTRAVIO_MONITORADO → atualização BARATA (steady-state, roda todo
  // sync p/ TODOS os extravios): só oc/data/agent_state/aviso. SEM RPC de e-mail
  // e SEM upsertPropostas — as propostas são criadas só nos PONTOS DE ENTRADA
  // (casos a/c aqui + atualizar-card-via-portal-ssw). Crítico: o RPC de e-mail
  // por card no loop principal estourava o timeout 150s e a cauda de extravio
  // (ordenada por último) ficava starved.
  if (existing.state === "EXTRAVIO_MONITORADO") {
    await supabase.from("cards").update({
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_pendencia_id: p.id,
      agent_state: agentStateFinal,
      aviso_alteracao_oc: aviso,
      responsavel_relacionamento: atribuicao.responsavel_relacionamento,
      assigned_operator_id: atribuicao.assigned_operator_id,
      bastao_synced_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return "updated";
  }

  // (c) card ATIVO em outro estado. INV-007: não toca ação in-flight/humana.
  if (SKIP_EXTRAVIO.has(existing.state as string)) return "unchanged";

  // Janela 60min pós-lançamento (Risco 3): se o Cockpit lançou oc há pouco e o
  // Bastão re-reporta extravio stale, NÃO flipa — aguarda o Bastão sincronizar.
  const acaoEm = existing.acao_executada_em
    ? new Date(existing.acao_executada_em as string).getTime() : 0;
  const lancEm = existing.bastao_updated_at_no_lancamento
    ? new Date(existing.bastao_updated_at_no_lancamento as string).getTime() : 0;
  const J = 60 * 60_000;
  if ((acaoEm && Date.now() - acaoEm < J) || (lancEm && Date.now() - lancEm < J)) {
    return "unchanged";
  }

  const suspeita = RELACIONAMENTO_ATIVO_EXTRAVIO.has(existing.state as string);
  const lockado = existing.lock_aguardando_validacao === true ||
    existing.state === "AGUARDANDO_VALIDACAO_HUMANA";

  // (c1) Lockado em AGUARDANDO_VOCÊ → FICA lockado lá (regra alteracao_oc_durante_
  // lock) + flag laranja requer_ok. Move só quando o operador der OK
  // (liberar_card_suspeito_lockado). Não troca state/lock.
  if (suspeita && lockado) {
    const mudanca = {
      de_oc: existing.cod_ultima_ocorrencia ?? null, para_oc: p.cod_ultima_ocorrencia,
      de_state: existing.state, requer_ok: true,
      detectada_em: new Date().toISOString(), vista_em: null,
    };
    await supabase.from("cards").update({
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_pendencia_id: p.id,
      mudanca_suspeita: mudanca,
      bastao_synced_at: new Date().toISOString(),
    }).eq("id", existing.id);
    await supabase.from("card_events").insert({
      card_id: existing.id, event_type: "MudancaSuspeitaDetectada", actor_type: "system",
      actor_id: "sync-bastao", payload: { ...mudanca, lockado: true },
    });
    return "updated";
  }

  // (c2) Não lockado → MOVE pra Extravios (segue última oc). Cancela propostas
  // de relacionamento pendentes. Seta flag laranja só se era relacionamento ativo.
  const email = await resolverEmailDestino(supabase, p.cnpj_pagador);
  // Cancela TODOS os pendentes (são de relacionamento; extravio ainda não tem
  // propostas — upsertPropostasExtravio cria abaixo). .neq em jsonb path não
  // pega origem NULL, por isso cancelamos todos.
  await supabase.from("todos").update({
    status: "cancelado",
    rejection_reason: "Card virou extravio (última oc 6/9/16) — propostas de relacionamento canceladas",
  }).eq("card_id", existing.id).eq("status", "pendente");
  const mudanca = suspeita
    ? {
      de_oc: existing.cod_ultima_ocorrencia ?? null, para_oc: p.cod_ultima_ocorrencia,
      de_state: existing.state, requer_ok: false,
      detectada_em: new Date().toISOString(), vista_em: null,
    }
    : null;
  await supabase.from("cards").update({
    state: "EXTRAVIO_MONITORADO",
    lock_aguardando_validacao: false,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    bastao_pendencia_id: p.id,
    agent_state: agentStateFinal,
    aviso_alteracao_oc: aviso,
    mudanca_suspeita: mudanca,
    bastao_synced_at: new Date().toISOString(),
  }).eq("id", existing.id);
  if (suspeita) {
    await supabase.from("card_events").insert({
      card_id: existing.id, event_type: "MudancaSuspeitaDetectada", actor_type: "system",
      actor_id: "sync-bastao", payload: { ...mudanca, lockado: false, moveu_para: "EXTRAVIO_MONITORADO" },
    });
  }
  await upsertPropostasExtravio(supabase, existing.id, p, nf, email, ext.template);
  return "updated";
}

// Caio 2026-06-11 (NF 1012717): contexto de uma reconciliação SSW divergente
// DEFERIDA pra o 2º passo do Pass A (ver processarReconciliacaoDeferida).
type ReconciliacaoDeferida = {
  cardId: string;
  nf: string;
  ctrc: string | null;
  ocPraRegra: number;
  effState: string;
  effLock: boolean;
  snapshotAgent: Record<string, unknown>;
};

/**
 * Caio 2026-06-11 (NF 1012717): 2º passo do Pass A. A reconciliação SSW
 * divergente (2 functions.invoke, ~3s cada) era inline no loop e estourava o
 * timeout 150s do sync com ~534 pendências → a cauda nunca era processada → o
 * reopen não rodava → invariante INV-003 "oc de relacionamento sempre no
 * Cockpit" violada (card preso em TRANSFERIDO). Agora o loop só faz reopen/
 * state (barato) e empurra a reconciliação pra cá, processada pós-loop com
 * orçamento de tempo. Mesma lógica E ordem (reconciliação → proposta) do bloco
 * inline antigo — preserva a proteção contra propostas erradas (NF 761333).
 */
async function processarReconciliacaoDeferida(
  supabase: SupabaseClient,
  ctx: ReconciliacaoDeferida,
  excecoesOc13: ReadonlySet<string>,
): Promise<void> {
  const { cardId, nf, ctrc, ocPraRegra, effState, effLock, snapshotAgent } = ctx;
  let pulouAutoProposicao = false;
  try {
    await supabase.functions.invoke("puxar-historico-ssw-card", {
      body: { card_id: cardId },
    });
    const { data: cardFresh } = await supabase
      .from("cards")
      .select("historico_ssw, agent_state")
      .eq("id", cardId)
      .maybeSingle();
    const histFresh = (cardFresh as { historico_ssw?: Array<{ codigo?: number }> } | null)?.historico_ssw;
    const ocSswReal = Array.isArray(histFresh) && histFresh.length > 0
      ? (histFresh[0]?.codigo as number | undefined)
      : undefined;

    if (typeof ocSswReal === "number" && ocSswReal !== ocPraRegra) {
      const reconc = await supabase.functions.invoke("atualizar-card-via-portal-ssw", {
        body: { card_id: cardId },
      });
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "BastaoDivergiuSswReconciliado",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_bastao_recebida: ocPraRegra,
          oc_ssw_real: ocSswReal,
          reconciliacao_resultado: reconc.data,
          nf,
          deferido: true,
        },
      });
      const existingAgent = (cardFresh as { agent_state?: Record<string, unknown> } | null)?.agent_state ?? {};
      await supabase
        .from("cards")
        .update({
          agent_state: {
            ...existingAgent,
            bastao_divergencia_reconciliada_em: new Date().toISOString(),
            bastao_divergencia_oc: ocPraRegra,
          },
        })
        .eq("id", cardId);
      pulouAutoProposicao = true;
    }
  } catch (err) {
    console.warn(
      `Reconciliação deferida falhou (card ${cardId}, nf ${nf}): ${err instanceof Error ? err.message : String(err)}. Fallback proporAutoAcao.`,
    );
  }

  if (!pulouAutoProposicao) {
    await proporAutoAcaoSeAplicavel(supabase, {
      cardId,
      cardNf: nf,
      cardCtrc: ctrc,
      codUltimaOc: ocPraRegra,
      agentState: snapshotAgent,
      cardState: effState,
      cardLock: effLock,
      excecoesOc13,
    });
  }
}

/**
 * Match Cockpit ↔ Bastão por NF (chave natural estável). Bastão regenera
 * UUIDs ao atualizar, então `bastao_pendencia_id` é só snapshot.
 */
async function upsertCardFromPendencia(
  supabase: SupabaseClient,
  pRaw: BastaoPendencia,
  _ocsBloqueadasTracking: OcsBloqueadasTracking,
  excecoesOc13: ReadonlySet<string>,
  cnpjsExcluidos: ReadonlySet<string>,
  reconciliacoesDeferidas: ReconciliacaoDeferida[],
  // deno-lint-ignore no-explicit-any
  prefetchedByNf: Map<string, any>,
): Promise<UpsertResult> {
  // Normalização canônica: NF no Cockpit nunca tem zeros à esquerda.
  // Bastão API às vezes retorna com zeros, às vezes sem — manter o
  // banco sempre num formato único elimina cards-fantasma duplicados.
  const p: BastaoPendencia = { ...pRaw, nf: normalizeNf(pRaw.nf) };

  if (!p.nf) {
    // Sem NF não temos como matchar; pula.
    return "unchanged";
  }

  // Caio 2026-05-20: skip se cnpj_pagador está em cnpjs_excluidos_cockpit.
  // Caso âncora AMPLA SLI TRANS (21280493000130): cliente de operador
  // demitido. EXCEÇÃO consciente à invariante "NF de relacionamento sempre
  // no Cockpit" — admin marca CNPJs que devem ficar fora.
  // Skip ANTES de qualquer SELECT/UPDATE em cards: preserva INV-003 (guard
  // bastaoEhMesmoSnapshotDoLancamento não roda) + INV-004 (agent_state não
  // é tocado) + INV-007 (Pass B nem sabe que existe).
  if (p.cnpj_pagador && cnpjsExcluidos.has(p.cnpj_pagador)) {
    return "unchanged";
  }

  // Caio 2026-05-07: lookup INCLUI RESOLVIDO/CANCELADO pra detectar "NF já
  // finalizada" e evitar duplicação. Bug raiz das ~5500 duplicatas (NF 127811
  // 2255 cards, NF 997113 2133, etc): Bastão continuava enviando essas NFs
  // como pendência mesmo já fechadas (oc=30 finalizadora); o filtro antigo
  // .not("state","in","(RESOLVIDO,CANCELADO)") fazia o lookup falhar e
  // criar novo card a cada sync (a cada 2min).
  //
  // Reabertura legítima por cliente cobrar é feita pelo VINCULADOR (move
  // card existente pra TRATATIVA_PENDENTE — não Pass A).
  // Caio 2026-06-16: card existente vem do PRÉ-FETCH em lote do runPassA
  // (Map nf -> card mais recente), eliminando o SELECT por pendência (N+1) que
  // estourava o timeout 150s no onboarding em massa. O Map já trouxe os MESMOS
  // campos do SELECT antigo (id, cod_ultima_ocorrencia, bastao_data_ultima_
  // ocorrencia, state, bastao_pendencia_id, lock_aguardando_validacao, aviso_
  // alteracao_oc, agent_state, cliente_respondeu_em, acao_executada_em, bastao_
  // oc_no_lancamento, bastao_updated_at_no_lancamento, responsavel_relacionamento,
  // historico_ssw, historico_ssw_atualizado_em) e replica o `.order(created_at
  // desc).limit(1)` (1º por NF = mais recente). Guard combinado
  // `bastaoEhMesmoSnapshotDoLancamento` (INV-003) segue lendo esses campos.
  const existing = prefetchedByNf.get(p.nf as string) ?? null;

  // Camada 2: gateway de segurança — qualquer oc do Bastão fora do dicionário
  // é descartada (preserva oc anterior do card, ou null se card novo).
  // Garante que nenhum UPDATE/INSERT estoure FK cards_cod_ultima_ocorrencia_fkey.
  p.cod_ultima_ocorrencia = await clampOcAoDicionario(
    supabase,
    p.cod_ultima_ocorrencia,
    existing?.cod_ultima_ocorrencia ?? null,
    "sync-bastao/passA",
    existing?.id as string | undefined,
  );

  // Guard anti-duplicação — card nascido via e-mail do SSW (Caio 2026-06-16/17).
  // Roda ANTES da Camada 5a / voltouParaRelacionamento. Escopado por
  // agent_state.origem='email_ssw' → ZERO efeito em cards-Bastão normais.
  //
  // Por que um guard PRÓPRIO (e não confiar no nativo bastaoEhMesmoSnapshotDoLancamento,
  // INV-003): o card-email grava bastao_updated_at_no_lancamento com o HORÁRIO DO
  // E-MAIL, não com um timestamp real do Bastão. Quando o Bastão finalmente chega
  // com a MESMA oc, o updated_at não bate → o guard nativo (oc + updated_at)
  // consideraria "snapshot novo" e REABRIRIA o card já tratado, duplicando a
  // tratativa. Aqui bloqueamos a reabertura quando:
  //   (a) catch-up: Bastão traz a MESMA oc com que o card-email nasceu — cobre as
  //       ocs de relacionamento da FASE 1 (49/10/11/19/35); ou
  //   (b) continuação de extravio (FASE 2): nasceu oc=6 e Bastão traz 49/43.
  // NÃO bloqueia oc diferente/progressão real (ex: 21 cliente respondeu, 30/01/32
  // finalizadora) → essas seguem o fluxo normal e podem reabrir/finalizar.
  const agentStateExistente = (existing?.agent_state ?? {}) as Record<string, unknown>;
  const ehCardEmailSswJaTratado =
    !!existing &&
    agentStateExistente["origem"] === "email_ssw" &&
    !!(existing as Record<string, unknown>)["acao_executada_em"];
  const ocNascimentoEmailSsw = Number(agentStateExistente["cod_ultima_ocorrencia"]);
  const ehMesmaOcDeNascimento =
    Number.isFinite(ocNascimentoEmailSsw) &&
    p.cod_ultima_ocorrencia === ocNascimentoEmailSsw;
  const ehContinuacaoExtravio =
    ocNascimentoEmailSsw === 6 &&
    (p.cod_ultima_ocorrencia === 49 || p.cod_ultima_ocorrencia === 43);
  if (
    ehCardEmailSswJaTratado &&
    p.cod_ultima_ocorrencia != null &&
    (ehMesmaOcDeNascimento || ehContinuacaoExtravio)
  ) {
    const jaVinculado =
      (existing as Record<string, unknown>)["bastao_pendencia_id"] === p.id;
    if (!jaVinculado) {
      await supabase
        .from("cards")
        .update({ bastao_pendencia_id: p.id, bastao_synced_at: new Date().toISOString() })
        .eq("id", existing!.id);
      await supabase.from("card_events").insert({
        card_id: existing!.id,
        event_type: "BastaoIgnoradoCardEmailSswJaTratado",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          nf: p.nf,
          oc_bastao: p.cod_ultima_ocorrencia,
          motivo:
            "Card origem=email_ssw já tratado (acao_executada_em). Bastão traz " +
            "continuação do extravio — NÃO reabre pra evitar duplicação de tratativa.",
        },
      });
    }
    return jaVinculado ? "unchanged" : "updated";
  }

  // Camada 5a (Caio 2026-05-12): NF terminal (RESOLVIDO/CANCELADO) +
  // Bastão volta a mostrar com oc de relacionamento → REABRE no state
  // final correto via stateFinalAposBastao. A regra "só vinculador reabre"
  // foi sobrescrita: a prioridade do Cockpit é apontar pra Larissa toda
  // pendência de relacionamento, sem depender de email do cliente.
  //
  // States possíveis no retorno (idêntico ao path ACAO_EXECUTADA→liberação):
  //   - oc=54        → AGUARDANDO_CLIENTE                 (sem lock)
  //   - oc 1/30/32   → RESOLVIDO                          (mantém terminal)
  //   - oc com regra → AGUARDANDO_VALIDACAO_HUMANA + lock (aba "AGUARDANDO VOCÊ")
  //   - oc s/ regra  → AGUARDANDO_AGENTE                  (aba "PARA FAZER")
  if (existing && (existing.state === "RESOLVIDO" || existing.state === "CANCELADO")) {
    if (!isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
      cnpjPagador: p.cnpj_pagador, excecoesOc13,
    })) {
      return "unchanged";
    }

    // Caio 2026-05-26 (NF 41333 DUILIO): guard SSW > Bastão. Bastão pode ficar
    // stale por dias quando a NF é finalizada fora do Cockpit — operação lança
    // oc=30/01/32 direto no SSW e RPA Bastão demora a refletir. Antes deste
    // guard, Camada 5a reabria o card a cada sync, entrando em loop com o
    // operador clicando ATUALIZAR AGORA (que resolve via SSW interno) e o
    // sync re-reabrindo via Bastão stale. Confiamos no SSW (fonte canônica
    // de SAÍDA — memory project_ssw_interno_fonte_saida) sobre o Bastão
    // (INPUT) quando o cache historico_ssw é fresh (≤24h) e mostra
    // finalizadora na linha 0. Reusa stateFinalAposBastao pra não duplicar
    // mapping (INV-008).
    const historicoSswCache = (existing as Record<string, unknown>)["historico_ssw"] as
      | Array<Record<string, unknown>>
      | null;
    const histAtualizadoEm = (existing as Record<string, unknown>)["historico_ssw_atualizado_em"] as
      | string
      | null;
    if (
      Array.isArray(historicoSswCache) &&
      historicoSswCache.length > 0 &&
      histAtualizadoEm
    ) {
      const ageMs = Date.now() - new Date(histAtualizadoEm).getTime();
      const FRESH_MAX_MS = 24 * 60 * 60_000;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FRESH_MAX_MS) {
        // historico_ssw pode ter linhas auxiliares sem `codigo` (ex: "CTRC
        // EMITIDO PARA DEVOLUCAO" na NF 41333 ocupa linha 0 sem código).
        // Pega a primeira linha com codigo numérico válido.
        let ultimaOcReal = NaN;
        for (const linha of historicoSswCache) {
          const raw = (linha as Record<string, unknown>)?.["codigo"];
          const n = typeof raw === "number"
            ? raw
            : raw != null
              ? parseInt(String(raw), 10)
              : NaN;
          if (Number.isFinite(n)) {
            ultimaOcReal = n;
            break;
          }
        }
        if (Number.isFinite(ultimaOcReal)) {
          const ocRealTemRegra = REGRAS_AUTO_ACAO[ultimaOcReal] != null;
          const stateRealSegundoSsw = stateFinalAposBastao(ultimaOcReal, ocRealTemRegra);
          if (stateRealSegundoSsw.state === "RESOLVIDO") {
            await supabase.from("card_events").insert({
              card_id: existing.id as string,
              event_type: "BastaoReaberturaIgnoradaSswFinalizado",
              actor_type: "system",
              actor_id: "sync-bastao",
              payload: {
                motivo: "Bastão voltou a mostrar oc de relacionamento, mas historico_ssw (cache fresh) confirma NF finalizada pelo SSW. SSW é fonte canônica de saída. Mantém RESOLVIDO.",
                oc_bastao: p.cod_ultima_ocorrencia,
                oc_ssw_real: ultimaOcReal,
                historico_ssw_atualizado_em: histAtualizadoEm,
                age_ms: ageMs,
              },
            });
            console.log(
              `[A] ${p.nf}: ignorando reabertura — Bastão=oc${p.cod_ultima_ocorrencia} (stale), SSW=oc${ultimaOcReal} (finalizadora). Mantém RESOLVIDO.`,
            );
            return "unchanged";
          }
        }
      }
    }

    const oc = p.cod_ultima_ocorrencia!;
    const ocTemRegra = REGRAS_AUTO_ACAO[oc] != null;
    // Caio 2026-05-19: oc=13 + cnpj_pagador na exceção vira AGUARDANDO_VALIDACAO_HUMANA
    // + lock direto, sem chamar stateFinalAposBastao (que mapearia 13 → TRANSFERIDO
    // por não estar no set base). Preserva INV-008: stateFinalAposBastao continua
    // sendo fonte única pra todas as outras ocs.
    const isExcecaoOc13 = oc === 13 && !!p.cnpj_pagador && excecoesOc13.has(p.cnpj_pagador);
    const stateFinal = isExcecaoOc13
      ? { state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true }
      : stateFinalAposBastao(oc, ocTemRegra);

    // Se a oc atual é finalizadora, mantém RESOLVIDO (nada a fazer)
    if (stateFinal.state === "RESOLVIDO") {
      return "unchanged";
    }

    // Cancela propostas órfãs (status='executando' ou 'pendente' antigas)
    // pra não ter duplicação quando proporAutoAcaoSeAplicavel for chamado
    // pra esse novo ciclo. RPC reverter_acao_falhou faz cleanup completo.
    const { data: todosAtivos } = await supabase
      .from("todos")
      .select("id")
      .eq("card_id", existing.id as string)
      .in("status", ["executando", "pendente"]);
    if (todosAtivos && todosAtivos.length > 0) {
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Reabertura por Bastão pendência (Camada 5a) — propostas anteriores invalidadas",
        })
        .eq("card_id", existing.id as string)
        .in("status", ["executando", "pendente"]);
    }

    await supabase
      .from("cards")
      .update({
        state: stateFinal.state,
        lock_aguardando_validacao: stateFinal.lock,
        cod_ultima_ocorrencia: oc,
        bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
        bastao_pendencia_id: p.id,
        bastao_synced_at: new Date().toISOString(),
        acao_executada_em: null,  // limpa relíquia de ciclo anterior
        aviso_alteracao_oc: null,
      })
      .eq("id", existing.id as string);

    await supabase.from("card_events").insert({
      card_id: existing.id as string,
      event_type: "BastaoReabriuNFFonteRelacionamento",
      actor_type: "system",
      actor_id: "sync-bastao",
      payload: {
        state_anterior: existing.state,
        state_novo: stateFinal.state,
        lock_novo: stateFinal.lock,
        oc_atual_bastao: oc,
        todos_cancelados: todosAtivos?.length ?? 0,
        motivo: "Bastão recolocou NF como pendência com oc de relacionamento. Card reaberto no state final correspondente (Caio 2026-05-12).",
      },
    });

    // Recria as propostas auto pra essa oc (idempotente — ignora se já
    // existir todo pendente da mesma regra)
    await proporAutoAcaoSeAplicavel(supabase, {
      cardId: existing.id as string,
      cardNf: p.nf,
      cardCtrc: p.ctrc ?? null,
      codUltimaOc: oc,
      agentState: snapshotFromPendencia(p) as Record<string, unknown>,
      cardState: stateFinal.state,
      cardLock: stateFinal.lock,
      excecoesOc13,
    });

    console.log(
      `[A] ${p.nf}: ${existing.state} → ${stateFinal.state}${stateFinal.lock ? " (lock)" : ""} (Bastão reabriu com oc=${oc}).`,
    );
    return "updated";
  }

  // Caio 2026-05-07: state ACAO_EXECUTADA bloqueia sync até Bastão confirmar.
  // Card foi pra ACAO_EXECUTADA quando executor lançou oc com sucesso. Pass A
  // só libera quando Bastão.oc == card.oc (ou seja, RPA sincronizou e
  // confirmou a oc lançada). Substitui a "proteção 60min" antiga que era
  // baseada em timer de evento — agora é estado explícito.
  if (
    existing &&
    (existing as Record<string, unknown>)["state"] === "ACAO_EXECUTADA"
  ) {
    if (
      p.cod_ultima_ocorrencia != null &&
      p.cod_ultima_ocorrencia === existing.cod_ultima_ocorrencia
    ) {
      // Caio 2026-05-11: state final via helper stateFinalAposBastao.
      // Inclui regra: oc relacionamento SEM regra REGRAS_AUTO_ACAO → PARA FAZER
      // (não AGUARDANDO VOCÊ + lock), pra não travar Larissa em card sem opções.
      const oc = p.cod_ultima_ocorrencia;
      const ocTemRegra = REGRAS_AUTO_ACAO[oc] != null;
      const stateFinal = stateFinalAposBastao(oc, ocTemRegra);
      const stateLiberado = stateFinal.state;
      const lockLiberado = stateFinal.lock;

      await supabase
        .from("cards")
        .update({
          state: stateLiberado,
          lock_aguardando_validacao: lockLiberado,
          acao_executada_em: null,
          bastao_synced_at: new Date().toISOString(),
        })
        .eq("id", existing.id as string);

      await supabase.from("card_events").insert({
        card_id: existing.id as string,
        event_type: "AcaoExecutadaConfirmadaPeloBastao",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_confirmada: oc,
          state_novo: stateLiberado,
          lock_novo: lockLiberado,
          motivo: "Bastão confirmou a oc lançada pelo Cockpit. Card liberado pro state final.",
        },
      });

      console.log(
        `[A] ${p.nf}: ACAO_EXECUTADA → ${stateLiberado} (Bastão confirmou oc=${oc}).`,
      );
      return "updated";
    }
    // Caio 2026-05-12: Camada 5b (timeout ACAO_EXECUTADA → state final
    // após 60min) FOI PROPOSTA mas DESCARTADA. Regra existente "ACAO_EXECUTADA
    // bloqueia sync até Bastão confirmar a oc lançada" (Caio 2026-05-07)
    // tem precedência. Se aparecerem cards travados em ACAO_EXECUTADA,
    // tratar caso a caso e só com instrução explícita do Caio.

    // Bastão ainda não confirmou — mantém em ACAO_EXECUTADA e ignora sync.
    console.log(
      `[A] ${p.nf}: mantendo ACAO_EXECUTADA — Bastão diz oc=${p.cod_ultima_ocorrencia}, card lançou oc=${existing.cod_ultima_ocorrencia}.`,
    );
    return "unchanged";
  }

  // Caio 2026-05-12: crosscheck do tracking SSW público REMOVIDO do Pass A.
  // Motivo: o filtro upstream em fetchPendenciasDoCockpit já garante que
  // p.cod_ultima_ocorrencia ∈ OCORRENCIAS_DE_RELACIONAMENTO. Pedir "segunda
  // opinião" pro tracking só introduzia retornos fora do dicionário
  // (oc=88/84 do SSWMOBILE) que estouravam FK em cards.cod_ultima_ocorrencia
  // e travavam 6 cards reais (NFs 1073118, 1070875, 177627, 761452, 1073720,
  // 756800) em TRANSFERIDO. Bastão é fonte de verdade pra escopo de
  // relacionamento. O parâmetro `tracking` continua na assinatura por
  // compatibilidade — outras passes ainda usam.

  // Calcula o state baseado em (1) responsavel_atual do Bastão e
  // (2) responsabilidade do dicionário como fallback. Bastão é fonte
  // primária — quando ele diz que outro setor está cuidando, é outro setor.
  let stateProposto = await calcularStatePeloBastao(
    supabase,
    p.cod_ultima_ocorrencia,
    p.responsavel_atual,
  );

  // Caio 2026-05-19 (exceção oc=13): RPC state_pelo_bastao mapeia oc=13 →
  // TRANSFERIDO porque Bastão envia responsavel_atual='operacao' (regra geral
  // correta). Pros 12 CNPJs em cliente_config_oc13 a oc=13 vira caso de
  // relacionamento — override aqui pra AGUARDANDO_VALIDACAO_HUMANA. RPC
  // permanece intacta (INV-008 preservada: stateFinalAposBastao não duplicada).
  const isExcecaoOc13Sync = p.cod_ultima_ocorrencia === 13 &&
    !!p.cnpj_pagador && excecoesOc13.has(p.cnpj_pagador);
  if (isExcecaoOc13Sync) {
    stateProposto = "AGUARDANDO_VALIDACAO_HUMANA";
  }

  if (existing) {
    const changedOcorrencia = existing.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia;
    const changedData = existing.bastao_data_ultima_ocorrencia !== p.data_ultima_ocorrencia;

    // Detecta caso especial: card lockado em AGUARDANDO_VALIDACAO_HUMANA
    // com todo pendente cuja oc proposta JÁ aparece no Bastão. Significa
    // que alguém lançou a oc por fora (manualmente no SSW). Aprovar
    // duplicaria. Auto-cancela o todo + destrava lock + segue fluxo normal.
    const lockOriginal = Boolean(
      (existing as Record<string, unknown>)["lock_aguardando_validacao"],
    );
    let lockEffective = lockOriginal;

    if (lockOriginal && p.cod_ultima_ocorrencia != null) {
      const cancelou = await cancelarTodoSeOcJaLancada(
        supabase,
        existing.id as string,
        p.cod_ultima_ocorrencia,
      );
      if (cancelou) lockEffective = false;
    }

    // Caio 2026-05-07: regra absoluta — oc=54 ⟺ AGUARDANDO_CLIENTE.
    // Pass A força essa coerência mesmo em cards ativos/lockados pra resolver
    // cards "presos" após transições. Caso real NF 573123: card saiu de
    // AGUARDANDO_CLIENTE → AGUARDANDO_VALIDACAO_HUMANA quando Bastão tinha
    // oc=49 bloqueada; depois Bastão voltou pra oc=54 mas Pass A normalmente
    // não recalcula AGUARDANDO_VALIDACAO_HUMANA + lockado.
    // EXECUTANDO_ACAO é exceção (executor está rodando — não interromper).
    //
    // Caio 2026-05-08 (NF 70677): exceção pra cliente_respondeu_em != null.
    // Quando vinculador transiciona AGUARDANDO_CLIENTE → AGUARDANDO_VALIDACAO_HUMANA
    // por reply do cliente (aba CLIENTE RESPONDEU), Bastão.oc fica em 54 (não
    // muda — só Larissa decide oc nova). Sem essa exceção, Pass A reverte o
    // card pra AGUARDANDO_CLIENTE no próximo sync e tira ele da aba CLIENTE
    // RESPONDEU. cliente_respondeu_em é sticky até Larissa agir.
    const clienteJaRespondeu = (existing as Record<string, unknown>)["cliente_respondeu_em"] != null;
    const forcaAguardandoClienteOc54 =
      p.cod_ultima_ocorrencia === 54 &&
      existing.state !== "AGUARDANDO_CLIENTE" &&
      existing.state !== "EXECUTANDO_ACAO" &&
      !(existing.state === "AGUARDANDO_VALIDACAO_HUMANA" && clienteJaRespondeu);

    // Recalcula state APENAS se:
    //  (a) lock_aguardando_validacao=false (humano não travou)
    //  (b) state atual é "passivo" (não é estado ativo de execução nem de
    //      espera intencional)
    //  (c) state proposto é diferente do atual
    //
    // Estados ativos NÃO mexidos: EXECUTANDO_ACAO, AGUARDANDO_VALIDACAO_HUMANA,
    // TRATATIVA_PENDENTE, BLOQUEADO_POR_ERRO, ESCALADO_HUMANO.
    // AGUARDANDO_CLIENTE também NÃO é passivo: Sal já lançou oc=54 e está
    // intencionalmente esperando cliente responder. Bastão pendência segue
    // mostrando a oc original (10/11/35/49) até cliente responder de fato —
    // se Pass A recalcular esse card, vai relockar e criar propostas duplicadas.
    // Saída de AGUARDANDO_CLIENTE: vinculador detecta resposta cliente OU
    // marcar_retorno_inconclusivo OU cobrança D+4.
    // Pass B já filtra TRANSFERIDO/RESOLVIDO/CANCELADO no SELECT acima.
    const STATES_PASSIVOS = new Set([
      "AGUARDANDO_AGENTE",
      "AGUARDANDO_CONTEXTO",
      "AGUARDANDO_VINCULACAO",
      "EM_TRIAGEM",
      "RECEBIDO",
    ]);

    const podeRecalcular =
      !lockEffective &&
      STATES_PASSIVOS.has(existing.state as string) &&
      stateProposto != null &&
      stateProposto !== existing.state;

    // Regra geral 2026-05-04 + atualização Caio 2026-05-12:
    // Cards em TRANSFERIDO ou TRATATIVA_PENDENTE sobrevivem só enquanto a oc
    // atual NÃO é de relacionamento. Quando Bastão diz que oc voltou pra
    // relacionamento, card vai pro state final correto via stateFinalAposBastao:
    //   - oc com regra → AGUARDANDO_VALIDACAO_HUMANA + lock (aba "AGUARDANDO VOCÊ")
    //   - oc sem regra → AGUARDANDO_AGENTE (aba "PARA FAZER")
    // oc=54 cai antes via `forcaAguardandoClienteOc54`; oc finalizadora
    // (1/30/32) não chega aqui (não está em OCORRENCIAS_DE_RELACIONAMENTO).
    //
    // Antes o gatilho era estreito (`stateProposto === "AGUARDANDO_AGENTE"`),
    // o que prendia cards em TRATATIVA_PENDENTE quando Bastão voltava pra
    // oc com regra (ex: 10/11/35/49). Agora libera todos.
    // Caio 2026-05-13 (NF 692021/20761): guard pra evitar amplificação do bug
    // do Pass B. Se card está em TRANSFERIDO MAS teve AcaoExecutada nos últimos
    // 60min, NÃO reabrir — esse TRANSFERIDO é provavelmente resultado de Pass B
    // ter movido o card erroneamente durante latência RPA Bastão (NF some
    // momentaneamente, tracking SSW público retorna oc histórica fora-escopo).
    // Bastão deve sincronizar a oc real lançada pelo Cockpit dentro de 60min;
    // até lá, mantém TRANSFERIDO em vez de recriar lock+propostas.
    // Caso legítimo de reabertura (Operação devolveu pro setor semanas depois)
    // tem `acao_executada_em = null` (Pass G/A já liberou), então não bate aqui.
    const acaoExecutadaEm = (existing as Record<string, unknown>)["acao_executada_em"]
      ? new Date((existing as Record<string, unknown>)["acao_executada_em"] as string).getTime()
      : null;
    const JANELA_REABERTURA_MS = 60 * 60_000;
    const dentroDaJanelaPosLancamento =
      acaoExecutadaEm != null &&
      Date.now() - acaoExecutadaEm < JANELA_REABERTURA_MS;

    // Caio 2026-05-14 (NF 1005270/177817/1074810/20958/1006425 loop final):
    // Guarda anti-reabertura por OC DO LANÇAMENTO.
    //
    // Regra Caio (textual): "Quando esse card vai voltar? Quando tiver uma
    // próxima atualização. E aí com ALTÍSSIMAS CHANCES de ser a mesma
    // ocorrência (visto que a ocorrência foi lançada pela Larissa). E SE
    // VOLTAR COM OCORRÊNCIA DE RELACIONAMENTO com certeza houve tratativa
    // da Operação e procede a criação/reabertura."
    //
    // Adicional Caio: "INFO SSW QUE O EXECUTOR PEGOU DENTRO DO SSW SEMPRE
    // VAI TER PRIORIDADE." → mesmo que Bastão eventualmente atualize, se
    // mostrar a mesma oc do lançamento (RPA Bastão atrasado), SSW interno
    // já refletiu a verdade → ignora Bastão.
    //
    // Discriminador final = oc.
    //   bloquear = (Bastão.oc === bastao_oc_no_lancamento)
    //
    // - igual  → NO-OP COMPLETO (não toca em state, não cria todo, não
    //            cancela nada; card fica EXATAMENTE onde está). Cobre:
    //              (cen.1) Mesma planilha do Bastão lida várias vezes pelo
    //                       sync 2min — atualização imutável, sem mudança.
    //              (cen.2) Nova planilha mas RPA ainda mostra oc antiga —
    //                       SSW interno (já lançou oc nova) tem prioridade.
    // - diff   → segue fluxo normal: voltouParaRelacionamento avalia se
    //            oc nova é de relacionamento (re-tratativa Operação) e
    //            reabre, OU se é oc fora de relacionamento card já estava
    //            TRANSFERIDO e permanece.
    //
    // Tentativas anteriores (tupla oc+updated_at; tupla pendencia_id):
    // falharam porque o Bastão muda updated_at/pendencia_id mesmo sem
    // mudança semântica de oc. A oc é o discriminador semanticamente
    // correto + simples.
    //
    // Operação re-tratativa com MESMA oc é tratada via outros canais:
    // (1) cliente cobra → vinculador; (2) Larissa reabre manualmente
    // via cockpit.
    const bastaoOcNoLancamento = (existing as Record<string, unknown>)["bastao_oc_no_lancamento"] as
      | number | null | undefined;
    const bastaoEhMesmoSnapshotDoLancamento =
      bastaoOcNoLancamento != null &&
      p.cod_ultima_ocorrencia != null &&
      p.cod_ultima_ocorrencia === bastaoOcNoLancamento;

    // SAFEGUARD INVIOLÁVEL — invariante "oc de relacionamento SEMPRE no Cockpit"
    // (Caio 2026-05-23, NFs 286697/47187/1005069/756800/693706 perdidas eternas).
    //
    // Problema observado: cards lançados pelo Cockpit (ex: oc=55 quando Bastão
    // já tinha oc=49 do motorista) ficavam permanentemente em TRANSFERIDO porque
    // bastao_oc_no_lancamento=49 e Bastão segue mostrando oc=49. Guard original
    // bloqueava reabertura indefinidamente → invariante "oc relacionamento
    // sempre no Cockpit" violada.
    //
    // Safeguard: se passou >24h desde o snapshot do lançamento E Bastão ainda
    // sinaliza oc de relacionamento, REABRE incondicionalmente. Não introduz
    // o loop antigo (mig 095) porque o intervalo é DIÁRIO, não a cada update
    // RPA. Cobre cenário "card travado", preserva proteção anti-loop curto.
    const bastaoUpdatedAtNoLancamento = (existing as Record<string, unknown>)["bastao_updated_at_no_lancamento"] as
      | string | null | undefined;
    const lancamentoExpirouParaSafeguard =
      bastaoUpdatedAtNoLancamento != null &&
      Date.now() - new Date(bastaoUpdatedAtNoLancamento).getTime() > 24 * 60 * 60 * 1000;

    // Caio 2026-06-18 (aba EXTRAVIOS): EXTRAVIO_MONITORADO é um state PARKED
    // (card de extravio oc 6/9/16 na aba Extravios). Quando o Bastão passa a
    // mostrar oc de relacionamento (ex: 20 localizado, 49 prazo expirado — a 54
    // já é coberta por forcaAguardandoClienteOc54 antes), o card DEVE reabrir
    // pro fluxo normal igual TRANSFERIDO. Sem isso, a oc era atualizada mas o
    // state ficava EXTRAVIO_MONITORADO → card sumia das duas abas (a view do
    // kanban filtra oc∈{6,9,16}). Extravio nunca teve lançamento via Cockpit
    // (acao_executada_em/bastao_oc_no_lancamento nulos), então as guardas de
    // janela/snapshot abaixo passam naturalmente.
    const voltouParaRelacionamento =
      (existing.state === "TRANSFERIDO" || existing.state === "TRATATIVA_PENDENTE" ||
        existing.state === "EXTRAVIO_MONITORADO") &&
      p.cod_ultima_ocorrencia != null &&
      isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
        cnpjPagador: p.cnpj_pagador, excecoesOc13,
      }) &&
      !dentroDaJanelaPosLancamento &&
      (!bastaoEhMesmoSnapshotDoLancamento || lancamentoExpirouParaSafeguard);

    let stateFinalReentrada: { state: string; lock: boolean } | null = null;
    if (voltouParaRelacionamento) {
      const ocRet = p.cod_ultima_ocorrencia!;
      const temRegra = REGRAS_AUTO_ACAO[ocRet] != null;
      // Caio 2026-05-19: oc=13 + cnpj excepcional → AGUARDANDO_VALIDACAO_HUMANA+lock
      // inline. stateFinalAposBastao retornaria TRANSFERIDO (oc=13 fora do set base).
      const isExcecaoOc13Reentrada = ocRet === 13 && !!p.cnpj_pagador && excecoesOc13.has(p.cnpj_pagador);
      stateFinalReentrada = isExcecaoOc13Reentrada
        ? { state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true }
        : stateFinalAposBastao(ocRet, temRegra);
    } else if (
      (existing.state === "TRANSFERIDO" || existing.state === "TRATATIVA_PENDENTE") &&
      p.cod_ultima_ocorrencia != null &&
      isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
        cnpjPagador: p.cnpj_pagador, excecoesOc13,
      }) &&
      dentroDaJanelaPosLancamento
    ) {
      // Reabertura SUPRIMIDA pela janela — log pra audit
      console.log(
        `[A] ${p.nf}: TRANSFERIDO + Bastão oc=${p.cod_ultima_ocorrencia} (relac) SUPRIMIDO — AcaoExecutada há ${Math.round((Date.now() - acaoExecutadaEm!) / 60_000)}min (<60min). Aguardando Bastão sincronizar a oc real do Cockpit.`,
      );
      await supabase.from("card_events").insert({
        card_id: existing.id as string,
        event_type: "ReaberturaSuprimidaPorJanela",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          motivo: "TRANSFERIDO + Bastão sinaliza oc de relacionamento, MAS AcaoExecutada recente (<60min). Suprimindo reabertura pra evitar amplificação do bug Pass B (NF some temporária).",
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_card: existing.cod_ultima_ocorrencia,
          acao_executada_em: existing.acao_executada_em,
          minutos_desde_acao: Math.round((Date.now() - acaoExecutadaEm!) / 60_000),
        },
      });
    }

    // Mantém variável legada com mesmo valor pra não quebrar referências
    // posteriores no arquivo.
    const transferidoVoltouRelacionamento = voltouParaRelacionamento;

    // Preserva chave_cte que pode ter sido populada por outros paths
    // (Pass F do sync, vinculador, helper resolverEPersistirChaveCte).
    // snapshotFromPendencia(p) vem do Bastão pendência e NÃO inclui chave —
    // se sobrescrever inteiro, perde a chave. Bug observado 2026-05-06 NF
    // 422476: Pass F populou, Pass A do sync seguinte sobrescreveu, executor
    // falhou no aprovar.
    //
    // Caio 2026-05-13 (plano "hoje-usamos-o-bastao"): também preserva
    // propostas_recusadas_em + propostas_recusadas_para_oc, setados pelo
    // voltar-para-to-do-com-rastreio. Sem isso, o cooldown POR OC em
    // proporAutoAcaoSeAplicavel vira letra morta — Pass A sobrescreve no
    // próximo sync, regra recria propostas, loop volta. Mesmo padrão da
    // chave_cte. Campos auto-expiram em 10min na regra (não acumulam lixo).
    const agentStateExistente = (existing.agent_state ?? {}) as Record<string, unknown>;
    const chaveCtePreservada = agentStateExistente["chave_cte"] as string | null | undefined;
    const propostasRecusadasEm = agentStateExistente["propostas_recusadas_em"] as string | undefined;
    const propostasRecusadasParaOc = agentStateExistente["propostas_recusadas_para_oc"] as number | undefined;
    const novoSnapshot = snapshotFromPendencia(p) as Record<string, unknown>;
    const agentStateNovo: Record<string, unknown> = { ...novoSnapshot };
    if (chaveCtePreservada) agentStateNovo["chave_cte"] = chaveCtePreservada;
    if (typeof propostasRecusadasEm === "string") {
      agentStateNovo["propostas_recusadas_em"] = propostasRecusadasEm;
    }
    if (typeof propostasRecusadasParaOc === "number") {
      agentStateNovo["propostas_recusadas_para_oc"] = propostasRecusadasParaOc;
    }

    // Caio 2026-05-19 (bug NF 568107 NORTEL/Ingrid):
    // Antes escrevia `responsavel_relacionamento: p.responsavel_relacionamento`
    // cru do Bastão. Isso ignorava o resolver e fazia carteira_dormente
    // (CNPJ de operador inativo no Cockpit) ser silenciosamente atribuído
    // ao operador cujo nome o Bastão mandou. Agora passa pelo helper que
    // respeita: carteira_cnpj > nome > segmento; carteira_dormente => NULL.
    const atribuicao = await resolverCamposAtribuicaoDoCard(supabase, {
      responsavelNome: p.responsavel_relacionamento,
      cnpjPagador: p.cnpj_pagador,
      segmentoCodigo: p.segmento_cliente,
    });

    const updatePayload: Record<string, unknown> = {
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: atribuicao.responsavel_relacionamento,
      assigned_operator_id: atribuicao.assigned_operator_id,
      tipo_cte: p.tipo_documento,
      qtde_volumes: p.qtd_volumes,
      agent_state: agentStateNovo,
    };
    if (forcaAguardandoClienteOc54) {
      // Caio 2026-05-07: prioridade máxima — oc=54 sempre AGUARDANDO_CLIENTE.
      // Sobrescreve podeRecalcular/transferidoVoltouRelacionamento.
      updatePayload["state"] = "AGUARDANDO_CLIENTE";
      updatePayload["lock_aguardando_validacao"] = false;
      updatePayload["aviso_alteracao_oc"] = null;
      console.log(
        `[A] ${p.nf}: oc=54 forçando AGUARDANDO_CLIENTE (state anterior: ${existing.state}, lock=${lockOriginal})`,
      );
    } else if (podeRecalcular) {
      updatePayload["state"] = stateProposto;
    } else if (transferidoVoltouRelacionamento && stateFinalReentrada) {
      // Caio 2026-05-12: re-entrada pra relacionamento usa stateFinalAposBastao
      // → cobre AGUARDANDO_AGENTE (PARA FAZER) e AGUARDANDO_VALIDACAO_HUMANA
      // + lock (AGUARDANDO VOCÊ). Antes só ia pra AGUARDANDO_AGENTE, prendendo
      // cards com oc que tinha regra (NF 750030 oc=54, etc).
      updatePayload["state"] = stateFinalReentrada.state;
      updatePayload["lock_aguardando_validacao"] = stateFinalReentrada.lock;
    }
    // Senão (caso TRANSFERIDO mantém TRANSFERIDO): updatePayload sem state →
    // só atualiza cod/data/synced. Não cria duplicata.

    // Caio 2026-05-07: regra unificada do aviso amarelo.
    // - Nova oc é de relacionamento (ex: 10/11/35/49/54): banner some sempre.
    //   Cockpit reassume com propostas atualizadas; alertar só confunde.
    // - Nova oc fora do relacionamento + card lockado: alerta Larissa pra
    //   revisar (operação lançou oc por fora durante o lock).
    // - Card sem lock + nova oc fora do relacionamento: sem aviso (card já
    //   sai do escopo via TRANSFERIDO).
    if (changedOcorrencia) {
      const novaOcRelacionamento = isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
        cnpjPagador: p.cnpj_pagador, excecoesOc13,
      });
      if (novaOcRelacionamento) {
        updatePayload["aviso_alteracao_oc"] = null;
      } else if (lockOriginal) {
        updatePayload["aviso_alteracao_oc"] = {
          tipo: "alteracao_oc_durante_lock",
          oc_anterior: existing.cod_ultima_ocorrencia,
          oc_atual: p.cod_ultima_ocorrencia,
          alterada_em: new Date().toISOString(),
        };
      }

      // Caio 2026-05-07: ciclo mudou → sugestão da IA + flag "cliente respondeu"
      // são contexto do ciclo anterior. Caso real NF 196537: cliente respondeu
      // "pode seguir devolução" no ciclo oc=54; Devolução lançou 44 por fora;
      // depois devolveu com 49 ("CLIENTE BLOQUEADO"). Sugestão antiga (oc=44)
      // continuava no front confundindo Larissa. Limpa pra não poluir.
      //
      // Caio 2026-05-11 (NF 690480 + NF 920161): exceção pra resposta cliente
      // RECENTE. Quando Cockpit lança oc (ex: 54) e Bastão ainda mostra oc
      // anterior (ex: 35/49) por latência RPA, `changedOcorrencia` dispara.
      // Se o cliente respondeu antes do Bastão sincronizar, vinculador setou
      // cliente_respondeu_em. Limpar aqui apaga o sinal antes do
      // cron-ia-resposta-pendentes conseguir retentar a IA.
      //
      // Janela 24h cobre: (a) latência Bastão (minutos-horas), (b) fins de
      // semana onde card fica parado e cliente responde 2º dia, (c) ciclos
      // longos com RPA lento. Caso histórico NF 196537 (cliente respondeu há
      // DIAS antes do ciclo evoluir) continua sendo limpo — fora da janela.
      // Janela anterior 30min era estreita demais — bug retroativo NF 920161
      // (cliente respondeu 14:30, sync rodou 14:48 limpando, descoberta 20h+).
      const clienteRespondeuEm = (existing as { cliente_respondeu_em?: string | null }).cliente_respondeu_em;
      const clienteRespondeuRecente = clienteRespondeuEm &&
        (Date.now() - new Date(clienteRespondeuEm).getTime() < 24 * 60 * 60_000);
      if (!clienteRespondeuRecente) {
        updatePayload["ia_sugestao_oc_resposta"] = null;
        updatePayload["cliente_respondeu_em"] = null;
      }
    }

    // Caio 2026-06-19 (FIX timeout 150s — RAIZ): este UPDATE rodava
    // INCONDICIONALMENTE pra TODA pendência existente (~500/run, dominado pelas
    // ~989 oc=54 AGUARDANDO_CLIENTE estáveis), reescrevendo bastao_synced_at +
    // agent_state IDÊNTICOS. Eram ~500 UPDATEs sequenciais = o gargalo real do
    // Pass A (mainloop 154s). Como o card_events é gated por mudança, isso dava a
    // assinatura "0 eventos de write MAS loop de 154s". Agora só escreve quando há
    // mudança SEMÂNTICA. bastao_synced_at per-card não é lido criticamente: a
    // freshness global do sync vive em sync_status_global (o SELECT
    // max(bastao_synced_at) FROM cards foi aposentado na mig 167 por custo).
    const precisaEscrever =
      changedOcorrencia || changedData ||
      forcaAguardandoClienteOc54 || podeRecalcular ||
      (transferidoVoltouRelacionamento && stateFinalReentrada != null) ||
      lockEffective !== lockOriginal ||
      atribuicao.responsavel_relacionamento !== (existing.responsavel_relacionamento ?? null);

    if (precisaEscrever) {
      const { error: updErr } = await supabase
        .from("cards")
        .update(updatePayload)
        .eq("id", existing.id);

      if (updErr) throw new Error(`UPDATE cards: ${updErr.message}`);
    }

    // Caio 2026-06-18: card REABRIU de EXTRAVIO_MONITORADO → relacionamento.
    // Cancela as propostas de extravio (origem=extravio_cockpit: lançar 49/55,
    // e-mail) antes da auto-proposta abaixo recriar as de relacionamento. Sem
    // isso ficariam botões obsoletos no card e o dedupe da regra poderia barrar
    // as novas. forcaAguardandoClienteOc54 (oc=54) também passa por aqui.
    if (
      (voltouParaRelacionamento || forcaAguardandoClienteOc54) &&
      existing.state === "EXTRAVIO_MONITORADO"
    ) {
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Card saiu de Extravios (Bastão trouxe oc de relacionamento) — propostas de extravio canceladas",
        })
        .eq("card_id", existing.id)
        .eq("status", "pendente")
        .eq("proposta_payload->meta->>origem", "extravio_cockpit");
    }

    if (forcaAguardandoClienteOc54) {
      await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: "StateForcadoOc54AguardandoCliente",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          state_anterior: existing.state,
          lock_anterior: lockOriginal,
          oc_atual: p.cod_ultima_ocorrencia,
          regra: "oc=54 ⟺ AGUARDANDO_CLIENTE (Caio 2026-05-07).",
        },
      });
    }

    if (changedOcorrencia || changedData || podeRecalcular) {
      const { error: evErr } = await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: podeRecalcular ? "StateRecalculadoPorOc" : "BastaoCardAtualizado",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          previous: {
            state: existing.state,
            cod_ultima_ocorrencia: existing.cod_ultima_ocorrencia,
            bastao_data_ultima_ocorrencia: existing.bastao_data_ultima_ocorrencia,
          },
          current: {
            state: podeRecalcular ? stateProposto : existing.state,
            ...snapshotFromPendencia(p),
          },
          fonte_oc: "bastao_pendencia",
        },
      });
      if (evErr) throw new Error(`INSERT card_events (atualizado): ${evErr.message}`);
    }

    // Auto-proposta sempre avaliada no Pass A (idempotente — não cria 2º
    // todo da mesma proposta). Garante que cards "unchanged" recebem regra
    // recém-deployada na próxima execução.
    //
    // Se card está lockado e tem aviso_alteracao_oc (oc mudou no SSW por
    // fora durante o lock), avalia regra usando a oc QUE ORIGINOU O LOCK
    // (oc_anterior do aviso) — não a oc atual. Senão, regra nova publicada
    // pra oc_anterior nunca dispararia (oc atual já é outra coisa, sem
    // regra) e propostas faltantes não seriam criadas.
    // effState reflete o state PÓS-update — usado pela auto-proposta abaixo.
    // Caio 2026-05-12: pra re-entrada (TRANSFERIDO/TRATATIVA_PENDENTE →
    // relacionamento), usa state vindo de stateFinalAposBastao em vez do
    // hardcode "AGUARDANDO_AGENTE" anterior. Cobre oc com regra (que vai pra
    // AGUARDANDO_VALIDACAO_HUMANA + lock).
    let effState = podeRecalcular ? (stateProposto as string) : existing.state;
    let effLock = lockEffective;
    if (transferidoVoltouRelacionamento && stateFinalReentrada) {
      effState = stateFinalReentrada.state;
      effLock = stateFinalReentrada.lock;
    }
    const avisoExisting = (existing as Record<string, unknown>)["aviso_alteracao_oc"] as
      | { oc_anterior?: number; oc_atual?: number }
      | null
      | undefined;
    const ocPraRegra = (lockOriginal && avisoExisting?.oc_anterior != null)
      ? avisoExisting.oc_anterior
      : p.cod_ultima_ocorrencia;

    // ---------------------------------------------------------------------
    // Defesa anti-divergência Bastão vs SSW real (Caio 2026-05-19, NF 761333)
    //
    // Bug raiz: Bastão pode atrasar/errar e enviar `cod_ultima_ocorrencia`
    // diferente da última oc real do SSW. Aconteceu na NF 761333: SSW tinha
    // oc=49 (relacionamento, lançada via Cockpit), Bastão enviou oc=20
    // (extravio operacional antigo). proporAutoAcaoSeAplicavel disparou a
    // regra de oc=20 e criou propostas inadequadas.
    //
    // Dispara só quando há `changedOcorrencia` (oc do Bastão mudou) — caso
    // raro o suficiente pra justificar o overhead de 2 chamadas SSW.
    // Anti-oscilação: agent_state.bastao_divergencia_reconciliada_em + oc
    // associada. Se Bastão continua mandando mesma oc divergente em <1h,
    // skipa o ciclo (já reconciliamos recentemente).
    //
    // Try/catch agressivo: qualquer falha cai no fluxo atual (chama
    // proporAutoAcaoSeAplicavel normalmente). NÃO bloqueia sync.
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // GUARD ADICIONAL (Caio 2026-05-23, NF 346399 recriada eternamente):
    // Se historico_ssw JÁ tem oc finalizadora (1/14/30/32) MAIS RECENTE que
    // a oc do Bastão, o card está REALMENTE finalizado e NUNCA deveria ser
    // reaberto pelo Pass A — independente de changedOcorrencia.
    //
    // Caso âncora NF 346399: SSW tinha oc=30 DEVOLUÇÃO AUTORIZADA em 21/05.
    // Bastão segue mandando oc=20 (relacionamento antiga) sem mudar →
    // changedOcorrencia=false → reconciliação não disparava → Pass A reabria
    // o card pra AVH+lock continuamente. Larissa "forçou atualizar" 2x sem
    // sucesso porque sync-bastao sobrescrevia logo depois.
    //
    // Fix: detecta finalizadora no histórico existente (sem precisar refetch)
    // e força a reconciliação completa antes de qualquer auto-proposição.
    // ---------------------------------------------------------------------
    const FINALIZADORAS_SSW = new Set([1, 14, 30, 32]);
    const histExistente = (existing as Record<string, unknown>)["historico_ssw"] as
      Array<{ codigo?: number }> | null | undefined;
    const ocSswMaisRecente = Array.isArray(histExistente) && histExistente.length > 0
      ? (histExistente[0]?.codigo as number | undefined)
      : undefined;
    const sswJaFinalizadoDivergenteDoBastao =
      typeof ocSswMaisRecente === "number" &&
      FINALIZADORAS_SSW.has(ocSswMaisRecente) &&
      ocPraRegra != null &&
      ocSswMaisRecente !== ocPraRegra;

    // Caio 2026-06-11 (NF 1012717): a reconciliação SSW divergente faz 2
    // functions.invoke (~3s cada). Inline por-pendência, isso estourava o
    // timeout 150s do sync com ~534 pendências → a CAUDA nunca era processada
    // → o reopen (cards.update acima, ~linha 1116) não rodava pras NFs da cauda
    // → invariante INV-003 violada (card preso em TRANSFERIDO). O reopen JÁ foi
    // commitado acima (barato); aqui só DEFERIMOS a reconciliação cara (+ a
    // auto-proposta dos divergentes, que depende dela — proteção NF 761333) pra
    // um 2º passo pós-loop com orçamento de tempo. Casos NÃO divergentes seguem
    // com auto-proposta inline (barata, só DB).
    const existingAgentRec = (existing.agent_state ?? {}) as Record<string, unknown>;
    const cooldownEmRec = existingAgentRec["bastao_divergencia_reconciliada_em"] as string | undefined;
    const cooldownOcRec = existingAgentRec["bastao_divergencia_oc"] as number | undefined;
    const dentroCooldownRec =
      typeof cooldownEmRec === "string" &&
      typeof cooldownOcRec === "number" &&
      cooldownOcRec === ocPraRegra &&
      Date.now() - new Date(cooldownEmRec).getTime() < 60 * 60_000;

    const precisaReconciliar =
      (changedOcorrencia || sswJaFinalizadoDivergenteDoBastao) &&
      ocPraRegra != null &&
      !dentroCooldownRec;

    if (precisaReconciliar) {
      // Defere: a reconciliação + (se divergir) a proposta rodam no 2º passo.
      // NÃO chama proporAutoAcao agora — igual ao inline antigo, que só propunha
      // após confirmar a oc real (evita propostas erradas, NF 761333).
      reconciliacoesDeferidas.push({
        cardId: existing.id as string,
        nf: p.nf,
        ctrc: p.ctrc ?? null,
        ocPraRegra: ocPraRegra as number,
        effState: effState as string,
        effLock,
        snapshotAgent: snapshotFromPendencia(p) as Record<string, unknown>,
      });
    } else {
      // Caio 2026-06-19 (FIX timeout 150s): proporAutoAcao SÓ pra card que de
      // fato mudou. Antes rodava pra TODA pendência do Pass A (incl. as ~994
      // oc=54 AGUARDANDO_CLIENTE inalteradas), e cada chamada faz 1 SELECT em
      // `todos` por card → ~1000 SELECTs sequenciais por run = o gargalo que
      // matava o sync no Pass A antes dos passes B-H rodarem. Card inalterado
      // não precisa: a oc é a mesma, o state é o mesmo, as propostas já existem.
      //
      // O que essa chamada fazia a mais (self-heal): backfillar propostas de
      // REGRA NOVA em cards antigos que não mudaram. Isso agora é explícito:
      //   - deploy de regra nova → rodar `backfill-propostas-oc` 1× (padrão já
      //     usado em oc=23 e oc=13/FORTPEL);
      //   - card que ficou sem proposta por bug → detectado pelo probe
      //     inviolável (Bastão-vs-Cockpit) + recuperável via ATUALIZAR.
      const cardMudou = changedOcorrencia || changedData || podeRecalcular ||
        transferidoVoltouRelacionamento;
      if (cardMudou) {
        await proporAutoAcaoSeAplicavel(supabase, {
          cardId: existing.id as string,
          cardNf: p.nf,
          cardCtrc: p.ctrc ?? null,
          codUltimaOc: ocPraRegra,
          agentState: snapshotFromPendencia(p) as Record<string, unknown>,
          cardState: effState as string,
          cardLock: effLock,
          excecoesOc13,
        });
      }
    }

    if (changedOcorrencia || changedData || podeRecalcular || transferidoVoltouRelacionamento) return "updated";
    return "unchanged";
  }

  const newState = stateProposto ?? "AGUARDANDO_AGENTE";

  // Caio 2026-05-14 (multi-operador): atribui assigned_operator_id no momento
  // da criação via hints do Bastão. Antes ficava null e RLS resolvia visibilidade
  // por carteira/segmento — funcional mas menos auditável. Agora explícito.
  //
  // Caio 2026-05-19 (bug NF 568107 NORTEL/Ingrid): substituído pelo helper
  // que respeita carteira_dormente (CNPJ pertence a operador inativo no Cockpit
  // → NULL/NULL pra não atribuir erroneamente via responsavel_nome do Bastão).
  const atribuicao = await resolverCamposAtribuicaoDoCard(supabase, {
    responsavelNome: p.responsavel_relacionamento,
    cnpjPagador: p.cnpj_pagador,
    segmentoCodigo: p.segmento_cliente,
  });

  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf: p.nf,
      ctrc: p.ctrc,
      canal_origem: "sistema",
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: atribuicao.responsavel_relacionamento,
      state: newState,
      // Caio 2026-05-19: oc=13 excepcional nasce lockado em AGUARDANDO_VALIDACAO_HUMANA
      lock_aguardando_validacao: isExcecaoOc13Sync,
      tipo: null,
      risco: "baixo",
      assigned_agent: null,
      assigned_operator_id: atribuicao.assigned_operator_id,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      tipo_cte: p.tipo_documento,
      qtde_volumes: p.qtd_volumes,
      agent_state: snapshotFromPendencia(p),
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards: ${insErr.message}`);

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: insertedCard.id,
    event_type: "BastaoCardImportado",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: snapshotFromPendencia(p),
  });
  if (evErr) throw new Error(`INSERT card_events (importado): ${evErr.message}`);

  // Caio 2026-06-08: REMOVIDA chamada a resolverEPersistirChaveCte.
  // Executor agora lança via portal interno (lancarSswPortal) que resolve
  // seq_ctrc via buscarNFInterno(ctrcEsperado=card.ctrc). chave_cte 44 dígitos
  // não é mais necessária. Tabela nf_chave_cte dropada na mig 195.

  // Caio 2026-05-07: oc=10/11/35 → SEM ação autônoma. Helper grava
  // cards.evidencia_status + evidencia_diagnostico pro front renderizar
  // banner amarelo "IA — VALIDAÇÃO DE EVIDÊNCIA". Larissa decide manualmente.
  // proporAutoAcaoSeAplicavel SEMPRE roda — as 4 propostas (21/54+email/44/56)
  // ficam pendentes pra Larissa aprovar.
  // Caio 2026-05-14 (NF 20761): propaga p.ctrc pra evitar falso negativo em
  // NFs com múltiplos CTRCs (reentrega/complementar). Sem isso, helper grava
  // evidencia_status='scrape_indisponivel' erradamente em cards onde a foto
  // existe no SSW interno mas a NF tem mais de 1 CTRC.
  await verificarEvidenciaESinalizar(
    supabase,
    insertedCard.id as string,
    p.nf,
    p.cnpj_pagador ?? null,
    p.cod_ultima_ocorrencia,
    p.ctrc ?? null,
    p.responsavel_relacionamento ?? null,
  );

  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: insertedCard.id as string,
    cardNf: p.nf,
    cardCtrc: p.ctrc ?? null,
    codUltimaOc: p.cod_ultima_ocorrencia,
    agentState: snapshotFromPendencia(p) as Record<string, unknown>,
    cardState: newState,
    cardLock: isExcecaoOc13Sync, // Caio 2026-05-19: oc=13 excepcional nasce em AGUARDANDO_VALIDACAO_HUMANA + lock=true
    excecoesOc13,
  });

  return "created";
}


// =============================================================================
// PASS B — release: cards que sairam do escopo do Relacionamento
// =============================================================================

async function runPassB(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  excecoesOc13: ReadonlySet<string>,
  errors: SyncSummary["errors"],
  // Caio 2026-06-19 (opção B): NFs que o Pass A puxou neste ciclo. Card cuja NF
  // está aqui continua no escopo → Pass B PULA (sem refazer a consulta single-NF).
  pulledNfs: Set<string>,
): Promise<PassBSummary> {
  // 1. Cards ativos no Cockpit com bastao_pendencia_id (= importados do Bastão)
  //    e que TÊM nf (sem nf não dá pra fazer lookup).
  // Inclui lock_aguardando_validacao pra respeitar o lock no release.
  // Caio 2026-05-13 (NF 692021/20761): EXCLUI ACAO_EXECUTADA do Pass B.
  // Cards nesse state estão aguardando Bastão sincronizar a oc lançada pelo
  // Cockpit — Pass A (na confirmação) ou Pass G (na liberação por janela)
  // cuidam. Latência RPA Bastão pode TIRAR a NF temporariamente da fila;
  // Pass B antes via isso como "NF saiu" e movia pra TRANSFERIDO usando oc
  // do tracking público, disparando o amplificador `voltouParaRelacionamento`
  // do Pass A no ciclo seguinte → card travava em AVH+lock.
  const { data: activeCards, error: selErr } = await supabase
    .from("cards")
    // Caio 2026-05-15 (multi-operador): responsavel_relacionamento p/ resolver
    // creds SSW do operador no descobrirUltimaOcSsw.
    .select("id, nf, cod_ultima_ocorrencia, state, lock_aguardando_validacao, agent_state, acao_executada_em, responsavel_relacionamento")
    // Caio 2026-06-18 (ADR 0005): EXCLUI EXTRAVIO_MONITORADO. Extravio (oc 6/9/16)
    // é dono EXCLUSIVO do ramo de extravio do Pass A (handleExtravioPendencia).
    // Sem isso, o Pass B veria oc 6/9/16 como "fora de relacionamento" e soltaria
    // o card pra TRANSFERIDO no MESMO run em que o Pass A o criou (bug NF 608372).
    .not("state", "in", "(RESOLVIDO,CANCELADO,TRANSFERIDO,TRATATIVA_PENDENTE,ACAO_EXECUTADA,EXTRAVIO_MONITORADO)")
    .not("bastao_pendencia_id", "is", null)
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "B", ref: "select_active_cards", message: selErr.message });
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  const cards = activeCards ?? [];
  if (cards.length === 0) {
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  // 2. Estado atual no Bastão por NF (1 query por card — Bastão não tem
  //    `nf=in.(...)` performático com 30+ valores; vamos sequencial)
  let released = 0;
  let notFound = 0;

  // Caio 2026-06-19 (FIX timeout 150s): ORÇAMENTO de tempo do Pass B. O loop faz
  // descobrirUltimaOcSsw (~2s/card via SSW interno) pros cards ATIVOS que sumiram
  // do Bastão (finalizados/transferidos aguardando confirmação SSW). Quando o Pass
  // A foi consertado (154s→15s) e voltou a sobrar tempo, o Pass B passou a rodar e
  // sozinho consumia ~138s (≈69 chamadas SSW sequenciais + backlog dos 3 dias que
  // ele não rodou) — estourando os 150s ANTES dos passes C-H. Igual ao
  // RECONC_BUDGET do Pass A: processa o que cabe no orçamento, DEFERE o resto pro
  // próximo ciclo (deferir um release = latência, NUNCA perda — o card fica ATIVO
  // e visível até ser solto). Backlog limpa em poucos ciclos; steady-state é baixo.
  for (const card of cards) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto pro próximo ciclo
    // Defesa em profundidade: Pass B NUNCA mexe em ACAO_EXECUTADA (já filtrado
    // no SELECT mas re-checado aqui pra evitar regressão se o filtro for
    // mexido). Razão: Pass B usa tracking SSW público como fallback quando
    // Bastão pendência some — durante janela pós-lançamento, isso causa
    // movimento errado pra TRANSFERIDO + amplificação no Pass A.
    if ((card as Record<string, unknown>)["state"] === "ACAO_EXECUTADA") {
      continue;
    }
    // Caio 2026-06-18 (ADR 0005): defesa em profundidade — Pass B NUNCA solta
    // card de extravio (dono é o ramo do Pass A). Já filtrado no SELECT; re-check
    // aqui evita regressão se o filtro for mexido.
    if ((card as Record<string, unknown>)["state"] === "EXTRAVIO_MONITORADO") {
      continue;
    }
    const nf = normalizeNf(card.nf as string) ?? (card.nf as string);
    // Caio 2026-06-19 (opção B): se a NF veio no pull do Pass A neste ciclo, o
    // card CONTINUA no escopo (oc de relacionamento/extravio) — o Pass A já
    // tratou. PULA sem refazer a consulta single-NF. Equivale ao caminho antigo
    // "encontrado + stillInScope → continue", mas sem a query (corta o gargalo
    // de 619 consultas sequenciais). NÃO afrouxa o release: cards FORA do pull
    // seguem a lógica abaixo (confirmação SSW obrigatória pra soltar).
    if (pulledNfs.has(nf)) continue;
    let current: BastaoPendencia | null;
    try {
      current = await bastao.fetchPendenciaByNf(nf);
    } catch (err) {
      errors.push({
        pass: "B",
        ref: `nf=${nf}`,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!current) {
      notFound++;
      // NF saiu do Bastão pendência. Regra Sal Express 2026-05-05: ocs
      // finalizadoras do CT-e (30, 01, 32) tiram a NF da fila do Bastão.
      // Confirma via SSW INTERNO (opção 101) — se última oc é finalizadora,
      // fecha card como RESOLVIDO. Se oc é fora de relacionamento, marca
      // TRANSFERIDO. Se cliente cobrar de novo, o vinculador reabre como
      // TRATATIVA_PENDENTE (preserva histórico).
      //
      // Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
      // migrado de tracking SSW público pra SSW interno. Ganho: cobre ocs
      // ocultas do público (44 devolução, 31, etc) — antes essas NFs
      // ficavam presas no Pass B sem ser detectadas.
      try {
        const ctrcEsperado = (card as Record<string, unknown>)["ctrc"] as string | null | undefined;
        // Caio 2026-05-15 (multi-operador): SSW interno usa creds do operador
        // do card. Pass B SELECT carrega responsavel_relacionamento? Vou ler
        // direto do card se disponível, fallback null (env genérico).
        const respPassB = (card as Record<string, unknown>)["responsavel_relacionamento"] as string | null | undefined;
        const r = await descobrirUltimaOcSsw(nf, ctrcEsperado ?? null, undefined, respPassB ?? null);
        if (r.sucesso) {
          if (OCORRENCIAS_FINALIZADORAS.has(r.oc)) {
            await fecharCardComoResolvidoFimDePendencia(
              supabase,
              card.id as string,
              card.cod_ultima_ocorrencia as number | null,
              r.oc,
            );
            released++;
          } else if (!OCORRENCIAS_DE_RELACIONAMENTO.has(r.oc)) {
            // SSW retornou oc fora de relacionamento e não-finalizadora
            // (ex: 14 = Operação, 44 = Devolução). NF saiu do Bastão →
            // marca TRANSFERIDO com oc real do SSW.
            await releaseCardViaTracking(
              supabase,
              card.id as string,
              card.cod_ultima_ocorrencia as number | null,
              r.oc,
            );
            released++;
          }
          // Se oc continua de relacionamento (mas Bastão tirou): não decide.
          // Pass A do próximo ciclo provavelmente vai reabrir/sincronizar.
        }
        // r.sucesso === false (sem_nf, ssw_sem_oc, env_ausente, ssw_erro):
        // conservador — não move o card. Próximo sync tenta novamente.
        // CRÍTICO: nunca move pra TRANSFERIDO sem confirmação SSW positiva.
      } catch (err) {
        errors.push({
          pass: "B",
          ref: `nf=${nf}/ssw_interno`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const newCod = current.cod_ultima_ocorrencia;
    // Caio 2026-05-13 (bug crítico): defesa em profundidade — oc=54 NUNCA
    // sai daqui via Pass B. 54 é "aguardando cliente" e é tratada como
    // caso especial em Pass A (force AGUARDANDO_CLIENTE). Mesmo se alguém
    // remover 54 do set OCORRENCIAS_DE_RELACIONAMENTO por engano, Pass B
    // não pode mover cards de 54 pra TRANSFERIDO. Bug histórico: removi 54
    // do set → Pass B moveu TODOS cards AGUARDANDO_CLIENTE pra TRANSFERIDO.
    if (newCod === 54) continue;
    // Caio 2026-05-19: oc=13 + cnpj na exceção `cliente_config_oc13` é
    // considerada in scope (caso de relacionamento excepcional). Lê cnpj do
    // agent_state — sync-bastao Pass A grava via snapshotFromPendencia.
    const cardCnpjPagador = ((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null | undefined)?.["cnpj_pagador"] as string | undefined;
    const stillInScope = isOcorrenciaDeRelacionamentoCtx(newCod, {
      cnpjPagador: cardCnpjPagador, excecoesOc13,
    });
    if (stillInScope) continue;

    // Lock: card que o agente puxou pra validação humana não pode sair daqui
    // automaticamente. Mesmo que a oc no Bastão tenha mudado, esperamos o
    // operador clicar Aprovar ou Rejeitar pra destravar.
    if ((card as Record<string, unknown>)["lock_aguardando_validacao"] === true) {
      console.log(`[B] card ${card.id} lockado em AGUARDANDO_VALIDACAO_HUMANA — pulando release`);
      continue;
    }

    try {
      await releaseCard(supabase, card.id as string, card.cod_ultima_ocorrencia, current);
      released++;
    } catch (err) {
      errors.push({
        pass: "B",
        ref: card.id as string,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked: cards.length, released, not_found_in_bastao: notFound };
}

async function releaseCard(
  supabase: SupabaseClient,
  cardId: string,
  previousCod: number | null,
  current: BastaoPendencia,
): Promise<void> {
  // Busca setor responsável da nova ocorrência no dicionário pra registrar
  // pra qual setor o card foi (Operação, Devolução, Indenização, etc).
  // Se não achar, fica null e o evento ainda registra que houve transferência.
  let setorDestino: string | null = null;
  if (current.cod_ultima_ocorrencia != null) {
    const { data: dicRow } = await supabase
      .from("ocorrencias_dicionario")
      .select("responsabilidade")
      .eq("codigo", current.cod_ultima_ocorrencia)
      .maybeSingle();
    setorDestino = (dicRow?.responsabilidade as string | undefined) ?? null;
  }

  // Renomeado de DevolvidoParaOperacao → DevolvidoParaSetor (genérico).
  // Setor específico vai no payload.
  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "DevolvidoParaSetor",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      motivo: "cod_ultima_ocorrencia mudou pra fora do escopo do Relacionamento",
      setor_destino: setorDestino,
      previous_cod: previousCod,
      new_cod: current.cod_ultima_ocorrencia,
      new_descricao_instrucao: current.instrucao_ultima_ocorrencia,
      new_data_ocorrencia: current.data_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (released): ${evErr.message}`);

  // state='TRANSFERIDO' (não mais RESOLVIDO). RESOLVIDO fica reservado pra
  // "fim de fato" (operador marca como resolvido sem ação SSW). TRANSFERIDO
  // pode voltar pra TRATATIVA_PENDENTE se cliente cobrar.
  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "TRANSFERIDO",
      bastao_pendencia_id: current.id,
      cod_ultima_ocorrencia: current.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: current.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (released): ${updErr.message}`);
}

/**
 * Marca card como TRANSFERIDO quando NF sumiu do Bastão E tracking confirma
 * oc fora de escopo de relacionamento (não-finalizadora). Casos típicos:
 * card aprovado oc=44 que vira oc 88 no Bastão (devolução), ou oc=14 (saída
 * pra entrega = Operação). NF some da pendência mas tracking ainda mostra
 * histórico — usa essa info pra fechar o card como TRANSFERIDO sem ficar
 * preso em EXECUTANDO_ACAO/AGUARDANDO_CLIENTE/etc.
 */
async function releaseCardViaTracking(
  supabase: SupabaseClient,
  cardId: string,
  ocAnterior: number | null,
  ocTracking: number,
): Promise<void> {
  let setorDestino: string | null = null;
  const { data: dicRow } = await supabase
    .from("ocorrencias_dicionario")
    .select("responsabilidade")
    .eq("codigo", ocTracking)
    .maybeSingle();
  setorDestino = (dicRow?.responsabilidade as string | undefined) ?? null;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "DevolvidoParaSetor",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      motivo: "NF saiu do Bastão pendência + SSW interno confirma oc fora do escopo de Relacionamento",
      setor_destino: setorDestino,
      previous_cod: ocAnterior,
      new_cod: ocTracking,
      fonte_oc: "ssw_internal",
    },
  });

  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "TRANSFERIDO",
      cod_ultima_ocorrencia: ocTracking,
      bastao_synced_at: new Date().toISOString(),
      lock_aguardando_validacao: false,
      aviso_alteracao_oc: null,
      acao_falhou_motivo: null,
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (transferido via tracking): ${updErr.message}`);
}

/**
 * Fecha card como RESOLVIDO quando NF sumiu do Bastão pendência E tracking
 * confirma oc finalizadora. Registra a oc final no card_event pra auditoria.
 * Se cliente cobrar essa NF depois, vinculador reabre o MESMO card em
 * TRATATIVA_PENDENTE (preserva histórico).
 */
async function fecharCardComoResolvidoFimDePendencia(
  supabase: SupabaseClient,
  cardId: string,
  ocAnterior: number | null,
  ocFinalTracking: number,
): Promise<void> {
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "CardResolvidoBastaoFimDePendencia",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      oc_anterior: ocAnterior,
      oc_final_tracking: ocFinalTracking,
      regra: "NF saiu do Bastão pendência + tracking confirma oc finalizadora ∈ {1, 30, 32}. Card encerrado.",
      reabertura: "Se cliente cobrar essa NF depois, vinculador reabre este card em TRATATIVA_PENDENTE.",
    },
  });

  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "RESOLVIDO",
      cod_ultima_ocorrencia: ocFinalTracking,
      bastao_synced_at: new Date().toISOString(),
      lock_aguardando_validacao: false,
      aviso_alteracao_oc: null,
      acao_falhou_motivo: null,
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (resolvido fim de pendência): ${updErr.message}`);
}

// =============================================================================
// PASS C — verify: todos em "executando" → confirmar ou marcar timeout
// =============================================================================

async function runPassC(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassCSummary> {
  const { data: pendingTodos, error: selErr } = await supabase
    .from("todos")
    .select(`
      id, card_id, proposta_payload, approved_at,
      cards!inner(id, nf)
    `)
    .eq("status", "executando")
    .not("cards.nf", "is", null);

  if (selErr) {
    errors.push({ pass: "C", ref: "select_executando", message: selErr.message });
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  const todos = pendingTodos ?? [];
  if (todos.length === 0) {
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  let confirmed = 0;
  let timedOut = 0;
  let stillWaiting = 0;
  const now = Date.now();
  const timeoutMs = VERIFICATION_TIMEOUT_MINUTES * 60 * 1000;

  for (const t of todos) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto
    try {
      const cardRef = (t as Record<string, unknown>)["cards"] as
        | { id: string; nf: string | null }
        | { id: string; nf: string | null }[]
        | null;
      const ref = Array.isArray(cardRef) ? cardRef[0] : cardRef;
      const nf = ref?.nf;
      if (!nf) {
        stillWaiting++;
        continue;
      }

      const current = await bastao.fetchPendenciaByNf(nf);
      if (!current) {
        stillWaiting++;
        continue;
      }

      const expected = parseExpectedCodigo(t.proposta_payload);
      if (!expected) {
        stillWaiting++;
        continue;
      }

      if (current.cod_ultima_ocorrencia === expected) {
        await markTodoExecutado(supabase, t, current, expected);
        confirmed++;
      } else {
        const approvedAt = t.approved_at ? new Date(t.approved_at).getTime() : now;
        const elapsed = now - approvedAt;
        if (elapsed > timeoutMs) {
          await markTodoFalhou(supabase, t, current, expected, elapsed);
          timedOut++;
        } else {
          stillWaiting++;
        }
      }
    } catch (err) {
      errors.push({
        pass: "C",
        ref: String(t.id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pending: todos.length, confirmed, timed_out: timedOut, still_waiting: stillWaiting };
}

function parseExpectedCodigo(proposta: unknown): number | null {
  if (!proposta || typeof proposta !== "object") return null;
  const args = (proposta as Record<string, unknown>)["args"];
  if (!args || typeof args !== "object") return null;
  const codigo = (args as Record<string, unknown>)["codigo"];
  if (codigo == null) return null;
  const n = typeof codigo === "number" ? codigo : parseInt(String(codigo), 10);
  return Number.isFinite(n) ? n : null;
}

async function markTodoExecutado(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "OcorrenciaSSWConfirmada",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_confirmado: expected,
      data_ocorrencia: current.data_ultima_ocorrencia,
      instrucao: current.instrucao_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (confirmada): ${evErr.message}`);

  const { error: updErr } = await supabase
    .from("todos")
    .update({ status: "executado" })
    .eq("id", todoId);
  if (updErr) throw new Error(`UPDATE todos (executado): ${updErr.message}`);

  // Transição de state agora é feita pelo executor IMEDIATAMENTE pós-sucesso
  // SSW (regra 2026-05-05). Pass C aqui só confirma `status=executado` no todo
  // pra fins de auditoria/dashboard. NÃO mexe em cards.state.
}

async function markTodoFalhou(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
  elapsedMs: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AcaoExecutadaSemConfirmacao",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_esperado: expected,
      codigo_atual: current.cod_ultima_ocorrencia,
      minutos_decorridos: Math.round(elapsedMs / 60000),
      timeout_minutos: VERIFICATION_TIMEOUT_MINUTES,
      motivo: "Ocorrência esperada não apareceu no Bastão dentro do prazo",
    },
  });
  if (evErr) throw new Error(`INSERT card_events (falhou): ${evErr.message}`);

  const { error: updTodoErr } = await supabase
    .from("todos")
    .update({ status: "falhou" })
    .eq("id", todoId);
  if (updTodoErr) throw new Error(`UPDATE todos (falhou): ${updTodoErr.message}`);

  const { error: updCardErr } = await supabase
    .from("cards")
    .update({ state: "BLOQUEADO_POR_ERRO" })
    .eq("id", cardId);
  if (updCardErr) throw new Error(`UPDATE cards (BLOQUEADO_POR_ERRO): ${updCardErr.message}`);
}

// =============================================================================
// PASS D — crosscheck cards lockados
// =============================================================================
// Pass A só puxa pendências cuja oc atual está em OCORRENCIAS_DE_RELACIONAMENTO.
// Quando oc muda no Bastão pra um código fora dessa lista (ex: 41), o Pass A
// deixa de ver a pendência e o card lockado fica congelado com a oc antiga,
// sem o aviso visual pra Larissa.
//
// Pass D fecha esse buraco: pega TODOS cards lockados, busca pendências
// correspondentes no Bastão por bastao_pendencia_id (sem filtro de oc), e se
// a oc do Bastão divergir da oc do card, popula aviso_alteracao_oc.
//
// Importante: Pass D NÃO mexe em state, NÃO cria propostas, NÃO recalcula
// nada. Só dispara o aviso visual. Larissa continua dona da decisão.
// =============================================================================

async function runPassD(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  excecoesOc13: ReadonlySet<string>,
  errors: SyncSummary["errors"],
): Promise<PassDSummary> {
  const summary: PassDSummary = {
    checked: 0,
    aviso_disparado: 0,
    sem_pendencia_no_bastao: 0,
  };

  const { data: lockados, error: selErr } = await supabase
    .from("cards")
    // Caio 2026-05-19: agent_state pra ler cnpj_pagador (exceção oc=13).
    .select("id, nf, cod_ultima_ocorrencia, bastao_pendencia_id, aviso_alteracao_oc, agent_state")
    .eq("lock_aguardando_validacao", true)
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "D", ref: "select", message: selErr.message });
    return summary;
  }

  const cards = (lockados ?? []) as Array<{
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    bastao_pendencia_id: string | null;
    aviso_alteracao_oc: Record<string, unknown> | null;
    agent_state: Record<string, unknown> | null;
  }>;

  summary.checked = cards.length;
  if (cards.length === 0) return summary;

  // Bastão regenera UUIDs quando atualiza pendência, então o
  // bastao_pendencia_id no card pode estar obsoleto. Match por NF
  // (chave estável) — uma chamada por card.
  for (const card of cards) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto
    try {
      if (!card.nf) continue;
      const p = await bastao.fetchPendenciaByNf(card.nf);
      if (!p) {
        // Pendência sumiu do Bastão (NF saiu da fila inteira). Pass B trata
        // isso quando confirma — aqui só conta.
        summary.sem_pendencia_no_bastao++;
        continue;
      }
      const ocBastao = p.cod_ultima_ocorrencia;
      if (ocBastao == null) continue;
      if (ocBastao === card.cod_ultima_ocorrencia) continue;

      // Caio 2026-05-07: aviso só vale pra oc fora de relacionamento. Se
      // Bastão sinaliza nova oc de relacionamento (ex: 49 após operação
      // corrigir), limpa aviso existente — Cockpit já trata com propostas
      // próprias.
      // Caio 2026-05-19: passa cnpj_pagador pra reconhecer oc=13 excepcional
      // como "de relacionamento" e limpar banner corretamente.
      const cardCnpjPagador = (card.agent_state ?? {})["cnpj_pagador"] as string | undefined;
      const novaOcRelacionamento = isOcorrenciaDeRelacionamentoCtx(ocBastao, {
        cnpjPagador: cardCnpjPagador, excecoesOc13,
      });
      const avisoExistente = card.aviso_alteracao_oc;

      if (novaOcRelacionamento) {
        if (avisoExistente == null) continue; // nada pra limpar
        const { error: updErr } = await supabase
          .from("cards")
          .update({ aviso_alteracao_oc: null })
          .eq("id", card.id);
        if (updErr) throw new Error(`UPDATE cards (aviso clear): ${updErr.message}`);
        await supabase.from("card_events").insert({
          card_id: card.id,
          event_type: "AvisoAlteracaoOcLimpoNovaOcDeRelacionamento",
          actor_type: "system",
          actor_id: "sync-bastao",
          payload: {
            oc_anterior: card.cod_ultima_ocorrencia,
            oc_atual: ocBastao,
            fonte: "bastao_pendencia",
            observacao: "Pass D — nova oc é de relacionamento; aviso descartado.",
          },
        });
        continue;
      }

      // Idempotente — se aviso já aponta pra essa mesma oc atual, não retoca.
      if (
        avisoExistente &&
        Number(avisoExistente["oc_atual"]) === ocBastao &&
        Number(avisoExistente["oc_anterior"]) === card.cod_ultima_ocorrencia
      ) {
        continue;
      }

      const novoAviso = {
        oc_anterior: card.cod_ultima_ocorrencia,
        oc_atual: ocBastao,
        alterada_em: new Date().toISOString(),
      };

      const { error: updErr } = await supabase
        .from("cards")
        .update({ aviso_alteracao_oc: novoAviso })
        .eq("id", card.id);
      if (updErr) throw new Error(`UPDATE cards (aviso): ${updErr.message}`);

      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "AvisoAlteracaoOcDisparadoPassD",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_anterior: card.cod_ultima_ocorrencia,
          oc_atual: ocBastao,
          fonte: "bastao_pendencia",
          observacao: "Detectado pelo Pass D — oc do Bastão divergiu do card lockado, fora do filtro de relacionamento do Pass A.",
        },
      });

      summary.aviso_disparado++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ref = `${card.nf ?? "?"}/${card.id}`;
      console.error(`[D] Erro card ${ref}: ${message}`);
      errors.push({ pass: "D", ref, message });
    }
  }

  return summary;
}

// =============================================================================
// PASS E — verifica cards em AGUARDANDO_CLIENTE
// =============================================================================
// Regra Caio 2026-05-05: AGUARDANDO_CLIENTE só pode conter cards com oc=54.
// Lógica de decisão+aplicação extraída pra _shared/transicao-aguardando-cliente.ts
// (reusada pelo botão manual da Edge Function atualizar-card-via-portal-ssw).
// =============================================================================

// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao"): Pass E roda a cada
// 8h em vez de 1min. Motivação: card em AGUARDANDO_CLIENTE só sai dessa aba
// via 3 caminhos REATIVOS (cliente responde → vinculador; Larissa lança oc
// manual → executor + Pass H; Pass A força oc=54). Pass E é só rede de
// segurança pra detectar "Operação lançou oc por fora" — não precisa de
// alta frequência. Janela 8h reduz carga no SSW interno (login compartilhado
// l.silva) de ~45 calls/min pra ~135 calls/dia.
const PASS_E_INTERVAL_MS = 8 * 60 * 60 * 1000;

async function runPassE(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  _ocsBloqueadasTracking: OcsBloqueadasTracking,
  errors: SyncSummary["errors"],
): Promise<PassESummary> {
  const summary: PassESummary = {
    checked: 0,
    mantido_em_54: 0,
    resolvido_finalizadora: 0,
    movido_aguardando_voce: 0,
    movido_transferido: 0,
    sem_info: 0,
    pulado_por_cadencia: false,
    last_full_run_at: null,
  };

  // Gate de cadência 8h — Caio 2026-06-19 (fix ciclo vicioso): lê um timestamp
  // DURÁVEL (sync_status_global.ultimo_pass_e_run) em vez do summary do sync_runs.
  // Bug raiz: o summary só é gravado quando o sync COMPLETA; como o sync estava
  // estourando o timeout (513 raspagens SSW do Pass E), o registro nunca
  // aparecia → o gate achava "nunca rodou" → Pass E disparava TODO run → timeout
  // eterno. Agora o carimbo é gravado no INÍCIO da execução (sobrevive ao
  // timeout), igual ao padrão registrar_sync_bastao_concluido (marca no início).
  const { data: minE } = await supabase.rpc("minutos_desde_ultimo_pass_e");
  const minutosDesdePassE = typeof minE === "number" ? minE : 999999;
  if (minutosDesdePassE * 60_000 < PASS_E_INTERVAL_MS) {
    summary.pulado_por_cadencia = true;
    console.log(
      `[E] pulado por cadência — última run há ${minutosDesdePassE}min (intervalo: ${PASS_E_INTERVAL_MS / 3_600_000}h).`,
    );
    return summary;
  }
  // Vai executar — carimba JÁ (durável), antes de qualquer raspagem SSW, pra
  // não repetir mesmo se este run estourar o timeout depois.
  // Caio 2026-06-19 (Claude): PostgREST builder não tem `.catch` (é thenable, não
  // Promise) — `.catch is not a function` derrubava o Pass E e marcava a run como
  // failed. Só não aparecia antes porque o sync estourava o timeout ANTES de chegar
  // no Pass E. Usa `.then(ok, err)` que o builder suporta.
  await supabase.rpc("registrar_pass_e_run").then(() => {}, () => {});

  // Janela vencida — executa.
  const { data: cards, error: selErr } = await supabase
    .from("cards")
    // Caio 2026-05-15 (multi-operador): responsavel_relacionamento p/ creds SSW.
    .select("id, nf, ctrc, cod_ultima_ocorrencia, responsavel_relacionamento")
    .eq("state", "AGUARDANDO_CLIENTE")
    .not("nf", "is", null);
  if (selErr) {
    errors.push({ pass: "E", ref: "select", message: selErr.message });
    return summary;
  }
  const lista = (cards ?? []) as Array<{
    id: string;
    nf: string | null;
    ctrc: string | null;
    cod_ultima_ocorrencia: number | null;
    responsavel_relacionamento: string | null;
  }>;
  summary.checked = lista.length;

  // Caio 2026-06-19: orçamento de tempo. Cada card faz 1 Bastão + 1 raspagem SSW
  // (~3s); com centenas de AGUARDANDO_CLIENTE isso sozinho estoura os 150s. Cap
  // de ~40s por run; o restante é coberto no próximo ciclo de 8h (rede de
  // segurança, não precisa varrer tudo de uma vez). Já carimbamos o run no início.
  const inicioPassE = Date.now();
  const PASS_E_BUDGET_MS = 40_000;
  let passEDeferidos = 0;

  // Caio 2026-05-07: proteção anti-regressão antiga (timer 60min) removida.
  // Agora cards lançados pelo Cockpit ficam em state=ACAO_EXECUTADA até Pass A
  // confirmar — Pass E não pega esses cards porque filtra state=AGUARDANDO_CLIENTE.
  for (const card of lista) {
    if (Date.now() - inicioPassE > PASS_E_BUDGET_MS || syncDeadlineExcedido()) {
      passEDeferidos = lista.length - lista.indexOf(card);
      console.log(`[E] orçamento ${PASS_E_BUDGET_MS / 1000}s esgotado — ${passEDeferidos} cards adiados pro próximo ciclo.`);
      break;
    }
    try {
      const nf = normalizeNf(card.nf as string) ?? (card.nf as string);

      // Fonte 1: Bastão (pode estar atrasado, mas é input canônico)
      const pendBastao = await bastao.fetchPendenciaByNf(nf);
      const ocBastao = pendBastao?.cod_ultima_ocorrencia ?? null;

      // Fonte 2: SSW interno on-time (cobre TODAS ocs, inclui as bloqueadas
      // do tracking público). Caio 2026-05-13: ocsBloqueadasTracking não
      // precisa mais filtrar — SSW interno mostra tudo.
      // Caio 2026-05-15 (multi-operador): SSW interno usa creds do operador do card.
      const r = await descobrirUltimaOcSsw(nf, card.ctrc, undefined, card.responsavel_relacionamento ?? null);
      const ocSsw = r.sucesso ? r.oc : null;

      const decisao = decidirTransicaoAguardandoCliente({ ocBastao, ocTracking: ocSsw });
      switch (decisao.tipo) {
        case "manter":
          summary.mantido_em_54++;
          break;
        case "resolvido":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.resolvido_finalizadora++;
          break;
        case "aguardando_voce":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.movido_aguardando_voce++;
          break;
        case "transferido":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.movido_transferido++;
          break;
        case "sem_info":
          summary.sem_info++;
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pass: "E", ref: card.nf ?? card.id, message });
    }
  }

  summary.last_full_run_at = new Date().toISOString();
  return summary;
}

// =============================================================================
// PASS F — re-lookup chave_cte pra cards com sem_chave_cte=true
// =============================================================================
// Regra Caio 2026-05-06: cards podem ser criados antes do RPA OPC 455
// importar a chave (ex: card criado 9h, RPA roda 18h). Pass F roda em todo
// sync (5min) e tenta resolver a chave pra todos cards `sem_chave_cte=true`
// em states ativos. Idempotente — se chave já está em agent_state, helper pula.
//
// Não toca em cards CANCELADO/RESOLVIDO/TRANSFERIDO (concluídos). RPS sem
// chave continua marcado — só aparece como "ainda_sem_chave" no summary.
// =============================================================================

async function runPassF(
  _supabase: SupabaseClient,
  _errors: SyncSummary["errors"],
): Promise<PassFSummary> {
  // Caio 2026-06-08: Pass F neutralizado com a migração pra portal interno.
  // chave_cte deixou de ser usada pelo executor — não precisa mais resolver
  // pra cards "sem_chave_cte=true". A coluna `sem_chave_cte` e a tabela
  // `nf_chave_cte` foram removidas na mig 195.
  // Mantenho o helper como no-op pra preservar a interface (PassFSummary,
  // SyncSummary). Pode ser deletado em refator futuro.
  return { checked: 0, resolvido: 0, ainda_sem_chave: 0 };
}

// =============================================================================
// PASS G — libera cards em ACAO_EXECUTADA quando Bastão confirma a oc lançada
// =============================================================================
// Caio 2026-05-07: cards em ACAO_EXECUTADA com oc fora do escopo de relacionamento
// (ex: 56, 21, 44) NÃO aparecem em runPassA (que filtra pendências do Bastão por
// OCS_RELACIONAMENTO). Pass G busca direto por NF (sem filtro) e libera quando
// Bastão.oc == card.oc.
//
// Estados finais aplicados (mesmo padrão do código embutido em Pass A):
//   - oc=54  → AGUARDANDO_CLIENTE
//   - oc=1/30/32 (finalizadora) → RESOLVIDO
//   - oc=relacionamento (não 54) → AGUARDANDO_VALIDACAO_HUMANA + lock
//   - outras → TRANSFERIDO
// =============================================================================

async function runPassG(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassGSummary> {
  const summary: PassGSummary = {
    checked: 0,
    liberados: 0,
    ainda_aguardando: 0,
    bastao_sem_dado: 0,
  };

  const { data: cards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, acao_executada_em, bastao_oc_no_lancamento")
    .eq("state", "ACAO_EXECUTADA")
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "G", ref: "select", message: selErr.message });
    return summary;
  }

  const lista = (cards ?? []) as Array<{
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    acao_executada_em: string | null;
    bastao_oc_no_lancamento: number | null;
  }>;
  summary.checked = lista.length;

  for (const card of lista) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto
    try {
      const nf = normalizeNf(card.nf as string) ?? (card.nf as string);
      const pend = await bastao.fetchPendenciaByNf(nf);
      if (!pend || pend.cod_ultima_ocorrencia == null) {
        summary.bastao_sem_dado++;
        continue;
      }

      // Caio 2026-05-08 (v3 — snapshot): libera quando:
      //   (a) Bastão confirma a oc lançada (Bastão.oc == card.oc), OU
      //   (b) Bastão AVANÇOU pra oc diferente da snapshot pré-lançamento
      //       (Bastão.oc != bastao_oc_no_lancamento). Significa que Bastão
      //       MUDOU a oc desde o lançamento — não é só RPA refrescando a row.
      //   Senão, mantém ACAO_EXECUTADA (Bastão ainda atrasado).
      //
      // **Histórico de tentativas falhas (não voltar pra essas heurísticas):**
      //   v1 — `updated_at >= acao_executada_em`: falhou (RPA Bastão faz
      //        delete+insert; updated_at fica trivialmente recente). Liberou
      //        errado NF 23319 (oc=23 desde 2026-05-06).
      //   v2 — `data_ultima_ocorrencia >= DATE(acao_executada_em)`: falhou
      //        em casos onde Bastão já tinha oc do dia ANTES do lançamento.
      //        Liberou errado NF 1078124 (lançou oc=55 às 14:12; Bastão
      //        tinha oc=20 com data hoje, mas de antes do lançamento).
      //
      // Snapshot é o único sinal robusto: capturado pelo executor no instante
      // do lançamento (cards.bastao_oc_no_lancamento). Pass G compara estado
      // atual vs estado pré-lançamento — só libera se REALMENTE houve mudança.
      //
      // Edge case: snapshot NULL (cards antigos sem backfill). Conservador:
      // só libera em mesma_oc; mantém ACAO_EXECUTADA até Bastão confirmar.
      const ocBastao = pend.cod_ultima_ocorrencia;
      const ocCard = card.cod_ultima_ocorrencia;
      const ocSnapshot = card.bastao_oc_no_lancamento;

      const bastaoConfirmouMesmaOc = ocBastao === ocCard;
      const bastaoAvancouVsSnapshot =
        ocBastao !== ocCard &&
        ocSnapshot != null &&
        ocBastao !== ocSnapshot;

      // Caio 2026-05-12 (NF 607458): bastao_avancou só vale se passou janela
      // mínima de 30min desde o lançamento. RPA Bastão tem latência típica
      // 15-30min — antes disso, oc do Bastão pode ainda ser o estado anterior
      // ao lançamento do Cockpit (ex: 54 pré-existente que RPA estava
      // processando), não uma oc "avançada" por outro setor.
      // Caso real: oc=33 lançada 20:10:13; Pass G rodou 20:10:29 e viu
      // Bastão.oc=54 (anterior, ainda em RPA) com snapshot=49. Concluiu
      // "Operação lançou 54 por fora" e moveu pra AGUARDANDO_CLIENTE.
      // Errado — bastava esperar Bastão sincronizar a 33.
      // Confirmação exata (bastaoConfirmouMesmaOc) continua liberando na hora
      // — não há ambiguidade quando Bastão já reflete a oc do Cockpit.
      const JANELA_BASTAO_AVANCOU_MS = 30 * 60 * 1000;
      const acaoExecutadaEm = card.acao_executada_em
        ? new Date(card.acao_executada_em).getTime()
        : null;
      const dentroDaJanelaAvancou =
        bastaoAvancouVsSnapshot &&
        acaoExecutadaEm != null &&
        Date.now() - acaoExecutadaEm < JANELA_BASTAO_AVANCOU_MS;

      if (!bastaoConfirmouMesmaOc && !bastaoAvancouVsSnapshot) {
        // Bastão ainda no estado pré-lançamento (oc não mudou) OU snapshot
        // ausente. Mantém ACAO_EXECUTADA, espera próximo sync.
        summary.ainda_aguardando++;
        continue;
      }

      if (dentroDaJanelaAvancou) {
        // Bastão divergiu do snapshot, mas faz <30min do lançamento. Bastão
        // provavelmente atrasado (RPA não sincronizou a oc do Cockpit ainda).
        // Conservador: mantém ACAO_EXECUTADA até janela expirar OU Bastão
        // confirmar a oc exata do card.
        summary.ainda_aguardando++;
        continue;
      }

      // Libera. Decide state final pela oc atual do Bastão (helper compartilhado
      // — inclui regra Caio 2026-05-11: oc relacionamento SEM REGRAS_AUTO_ACAO
      // → PARA FAZER, não AGUARDANDO VOCÊ).
      const oc = ocBastao;
      const ocTemRegraG = REGRAS_AUTO_ACAO[oc] != null;
      const stateFinalG = stateFinalAposBastao(oc, ocTemRegraG);
      const stateNovo = stateFinalG.state;
      const lockNovo = stateFinalG.lock;

      await supabase
        .from("cards")
        .update({
          state: stateNovo,
          lock_aguardando_validacao: lockNovo,
          acao_executada_em: null,
          bastao_oc_no_lancamento: null,
          bastao_synced_at: new Date().toISOString(),
        })
        .eq("id", card.id);

      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "AcaoExecutadaConfirmadaPeloBastao",
        actor_type: "system",
        actor_id: "sync-bastao-passG",
        payload: {
          oc_confirmada: oc,
          oc_card_anterior: ocCard,
          state_novo: stateNovo,
          lock_novo: lockNovo,
          pass: "G",
          cenario: bastaoConfirmouMesmaOc ? "mesma_oc" : "bastao_avancou",
          bastao_oc_no_lancamento: ocSnapshot,
          motivo: bastaoConfirmouMesmaOc
            ? "Pass G v3 — Bastão confirmou exata oc lançada pelo Cockpit."
            : "Pass G v3 — Bastão avançou: oc atual != snapshot pré-lançamento. Operação/Devolução lançou outra oc por fora; libera com a oc atual.",
        },
      });

      console.log(`[G] ${nf}: ACAO_EXECUTADA → ${stateNovo} (Bastão confirmou oc=${oc}).`);
      summary.liberados++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pass: "G", ref: card.nf ?? card.id, message });
    }
  }

  return summary;
}

// =============================================================================
// PASS H — libera cards em ACAO_EXECUTADA via SSW interno (opção 101) on-time
//
// Caio 2026-05-13 (Fase 2 do plano "hoje-usamos-o-bastao"):
//
// Pass G espera Bastão refletir a oc lançada (latência RPA 15-60min) + janela
// 30min de proteção contra "RPA piscar". Pass H consulta o SSW interno
// (opção 101) on-time (2-3s) — sem latência, sem janela necessária.
//
// Filtro de elegibilidade:
//   - state = 'ACAO_EXECUTADA'
//   - acao_executada_em < now() - 2min (grace pra executor-inline tentar primeiro)
//
// Decisão pela última oc real do SSW (mesma lógica de stateFinalAposBastao):
//   - oc=54        → AGUARDANDO_CLIENTE
//   - oc 1/30/32   → RESOLVIDO
//   - oc com regra → AGUARDANDO_VALIDACAO_HUMANA + lock
//   - oc s/regra   → AGUARDANDO_AGENTE
//   - outras       → TRANSFERIDO
//
// Pass G fica como BACKUP — roda ANTES de H. Se Pass G já liberou (Bastão
// confirmou na hora), H não acha o card (filtro state=ACAO_EXECUTADA). Plano:
// remover Pass G após 14 dias de confiança no H (fase 3 rollout).
//
// Fallback gracioso: SSW indisponível (env_ausente, login bloqueado, timeout)
// → confirmarAcaoExecutadaViaSsw retorna `confirmado: false` sem throw → card
// permanece em ACAO_EXECUTADA → próximo sync tenta novamente.
// =============================================================================

async function runPassH(
  supabase: SupabaseClient,
  errors: SyncSummary["errors"],
): Promise<PassHSummary> {
  const summary: PassHSummary = {
    checked: 0,
    liberados: 0,
    ssw_indisponivel: 0,
    ainda_em_grace: 0,
    revertidos_nao_lancada: 0,
  };

  const limiteGrace = new Date(Date.now() - 2 * 60_000).toISOString();

  const { data: cards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, acao_executada_em")
    .eq("state", "ACAO_EXECUTADA")
    .not("nf", "is", null)
    .lt("acao_executada_em", limiteGrace);

  if (selErr) {
    errors.push({ pass: "H", ref: "select", message: selErr.message });
    return summary;
  }

  const lista = (cards ?? []) as Array<{ id: string; nf: string | null; acao_executada_em: string | null }>;
  summary.checked = lista.length;

  for (const card of lista) {
    try {
      const r = await confirmarAcaoExecutadaViaSsw(supabase, card.id as string, { origem: "pass_h" });
      if (r.confirmado) {
        console.log(
          `[H] ${card.nf}: ACAO_EXECUTADA → ${r.state_novo}${r.lock_novo ? " (lock)" : ""} (SSW oc=${r.oc_ssw} cenario=${r.cenario}).`,
        );
        summary.liberados++;
      } else if (r.motivo === "oc_nao_lancada") {
        // Caio 2026-06-15: SSW acessível confirmou que a oc pretendida NÃO foi
        // lançada → confirmarAcaoExecutadaViaSsw já reverteu o card pro operador.
        console.log(`[H] ${card.nf}: ÚLTIMA OCORRÊNCIA NÃO LANÇADA — revertido pro operador.`);
        summary.revertidos_nao_lancada++;
      } else if (r.motivo === "ssw_erro" || r.motivo === "ssw_sem_oc" || r.motivo === "env_ausente") {
        summary.ssw_indisponivel++;
      } else {
        // motivo === "card_nao_acao_executada" (race com Pass G ou ação manual)
        summary.ainda_em_grace++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pass: "H", ref: card.nf ?? card.id, message });
    }
  }

  return summary;
}

// =============================================================================
// helpers
// =============================================================================

/**
 * Normaliza NF removendo zeros à esquerda. Bastão API ora retorna
 * "000757683", ora "757683" pra mesma NF; o Cockpit padroniza sem zeros.
 * Mantém null/string vazia como null.
 */
function normalizeNf(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const trimmed = nf.trim().replace(/^0+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Card lockado em AGUARDANDO_VALIDACAO_HUMANA com todo pendente cuja oc
 * proposta JÁ apareceu no Bastão = alguém lançou a oc manualmente no SSW
 * por fora do Cockpit. Aprovar duplicaria. Auto-cancela o todo + destrava
 * o lock pra que o sync siga o fluxo normal (state segue responsavel_atual).
 *
 * Retorna true se cancelou algum todo (logo, o lock deve ser ignorado no
 * resto do upsert).
 */
async function cancelarTodoSeOcJaLancada(
  supabase: SupabaseClient,
  cardId: string,
  ocAtualNoBastao: number,
): Promise<boolean> {
  const { data: todosPendentes, error: selErr } = await supabase
    .from("todos")
    .select("id, action_id, proposta_payload")
    .eq("card_id", cardId)
    .eq("status", "pendente");

  if (selErr || !todosPendentes || todosPendentes.length === 0) return false;

  const alvos = todosPendentes.filter((t: Record<string, unknown>) => {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const args = payload?.["args"] as Record<string, unknown> | undefined;
    const codProposto = args?.["codigo_ssw"];
    return typeof codProposto === "number" && codProposto === ocAtualNoBastao;
  });

  if (alvos.length === 0) return false;

  for (const t of alvos) {
    const todoId = t["id"] as string;
    const actionId = (t["action_id"] as string | undefined) ?? null;

    const { error: updErr } = await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: "Auto-cancelado: oc já lançada por fora (Bastão registrou antes da aprovação)",
      })
      .eq("id", todoId);

    if (updErr) {
      console.error(`auto-cancel todo ${todoId}: ${updErr.message}`);
      continue;
    }

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "TodoAutoCanceladoOcLancadaPorFora",
      actor_type: "system",
      actor_id: "sync-bastao",
      payload: {
        todo_id: todoId,
        action_id: actionId,
        cod_atual_bastao: ocAtualNoBastao,
        motivo: "Bastão já mostra oc igual à proposta — evita duplicação no SSW",
      },
    });
  }

  // Destrava o lock (ainda não muda state — quem decide o state final é o
  // resto do upsert via stateProposto/podeRecalcular).
  //
  // Caio 2026-05-12 (NF 920161): EXCEÇÃO — se card está em CLIENTE RESPONDEU
  // (state=AGUARDANDO_VALIDACAO_HUMANA + cliente_respondeu_em != null), NÃO
  // destrava o lock. Cancelar todo concorrente (ex: relancamento_54 quando
  // Bastão já tem 54) era zerando o lock que o vinculador acabou de setar
  // pra sinalizar "Larissa precisa decidir", e o card sumia da aba CLIENTE
  // RESPONDEU sem ação.
  const { data: cardAtual } = await supabase
    .from("cards")
    .select("state, cliente_respondeu_em")
    .eq("id", cardId)
    .maybeSingle();
  const ehClienteRespondeu =
    (cardAtual as { state?: string; cliente_respondeu_em?: string | null } | null)?.state ===
      "AGUARDANDO_VALIDACAO_HUMANA" &&
    (cardAtual as { cliente_respondeu_em?: string | null } | null)?.cliente_respondeu_em != null;

  if (!ehClienteRespondeu) {
    await supabase
      .from("cards")
      .update({ lock_aguardando_validacao: false })
      .eq("id", cardId);
  }

  return true;
}

/**
 * Calcula o state usando responsavel_atual do Bastão como fonte primária
 * e o dicionário ocorrencias_dicionario como fallback. Wraps a RPC
 * public.state_pelo_bastao(int, text) (migration 029).
 */
// Caio 2026-06-19 (FIX timeout 150s): memoização por (cod, responsavel_atual).
// state_pelo_bastao é STABLE e determinística — depende só desses 2 args. No Pass A
// ela rodava 1 RPC POR pendência (~500/run, ~300ms cada = ~150s, o gargalo real do
// loop). As ~500 pendências compartilham pouquíssimas combinações (quase tudo
// oc=54 + 'cliente'), então o memo reduz ~500 RPCs → ~30. Zero mudança de
// comportamento (mesmo input → mesmo output). Mesmo tradeoff de staleness do
// _cachedOcsValidas (dicionário só muda via redeploy). Erros NÃO são cacheados.
const _stateBastaoMemo = new Map<string, string | null>();
async function calcularStatePeloBastao(
  supabase: SupabaseClient,
  cod: number | null | undefined,
  responsavelAtual: string | null | undefined,
): Promise<string | null> {
  const key = `${cod ?? ""}|${(responsavelAtual ?? "").toLowerCase().trim()}`;
  const cached = _stateBastaoMemo.get(key);
  if (cached !== undefined) return cached;
  const { data, error } = await supabase.rpc("state_pelo_bastao", {
    p_cod: cod ?? null,
    p_responsavel_atual: responsavelAtual ?? null,
  });
  if (error) {
    console.error(
      `state_pelo_bastao(${cod}, ${responsavelAtual}) erro: ${error.message}`,
    );
    return null; // não cacheia erro — retenta no próximo card/run
  }
  const v = typeof data === "string" ? data : null;
  _stateBastaoMemo.set(key, v);
  return v;
}

function snapshotFromPendencia(p: BastaoPendencia) {
  return {
    bastao_pendencia_id: p.id,
    // Caio 2026-05-14: timestamp do registro do Bastão. Usado pelo executor
    // pra gravar bastao_updated_at_no_lancamento (guarda anti-reabertura).
    bastao_updated_at: p.updated_at,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    cnpj_remetente: p.cnpj_remetente,
    remetente: p.remetente,
    cnpj_pagador: p.cnpj_pagador,
    cnpj_destinatario: p.cnpj_destinatario,
    destinatario: p.destinatario,
    uf_destino: p.uf_destino,
    cidade_destino: p.cidade_destino,
    base_destino: p.base_destino,
    unidade_atual: p.unidade_atual,
    dias_atraso: p.atraso_original,
    previsao_entrega: p.previsao_entrega,
    responsabilidade_cliente: p.responsabilidade_cliente,
    responsavel_atual: p.responsavel_atual,
    responsavel_relacionamento: p.responsavel_relacionamento,
    segmento_cliente: p.segmento_cliente,
    importante_acompanhar: p.importante_acompanhar,
    tipo_cte: p.tipo_documento,
    qtde_volumes: p.qtd_volumes,
    bastao_synced_at: new Date().toISOString(),
  };
}
