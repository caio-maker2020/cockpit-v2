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
  ehOcAguardandoCliente,
  isOcorrenciaDeRelacionamentoCtx,
  VERIFICATION_TIMEOUT_MINUTES,
  isOcorrenciaDeRelacionamento,
  stateFinalAposBastao,
} from "../_shared/bastao-rules.ts";
import { proporAutoAcaoSeAplicavel, REGRAS_AUTO_ACAO } from "../_shared/regras-auto-acao.ts";
import { ehPropostaPosRespostaMesmaOc } from "../_shared/todo-relancamento.ts";
import { preservarExtravioParcial } from "../_shared/preservar-extravio-parcial.ts";
// Caio 2026-07-21 (INV-040, NF 2084): guard anti-loop de fabricação — bloqueia
// a criação quando a NF já acumulou ≥3 cards TERMINAIS criados em 24h (loop
// criação→terminal→recriação que o uniq_cards_nf_active parcial não segura).
// Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md. Fail-open.
import { bloquearCriacaoSeLoopDetectado } from "../_shared/guard-anti-loop-criacao.ts";
import {
  classificarPorData,
  type DecisaoReabertura,
  decidirReaberturaPorSsw,
  ordenarPresosPorCustoDeDecisao,
  parseSswDataHoraBrt,
  passDDevePreservarBannerIaSugestao,
  cacheSswUtilizavel,
  dataBrtDeTimestamp,
  ehLagDeLancamentoCockpit,
  deveSuprimirForceOc54PorLancamento,
  ultimaDataLancamento54Brt,
  ultimaDataLancamentoCockpitBrt,
  ultimoLancamentoCockpitInfo,
  ultimoLancamentoCockpitMs,
} from "../_shared/lag-lancamento-54.ts";
import { enfileirarScanEmailPreCard } from "../_shared/scan-email-enqueue.ts";
// Caio 2026-06-22 (invariante "card em escopo protegido nunca sai sozinho"):
// guard de release pros estados AGUARDANDO_VALIDACAO_HUMANA / AGUARDANDO_CLIENTE.
import {
  cardEmEscopoProtegido,
  flagConflitoOcSemMover,
  type MudancaSuspeitaJson,
} from "../_shared/escopo-relacionamento.ts";
// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao"): tracking SSW público
// foi substituído pelo SSW interno (opção 101). Imports antigos do
// ssw-tracking-client removidos. Pass B e Pass E agora usam descobrirUltimaOcSsw.
import { descobrirUltimaOcSsw } from "../_shared/ssw-internal-client.ts";
import { confirmarAcaoExecutadaViaSsw } from "../_shared/confirmar-acao-executada-ssw.ts";
// Caio 2026-06-29 (PR3b SHADOW): registra a decisão NOVA (por identidade) × ATUAL
// (per-hora) SEM agir, gated pela flag reabertura_shadow_enabled (default OFF).
// NÃO muda decisão real. NUNCA quebra o caminho real (try/catch interno).
import { type DecisaoAtual, registrarShadowReabertura } from "../_shared/reabertura-shadow.ts";
// Caio 2026-06-29 (PR4): decisão de visibilidade por IDENTIDADE (ai.salex × terceiro),
// atrás da flag reabertura_por_identidade_enabled (default OFF).
import {
  type DecisaoVisibilidade,
  decidirVisibilidadePorSsw,
  estadoFinalParaDecisao,
} from "../_shared/decidir-visibilidade-ssw.ts";
// Caio 2026-06-22: transicao-aguardando-cliente.ts não é mais importado — Pass E
// (único caller) virou NO-OP. Módulo fica como dead code documentado (ver runPassE).
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
  banner_ia_preservado: number;
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
  if (error || !lockados || lockados.length === 0) return 0;

  // Caio 2026-06-20 (leveza): 1 query em LOTE pega os card_ids que JÁ têm proposta
  // ativa, em vez de 1 count por card (~25 queries = ~20s/ciclo). Os lockados que
  // NÃO aparecerem aqui = presos (0 propostas) → minoria (em geral 0).
  const ids = (lockados as Array<Record<string, unknown>>).map((c) => c["id"] as string);
  const comProposta = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: todosAtivos } = await supabase
      .from("todos")
      .select("card_id")
      .in("card_id", ids.slice(i, i + 200))
      .in("status", ["pendente", "aprovado"]);
    for (const t of (todosAtivos ?? []) as Array<{ card_id: string }>) comProposta.add(t.card_id);
  }

  let curados = 0;
  for (const c of lockados as Array<Record<string, unknown>>) {
    if (syncDeadlineExcedido()) break;
    const cardId = c["id"] as string;
    if (comProposta.has(cardId)) continue; // tem proposta ativa — card saudável
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

// =============================================================================
// DESEMPATE INV-019 (Caio 2026-06-24, NF 175621) — decide se rebaixa um card
// AGUARDANDO_CLIENTE com oc de relacionamento ≠54, distinguindo "anterior lagando
// após o Cockpit lançar 54" (FICA) de "oc genuinamente nova" (MOVE).
//
// 99% dos casos resolvem SÓ pela DATA (zero SSW):
//   - data da oc do Bastão ANTES do lançamento de 54 → lag → FICA.
//   - data DEPOIS → oc nova → MOVE.
// Só o caso MESMO-DIA é ambíguo (a data não desempata) → 1 consulta ao SSW interno
// (verdade em tempo real). Medido: ~2 cards/dia no sliver, e só na virada da oc.
// Retorna naoRebaixar: true = FICA em AGUARDANDO_CLIENTE; false = MOVE pra VOCÊ.
// =============================================================================
async function naoRebaixarComDesempateSsw(
  supabase: SupabaseClient,
  args: { cardId: string; nf: string | null; ctrc: string | null; responsavel: string | null; bastaoOcDate: string | null },
): Promise<boolean> {
  const launchDate = await ultimaDataLancamento54Brt(supabase, args.cardId);
  const cls = classificarPorData(args.bastaoOcDate, launchDate);
  // PR4 (flag ON): caminho IDENTIDADE. naoRebaixar: true=FICA em AC / false=MOVE pra
  // VOCÊ. "lag" NÃO esconde sozinho — só "nova" decide sem SSW.
  if (await reaberturaPorIdentidadeAtivo(supabase)) {
    if (cls === "nova") return false; // Bastão posterior → move pra VOCÊ
    try {
      const r = await descobrirUltimaOcSsw(args.nf, args.ctrc, undefined, args.responsavel ?? null);
      const codigoUltimo = await ultimaOcLancadaCockpit(supabase, args.cardId);
      const conta = Deno.env.get("SSW_LANCAMENTO_USUARIO") ?? "";
      const dv = decidirVisibilidadePorSsw({
        ocorrenciasSsw: r.sucesso ? r.ocorrencias : [],
        ehRelac: (oc) => OCORRENCIAS_DE_RELACIONAMENTO.has(oc),
        contaLancamentoCockpit: conta,
        codigoUltimoLancamentoCockpit: codigoUltimo,
        sswFresco: r.sucesso,
      });
      if (dv.decisao === "MOSTRAR_OPERADOR") return false; // move pra VOCÊ
      if (dv.decisao === "INDEFINIDO_RETRY") {
        return (await aplicarPrazoIndefinidoRetry(supabase, args.cardId)) !== "reabrir";
      }
      return true; // MANTER_FORA_RELACIONAMENTO ou AGUARDANDO_CLIENTE → fica em AC
    } catch {
      return true; // SSW indisponível → fica neste ciclo
    }
  }
  // ── Caminho ATUAL (per-hora) — INTACTO quando a flag está OFF ──────────────────
  if (cls === "lag") return true; // anterior atrasada → fica (sem SSW)
  if (cls === "nova") return false; // oc nova → move (sem SSW)
  // ambiguo (mesmo dia): desempata pela VERDADE DO SSW POR HORA (Caio 2026-06-25,
  // raiz NF 346778). Antes decidia só pelo CÓDIGO da última oc; agora confronta a
  // HORA da ocorrência do SSW com o instante do lançamento (decidirReaberturaPorSsw):
  // só MOVE se a oc de relacionamento ≠54 do SSW é POSTERIOR ao lançamento (oc nova
  // genuína); se for provadamente anterior, é lag → FICA (mata bounce-back).
  try {
    const r = await descobrirUltimaOcSsw(args.nf, args.ctrc, undefined, args.responsavel ?? null);
    const lancMs = await ultimoLancamentoCockpitMs(supabase, args.cardId);
    const decisao = decidirReaberturaPorSsw({
      ocSswMaisRecente: r.sucesso ? r.oc : null,
      ocSswMaisRecenteMs: r.sucesso ? r.dataBrtMs : null,
      ehRelac: (oc) => OCORRENCIAS_DE_RELACIONAMENTO.has(oc),
      ultimoLancamentoCockpitMs: lancMs,
    });
    // PR3b SHADOW: registra decisão nova × atual SEM agir (gate OFF → no-op). NÃO
    // muda o que esta função retorna.
    await shadowReabertura(supabase, {
      cardId: args.cardId,
      nf: args.nf,
      caller: "sweepInv019",
      decisaoAtual: decisao,
      ocorrenciasSsw: r.sucesso ? r.ocorrencias : [],
      sswFresco: r.sucesso,
    });
    // reabrir → MOVE (false). suprimir/indefinido → FICA (true; indefinido reavalia
    // no próximo sync, SSW fora do ar é raro/transitório).
    return decisao !== "reabrir";
  } catch (_e) {
    return true; // SSW indisponível → FICA neste ciclo (retry no próximo).
  }
}

// =============================================================================
// decidirReaberturaCandidato — VERDADE DO SSW POR HORA pro caminho candidatoReabertura
// (TRANSFERIDO/TRATATIVA_PENDENTE/EXTRAVIO → relacionamento). Caio 2026-06-25 (NF 346778).
//
// Substitui o discriminador por DATA (ehLagDeLancamentoCockpit). Custo controlado:
//   1. fast-path por DATA (classificarPorData): estritamente antes/depois decide
//      sem SSW (cobre a maioria, zero rede);
//   2. mesmo-dia (ambíguo) → SSW cache-first: usa historico_ssw se fresco (<4h),
//      só bate na rede se stale → amarrado ao FLUXO, não ao estoque;
//   3. decidirReaberturaPorSsw confronta a oc/hora real do SSW com o lançamento.
// Retorna "reabrir" | "suprimir" | "indefinido" (indefinido = não decide neste
// ciclo; reavalia no próximo sync; safeguard 24h cobre persistência).
// =============================================================================
const HISTORICO_FRESCO_MS = 4 * 60 * 60 * 1000; // 4h: cache vale; senão puxa fresco.

async function obterOcSswRecenteCacheFirst(args: {
  nf: string | null;
  ctrc: string | null;
  responsavel: string | null;
  historicoCache: unknown;
  historicoCacheEm: string | null;
  /** FIX NF 387848 (Caio 2026-08-24): cache puxado ANTES do último lançamento
   *  do Cockpit é pré-evento — não enxerga a nossa ação → NUNCA embasa decisão,
   *  mesmo "fresco" no relógio. null = card sem lançamento (só relógio decide). */
  ultimoLancamentoMs?: number | null;
}): Promise<{
  oc: number | null;
  ms: number | null;
  // ADITIVO (PR3b shadow): histórico completo (autor) + fonte. Os callers reais
  // continuam lendo só `oc`/`ms` — decisão real inalterada.
  ocorrencias: Array<{ codigo: number | null; usuario: string | null; data: string | null }>;
  fonte: "cache" | "ssw" | "indefinido";
}> {
  const cache = Array.isArray(args.historicoCache)
    ? (args.historicoCache as Array<Record<string, unknown>>)
    : null;
  const cacheEm = args.historicoCacheEm ? new Date(args.historicoCacheEm).getTime() : 0;
  // Validade por EVENTO além do relógio (NFs 387848/680392): cache pré-lançamento
  // é semanticamente velho — 7/7 casos de 24/08 tinham cache puxado 1-3min ANTES
  // da aprovação (operador abre o card → front grava cache → aprova → lançamos).
  const cacheUtilizavel = cacheSswUtilizavel({
    cacheEmMs: cacheEm || null,
    agoraMs: Date.now(),
    frescoMs: HISTORICO_FRESCO_MS,
    ultimoLancamentoMs: args.ultimoLancamentoMs ?? null,
  });
  if (cache && cache.length > 0 && cacheUtilizavel) {
    // Cache fresco: usa a oc CODIFICADA mais recente (pula eventos sem código).
    const top = cache.find((o) => o["codigo"] != null);
    if (top) {
      const ocorrencias = cache.map((o) => ({
        codigo: (o["codigo"] as number | null) ?? null,
        usuario: (o["usuario"] as string | null) ?? null,
        data: (o["data"] as string | null) ?? null,
      }));
      return {
        oc: (top["codigo"] as number | null) ?? null,
        ms: parseSswDataHoraBrt((top["data"] as string | null) ?? null),
        ocorrencias,
        fonte: "cache",
      };
    }
  }
  // Cache stale/ausente → puxa fresco do SSW (1 consulta; pula se deadline estourou).
  if (syncDeadlineExcedido()) return { oc: null, ms: null, ocorrencias: [], fonte: "indefinido" }; // → indefinido (retry)
  const r = await descobrirUltimaOcSsw(args.nf, args.ctrc, undefined, args.responsavel);
  if (r.sucesso) return { oc: r.oc, ms: r.dataBrtMs, ocorrencias: r.ocorrencias, fonte: "ssw" };
  return { oc: null, ms: null, ocorrencias: [], fonte: "indefinido" }; // SSW indisponível → indefinido
}

// =============================================================================
// PR3b SHADOW (Caio 2026-06-29) — registra a decisão NOVA (por identidade) × a
// ATUAL (per-hora) SEM agir. Gated pela flag `reabertura_shadow_enabled` (default
// OFF), lida no máx. 1x/60s (memo). Flag OFF → no-op TOTAL (nenhum INSERT, nenhuma
// query extra além da leitura memoizada da flag). NÃO muda decisão real; NUNCA lança.
// =============================================================================
let _shadowFlagCache: { v: boolean; em: number } | null = null;
async function shadowReaberturaAtivo(supabase: SupabaseClient): Promise<boolean> {
  if (_shadowFlagCache && Date.now() - _shadowFlagCache.em < 60_000) return _shadowFlagCache.v;
  try {
    const { data } = await supabase
      .from("feature_flags").select("enabled").eq("key", "reabertura_shadow_enabled").maybeSingle();
    const v = (data as { enabled?: boolean } | null)?.enabled === true;
    _shadowFlagCache = { v, em: Date.now() };
    return v;
  } catch {
    return false; // default OFF
  }
}

async function ultimaOcLancadaCockpit(supabase: SupabaseClient, cardId: string): Promise<number | null> {
  try {
    const { data } = await supabase
      .from("acoes_executadas_ssw").select("codigo_oc")
      .eq("card_id", cardId).eq("sucesso", true)
      .order("iniciado_em", { ascending: false }).limit(1).maybeSingle();
    return (data as { codigo_oc?: number } | null)?.codigo_oc ?? null;
  } catch {
    return null;
  }
}

async function shadowReabertura(
  supabase: SupabaseClient,
  args: {
    cardId: string;
    nf: string | null;
    caller: "passA" | "sweepInv019";
    decisaoAtual: DecisaoAtual;
    ocorrenciasSsw: Array<{ codigo: number | null; usuario: string | null; data: string | null }>;
    sswFresco: boolean;
  },
): Promise<void> {
  try {
    if (!(await shadowReaberturaAtivo(supabase))) return; // flag OFF → nada acontece
    const codigoUltimo = await ultimaOcLancadaCockpit(supabase, args.cardId);
    const conta = Deno.env.get("SSW_LANCAMENTO_USUARIO") ?? "";
    await registrarShadowReabertura(supabase, true, {
      cardId: args.cardId,
      nf: args.nf,
      caller: args.caller,
      decisaoAtual: args.decisaoAtual,
      ocorrenciasSsw: args.ocorrenciasSsw,
      ehRelac: (oc) => OCORRENCIAS_DE_RELACIONAMENTO.has(oc),
      contaLancamentoCockpit: conta,
      codigoUltimoLancamentoCockpit: codigoUltimo,
      sswFresco: args.sswFresco,
    });
  } catch (_e) {
    // shadow NUNCA quebra o caminho real
  }
}

// =============================================================================
// PR4 (Caio 2026-06-29) — REABERTURA POR IDENTIDADE, atrás da flag
// `reabertura_por_identidade_enabled` (default OFF). Flag OFF → caminho per-hora
// INTACTO. Flag ON → a visibilidade passa por `decidirVisibilidadePorSsw`
// (identidade ai.salex × terceiro) e o INDEFINIDO_RETRY ganha PRAZO (≈1h/2 ciclos
// → escala MOSTRAR). ai.salex = conta oficial; autor desconhecido nunca esconde
// por código; preferir falso-positivo a Relacionamento invisível.
// =============================================================================
let _idFlagCache: { v: boolean; em: number } | null = null;
async function reaberturaPorIdentidadeAtivo(supabase: SupabaseClient): Promise<boolean> {
  if (_idFlagCache && Date.now() - _idFlagCache.em < 60_000) return _idFlagCache.v;
  try {
    const { data } = await supabase
      .from("feature_flags").select("enabled").eq("key", "reabertura_por_identidade_enabled").maybeSingle();
    const v = (data as { enabled?: boolean } | null)?.enabled === true;
    _idFlagCache = { v, em: Date.now() };
    return v;
  } catch {
    return false; // default OFF
  }
}

// Política de PRAZO do INDEFINIDO_RETRY (~1h ≈ 2 ciclos de 30min). Rastreada por
// card_events (sem corrida com agent_state). Após o prazo, com o Bastão ainda
// apontando Relacionamento ≠54, ESCALA pra MOSTRAR_OPERADOR ("reabrir") — nunca
// deixar Relacionamento invisível sem prazo.
const PRAZO_INDEFINIDO_MS = 60 * 60 * 1000;
async function aplicarPrazoIndefinidoRetry(
  supabase: SupabaseClient,
  cardId: string,
): Promise<DecisaoReabertura> {
  const emitir = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: eventType,
        actor_type: "system",
        actor_id: "sync-bastao",
        payload,
      });
    } catch { /* nunca quebra o sync */ }
  };
  let last: { created_at: string; event_type: string } | null = null;
  try {
    const { data } = await supabase
      .from("card_events")
      .select("created_at, event_type")
      .eq("card_id", cardId)
      .in("event_type", [
        "ReaberturaIndefinida",
        "ReaberturaPorIndefinidoExpirado",
        "CardReaberto",
        "ReaberturaSuprimidaPorVerdadeSsw",
        "DevolvidoParaSetor",
      ])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    last = (data as { created_at: string; event_type: string } | null) ?? null;
  } catch {
    last = null;
  }
  // Janela ativa = último evento relevante é ReaberturaIndefinida.
  if (last && last.event_type === "ReaberturaIndefinida") {
    if (Date.now() - new Date(last.created_at).getTime() > PRAZO_INDEFINIDO_MS) {
      await emitir("ReaberturaPorIndefinidoExpirado", {
        motivo:
          "Prazo do INDEFINIDO_RETRY (~1h/2 ciclos) expirou e o Bastão ainda aponta Relacionamento ≠54 — escala pra MOSTRAR_OPERADOR (não deixar Relacionamento invisível sem prazo).",
        indefinido_desde: last.created_at,
      });
      return "reabrir"; // escala → MOSTRAR_OPERADOR
    }
    return "indefinido"; // dentro do prazo → retry (sem novo evento)
  }
  // Sem janela ativa → abre uma.
  await emitir("ReaberturaIndefinida", {
    motivo:
      "Visibilidade indefinida (SSW indisponível / cache stale / autor desconhecido) — aguardando prazo (~1h) antes de escalar pra MOSTRAR.",
    prazo_ms: PRAZO_INDEFINIDO_MS,
  });
  return "indefinido";
}

// AGUARDANDO_CLIENTE no candidato (Pass A): SSW interno mostra oc=54 como mais
// recente → o card vai pra AGUARDANDO_CLIENTE (lock=false) + evento. NUNCA vira
// "suprimir"/TRANSFERIDO (INV-006). O downstream de upsertCardFromPendencia NÃO
// seta state quando o candidato retorna "indefinido" (podeRecalcular=false p/
// TRANSFERIDO; forcaAguardandoClienteOc54=false p/ Bastão≠54), então este UPDATE
// não é sobrescrito. Usa o mapeamento único `estadoFinalParaDecisao` (testado em PR1b).
async function forcarAguardandoClientePorSsw(supabase: SupabaseClient, cardId: string): Promise<void> {
  const ef = estadoFinalParaDecisao("AGUARDANDO_CLIENTE", "passA");
  if (ef.state == null) return;
  try {
    await supabase.from("cards").update({
      state: ef.state,
      lock_aguardando_validacao: ef.lock ?? false,
      aviso_alteracao_oc: null,
    }).eq("id", cardId);
    if (ef.evento) {
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: ef.evento,
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          motivo:
            "SSW interno mostra oc=54 como a mais recente — card vai pra AGUARDANDO_CLIENTE (lock=false). NUNCA mantém TRANSFERIDO. Bastão pode estar lagando na oc anterior.",
        },
      });
    }
  } catch { /* nunca quebra o sync */ }
}

// Mapeia a decisão por identidade → DecisaoReabertura no caminho CANDIDATO (Pass A).
async function mapearDecisaoVisibilidadeCandidato(
  supabase: SupabaseClient,
  cardId: string,
  decisao: DecisaoVisibilidade,
): Promise<DecisaoReabertura> {
  if (decisao === "MOSTRAR_OPERADOR") return "reabrir";
  if (decisao === "INDEFINIDO_RETRY") return await aplicarPrazoIndefinidoRetry(supabase, cardId);
  if (decisao === "AGUARDANDO_CLIENTE") {
    // oc=54 (SSW) → AGUARDANDO_CLIENTE de verdade; state já aplicado aqui.
    await forcarAguardandoClientePorSsw(supabase, cardId);
    return "indefinido"; // downstream não reabre nem suprime (state preservado)
  }
  return "suprimir"; // MANTER_FORA_RELACIONAMENTO
}

type ResultadoReabertura = {
  decisao: DecisaoReabertura;
  via: "identidade_ssw" | "per_hora";
  usuarioSswTopo: string | null;
  ocSswTopo: number | null;
  decisaoVisibilidade: DecisaoVisibilidade | null;
};

async function decidirReaberturaCandidato(
  supabase: SupabaseClient,
  args: {
    cardId: string;
    nf: string | null;
    ctrc: string | null;
    responsavel: string | null;
    bastaoOcDate: string | null;
    historicoCache: unknown;
    historicoCacheEm: string | null;
    ehRelac: (oc: number) => boolean;
  },
): Promise<ResultadoReabertura> {
  // 1. Fast-path por data (zero SSW). Busca ÚNICA do último lançamento (ms) —
  //    a data BRT deriva dele (antes eram 2 queries pro mesmo registro).
  const lancMsCandidato = await ultimoLancamentoCockpitMs(supabase, args.cardId);
  const lancDateBrt = lancMsCandidato != null
    ? dataBrtDeTimestamp(new Date(lancMsCandidato).toISOString())
    : null;
  const cls = classificarPorData(args.bastaoOcDate, lancDateBrt);
  // PR4 (flag ON): caminho IDENTIDADE. "nova" decide sem SSW (mostrar é seguro).
  if (await reaberturaPorIdentidadeAtivo(supabase)) {
    if (cls === "nova") {
      // Bastão estritamente posterior → mostra (sem SSW).
      return { decisao: "reabrir", via: "identidade_ssw", usuarioSswTopo: null, ocSswTopo: null, decisaoVisibilidade: "MOSTRAR_OPERADOR" };
    }
    if (cls === "lag") {
      // FIX porta 2 (Caio 2026-08-24, NF 387848): oc do Bastão PROVADAMENTE
      // anterior por data ao último lançamento do Cockpit → suprime SEM SSW —
      // o mesmo veredito que o caminho per-hora sempre honrou (regra inviolável
      // 25/06). Antes o "lag" caía no cache-first e um cache pré-lançamento
      // (topo 54 gravado quando o operador ABRIU o card, minutos antes de
      // aprovar) devolvia o card pra AGUARDANDO_CLIENTE: 420 bounces/30d, 97%
      // dos disparos da porta. Trade-off (retro-datada suprimida) é o mesmo já
      // aceito no per-hora; prazo/safeguard 24h cobrem.
      return { decisao: "suprimir", via: "identidade_ssw", usuarioSswTopo: null, ocSswTopo: null, decisaoVisibilidade: "MANTER_FORA_RELACIONAMENTO" };
    }
    const { ocorrencias, fonte } = await obterOcSswRecenteCacheFirst({ ...args, ultimoLancamentoMs: lancMsCandidato });
    const codigoUltimo = await ultimaOcLancadaCockpit(supabase, args.cardId);
    const conta = Deno.env.get("SSW_LANCAMENTO_USUARIO") ?? "";
    const dv = decidirVisibilidadePorSsw({
      ocorrenciasSsw: ocorrencias,
      ehRelac: args.ehRelac,
      contaLancamentoCockpit: conta,
      codigoUltimoLancamentoCockpit: codigoUltimo,
      sswFresco: fonte !== "indefinido",
    });
    const decisao = await mapearDecisaoVisibilidadeCandidato(supabase, args.cardId, dv.decisao);
    const topo = ocorrencias[0] ?? null;
    return {
      decisao,
      via: "identidade_ssw",
      usuarioSswTopo: topo?.usuario ?? null,
      ocSswTopo: topo?.codigo ?? null,
      decisaoVisibilidade: dv.decisao,
    };
  }
  // ── Caminho ATUAL (per-hora) — INTACTO quando a flag está OFF ──────────────────
  if (cls === "lag") {
    return { decisao: "suprimir", via: "per_hora", usuarioSswTopo: null, ocSswTopo: null, decisaoVisibilidade: null };
  }
  if (cls === "nova") {
    return { decisao: "reabrir", via: "per_hora", usuarioSswTopo: null, ocSswTopo: null, decisaoVisibilidade: null };
  }
  // 2. Mesmo-dia (ambíguo) → verdade do SSW por hora (cache-first, validado
  //    por EVENTO — cache pré-lançamento não embasa decisão). Reusa o lancMs
  //    já buscado no topo (era uma 2ª query pro mesmo registro).
  const { oc, ms, ocorrencias, fonte } = await obterOcSswRecenteCacheFirst({ ...args, ultimoLancamentoMs: lancMsCandidato });
  const lancMs = lancMsCandidato;
  const decisao = decidirReaberturaPorSsw({
    ocSswMaisRecente: oc,
    ocSswMaisRecenteMs: ms,
    ehRelac: args.ehRelac,
    ultimoLancamentoCockpitMs: lancMs,
  });
  // PR3b SHADOW: registra decisão nova × atual SEM agir (gate OFF → no-op). O
  // retorno (`decisao`) é EXATAMENTE o de decidirReaberturaPorSsw — inalterado.
  await shadowReabertura(supabase, {
    cardId: args.cardId,
    nf: args.nf,
    caller: "passA",
    decisaoAtual: decisao,
    ocorrenciasSsw: ocorrencias,
    sswFresco: fonte !== "indefinido",
  });
  const topo = ocorrencias[0] ?? null;
  return {
    decisao,
    via: "per_hora",
    usuarioSswTopo: topo?.usuario ?? null,
    ocSswTopo: oc ?? topo?.codigo ?? null,
    decisaoVisibilidade: null,
  };
}

// =============================================================================
// SWEEP INVARIANTE INV-019 (Caio 2026-06-24, NF 175621) — REDE DE SEGURANÇA
// SEMPRE-LIGADA, DESACOPLADA do Pass A.
//
// Regra inviolável: card em AGUARDANDO_CLIENTE com oc DE RELACIONAMENTO ≠54 TEM
// que ir pra AGUARDANDO VOCÊ (AVH+lock). Isso é OBRIGAÇÃO do Pass A, mas a regra
// NÃO pode depender só dele — em 2026-06-22 o Pass E (então dono) foi desligado e
// o ramo ficou órfão por 2 dias (52 cards invisíveis). Este sweep é a garantia:
// varre o ESTADO FINAL (não o fluxo) toda execução e cura qualquer violação,
// independente de qual código a causou (Pass A, SQL manual, vinculador, race).
//
// É a contraparte do `selfHealCardsPresos`. Não substitui o Pass A (que age na
// hora); é o net que torna impossível um card de relacionamento ficar preso.
// O watchdog INDEPENDENTE (health-check `checkAguardandoClienteOcRelacionamento`,
// outro processo/cron) alerta o Caio se ESTE sweep um dia parar de funcionar.
// =============================================================================
async function selfHealAguardandoClienteOcRelacionamento(
  supabase: SupabaseClient,
  excecoesOc13: ReadonlySet<string>,
  budgetMs: number | null = null,
): Promise<number> {
  const inicioSweep = Date.now();
  const estourouBudget = () => budgetMs != null && Date.now() - inicioSweep > budgetMs;
  if (syncDeadlineExcedido()) {
    // NF 1102092 (Caio 2026-08-17): o skip era SILENCIOSO — o card ficou 61min
    // invisível e não havia como saber que a rede de segurança nem rodou.
    // Telemetria obrigatória: skip aparece no log da function.
    console.warn("[sweep-inv019] PULADO por deadline — a rede de segurança do INV-019 não rodou neste ciclo");
    return 0;
  }
  // Fonte única: o set canônico de relacionamento MENOS as ocs que MORAM em
  // AGUARDANDO_CLIENTE (OCS_CLIENTE = {54,59}, dicionário responsabilidade='Cliente').
  // Caio 2026-07-22 (regressão 361 cards): o filtro antigo `oc !== 54` tratava a 59
  // (RETORNO INDENIZAÇÃO, split da 54) como "card preso" e o sweep varria TODOS os
  // cards 59 de AGUARDANDO_CLIENTE pra AGUARDANDO VOCÊ. Não hardcodar — INV-010.
  const ocsRelacionamentoSem54 = [...OCORRENCIAS_DE_RELACIONAMENTO].filter((oc) => !ehOcAguardandoCliente(oc));
  const { data: presos, error } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, agent_state, acao_executada_em, bastao_oc_no_lancamento, bastao_data_ultima_ocorrencia, responsavel_relacionamento")
    .eq("state", "AGUARDANDO_CLIENTE")
    .in("cod_ultima_ocorrencia", ocsRelacionamentoSem54)
    .limit(200);
  if (error || !presos || presos.length === 0) return 0;

  // FIX NF 693044 (Caio 2026-08-20): ordena por CUSTO da decisão — "nova" (cura
  // gratuita por data, sem SSW) primeiro; lag/ambíguo (consulta SSW, segundos
  // cada) por último. Sem isso, cards lentos na frente esgotavam o orçamento
  // (20s pré / deadline global pós) e um card trivialmente curável na posição 13
  // ficava invisível o dia inteiro — inanição determinística. A classificação
  // aqui usa só o banco (1 query por card, ms); a decisão real continua sendo
  // do guard autoritativo dentro do loop.
  const presosClassificados = await Promise.all(
    (presos as Array<Record<string, unknown>>).map(async (c) => {
      const lancBrt = await ultimaDataLancamento54Brt(supabase, c["id"] as string).catch(() => null);
      return {
        c,
        classe: classificarPorData((c["bastao_data_ultima_ocorrencia"] as string | null) ?? null, lancBrt),
      };
    }),
  );
  const presosOrdenados = ordenarPresosPorCustoDeDecisao(presosClassificados, (x) => x.classe)
    .map((x) => x.c);

  let curados = 0;
  for (const c of presosOrdenados) {
    if (syncDeadlineExcedido() || estourouBudget()) {
      console.warn(`[sweep-inv019] INTERROMPIDO (${estourouBudget() ? "budget local" : "deadline global"}) com ${presos.length - curados} card(s) ainda presos — o run pós-Pass A continua`);
      break;
    }
    const cardId = c["id"] as string;
    const ocNova = c["cod_ultima_ocorrencia"] as number | null;
    // GUARD AUTORITATIVO ANTI-REGRESSÃO (Caio 2026-06-24, NF 175621/10415): se o
    // Cockpit lançou oc=54 e a oc do Bastão é a ANTERIOR lagando (data <= data do
    // lançamento de 54), NÃO rebaixa — é atraso do RPA, não oc nova. Fonte = o
    // registro de lançamento do Cockpit (acoes_executadas_ssw), não campos voláteis
    // do card. Sinal CONFIÁVEL (acao_executada_em é LIMPO pelo confirm; snapshot é
    // inconsistente). Ver _shared/lag-lancamento-54.ts.
    const ehLag = await naoRebaixarComDesempateSsw(supabase, {
      cardId,
      nf: (c["nf"] as string | null) ?? null,
      ctrc: (c["ctrc"] as string | null) ?? null,
      responsavel: (c["responsavel_relacionamento"] as string | null) ?? null,
      bastaoOcDate: (c["bastao_data_ultima_ocorrencia"] as string | null) ?? null,
    });
    if (ehLag) continue;
    // GUARDS LEGADOS #2 e #3 REMOVIDOS (Caio 2026-07-06, NF 362406):
    //   (#2) `bastao_oc_no_lancamento === cod_ultima_ocorrencia → continue`
    //   (#3) janela de 60min por `acao_executada_em`.
    // O guard #2 (snapshot) prendia o card PRA SEMPRE — sem o escape de 24h que o
    // Pass A tem (bastaoAindaNoSnapshotDoLancamento) — sempre que a oc de
    // relacionamento NOVA coincidia em NÚMERO com a oc que o Bastão mostrava no
    // último lançamento do Cockpit, MESMO quando a DATA já provava ser oc nova.
    // NF 362406: novo 49 datado 07-03 (posterior ao 54 de 07-02) ficou invisível
    // pro operador; o watchdog do health-check (que NÃO tem esse guard) alertava
    // INV-019 pra sempre → divergência healer×watchdog. O snapshot é o sinal
    // LEGADO que o próprio código desconfia (ver cabeçalho de lag-lancamento-54.ts:
    // "bastao_oc_no_lancamento é inconsistente") e `acao_executada_em` é limpado pra
    // null pelo confirmar-acao-executada-ssw ao ir pra AGUARDANDO_CLIENTE.
    // Discriminador AUTORITATIVO = `naoRebaixarComDesempateSsw` (guard #1 acima, por
    // DATA + verdade do SSW por hora) = o MESMO predicado do watchdog/verify-cockpit,
    // eliminando a divergência. NÃO readicionar guard de snapshot (guard /verify-cockpit).
    try {
      // Event-source ANTES do update (INV-002).
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AguardandoClienteOcMudou",
        actor_type: "system",
        actor_id: "sync-bastao/sweep-inv019",
        payload: {
          oc_anterior: ocNova,
          oc_atual: ocNova,
          state_novo: "AGUARDANDO_VALIDACAO_HUMANA",
          motivo:
            "SWEEP INV-019: card em AGUARDANDO_CLIENTE com oc de relacionamento ≠54 — Pass A não moveu (rede de segurança). Vai pra AGUARDANDO VOCÊ.",
        },
      });
      await supabase
        .from("cards")
        .update({
          state: "AGUARDANDO_VALIDACAO_HUMANA",
          lock_aguardando_validacao: true,
          aviso_alteracao_oc: null,
        })
        .eq("id", cardId);
      // Garante as ações da nova oc (botões pro operador).
      await proporAutoAcaoSeAplicavel(supabase, {
        cardId,
        cardNf: (c["nf"] as string | null) ?? null,
        cardCtrc: (c["ctrc"] as string | null) ?? null,
        codUltimaOc: ocNova,
        agentState: (c["agent_state"] ?? {}) as Record<string, unknown>,
        cardState: "AGUARDANDO_VALIDACAO_HUMANA",
        cardLock: true,
        excecoesOc13,
        actorId: "sync-bastao/sweep-inv019",
      });
      curados++;
    } catch (e) {
      console.warn(`[sweep-inv019] nf ${c["nf"]} falhou (não bloqueia): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (curados > 0) {
    // Log ALTO: se o sweep curou algo, o Pass A (caminho primário) VAZOU.
    // O watchdog do health-check transforma isso em e-mail pro Caio.
    console.error(
      `[sweep-inv019] ALERTA: ${curados} card(s) AGUARDANDO_CLIENTE com oc de relacionamento ≠54 — Pass A NÃO moveu, sweep corrigiu. Investigar Pass A.`,
    );
  }
  return curados;
}

serve(async (req) => {
  const startedAt = Date.now();
  _syncDeadlineMs = startedAt + 110_000;

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

    // NF 1102092 (Caio 2026-08-17): o sweep do INV-019 roda ANTES do Pass A,
    // com orçamento GARANTIDO — quando rodava só depois, o Pass A podia comer o
    // deadline e o sweep era pulado em silêncio (o card ficou 61min invisível
    // atravessando 2 ciclos). A consulta é barata (≤200 cards). A chamada
    // pós-Pass A continua como 2ª chance pros casos que o próprio Pass A criar.
    try {
      // Teto de 20s no pré-run: casos "mesmo-dia" consultam o SSW (~4 hoje) e um
      // backlog patológico (classe 361-cards de 22/07) não pode estrangular o
      // Pass A. O que não couber fica pro run pós-Pass A e pro próximo ciclo.
      await selfHealAguardandoClienteOcRelacionamento(supabase, excecoesOc13, 20_000);
    } catch (e) {
      console.warn(`[sweep-inv019/pre] sweep falhou (não bloqueia sync): ${e instanceof Error ? e.message : String(e)}`);
    }
    await _mark("sweepInv019Pre");

    const passARes = await runPassA(supabase, bastao, ocsBloqueadasTracking, excecoesOc13, cnpjsExcluidos, errors);
    await _mark("A");
    const passA = passARes.summary;
    // Fix B (2026-06-19): recupera cards presos vazios (AVH+lock sem propostas) —
    // roda cedo, logo após o Pass A, pra garantir tempo dentro do deadline. O nº
    // de curados é logado dentro da função.
    await selfHealCardsPresos(supabase, excecoesOc13);
    await _mark("selfHeal");
    // Rede de segurança INV-019 (sempre roda, desacoplada do Pass A): cura cards
    // AGUARDANDO_CLIENTE com oc de relacionamento ≠54 que o Pass A não moveu.
    try {
      await selfHealAguardandoClienteOcRelacionamento(supabase, excecoesOc13);
    } catch (e) {
      console.warn(`[sweep-inv019] sweep falhou (não bloqueia sync): ${e instanceof Error ? e.message : String(e)}`);
    }
    await _mark("sweepInv019");
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
    await _mark("G");

    // Caio 2026-05-13 (Fase 2 plano "hoje-usamos-o-bastao"): Pass H consulta
    // SSW interno (opção 101) on-time pra liberar cards em ACAO_EXECUTADA
    // sem esperar latência RPA Bastão. Roda APÓS Pass G — se G já liberou,
    // card sai do SELECT de H (filtro state=ACAO_EXECUTADA). Pass G fica
    // como backup nos primeiros 14 dias do rollout (fase 3 remove).
    const passH = await runPassH(supabase, errors);
    await _mark("H");

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
    "id, nf, ctrc, created_at, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state, bastao_pendencia_id, lock_aguardando_validacao, aviso_alteracao_oc, agent_state, cliente_respondeu_em, acao_executada_em, bastao_oc_no_lancamento, bastao_updated_at_no_lancamento, responsavel_relacionamento, historico_ssw, historico_ssw_atualizado_em";
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
    const resultados = await Promise.allSettled(lote.map(async (p) => {
      // Caio 2026-06-20 (ADR 0006 — CTRC é a identidade do card): se o Bastão
      // passou a apontar a NF pra um CTRC DIFERENTE do card existente, o CT-e
      // anterior encerrou e nasceu outro (entrega→devolução/complementar). Encerra
      // o card antigo (RESOLVIDO) e o remove do prefetch ANTES do dispatch → o
      // handler (relacionamento OU extravio) vê "sem card" e cria card novo pro
      // CTRC novo. Roda nos dois ramos. Falha aqui não derruba o card (try/catch).
      try {
        await encerrarCardAntigoSeCtrcMudou(supabase, p, prefetchedByNf, cnpjsExcluidos);
      } catch (e) {
        console.error(
          `[A] encerrar card por troca de CTRC falhou (nf ${p.nf ?? "?"}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
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

// =============================================================================
// CTRC é a identidade do card (Caio 2026-06-20, ADR 0006).
//
// Uma NF gera vários CT-es ao longo da vida (entrega → reentrega → devolução →
// complementar/subcontrato). Quando o Bastão passa a apontar a pendência da NF
// pra um CTRC DIFERENTE do que está no card, o CT-e anterior encerrou e nasceu
// outro: é OUTRA tratativa. O card antigo finaliza junto com o CT-e antigo
// (RESOLVIDO) e o handler cria um card NOVO pro CTRC novo. A ocorrência segue a
// responsabilidade dela (CT-e de devolução/complementar com oc de relacionamento
// é do Relacionamento — o tipo de CT-e não muda a responsabilidade da oc).
//
// Bug raiz (antes): sync casava por NF + uniq_cards_nf_active = 1 card ativo por
// NF → a oc do CT-e novo era COLADA no card do CT-e velho (já baixado) →
// "Frankenstein": CTRC finalizado + oc nova. Risco: lançar ocorrência em CT-e
// baixado/complementar (DOCUMENTO BAIXADO OU ENTREGUE). Memory
// feedback_ctrc_e_identidade_do_card_nao_nf.
//
// Contida: finaliza o card antigo e o REMOVE do prefetchedByNf → o handler
// (relacionamento OU extravio) vê "sem card existente" e cria o card novo pro
// p.ctrc, reusando toda a lógica de criação. Mantém "1 card ativo por NF" (o
// velho vira RESOLVIDO antes do novo nascer) → vinculador/gmail/RPCs/front
// seguem válidos, SEM mexer no índice uniq_cards_nf_active.
//
// Guardas: só dispara com ambos CTRCs presentes e DIFERENTES (normalizado
// upper+trim); pula card em EXECUÇÃO (INV-007 — não interrompe o executor); pula
// CNPJ excluído do Cockpit. Card já terminal só recebe o evento + sai do prefetch
// (não reabre o CT-e velho via Camada 5a).
//
// Retorna true se encerrou (caller já loga); nunca lança fora do próprio caller
// (chamado dentro de try/catch no dispatch).
// =============================================================================
async function encerrarCardAntigoSeCtrcMudou(
  supabase: SupabaseClient,
  p: BastaoPendencia,
  // deno-lint-ignore no-explicit-any
  prefetchedByNf: Map<string, any>,
  cnpjsExcluidos: ReadonlySet<string>,
): Promise<boolean> {
  const nf = normalizeNf(p.nf);
  if (!nf || !p.ctrc) return false;
  // CNPJ fora do Cockpit: não mexe (mesmo skip do upsert/INV-003).
  if (p.cnpj_pagador && cnpjsExcluidos.has(p.cnpj_pagador)) return false;

  const existing = prefetchedByNf.get(nf);
  const ctrcExistente = existing?.ctrc as string | null | undefined;
  if (!existing || !ctrcExistente) return false;

  const normCtrc = (c: string) => c.toUpperCase().trim();
  if (normCtrc(ctrcExistente) === normCtrc(p.ctrc)) return false; // mesmo CT-e → nada a fazer

  // INV-007: nunca encerrar card em execução (executor rodando). Defere pro
  // próximo sync (quando a ação tiver terminado).
  const EM_EXECUCAO = new Set([
    "EXECUTANDO_ACAO",
    "EM_EXECUCAO_AUTOMATICA",
    "ACAO_EXECUTADA",
  ]);
  if (EM_EXECUCAO.has(existing.state as string)) return false;

  const JA_TERMINAL = new Set(["RESOLVIDO", "CANCELADO", "TRANSFERIDO"]);
  const jaTerminal = JA_TERMINAL.has(existing.state as string);

  if (!jaTerminal) {
    // Propostas pendentes do CT-e antigo não fazem mais sentido (CT-e baixado).
    await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason:
          "Card encerrado por troca de CT-e (CTRC mudou) — propostas do CT-e anterior invalidadas",
      })
      .eq("card_id", existing.id)
      .in("status", ["pendente", "aprovado"]);

    // Encerra o card antigo junto com o CT-e antigo (RESOLVIDO sai do
    // uniq_cards_nf_active → o INSERT do card novo pra mesma NF não viola).
    const { error: upErr } = await supabase
      .from("cards")
      .update({
        state: "RESOLVIDO",
        lock_aguardando_validacao: false,
        aviso_alteracao_oc: null,
      })
      .eq("id", existing.id);
    if (upErr) throw new Error(`encerrar card antigo (troca CTRC): ${upErr.message}`);
  }

  // Tira do prefetch ANTES do evento: mesmo se o INSERT do evento falhar, o
  // handler já cria o card novo (não reabre o velho via Camada 5a / if(existing)).
  prefetchedByNf.delete(nf);

  await supabase.from("card_events").insert({
    card_id: existing.id,
    event_type: "CardEncerradoPorTrocaDeCtrc",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      nf,
      ctrc_anterior: ctrcExistente,
      ctrc_novo: p.ctrc,
      oc_anterior: existing.cod_ultima_ocorrencia ?? null,
      oc_nova_bastao: p.cod_ultima_ocorrencia ?? null,
      tipo_documento_novo: p.tipo_documento ?? null,
      state_anterior: existing.state,
      ja_estava_terminal: jaTerminal,
      motivo:
        "CTRC é a identidade do card. O Bastão passou a apontar a NF pra outro " +
        "CT-e (ex.: entrega→devolução/complementar). O CT-e anterior encerrou junto " +
        "com o card; nasce um card novo pro CTRC novo. A ocorrência segue a " +
        "responsabilidade dela (ADR 0006).",
    },
  });

  console.log(
    `[A] ${nf}: CTRC mudou ${ctrcExistente}→${p.ctrc} (state anterior ${existing.state}) — card antigo encerrado, card novo será criado pro CTRC novo.`,
  );
  return true;
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
  const agentStateBaseExtravio: Record<string, unknown> = chaveExistente
    ? { ...snapshot, chave_cte: chaveExistente }
    : snapshot;
  // Hotfix 2026-07-03: preserva agent_state.extravio_parcial (dossiê). O snapshot do
  // Bastão não o inclui; sem isso o UPDATE de extravio (1201/1274) apagaria o dossiê se
  // um card com dossiê fosse re-reportado como extravio. No-op p/ extravio comum (sem a
  // chave). Mesma ideia da preservação da chave_cte.
  const agentStateFinal = preservarExtravioParcial(
    agentStateBaseExtravio,
    existing?.agent_state as Record<string, unknown> | undefined,
  );

  // (a) sem card OU terminal → cria card de extravio (terminal não bloqueia:
  // extravio que re-ocorre cria card novo, uniq_cards_nf_active libera terminais).
  const ehTerminal = existing && (existing.state === "RESOLVIDO" || existing.state === "CANCELADO");
  if (!existing || ehTerminal) {
    // Guard anti-loop INV-040 (NF 2084): ≥3 cards terminais da NF criados em
    // 24h = rajada de fabricação, não re-ocorrência legítima. Não cria.
    if (await bloquearCriacaoSeLoopDetectado(supabase, { nf, origem: "extravio", ctrc: p.ctrc ?? null })) {
      return "unchanged";
    }
    const email = await resolverEmailDestino(supabase, p.cnpj_pagador, p.cnpj_remetente ?? null);
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
    // Caio 2026-06-29 (NF 705764): card nascido de EXTRAVIO também enfileira o
    // scan de e-mail pré-existente. O caminho normal (upsertCardFromPendencia:2599)
    // já fazia isso, mas handleExtravioPendencia nunca chamava → cards de extravio
    // (que viram 49→54) ficavam cegos pra tratativa que o cliente já abriu no
    // e-mail da operadora ANTES do card. Best-effort, gated por flag, só enfileira.
    await enfileirarScanEmailPreCard(supabase, {
      card_id: cardId,
      nf,
      cnpj_pagador: p.cnpj_pagador ?? null,
      assigned_operator_id: atribuicao.assigned_operator_id ?? null,
      origem: "extravio",
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
  const email = await resolverEmailDestino(supabase, p.cnpj_pagador, p.cnpj_remetente ?? null);
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
      .select("historico_ssw, agent_state, mudanca_suspeita")
      .eq("id", cardId)
      .maybeSingle();
    const histFresh = (cardFresh as { historico_ssw?: Array<{ codigo?: number }> } | null)?.historico_ssw;
    const ocSswReal = Array.isArray(histFresh) && histFresh.length > 0
      ? (histFresh[0]?.codigo as number | undefined)
      : undefined;

    if (typeof ocSswReal === "number" && ocSswReal !== ocPraRegra) {
      // Caio 2026-06-22 (invariante "card em escopo protegido nunca sai sozinho"):
      // ANTES esta reconciliação chamava atualizar-card-via-portal-ssw SEMPRE, que
      // movia o card pro destino real do SSW AUTOMATICAMENTE (sem operador) — era a
      // 5ª via de saída automática (NF 66820: SSW=41 fora de escopo → TRANSFERIDO
      // sem aprovação, depois reaberto por Bastão atrasado). Agora: se o card está
      // em escopo protegido E o SSW real saiu de relacionamento (não-finalizadora),
      // FLAGGA pra aba CONFLITOS e NÃO move — o operador decide via FORÇAR.
      const cnpjPag = (snapshotAgent["cnpj_pagador"] as string | null | undefined) ?? null;
      const sswRelac = isOcorrenciaDeRelacionamentoCtx(ocSswReal, { cnpjPagador: cnpjPag, excecoesOc13 });
      const sswFinalizadora = OCORRENCIAS_FINALIZADORAS.has(ocSswReal);
      const mudancaAtual = (cardFresh as { mudanca_suspeita?: MudancaSuspeitaJson | null } | null)?.mudanca_suspeita ?? null;
      const protegido = cardEmEscopoProtegido(effState);

      if (protegido && !sswRelac && !sswFinalizadora) {
        // Fora de escopo → FLAGGA (CONFLITOS), card permanece protegido.
        await flagConflitoOcSemMover(supabase, {
          cardId, deState: effState, deOc: ocPraRegra, paraOc: ocSswReal,
          origemPass: "A_reconc", mudancaAtual,
        });
        pulouAutoProposicao = true; // não cria propostas pra oc do Bastão (stale)
      } else if (protegido && sswFinalizadora) {
        // Finalizadora em card protegido: NÃO auto-resolve (invariante 22/06),
        // mas FLAGGA pra CONFLITOS (Caio 2026-08-24, NF 1611059): antes era só
        // um evento deferido invisível e o card entregue virava ZUMBI eterno —
        // "operador descobre via histórico" não acontece na prática (ninguém
        // reabre card quieto). Flag é idempotente (mudanca_suspeita) e a
        // finalizadora nunca foi lançada pelo Cockpit → INV-014 não barra.
        await flagConflitoOcSemMover(supabase, {
          cardId, deState: effState, deOc: ocPraRegra, paraOc: ocSswReal,
          origemPass: "A_reconc", mudancaAtual,
        });
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "BastaoDivergiuSswReconciliado",
          actor_type: "system",
          actor_id: "sync-bastao",
          payload: {
            oc_bastao_recebida: ocPraRegra, oc_ssw_real: ocSswReal, nf,
            deferido: true, acao: "finalizadora_flaggada_conflitos",
          },
        });
        pulouAutoProposicao = true;
      } else {
        // Não-protegido OU SSW ainda de relacionamento → sincroniza via portal
        // (comportamento original: card fora de escopo se move, card relacionamento
        // re-sincroniza a oc/propostas pelo SSW real).
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

    // Caio 2026-06-22 (NF 376924): guard pós-lançamento pro force de oc=54.
    // Quando o Cockpit lança uma oc que SAI do relacionamento (ex: 33 reversão),
    // o card vai pra TRANSFERIDO/ACAO_EXECUTADA com a oc real (33). O RPA do
    // Bastão demora e segue mostrando a oc PRÉ-lançamento; se essa oc stale for
    // 54, o force abaixo arrastava o card de volta pra AGUARDANDO_CLIENTE/oc=54
    // → re-armava o "escopo protegido" → Pass B flaggava CONFLITOS contra a
    // PRÓPRIA oc do Cockpit (caso âncora NF 376924: oc=33 lançada pela Larissa
    // virou conflito 54→33). Espelha a doutrina do bloco voltouParaRelacionamento
    // (bastaoEhMesmoSnapshotDoLancamento + lancamentoExpirouParaSafeguard,
    // computados mais abaixo): enquanto o Bastão mostra EXATAMENTE a oc do
    // snapshot do lançamento e o lançamento não expirou (24h), o SSW interno
    // tem prioridade → NÃO força oc=54. Para card sem lançamento Cockpit
    // (bastao_oc_no_lancamento null), o guard é no-op → force segue como antes.
    const ocSnapshotLancamento = (existing as Record<string, unknown>)["bastao_oc_no_lancamento"] as number | null | undefined;
    const updatedAtLancamento = (existing as Record<string, unknown>)["bastao_updated_at_no_lancamento"] as string | null | undefined;
    const bastaoAindaNoSnapshotDoLancamento =
      ocSnapshotLancamento != null &&
      p.cod_ultima_ocorrencia === ocSnapshotLancamento &&
      !(updatedAtLancamento != null &&
        Date.now() - new Date(updatedAtLancamento).getTime() > 24 * 60 * 60 * 1000);

    // FIX NF 693044 (Caio 2026-08-20): o veto do snapshot NÃO pode valer quando a
    // DATA da pendência prova que a oc é NOVA. Caso real: cliente recusou 2x — o
    // Cockpit lançou 54 (snapshot da oc 10 do dia 19) e no dia 20 chegou OUTRA
    // recusa (mesmo código 10, data 20/08 > lançamento 19/08). O guard de 24h
    // tratava a 2ª recusa como "eco do RPA" e o card ficou invisível em
    // AGUARDANDO_CLIENTE (o Pass A só reavalia quando a oc muda — chance única).
    // Mesma lição da NF 362406, que removeu esse guard do sweep: snapshot é sinal
    // legado; a DATA + lançamento em acoes_executadas_ssw é o sinal confiável.
    // Só destrava com prova ("nova" estrita); lag/ambíguo mantêm o veto de 24h.
    // Custo: 1 query (acoes_executadas_ssw) apenas quando a oc mudou dentro do
    // snapshot — raríssimo.
    let snapshotVetaTransicaoRelacionamento = bastaoAindaNoSnapshotDoLancamento;
    if (
      snapshotVetaTransicaoRelacionamento &&
      existing.state === "AGUARDANDO_CLIENTE" &&
      changedOcorrencia &&
      p.cod_ultima_ocorrencia != null &&
      !ehOcAguardandoCliente(p.cod_ultima_ocorrencia) &&
      p.data_ultima_ocorrencia != null
    ) {
      const lanc54Brt = await ultimaDataLancamento54Brt(supabase, existing.id as string);
      if (classificarPorData(p.data_ultima_ocorrencia, lanc54Brt) === "nova") {
        snapshotVetaTransicaoRelacionamento = false;
        console.log(
          `[A] ${p.nf}: snapshot do lançamento CEDE — oc ${p.cod_ultima_ocorrencia} datada ${p.data_ultima_ocorrencia} é POSTERIOR ao lançamento (${lanc54Brt}); recusa/oc repetida é NOVA, não eco (NF 693044).`,
        );
      }
    }

    let forcaAguardandoClienteOc54 =
      p.cod_ultima_ocorrencia === 54 &&
      existing.state !== "AGUARDANDO_CLIENTE" &&
      existing.state !== "EXECUTANDO_ACAO" &&
      // Auditoria 25/07 (NF 431380): AVH com lock=true é validação humana
      // EXPLÍCITA (convenção 4) — o force com Bastão lagado atropelava o
      // acionamento da resposta 8min depois dela chegar. Poupa AVH também
      // quando o lock está armado, não só com carimbo de resposta.
      !(existing.state === "AGUARDANDO_VALIDACAO_HUMANA" &&
        (clienteJaRespondeu ||
          (existing as Record<string, unknown>)["lock_aguardando_validacao"] === true)) &&
      !bastaoAindaNoSnapshotDoLancamento;

    // FIX NF 1611059 (Caio 2026-08-24): o guard do snapshot acima nasce morto
    // quando o REGISTRO do Bastão no lançamento já tinha >24h (norma: cliente
    // demora 1+ dia pra responder antes do operador agir) — 643 bounces/611
    // cards em 30d: Cockpit lançou 21/44/55/33/56 → TRANSFERIDO, e 18min depois
    // o force arrastava de volta pra AGUARDANDO_CLIENTE com a 54 STALE.
    // Discriminador correto = regra inviolável 25/06: DATA do último lançamento
    // em acoes_executadas_ssw (fonte durável). 1 query, só quando o force já
    // passou nas outras condições (raro).
    if (forcaAguardandoClienteOc54) {
      const ultimoLanc = await ultimoLancamentoCockpitInfo(supabase, existing.id as string);
      if (
        deveSuprimirForceOc54PorLancamento(
          (p.data_ultima_ocorrencia as string | null) ?? null,
          ultimoLanc,
        )
      ) {
        forcaAguardandoClienteOc54 = false;
        console.log(
          `[A] ${p.nf}: forcaAguardandoClienteOc54 SUPRIMIDO — Bastão oc=54 datada ` +
            `${p.data_ultima_ocorrencia} é LAG do lançamento oc=${ultimoLanc?.codigoOc} ` +
            `de ${ultimoLanc?.dataBrt} pelo Cockpit (NF 1611059). state mantido: ${existing.state}.`,
        );
      }
    }

    if (
      bastaoAindaNoSnapshotDoLancamento &&
      p.cod_ultima_ocorrencia === 54 &&
      existing.state !== "AGUARDANDO_CLIENTE"
    ) {
      console.log(
        `[A] ${p.nf}: forcaAguardandoClienteOc54 SUPRIMIDO — Bastão ainda no ` +
          `snapshot do lançamento (oc=${ocSnapshotLancamento}); SSW interno tem ` +
          `prioridade. state mantido: ${existing.state}.`,
      );
    }

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

    // Caio 2026-06-24 (NF 175621 COMPROMISSO + 51 cards): RAMO RELACIONAMENTO
    // RESTAURADO no Pass A. Regra (memory project_aguardando_cliente_state §3):
    // AGUARDANDO_CLIENTE só pode conter oc=54. Quando a oc real (Bastão) de um
    // card AGUARDANDO_CLIENTE vira OUTRA oc DE RELACIONAMENTO ≠54 (ex: 49), o
    // card tem que ir pra AGUARDANDO VOCÊ (AGUARDANDO_VALIDACAO_HUMANA + lock)
    // pro operador tratar a nova oc.
    //
    // REGRESSÃO: esse ramo era do Pass E, DESLIGADO em 2026-06-22 pela invariante
    // "card em escopo protegido nunca sai sozinho". Mas mover AGUARDANDO_CLIENTE →
    // AGUARDANDO VOCÊ NÃO fere a invariante — o card CONTINUA no Cockpit, só troca
    // de aba e fica visível pro operador. A invariante proíbe sair pra
    // TRANSFERIDO/RESOLVIDO. O ramo out-of-escopo (→CONFLITOS) segue 100% no
    // Pass B (flagConflitoOcSemMover) — aqui NÃO mexemos nele.
    //
    // Lag pós-lançamento de 54 (Bastão ainda mostra a oc original — bug NF
    // 196537): coberto por !dentroDaJanelaPosLancamento (60min) +
    // !bastaoAindaNoSnapshotDoLancamento (Bastão ainda reflete o snapshot do
    // lançamento, 24h). Propostas pra nova oc: a reconciliação deferida (2º passo)
    // confirma a oc real via SSW antes de propor (proteção NF 761333) — aqui só
    // movemos o state; effState abaixo carrega AVH+lock pra esse caminho.
    let aguardandoClienteVirouOutraRelacionamento =
      existing.state === "AGUARDANDO_CLIENTE" &&
      changedOcorrencia &&
      !forcaAguardandoClienteOc54 &&
      p.cod_ultima_ocorrencia != null &&
      // Caio 2026-07-22: `!== 54` virou ehOcAguardandoCliente — a 59 (RETORNO
      // INDENIZAÇÃO) também MORA em AGUARDANDO_CLIENTE e não pode ser tratada
      // como "oc mudou" (mesma regressão do sweep INV-019, 361 cards em AVH).
      !ehOcAguardandoCliente(p.cod_ultima_ocorrencia) &&
      isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
        cnpjPagador: p.cnpj_pagador,
        excecoesOc13,
      }) &&
      !dentroDaJanelaPosLancamento &&
      // NF 693044: snapshot com veto condicionado à DATA (cede quando a pendência
      // prova oc nova — recusa repetida). Definido junto ao snapshot, acima.
      !snapshotVetaTransicaoRelacionamento;

    // GUARD AUTORITATIVO ANTI-REGRESSÃO (Caio 2026-06-24, NF 175621/10415): se o
    // Cockpit lançou oc=54 e a oc do Bastão é a ANTERIOR lagando (data da oc do
    // Bastão <= data do lançamento de 54 em acoes_executadas_ssw), NÃO rebaixa —
    // é atraso do RPA, não oc nova. Os guards de cima (acao_executada_em /
    // bastao_oc_no_lancamento) falharam: o confirmar-acao-executada-ssw LIMPA
    // acao_executada_em ao ir pra AGUARDANDO_CLIENTE e o snapshot é inconsistente.
    // Este é o sinal CONFIÁVEL (data, fonte = registro de lançamento do Cockpit).
    if (aguardandoClienteVirouOutraRelacionamento) {
      // FIX NF 1102092 (Caio 2026-08-17): a data avaliada TEM que ser a da
      // PENDÊNCIA que está chegando (p.data_ultima_ocorrencia), não a do card
      // pré-update (`existing.bastao_data_ultima_ocorrencia`). Com a data velha,
      // a oc NOVA datada depois do lançamento era classificada como lag/ambígua
      // e a transição legítima era bloqueada NA MESMA rodada que trouxe a oc —
      // o card ficou 61min invisível em AGUARDANDO_CLIENTE esperando o sweep.
      // Fallback conservador: sem data na pendência, usa a antiga (comportamento
      // anterior — nunca rebaixa com menos informação do que antes).
      const ehLag = await naoRebaixarComDesempateSsw(supabase, {
        cardId: existing.id as string,
        nf: p.nf,
        ctrc: (existing.ctrc as string | null) ?? null,
        responsavel: (existing.responsavel_relacionamento as string | null) ?? null,
        bastaoOcDate: p.data_ultima_ocorrencia ??
          (existing.bastao_data_ultima_ocorrencia as string | null) ?? null,
      });
      if (ehLag) {
        aguardandoClienteVirouOutraRelacionamento = false;
        console.log(
          `[A] ${p.nf}: NÃO rebaixa AGUARDANDO_CLIENTE — Bastão lag da oc anterior (oc=${p.cod_ultima_ocorrencia} data ${existing.bastao_data_ultima_ocorrencia}) ao lançamento de 54 do Cockpit.`,
        );
      }
    }

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
    // REGRA INVIOLÁVEL (Caio 2026-06-25, NF 351193 + 10415): TODA oc lançada pelo
    // Cockpit move o card naturalmente — o sync NÃO pode reabri-lo (bounce-back)
    // enquanto a oc do Bastão for ≤ a data do último lançamento bem-sucedido do
    // Cockpit (QUALQUER oc) = a anterior lagando, não oc nova. Generaliza o fix de
    // 54 (10415) pra qualquer oc: a 351193 lançou 56 → TRANSFERIDO e voltava travada
    // em AVH porque o Bastão lagou na oc=49 (de 11/06). Discriminador DURÁVEL por
    // data (acoes_executadas_ssw), não o volátil acao_executada_em (janela 60min,
    // limpado pelo confirm). Extravio nunca lançou pelo Cockpit → helper=null → não
    // é lag → reabre normalmente (preserva a reabertura EXTRAVIO_MONITORADO).
    const candidatoReabertura =
      (existing.state === "TRANSFERIDO" || existing.state === "TRATATIVA_PENDENTE" ||
        existing.state === "EXTRAVIO_MONITORADO") &&
      p.cod_ultima_ocorrencia != null &&
      isOcorrenciaDeRelacionamentoCtx(p.cod_ultima_ocorrencia, {
        cnpjPagador: p.cnpj_pagador, excecoesOc13,
      }) &&
      !dentroDaJanelaPosLancamento &&
      (!bastaoEhMesmoSnapshotDoLancamento || lancamentoExpirouParaSafeguard);

    // VERDADE DO SSW POR HORA (Caio 2026-06-25, raiz NF 346778): substitui o
    // discriminador por DATA — que, no mesmo dia (norma com 6000 entregas/dia),
    // escondia oc de relacionamento genuinamente nova. SÓ pros candidatos (raro):
    // fast-path por data + SSW cache-first (rede só no mesmo-dia com cache stale).
    //   reabrir   → oc nova genuína (SSW mostra relac ≠54 posterior ao lançamento)
    //   suprimir  → a anterior lagando / o Cockpit já moveu (mata bounce-back 351193)
    //   indefinido→ SSW fora do ar/sem hora → NÃO decide neste ciclo (retry; safeguard 24h)
    const resultadoReabertura: ResultadoReabertura = candidatoReabertura
      ? await decidirReaberturaCandidato(supabase, {
        cardId: existing.id as string,
        nf: p.nf,
        ctrc: (existing.ctrc as string | null) ?? null,
        responsavel: (existing.responsavel_relacionamento as string | null) ?? null,
        bastaoOcDate: (p.data_ultima_ocorrencia as string | null) ?? null,
        historicoCache: existing.historico_ssw,
        historicoCacheEm: (existing.historico_ssw_atualizado_em as string | null) ?? null,
        ehRelac: (oc) => isOcorrenciaDeRelacionamentoCtx(oc, { cnpjPagador: p.cnpj_pagador, excecoesOc13 }),
      })
      : { decisao: "suprimir", via: "per_hora", usuarioSswTopo: null, ocSswTopo: null, decisaoVisibilidade: null };
    const decisaoReabertura: DecisaoReabertura = resultadoReabertura.decisao;
    if (candidatoReabertura && decisaoReabertura === "suprimir") {
      // Observabilidade (Caio 2026-07-01): distingue QUAL lógica suprimiu (identidade
      // ADR 0011 × per-hora ADR 0009) + captura o topo real do SSW (usuário/oc) que
      // decidiu MANTER_FORA. Fecha o gap: antes o evento só tinha oc_bastao/oc_card,
      // impossibilitando auditar se a supressão foi correta (nossa ação) ou suspeita.
      await supabase.from("card_events").insert({
        card_id: existing.id as string,
        event_type: "ReaberturaSuprimidaPorVerdadeSsw",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          motivo: resultadoReabertura.via === "identidade_ssw"
            ? "IDENTIDADE (ADR 0011): a última oc real do SSW é nossa (ai.salex) ou não-relacionamento — o Cockpit já moveu / não é oc nova de terceiro. NÃO reabre."
            : "VERDADE DO SSW POR HORA (ADR 0009): a oc do Bastão é a anterior lagando / o Cockpit já moveu — não é oc nova. NÃO reabre (raiz NF 346778; mata bounce-back 351193/10415).",
          via: resultadoReabertura.via,
          usuario_ssw_topo: resultadoReabertura.usuarioSswTopo,
          oc_ssw_topo: resultadoReabertura.ocSswTopo,
          decisao_visibilidade: resultadoReabertura.decisaoVisibilidade,
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_bastao_data: p.data_ultima_ocorrencia,
          oc_card: existing.cod_ultima_ocorrencia,
        },
      });
    } else if (candidatoReabertura && decisaoReabertura === "indefinido") {
      console.log(
        `[A] ${p.nf}: candidatoReabertura mas SSW INDEFINIDO (fora do ar/sem hora) — NÃO decide neste ciclo, reavalia no próximo sync (safeguard 24h cobre).`,
      );
    }

    const voltouParaRelacionamento = candidatoReabertura && decisaoReabertura === "reabrir";

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
    const agentStateBase: Record<string, unknown> = { ...novoSnapshot };
    if (chaveCtePreservada) agentStateBase["chave_cte"] = chaveCtePreservada;
    if (typeof propostasRecusadasEm === "string") {
      agentStateBase["propostas_recusadas_em"] = propostasRecusadasEm;
    }
    if (typeof propostasRecusadasParaOc === "number") {
      agentStateBase["propostas_recusadas_para_oc"] = propostasRecusadasParaOc;
    }
    // Hotfix 2026-07-03: preserva agent_state.extravio_parcial (dossiê). snapshotFromPendencia
    // NÃO o inclui → sem isso o sync APAGA o dossiê que o interpretador populou (confirmado:
    // NF 1119469/28779 perderam o dossiê pós-sync). Mesmo padrão da chave_cte acima; helper
    // puro, mínimo — não classifica caso, não avalia dossiê, não toca gate/oc33/state/lock/todo.
    const agentStateNovo = preservarExtravioParcial(agentStateBase, agentStateExistente);

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

    // ── PORTA 4 (Caio 2026-08-25, NF 306070): Bastão lagado NÃO regride a oc ──
    // O Cockpit lançou 55 (card TRANSFERIDO, oc=55); 26min depois o Pass A,
    // ao processar a pendência STALE do Bastão (oc 49 velha), SUPRIMIU a
    // reabertura corretamente MAS gravou cod_ultima_ocorrencia=49 por cima da
    // 55 — e a régua da resposta de cliente ("a OC define se o card é do
    // Cockpit", Caio 25/07) leu a 49 envenenada e puxou o card de volta pra
    // CLIENTE RESPONDEU. 4ª porta da família "dado velho vence ação do
    // Cockpit": aqui o state fica certo, mas a OC regride e contamina as
    // decisões downstream. Discriminador = o mesmo por DATA das portas 1-3
    // (acoes_executadas_ssw, fonte durável): oc do Bastão datada <= último
    // lançamento => eco => PRESERVA a oc do card. Oc genuinamente nova
    // (data posterior) ou card sem lançamento => grava normal.
    let preservarOcDoCard = false;
    if (changedOcorrencia && p.cod_ultima_ocorrencia != null && existing.cod_ultima_ocorrencia != null) {
      try {
        preservarOcDoCard = await ehLagDeLancamentoCockpit(
          supabase,
          existing.id as string,
          (p.data_ultima_ocorrencia as string | null) ?? null,
        );
        if (preservarOcDoCard) {
          console.log(
            `[A] ${p.nf}: oc do Bastão (${p.cod_ultima_ocorrencia}, ${p.data_ultima_ocorrencia}) é ECO ` +
              `de lançamento do Cockpit — PRESERVANDO oc do card (${existing.cod_ultima_ocorrencia}). Porta 4 / NF 306070.`,
          );
        }
      } catch (_e) {
        preservarOcDoCard = false; // falha na checagem → comportamento antigo
      }
    }

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
    if (preservarOcDoCard) {
      delete updatePayload["cod_ultima_ocorrencia"];
    }
    if (forcaAguardandoClienteOc54) {
      // Caio 2026-05-07: prioridade máxima — oc=54 sempre AGUARDANDO_CLIENTE.
      // Sobrescreve podeRecalcular/transferidoVoltouRelacionamento.
      updatePayload["state"] = "AGUARDANDO_CLIENTE";
      updatePayload["lock_aguardando_validacao"] = false;
      updatePayload["aviso_alteracao_oc"] = null;
      console.log(
        `[A] ${p.nf}: oc=54 forçando AGUARDANDO_CLIENTE (state anterior: ${existing.state}, lock=${lockOriginal})`,
      );
    } else if (aguardandoClienteVirouOutraRelacionamento) {
      // Caio 2026-06-24 (NF 175621): oc de relacionamento ≠54 num card
      // AGUARDANDO_CLIENTE → AGUARDANDO VOCÊ (AVH + lock). Operador trata.
      updatePayload["state"] = "AGUARDANDO_VALIDACAO_HUMANA";
      updatePayload["lock_aguardando_validacao"] = true;
      console.log(
        `[A] ${p.nf}: AGUARDANDO_CLIENTE→AGUARDANDO VOCÊ (oc relacionamento ${existing.cod_ultima_ocorrencia}→${p.cod_ultima_ocorrencia})`,
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
        // Caio 2026-06-22: oc voltou pra relacionamento → conflito "saiu_de_escopo"
        // ficou stale. Limpa o flag pra o card não seguir na aba CONFLITOS. (Se o
        // SSW real ainda diverge p/ fora de escopo, a reconciliação deferida deste
        // mesmo sync re-flagga depois — ela roda no 2º passo, após este UPDATE.)
        updatePayload["mudanca_suspeita"] = null;
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

    if (aguardandoClienteVirouOutraRelacionamento) {
      await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: "AguardandoClienteOcMudou",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_anterior: existing.cod_ultima_ocorrencia,
          oc_atual: p.cod_ultima_ocorrencia,
          state_novo: "AGUARDANDO_VALIDACAO_HUMANA",
          motivo:
            "oc de relacionamento ≠54 detectada em AGUARDANDO_CLIENTE — card vai pra AGUARDANDO VOCÊ (Pass A, ramo restaurado 2026-06-24 NF 175621).",
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

    // Observabilidade (Caio 2026-06-30): evento EXPLÍCITO de reabertura quando o card
    // volta de TRANSFERIDO/etc pro relacionamento (candidatoReabertura). ADITIVO — o
    // BastaoCardAtualizado acima segue sendo emitido (compat com eventos existentes).
    // NUNCA quebra o sync (try/catch). `via` distingue identidade (ADR 0011) × per-hora.
    if (transferidoVoltouRelacionamento && stateFinalReentrada) {
      try {
        await supabase.from("card_events").insert({
          card_id: existing.id,
          event_type: "CardReaberto",
          actor_type: "system",
          actor_id: "sync-bastao",
          payload: {
            de_state: existing.state,
            para_state: stateFinalReentrada.state,
            lock: stateFinalReentrada.lock,
            oc: p.cod_ultima_ocorrencia,
            via: (await reaberturaPorIdentidadeAtivo(supabase)) ? "identidade_ssw" : "per_hora",
            motivo:
              "Card voltou de TRANSFERIDO/etc pro relacionamento (candidatoReabertura) — visível ao operador.",
          },
        });
      } catch (_e) {
        // observabilidade NUNCA quebra o caminho real
      }
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
    // Caio 2026-06-24 (NF 175621): AGUARDANDO_CLIENTE→AGUARDANDO VOCÊ por oc de
    // relacionamento ≠54. effState carrega AVH+lock pra a reconciliação deferida
    // (2º passo) propor as ações da nova oc no state certo.
    if (aguardandoClienteVirouOutraRelacionamento) {
      effState = "AGUARDANDO_VALIDACAO_HUMANA";
      effLock = true;
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

  // Guard anti-loop INV-040 (NF 2084, 14-15/07: 74 cards fabricados em rajada):
  // ≥3 cards terminais da NF criados em 24h = loop criação→terminal→recriação
  // (o uniq_cards_nf_active parcial não segura card que nasce/vira terminal).
  // Não cria; evento LoopCriacaoCardDetectado fica no card mais recente.
  if (await bloquearCriacaoSeLoopDetectado(supabase, { nf: p.nf, origem: "bastao", ctrc: p.ctrc ?? null })) {
    return "unchanged";
  }

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

  // Caio 2026-06-22: scan de e-mail pré-existente no nascimento (best-effort,
  // gated por flag). Só enfileira (pgmq O(1)) — a busca Gmail roda no edge
  // scan-email-pre-card via cron, fora do deadline do sync. Nunca lança.
  await enfileirarScanEmailPreCard(supabase, {
    card_id: insertedCard.id as string,
    nf: p.nf,
    cnpj_pagador: p.cnpj_pagador ?? null,
    assigned_operator_id: atribuicao.assigned_operator_id ?? null,
    origem: "bastao",
  });

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
  // Caio 2026-06-19 (escala Pass B sem timeout — síntese do workflow): caminho
  // WATERMARK+BULK atrás de feature flag. Flag OFF = caminho legado abaixo
  // (idêntico, byNf por card). Flag ON = trabalho O(LIMIT) por ciclo via
  // pass_b_checked_at + LIMIT 150 + fetchPendenciasByNfs em lote, independente do
  // nº de cards ativos. Rollback instantâneo desligando a flag.
  const { data: flagWm } = await supabase
    .from("feature_flags").select("enabled").eq("key", "pass_b_watermark_enabled").maybeSingle();
  if ((flagWm as { enabled?: boolean } | null)?.enabled === true) {
    return await runPassBWatermark(supabase, bastao, excecoesOc13, errors, pulledNfs);
  }

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
    .select("id, nf, ctrc, cod_ultima_ocorrencia, state, lock_aguardando_validacao, mudanca_suspeita, agent_state, acao_executada_em, responsavel_relacionamento")
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
          // Caio 2026-06-22 (invariante "não sai sozinho"): card em escopo
          // protegido (AGUARDANDO VOCÊ / AGUARDANDO CLIENTE) não é solto auto.
          const protegido = cardEmEscopoProtegido((card as Record<string, unknown>)["state"] as string);
          if (OCORRENCIAS_FINALIZADORAS.has(r.oc)) {
            if (protegido) {
              // Finalizadora em card protegido NÃO auto-resolve (invariante
              // 22/06), mas FLAGGA pra CONFLITOS (Caio 2026-08-24, NF 1611059):
              // o só-console.log deixava o card entregue ZUMBI invisível — o
              // operador nunca "descobre via histórico" um card quieto. Flag é
              // idempotente; finalizadora nunca é lançada pelo Cockpit → o
              // guard INV-014 do flag não barra.
              await flagConflitoOcSemMover(supabase, {
                cardId: card.id as string,
                deState: (card as Record<string, unknown>)["state"] as string,
                deOc: card.cod_ultima_ocorrencia as number | null,
                paraOc: r.oc,
                origemPass: "B_notfound",
                mudancaAtual: (card as Record<string, unknown>)["mudanca_suspeita"] as MudancaSuspeitaJson | null,
              });
              console.log(`[B] card ${card.id} protegido — finalizadora oc=${r.oc} via SSW: flaggado pra CONFLITOS (não auto-resolve; operador força).`);
            } else {
              await fecharCardComoResolvidoFimDePendencia(
                supabase,
                card.id as string,
                card.cod_ultima_ocorrencia as number | null,
                r.oc,
              );
              released++;
            }
          } else if (!OCORRENCIAS_DE_RELACIONAMENTO.has(r.oc)) {
            // SSW retornou oc fora de relacionamento e não-finalizadora
            // (ex: 14 = Operação, 44 = Devolução). NF saiu do Bastão.
            if (protegido) {
              // Não transfere — flagga pra aba CONFLITOS e mantém onde está.
              await flagConflitoOcSemMover(supabase, {
                cardId: card.id as string,
                deState: (card as Record<string, unknown>)["state"] as string,
                deOc: card.cod_ultima_ocorrencia as number | null,
                paraOc: r.oc,
                origemPass: "B_notfound",
                mudancaAtual: (card as Record<string, unknown>)["mudanca_suspeita"] as MudancaSuspeitaJson | null,
              });
            } else {
              await releaseCardViaTracking(
                supabase,
                card.id as string,
                card.cod_ultima_ocorrencia as number | null,
                r.oc,
              );
              released++;
            }
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

    // Caio 2026-06-22 (invariante "não sai sozinho"): card em escopo protegido
    // (AGUARDANDO VOCÊ / AGUARDANDO CLIENTE) NÃO é solto automaticamente —
    // flagga pra aba CONFLITOS e mantém onde está até o operador FORÇAR. Cobre
    // AGUARDANDO_CLIENTE (lock=false), que o guard de lock abaixo não pegava.
    if (cardEmEscopoProtegido((card as Record<string, unknown>)["state"] as string)) {
      if (newCod != null) {
        await flagConflitoOcSemMover(supabase, {
          cardId: card.id as string,
          deState: (card as Record<string, unknown>)["state"] as string,
          deOc: card.cod_ultima_ocorrencia as number | null,
          paraOc: newCod,
          origemPass: "B_found",
          mudancaAtual: (card as Record<string, unknown>)["mudanca_suspeita"] as MudancaSuspeitaJson | null,
          // Guard CT-e: oc vinda de um CT-e diferente (ex.: CT-e de devolução da
          // mesma NF) NÃO é conflito deste card. Ver NF 919069.
          cardCtrc: (card as Record<string, unknown>)["ctrc"] as string | null,
          pendenciaCtrc: current.ctrc,
        });
      }
      continue; // protegido nunca é solto pelo Pass B (mesmo se newCod null)
    }

    // Lock: card que o agente puxou pra validação humana não pode sair daqui
    // automaticamente. Mesmo que a oc no Bastão tenha mudado, esperamos o
    // operador clicar Aprovar ou Rejeitar pra destravar. (Defesa em profundidade
    // — o guard de escopo protegido acima já cobre AGUARDANDO_VALIDACAO_HUMANA.)
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

// =============================================================================
// PASS B — variante WATERMARK+BULK (atrás da flag pass_b_watermark_enabled).
// Escala sem timeout: trabalho O(LIMIT) por ciclo, independente do nº de cards.
//
// A DECISÃO DE RELEASE é IDÊNTICA ao Pass B legado (mesmos helpers, mesmos
// guards: oc=54 nunca sai [INV-006], lock AVH não solta, ACAO_EXECUTADA/
// EXTRAVIO excluídos [INV-007], release exige confirmação POSITIVA). O que muda:
//   (1) SELECT bounded por watermark `pass_b_checked_at` + LIMIT 150, NULLS FIRST
//       → no máximo 150 cards/ciclo, os de checagem mais antiga primeiro;
//   (2) lookup no Bastão em LOTE (fetchPendenciasByNfs) → corta o N+1;
//   (3) só os que SUMIRAM do lote (minoria) pagam o SSW interno (~2s), sob o
//       deadline global; (4) CIRCUIT-BREAKER: lote não-vazio que volta 0 do
//       Bastão (RPA caído) NÃO vira "todos sumiram" → aborta release do ciclo.
// =============================================================================
async function runPassBWatermark(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  excecoesOc13: ReadonlySet<string>,
  errors: SyncSummary["errors"],
  pulledNfs: Set<string>,
): Promise<PassBSummary> {
  const PASS_B_LIMIT = 150;
  // Cooldown = teto de re-inspeção do faxineiro. Curto demais → mais lookups;
  // longo demais → card que saiu do escopo demora a ser solto. 1h é o equilíbrio
  // pro volume atual (~600 ativos → ~50 checagens/ciclo, bem abaixo do LIMIT 150).
  // Tunável; revisar com o Caio se o volume crescer muito. (synthesis sugeria 6h.)
  const COOLDOWN_HORAS = 1;
  const cutoffIso = new Date(Date.now() - COOLDOWN_HORAS * 60 * 60 * 1000).toISOString();

  // ETAPA 1 — SELECT bounded por watermark (usa o índice parcial idx_cards_passb_due).
  const { data: cards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, ctrc, cod_ultima_ocorrencia, state, lock_aguardando_validacao, mudanca_suspeita, agent_state, acao_executada_em, responsavel_relacionamento")
    .not("state", "in", "(RESOLVIDO,CANCELADO,TRANSFERIDO,TRATATIVA_PENDENTE,ACAO_EXECUTADA,EXTRAVIO_MONITORADO)")
    .not("bastao_pendencia_id", "is", null)
    .not("nf", "is", null)
    .or(`pass_b_checked_at.is.null,pass_b_checked_at.lt.${cutoffIso}`)
    .order("pass_b_checked_at", { ascending: true, nullsFirst: true })
    .limit(PASS_B_LIMIT);
  if (selErr) {
    errors.push({ pass: "B", ref: "select_watermark", message: selErr.message });
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }
  const lista = (cards ?? []) as Array<Record<string, unknown>>;
  if (lista.length === 0) return { checked: 0, released: 0, not_found_in_bastao: 0 };

  // ETAPA 2 — skip cards in-pull (Pass A já tratou = ainda em escopo) + coleta os
  // que precisam de lookup no Bastão. `checados` = ids com DECISÃO CONCLUSIVA neste
  // ciclo (recebem pass_b_checked_at=now() no fim). Quem não decidir reentra depois.
  const checados: string[] = [];
  const precisamLookup: Array<Record<string, unknown>> = [];
  for (const card of lista) {
    const st = card["state"] as string;
    if (st === "ACAO_EXECUTADA" || st === "EXTRAVIO_MONITORADO") continue; // defesa (SELECT já exclui)
    const nf = normalizeNf(card["nf"] as string) ?? (card["nf"] as string);
    if (pulledNfs.has(nf)) { checados.push(card["id"] as string); continue; }
    precisamLookup.push(card);
  }

  let released = 0;
  let notFound = 0;

  // ETAPA 3a — LOOKUP EM LOTE no Bastão (1 chamada chunked em vez de N).
  const nfsLookup = precisamLookup.map((c) => normalizeNf(c["nf"] as string) ?? (c["nf"] as string));
  const porNf = new Map<string, BastaoPendencia>();
  let bulkOk = true;
  if (nfsLookup.length > 0) {
    try {
      const rows = await bastao.fetchPendenciasByNfs(nfsLookup);
      for (const r of rows) { const k = normalizeNf(r.nf ?? ""); if (k) porNf.set(k, r); }
      // CIRCUIT-BREAKER: lote claramente não-vazio que volta 0 rows = suspeita de
      // Bastão/RPA fora do ar. NÃO tratar como "todos sumiram" (evita soltar a
      // frota pra TRANSFERIDO — o bug histórico). Aborta a etapa de release.
      if (rows.length === 0 && nfsLookup.length >= 5) {
        bulkOk = false;
        console.warn(`[B-watermark] circuit-breaker: ${nfsLookup.length} NFs no lote, 0 rows do Bastão — release abortado neste ciclo.`);
        errors.push({ pass: "B", ref: "circuit_breaker", message: `lote ${nfsLookup.length} NFs → 0 rows do Bastão` });
      }
    } catch (e) {
      bulkOk = false;
      errors.push({ pass: "B", ref: "fetchPendenciasByNfs", message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ETAPA 3b — DIFF + decisão por card (regra IDÊNTICA ao legado).
  if (bulkOk) {
    for (const card of precisamLookup) {
      if (syncDeadlineExcedido()) break; // deadline global — resto reentra no próximo ciclo
      const cardId = card["id"] as string;
      const nf = normalizeNf(card["nf"] as string) ?? (card["nf"] as string);
      const current = porNf.get(nf) ?? null;

      if (current) {
        // ACHADO no Bastão — mesma lógica do legado (oc=54 nunca sai, ainda
        // relacionamento → não mexe, lock → não solta, senão releaseCard).
        const newCod = current.cod_ultima_ocorrencia;
        if (newCod === 54) { checados.push(cardId); continue; }
        const cnpj = (card["agent_state"] as Record<string, unknown> | null | undefined)?.["cnpj_pagador"] as string | undefined;
        const stillInScope = isOcorrenciaDeRelacionamentoCtx(newCod, { cnpjPagador: cnpj, excecoesOc13 });
        if (stillInScope) { checados.push(cardId); continue; }
        // Caio 2026-06-22 (invariante "não sai sozinho"): escopo protegido
        // (AGUARDANDO VOCÊ / AGUARDANDO CLIENTE) → flagga + mantém. Cobre
        // AGUARDANDO_CLIENTE (lock=false), que o guard de lock abaixo não pega.
        if (cardEmEscopoProtegido(card["state"] as string)) {
          if (newCod != null) {
            await flagConflitoOcSemMover(supabase, {
              cardId,
              deState: card["state"] as string,
              deOc: card["cod_ultima_ocorrencia"] as number | null,
              paraOc: newCod,
              origemPass: "B_found",
              mudancaAtual: card["mudanca_suspeita"] as MudancaSuspeitaJson | null,
              // Guard CT-e: oc vinda de um CT-e diferente (ex.: CT-e de devolução da
              // mesma NF) NÃO é conflito deste card. Ver NF 919069.
              cardCtrc: card["ctrc"] as string | null,
              pendenciaCtrc: current.ctrc,
            });
          }
          checados.push(cardId); // protegido nunca é solto pelo Pass B (mesmo se newCod null)
          continue;
        }
        if (card["lock_aguardando_validacao"] === true) { checados.push(cardId); continue; }
        try {
          await releaseCard(supabase, cardId, card["cod_ultima_ocorrencia"] as number | null, current);
          released++;
          checados.push(cardId);
        } catch (e) {
          errors.push({ pass: "B", ref: cardId, message: e instanceof Error ? e.message : String(e) });
        }
      } else {
        // SUMIU do Bastão — confirma via SSW interno (regra IDÊNTICA ao legado).
        // CRÍTICO: só marca como checado se a confirmação foi CONCLUSIVA (r.sucesso);
        // SSW falho (instável) NÃO marca → re-tenta no próximo ciclo (não some 6h).
        notFound++;
        try {
          const ctrcEsperado = (card["ctrc"] as string | null | undefined) ?? null;
          const respPassB = (card["responsavel_relacionamento"] as string | null | undefined) ?? null;
          const r = await descobrirUltimaOcSsw(nf, ctrcEsperado, undefined, respPassB);
          if (r.sucesso) {
            // Caio 2026-06-22 (invariante "não sai sozinho"): escopo protegido
            // (AGUARDANDO VOCÊ / AGUARDANDO CLIENTE) não é solto automaticamente.
            const protegido = cardEmEscopoProtegido(card["state"] as string);
            if (OCORRENCIAS_FINALIZADORAS.has(r.oc)) {
              if (protegido) {
                // Finalizadora em card protegido: NÃO auto-resolve (invariante
                // 22/06), mas FLAGGA pra CONFLITOS (Caio 2026-08-24, NF 1611059)
                // — só console.log deixava o card entregue zumbi invisível.
                await flagConflitoOcSemMover(supabase, {
                  cardId,
                  deState: card["state"] as string,
                  deOc: card["cod_ultima_ocorrencia"] as number | null,
                  paraOc: r.oc,
                  origemPass: "B_notfound",
                  mudancaAtual: card["mudanca_suspeita"] as MudancaSuspeitaJson | null,
                });
                console.log(`[B-watermark] card ${cardId} protegido — finalizadora oc=${r.oc}: flaggado pra CONFLITOS (não auto-resolve; operador força).`);
              } else {
                await fecharCardComoResolvidoFimDePendencia(supabase, cardId, card["cod_ultima_ocorrencia"] as number | null, r.oc);
                released++;
              }
            } else if (!OCORRENCIAS_DE_RELACIONAMENTO.has(r.oc)) {
              if (protegido) {
                await flagConflitoOcSemMover(supabase, {
                  cardId,
                  deState: card["state"] as string,
                  deOc: card["cod_ultima_ocorrencia"] as number | null,
                  paraOc: r.oc,
                  origemPass: "B_notfound",
                  mudancaAtual: card["mudanca_suspeita"] as MudancaSuspeitaJson | null,
                });
              } else {
                await releaseCardViaTracking(supabase, cardId, card["cod_ultima_ocorrencia"] as number | null, r.oc);
                released++;
              }
            }
            // oc continua de relacionamento (Bastão tirou mas SSW mantém): não decide,
            // mas a confirmação foi conclusiva → marca checado.
            checados.push(cardId);
          }
          // r.sucesso === false → conservador: NÃO move e NÃO marca (re-tenta).
        } catch (e) {
          errors.push({ pass: "B", ref: `nf=${nf}/ssw_interno`, message: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  // ETAPA 4 — carimba o watermark SÓ nos conclusivamente checados (UPDATE batch).
  if (checados.length > 0) {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < checados.length; i += 200) {
      const slice = checados.slice(i, i + 200);
      await supabase.from("cards").update({ pass_b_checked_at: nowIso }).in("id", slice)
        .then(() => {}, (e: unknown) => errors.push({ pass: "B", ref: "update_watermark", message: e instanceof Error ? e.message : String(e) }));
    }
  }

  return { checked: lista.length, released, not_found_in_bastao: notFound };
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

  // Caio 2026-06-20 (leveza/escala): lookup em LOTE no Bastão — 1 chamada em vez
  // de 1 fetchPendenciaByNf por todo (N+1 que estourava o Pass C ao drenar
  // backlog). Coleta as NFs dos todos executando, consulta de uma vez, e o loop
  // lê do Map. "Não achou" segue benigno (stillWaiting → re-tenta).
  const nfsC = (todos as Array<Record<string, unknown>>)
    .map((t) => { const cr = t["cards"]; const ref = Array.isArray(cr) ? cr[0] : cr; return (ref as { nf?: string | null } | null)?.nf ?? null; })
    .filter((n): n is string => !!n)
    .map((n) => normalizeNf(n) ?? n);
  const porNfC = new Map<string, BastaoPendencia>();
  if (nfsC.length > 0) {
    try {
      const rows = await bastao.fetchPendenciasByNfs(nfsC);
      for (const r of rows) { const k = normalizeNf(r.nf ?? ""); if (k) porNfC.set(k, r); }
    } catch (e) {
      errors.push({ pass: "C", ref: "fetchPendenciasByNfs", message: e instanceof Error ? e.message : String(e) });
    }
  }

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

      const current = porNfC.get(normalizeNf(nf) ?? nf) ?? null;
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
    banner_ia_preservado: 0,
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

  // Caio 2026-06-20 (leveza/escala): lookup em LOTE no Bastão — 1 chamada em vez
  // de 1 fetchPendenciaByNf por card. Match por NF (chave estável; o
  // bastao_pendencia_id pode estar obsoleto quando o Bastão regenera UUID).
  const nfsD = cards.map((c) => c.nf).filter((n): n is string => !!n).map((n) => normalizeNf(n) ?? n);
  const porNfD = new Map<string, BastaoPendencia>();
  if (nfsD.length > 0) {
    try {
      const rows = await bastao.fetchPendenciasByNfs(nfsD);
      for (const r of rows) { const k = normalizeNf(r.nf ?? ""); if (k) porNfD.set(k, r); }
    } catch (e) { errors.push({ pass: "D", ref: "fetchPendenciasByNfs", message: e instanceof Error ? e.message : String(e) }); }
  }
  for (const card of cards) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto
    try {
      if (!card.nf) continue;
      const p = porNfD.get(normalizeNf(card.nf) ?? card.nf) ?? null;
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

      // Caio 2026-06-29 (NF 705764, oc=49→54 extravio): NÃO destruir a recomendação
      // do agente (banner `ia_sugestao_ocs_padrao`) quando a oc do Bastão é
      // PROVADAMENTE anterior (por DATA) a um lançamento do Cockpit. Aqui a oc do
      // card (49/54) foi lançada PELO Cockpit e o Bastão ainda mostra a oc anterior
      // de extravio (6/9/16) de uma data ANTES do lançamento, só por atraso do RPA.
      // Sobrescrever com o aviso pelado {oc_atual} APAGAVA o banner "54 + e-mail de
      // extravio (pedir romaneio)" (proposta_destacada_acao) → a operadora ficava sem
      // recomendação e lançava 54 SEM e-mail (cliente não notificado). Família
      // INV-019/INV-023 (verdade do Cockpit > lag do Bastão).
      //
      // Caio 2026-06-29 (refino): MESMO DIA por data NÃO é lag confirmado — com 6000+
      // entregas/dia mesmo-dia é a NORMA e pode esconder uma oc genuinamente nova
      // (lição INV-023) → cai no overwrite normal (Pass D sinaliza a divergência).
      // Preserva SÓ em `classe === 'lag'` (estritamente anterior). Pass D é sweep
      // barato sobre todos os cards lockados e não faz SSW por design; o desempate
      // por hora não compensa no hot path pro caso raro de banner-mesmo-dia.
      const avisoTipo = (avisoExistente?.["tipo"] as string | undefined) ?? null;
      if (avisoTipo === "ia_sugestao_ocs_padrao") {
        const lancDateBrt = await ultimaDataLancamentoCockpitBrt(supabase, card.id);
        const classeBanner = classificarPorData(
          (p.data_ultima_ocorrencia as string | null) ?? null,
          lancDateBrt,
        );
        if (passDDevePreservarBannerIaSugestao(avisoTipo, classeBanner)) {
          summary.banner_ia_preservado++;
          continue;
        }
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
// PASS E — DESATIVADO (Caio 2026-06-22). Antes confrontava AGUARDANDO_CLIENTE
// com Bastão+SSW a cada 8h e MOVIA o card automaticamente — proibido pela
// invariante "card em escopo protegido nunca sai sozinho". AGUARDANDO_CLIENTE
// (oc=54) agora é coberto pelo Pass B (detect+flag pra aba CONFLITOS). Função
// mantida como NO-OP só pra não mexer na orquestração (ver corpo). Detalhe em
// docs e no helper _shared/escopo-relacionamento.ts.
// =============================================================================

async function runPassE(
  _supabase: SupabaseClient,
  _bastao: BastaoClient,
  _ocsBloqueadasTracking: OcsBloqueadasTracking,
  _errors: SyncSummary["errors"],
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

  // =========================================================================
  // DESATIVADO — Caio 2026-06-22 (invariante "card em escopo protegido nunca
  // sai sozinho"). Pass E confrontava AGUARDANDO_CLIENTE com Bastão+SSW a cada
  // 8h e MOVIA o card automaticamente (TRANSFERIDO/RESOLVIDO/AVH) sem aprovação
  // do operador — exatamente o que a invariante proíbe. Agora AGUARDANDO_CLIENTE
  // (oc=54) é coberto pelo Pass B: quando a oc real sai de escopo, ele FLAGGA
  // (mudanca_suspeita "saiu_de_escopo") e o card aparece na aba ⚠️ CONFLITOS até
  // o operador clicar FORÇAR ATUALIZAÇÃO.
  //
  // NO-OP: função e chamada (orquestração ~linha 313) + summary mantidos pra não
  // mexer no resto. O corpo antigo (gate de cadência mig 220 + loop SSW +
  // decidir/aplicarTransicaoAguardandoCliente) foi removido — git history
  // preserva. transicao-aguardando-cliente.ts fica como dead code documentado.
  // =========================================================================
  console.log("[E] desativado — AGUARDANDO_CLIENTE protegido via Pass B (invariante 2026-06-22).");
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

  // Caio 2026-06-20 (leveza/escala): lookup em LOTE no Bastão (1 chamada vs N).
  const nfsG = lista.map((c) => normalizeNf(c.nf as string) ?? (c.nf as string)).filter((n): n is string => !!n);
  const porNfG = new Map<string, BastaoPendencia>();
  if (nfsG.length > 0) {
    try {
      const rows = await bastao.fetchPendenciasByNfs(nfsG);
      for (const r of rows) { const k = normalizeNf(r.nf ?? ""); if (k) porNfG.set(k, r); }
    } catch (e) { errors.push({ pass: "G", ref: "fetchPendenciasByNfs", message: e instanceof Error ? e.message : String(e) }); }
  }
  for (const card of lista) {
    if (syncDeadlineExcedido()) break; // deadline global — defere o resto
    try {
      const nf = normalizeNf(card.nf as string) ?? (card.nf as string);
      const pend = porNfG.get(nf) ?? null;
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
    if (typeof codProposto !== "number" || codProposto !== ocAtualNoBastao) return false;
    // Auditoria 25/07: proposta do fluxo pós-resposta mira a MESMA oc POR
    // CONSTRUÇÃO (relançar = renotificar) — o Bastão mostrar essa oc não é
    // "lançada por fora", é a precondição da proposta. Cancelar aqui comia
    // 100% dos relançamentos (83 em 48h; NF 158084 ficou sem opções logo
    // após a resposta do cliente).
    if (ehPropostaPosRespostaMesmaOc(payload)) return false;
    return true;
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
