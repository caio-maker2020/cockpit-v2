// =============================================================================
// executor — consome pgmq.agent_executor, chama SSW pra lançar ocorrência,
// grava audit_log + card_event AcaoExecutada, marca todo.status='executando'.
//
// Gate de operadores: `operadores.cockpit_ativo` (aplicado upstream em
// resolveOperadorDoCard). Operador sem flag não recebe cards atribuídos
// nem do Bastão Pass A nem do vinculador, então jobs aqui sempre são de
// operadores autorizados. Caio 2026-05-15: TEST_FILTER (env
// EXECUTOR_TEST_OPERATORS) removido pq virou redundante + bloqueava o
// onboarding do Duilio (NF 20352 travada em EXECUTANDO_ACAO).
//
// Idempotency: lib/ssw-client deriva chave SHA256(card_id, codigo, nf).
// audit_log.idempotency_key é UNIQUE — mesmo se executor for chamado 2x
// (network retry, cron race), apenas 1 INSERT vence; outros falham com
// duplicate key e a gente reusa o resultado.
//
// Fluxo:
//   1. Lê msg da fila com vt=180s (ações SSW podem demorar)
//   2. Pega card + agent_state (pra pegar cnpj_remetente quando não vem no payload)
//   3. Chama lib/ssw-client.lancarOcorrencia()
//   4. Grava audit_log (success/failed)
//   5. Grava card_event AcaoExecutada
//   6. UPDATE todo.status='executando' — Pass C do sync-bastao confirma depois
//   7. Confirma processamento (delete_from_pgmq)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { lancarSswPortal } from "../_shared/lancar-ssw-portal.ts";
import { avaliarGuardOc54SemEmail } from "../_shared/guard-oc54-sem-email.ts";
import { sendGmailMessage, loadOperadorGmailCreds, refreshGmailAccessToken } from "../_shared/gmail-sender.ts";
import { garantirLabelCockpitTracked, aplicarLabelEmThread } from "../_shared/gmail-reader.ts";
import { carregarAnexosParaEnvio as carregarAnexos, finalizarAnexosPosEnvio } from "../_shared/anexos-storage.ts";
import {
  verificarEmailJaEnviado,
  registrarEmailSkipReenvio,
  sufixoRejeicaoEmailJaEnviado,
  type EmailJaEnviado,
} from "../_shared/email-idempotencia.ts";
// Caio 2026-06-22 (NF 376924): buscarNFInterno/lancarOcorrenciaPortal/obterSessao/
// readSswLancamentoEnv saíram daqui — todos os lançamentos do executor agora
// passam pelo envelope lancarSswPortal (que encapsula sessão + busca + tripé +
// idempotência). Só o tipo AnexoBytes permanece (assinatura do adapter).
import { type AnexoBytes } from "../_shared/ssw-internal-client.ts";
import { montarDescricaoSsw, camposObrigatoriosAusentes } from "../_shared/descricao-ssw.ts";
import {
  obterSessao as obterSessaoSswInterno,
  readSswLancamentoEnv,
  resolverNumeroRemessaViaDanfe,
} from "../_shared/ssw-internal-client.ts";
import {
  buscarFotosRomaneioPorNf,
  buscarFotosRomaneioPorTermo,
  obterSessao as obterSessaoRomaneio,
  readRomaneioEnv,
} from "../_shared/romaneio-interno-client.ts";
import {
  gerarJpegDescricaoValor,
  gerarJpegErroPlataforma,
  gerarJpegRemessaNaoExtraida,
  gerarJpegRomaneioNaoEncontrado,
} from "../_shared/jpeg-sintetico.ts";
import { acharAnexoDoDossie } from "../_shared/reuso-anexo.ts";
import { deveBloquear54PedirDescValor } from "../_shared/ressarcimento-relancar-54.ts";
import { confirmarAcaoExecutadaViaSsw } from "../_shared/confirmar-acao-executada-ssw.ts";
import {
  decidirAcaoRomaneioCompletude,
  decidirGateOc33,
  deveMaterializarCompletude,
  dossieVazio,
  ehImagemMimeSsw,
  LIMITE_TEXTO_SSW,
  lerExtravioParcial,
  marcarDossie,
  montarTextoDescricaoValor,
  montarTextoOc33ComOperador,
  prepararTextoOc33,
  type DossieExtravioParcial,
} from "../_shared/extravio-parcial-dossie.ts";
import { anexosCobremRomaneio } from "../_shared/romaneio-cobertura.ts";
import { carregarThreadDaTratativaAtual } from "../_shared/email-threading.ts";
import { novaExpiracaoTokenEvidencia } from "../_shared/token-evidencia.ts";
import { registrarContatoLogisticoSeNovo } from "../_shared/registrar-contato-cliente.ts";
import { registrarFeedbackImplicitoAgentes } from "../_shared/feedback-implicito-agentes.ts";
// Caio 2026-06-08: import de validarChaveCteCorrespondeCtrcDoCard removido.
// Guard substituído pelo tripé portal (validarTripeCtrcNfPagador), aplicado
// dentro do envelope lancarSswPortal.

// Caio 2026-05-13 (Fase 2 plano "hoje-usamos-o-bastao"): após lançamento
// SSW com sucesso, tenta confirmar imediatamente via SSW interno pra liberar
// card de ACAO_EXECUTADA on-time. Best-effort: erros não bloqueiam o executor
// (delete_from_pgmq já vai rodar). Pass H do sync-bastao pega depois se
// scrape falhar agora.
async function tentarConfirmarPosLancamento(
  supabase: any, // SupabaseClient — declarado any pra evitar import circular de tipos
  cardId: string,
  ctx: string,
): Promise<void> {
  try {
    const r = await confirmarAcaoExecutadaViaSsw(supabase, cardId, { origem: "executor_inline" });
    if (r.confirmado) {
      console.log(
        `[executor:${ctx}] card ${cardId} confirmado via SSW interno (oc=${r.oc_ssw} cenario=${r.cenario}) → ${r.state_novo}${r.lock_novo ? " lock" : ""}`,
      );
    } else {
      console.log(
        `[executor:${ctx}] confirmação inline SSW indisponível (${r.motivo}). Pass H assume.`,
      );
    }
  } catch (e) {
    console.error(`[executor:${ctx}] confirmar-acao-executada-ssw fatal:`, e);
  }
}

const VT_SECONDS = 180;
const BATCH_SIZE = 3;
const MAX_ATTEMPTS = 3;

/**
 * Erros determinísticos (não-retryable): retentar não vai resolver. Reverte
 * imediato na 1ª tentativa pra Larissa ver problema em ~1min em vez de 7min.
 * Erros transientes (timeout SSW, 5xx, network) NÃO entram aqui — esses
 * seguem o retry padrão de 3 tentativas.
 */
const DETERMINISTIC_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /chave_cte n[ãa]o dispon[íi]vel/i,
  /chave fiscal cadastrada/i,  // RPC aprovar bloqueando sem chave
  /codigo_ssw .* n[ãa]o fornecido/i,
  /Sem mapeamento de-para pra codigo_ssw/i,
  /Destino faltando: destino=null/i,
  /Operadora .* n[ãa]o encontrada/i,
  /sem gmail_oauth_credentials/i,
  /Gmail OAuth refresh falhou/i,
  /Evidencia ausente pra oc=/i,  // Caio 2026-05-06: SSW sem foto na oc atual
  /card\.ctrc vazio pra card/i,    // Caio 2026-06-09: guard tripé exige ctrc
  /nf n[ãa]o dispon[íi]vel pro todo/i,
  // Caio 2026-06-09 (NF 2163170): erros de programação (ReferenceError,
  // TypeError, undefined, etc.) são bugs de código — retry NÃO resolve.
  // Reverte imediato pra Larissa ver motivo e nós corrigirmos o bug, em vez
  // de duplicar efeitos colaterais (email enviado 2x no caso NF 2163170).
  /Cannot read propert(y|ies) of (undefined|null)/i,
  /is not defined/i,
  /is not a function/i,
  /Cannot access .* before initialization/i,
];

function isDeterministicError(msg: string): boolean {
  return DETERMINISTIC_ERROR_PATTERNS.some((re) => re.test(msg));
}

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    todo_id: string;
    card_id: string;
    action_id: string;
    proposta_payload: {
      tool: string;
      args: {
        // codigo_ssw é o que o operador conhece (= aparece no painel SSW).
        // Executor traduz pra codigo_api via lookup_codigo_api antes de chamar SSW.
        codigo_ssw?: number | string;
        // Compat retro: payloads antigos podem ter "codigo" — tratado como codigo_ssw.
        codigo?: number | string;
        chave_cte?: string;
        nf?: string;
        cnpj_remetente?: string | null;
        descricao?: string;
      };
      rationale?: string;
      texto?: string | null;
      meta?: Record<string, unknown>;
    };
    aprovado_por: string;
    card_nf?: string;
    card_ctrc?: string;
  };
}

interface RunSummary {
  read: number;
  executed: number;
  filtered_out: number;
  failed: number;
  archived: number;
  errors: Array<{ msg_id: number | null; todo_id?: string; message: string }>;
  duration_ms: number;
}

// ─── Observabilidade estruturada (Caio 2026-06-29, INV-031) ──────────────────
// Rastreia o ciclo de vida de CADA mensagem do executor por msg_id/todo_id/
// card_id/read_ct/tool. Objetivo: confirmar o gatilho de "mensagem lida mas
// nunca concluída" (card preso em EXECUTANDO_ACAO — NF 296312). Um msg_id que
// aparece em `mensagem_lida` mas nunca em `processamento_concluido`/`falhou_*`
// = mensagem perdida (a função morreu no meio). Eventos:
//   mensagem_lida · processamento_iniciado · processamento_concluido ·
//   processamento_falhou_retry · processamento_falhou_final ·
//   mensagem_deletada · mensagem_arquivada_dlq
function logExecutor(evento: string, dados: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ src: "executor", evento, ts: new Date().toISOString(), ...dados }));
  } catch { /* log nunca derruba o executor */ }
}

function ctxLogJob(job: QueueMessage): Record<string, unknown> {
  return {
    msg_id: job.msg_id,
    todo_id: job.message?.todo_id,
    card_id: job.message?.card_id,
    read_ct: job.read_ct,
    tool: job.message?.proposta_payload?.tool,
  };
}

// Wrapper p/ `delete_from_pgmq` que loga `mensagem_deletada` (usado em todos os
// caminhos terminais do executor via replace). Usa `queue_name: q` (variável)
// de propósito, pra o próprio wrapper NÃO casar com o replace_all dos call-sites.
async function deletarMsgExecutor(supabase: SupabaseClient, job: QueueMessage): Promise<void> {
  // Caio 2026-06-29: loga `mensagem_deletada` SÓ depois de confirmar que o RPC
  // não deu error. Se falhar, loga `mensagem_delete_falhou` (a msg fica na fila
  // e volta no vt — observabilidade não pode mentir "deletada" se não deletou).
  const q = "agent_executor";
  const { error } = await supabase.rpc("delete_from_pgmq", { queue_name: q, msg_id: job.msg_id });
  if (error) {
    logExecutor("mensagem_delete_falhou", { ...ctxLogJob(job), erro: error.message });
  } else {
    logExecutor("mensagem_deletada", ctxLogJob(job));
  }
}

serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Caio 2026-06-08: removido `ssw = createSswClient(...)` (WebAPI cliente).
    // Lançamento agora 100% via portal interno através do envelope
    // `lancarSswPortal` que cuida de sessão + idempotência + guard tripé.

    // Caio 2026-05-15 (onboarding Duilio): TEST_FILTER REMOVIDO.
    // Era um whitelist hardcoded via env EXECUTOR_TEST_OPERATORS (=LARISSA)
    // criada na fase 1 de teste pra impedir executor de lançar oc no SSW
    // pra cards de operadores ainda em onboarding. Substituído por
    // `operadores.cockpit_ativo` — operador sem flag não recebe cards via
    // resolveOperadorDoCard nem do Bastão Pass A nem do vinculador. Gate
    // por flag é mais robusto, por operador, sem env vars hardcoded.
    // Detectado quando Duilio teste NF 20352 foi bloqueado mesmo com tudo
    // configurado.

    const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
      queue_name: "agent_executor",
      vt_seconds: VT_SECONDS,
      qty: BATCH_SIZE,
    });

    if (readErr) throw new Error(`read_from_pgmq: ${readErr.message}`);

    const queue = (msgs ?? []) as QueueMessage[];
    const summary: RunSummary = {
      read: queue.length,
      executed: 0,
      filtered_out: 0,
      failed: 0,
      archived: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const job of queue) {
      logExecutor("mensagem_lida", ctxLogJob(job));
      try {
        await processOne(supabase, env, job, summary);
        logExecutor("processamento_concluido", ctxLogJob(job));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ msg_id: job.msg_id, todo_id: job.message?.todo_id, message: msg });

        // Reverter imediato pra erros determinísticos (não-retryable) — sem
        // esperar 3 tentativas (~7min). Operadora vê problema rápido.
        // Erros transientes (SSW timeout/5xx, network) seguem o retry de 3x.
        const isDeterministic = isDeterministicError(msg);
        const shouldFinalize = isDeterministic || job.read_ct >= MAX_ATTEMPTS;

        if (!shouldFinalize) {
          logExecutor("processamento_falhou_retry", { ...ctxLogJob(job), erro: msg.slice(0, 300) });
        }

        if (shouldFinalize) {
          logExecutor("processamento_falhou_final", { ...ctxLogJob(job), deterministico: isDeterministic, erro: msg.slice(0, 300) });
          const todoId = job.message?.todo_id as string | undefined;
          if (todoId) {
            try {
              await supabase.rpc("reverter_acao_falhou", {
                p_todo_id: todoId,
                p_motivo: isDeterministic
                  ? `Executor erro deterministico: ${msg.slice(0, 400)}`
                  : `Executor falhou ${job.read_ct}x: ${msg.slice(0, 400)}`,
              });
            } catch (revertErr) {
              console.error(`reverter_acao_falhou pre-archive: ${revertErr}`);
            }
          }
          const { error: arqErr } = await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_executor",
            source_msg_id: job.msg_id,
            motivo: `executor: ${msg.slice(0, 200)}${isDeterministic ? " (deterministico — sem retry)" : ` (após ${job.read_ct} tentativas)`}`,
            original_payload: job.message,
          });
          // Caio 2026-06-29: só conta/loga arquivamento se o RPC não deu error.
          if (arqErr) {
            logExecutor("mensagem_arquiva_dlq_falhou", { ...ctxLogJob(job), erro: arqErr.message });
          } else {
            summary.archived++;
            logExecutor("mensagem_arquivada_dlq", { ...ctxLogJob(job), deterministico: isDeterministic });
          }
        }
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("executor done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("executor fatal:", msg);
    return new Response(JSON.stringify({ error: msg, duration_ms: Date.now() - startedAt }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
// Caio 2026-06-08: type SswClient (cliente WebAPI) removido com a migração
// pra portal interno via envelope lancarSswPortal. processOne não recebe
// mais o ssw client — quem precisa lançar usa o envelope diretamente.

async function processOne(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  job: QueueMessage,
  summary: RunSummary,
): Promise<void> {
  const m = job.message;
  logExecutor("processamento_iniciado", ctxLogJob(job));

  // 1. Pega card pra TEST_FILTER + cnpj_remetente fallback + snapshot Bastão
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select(`
      id,
      nf,
      ctrc,
      empresa_cliente,
      assigned_operator_id,
      agent_state,
      cod_ultima_ocorrencia,
      bastao_pendencia_id,
      qtde_volumes,
      analise_padrao_resultado,
      aviso_alteracao_oc,
      operadores!cards_assigned_operator_id_fkey(nome)
    `)
    .eq("id", m.card_id)
    .single();

  if (cardErr) throw new Error(`SELECT card: ${cardErr.message}`);
  if (!card) throw new Error(`Card ${m.card_id} não encontrado`);

  // Caio 2026-05-12 (NF 920161): combo 33+44 NÃO usa WebAPI. Lança AMBAS
  // ocorrências via portal interno (opção 101) — único caminho que aceita
  // upload de N imagens numa só ocorrência. Demais propostas seguem WebAPI.
  if (m.proposta_payload?.tool === "lancar_combo_33_44") {
    await processarComboPortal33_44(supabase, env, m, job, summary, card);
    return;
  }

  // Caio 2026-05-12: oc=33 SOLO via portal interno (mesmo motivo do combo —
  // suporte a N imagens do romaneio). Não encadeia oc=44.
  if (m.proposta_payload?.tool === "lancar_oc33_solo_portal") {
    await processarOc33SoloPortal(supabase, env, m, job, summary, card);
    return;
  }

  // Caio 2026-05-12 (PRATI): email de notificação + lança oc=33 com romaneio
  // baixado de plataforma interna Sal Express (cliente_config). Não encadeia
  // oc=54 (cliente não envia romaneio nesse processo). Se email falhar,
  // registra aviso mas lança oc=33 mesmo assim.
  if (m.proposta_payload?.tool === "enviar_email_e_lancar_33_romaneio_interno") {
    await processarEmailELancar33ViaRomaneio(supabase, env, m, job, summary, card);
    return;
  }

  // Caio 2026-05-20: email texto LIVRE (sem template) + oc=33 via portal.
  // Caso da NF 70080 (oc=49): operador notifica cliente (sem aguardar
  // resposta) e lança oc=33. Diferente da regra PRATI (não busca romaneio
  // interno, anexos do operador). Diferente da `lancar_oc_e_enviar_email`
  // (essa usa template). Diferente da `lancar_oc33_solo_portal` (essa não
  // manda email).
  if (m.proposta_payload?.tool === "enviar_email_livre_e_lancar_oc33_portal") {
    await processarEmailLivreELancarOc33Portal(supabase, env, m, job, summary, card);
    return;
  }

  // 2. TEST_FILTER removido (Caio 2026-05-15) — gate agora é
  // operadores.cockpit_ativo aplicado upstream em resolveOperadorDoCard
  // (sync-bastao Pass A + vinculador). Operador com cockpit_ativo=false
  // não recebe cards atribuídos → nunca chega aqui aprovado.

  // 3. Resolve cnpj_remetente: payload.args primeiro, fallback agent_state
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const cnpjRemetente =
    m.proposta_payload.args.cnpj_remetente ??
    (agentState["cnpj_remetente"] as string | null | undefined) ??
    null;

  // Caio 2026-06-08: removidos chaveCTe (não precisa mais — portal busca via
  // ctrc do card) e lookup_codigo_api (portal usa código semântico direto, sem
  // remap dexpara). Ver plan modular-spinning-frost.md + REGRA CRÍTICA do
  // CLAUDE.md sobre tripé (CTRC, NF, Localização atual).

  const nf = m.proposta_payload.args.nf ?? card.nf ?? null;
  const ctrcCard = (card.ctrc as string | null | undefined) ?? null;

  // Resolve codigo_ssw: prefere args.codigo_ssw; fallback args.codigo (compat retro).
  const codigoSswRaw = m.proposta_payload.args.codigo_ssw ?? m.proposta_payload.args.codigo;
  const codigoSsw =
    typeof codigoSswRaw === "number"
      ? codigoSswRaw
      : codigoSswRaw != null
        ? parseInt(String(codigoSswRaw), 10)
        : NaN;

  // Caio 2026-06-17: skip_oc = ação "só notificar e-mail" (extravios). Envia o
  // e-mail e NÃO lança ocorrência no SSW (não precisa de ctrc/codigo_ssw). Gated
  // por extras.skip_oc=true → zero efeito nas demais propostas.
  const skipOc =
    ((m.proposta_payload.args as Record<string, unknown>)["extras"] as Record<string, unknown> | undefined)
      ?.["skip_oc"] === true;

  if (!nf) {
    throw new Error(`nf não disponível pro todo ${m.todo_id} — necessário pra lançar ocorrência`);
  }
  if (!ctrcCard && !skipOc) {
    throw new Error(
      `card.ctrc vazio pra card ${m.card_id} — guard tripé exige CTRC. Aguarde sync-bastao popular o CTRC ou cadastre manual.`,
    );
  }
  if (!Number.isFinite(codigoSsw) && !skipOc) {
    throw new Error(`codigo_ssw de ocorrência não fornecido no proposta_payload`);
  }

  const baseDescricao =
    m.proposta_payload.args.descricao ?? `Ocorrência ${codigoSsw} lançada via Cockpit`;

  // Extras são informações que a operadora preencheu no momento da aprovação
  // (ex: oc=44 retorno de carga — Larissa informa quantidade_volumes, motivo,
  // filial). Viram texto pro campo Instrução/Complemento do SSW.
  const extras = (m.proposta_payload.args as Record<string, unknown>)["extras"] as
    | Record<string, unknown>
    | undefined;
  // Caio 2026-06-24 (NF 59299): montagem do texto extraída pra
  // _shared/descricao-ssw.ts (montarDescricaoSsw). Whitelist explícita +
  // extras operacionais PRIMEIRO na string — antes a boilerplate base (~61
  // chars) vinha antes e estourava o limite de 70 do campo f6 (a coluna que o
  // setor de Devolução LÊ), truncando "Volumes/Motivo" pra "VOLUM". Detalhe e
  // guard de não-regressão: descricao-ssw.test.ts. (Histórico: whitelist
  // criada em 2026-06-10 / NF 2161614 pra não vazar flags internas.)
  const descricao = montarDescricaoSsw({ baseDescricao, extras });

  // Caio 2026-06-24 (NF 59299): oc=44 (devolução) NÃO pode ser lançada sem
  // quantidade_volumes + motivo — o setor de Devolução não consegue tratar sem
  // isso. O modal do Cockpit é obrigado a coletar, inclusive quando a oc=44 vem
  // como sugestão do agente no banner. Guard de não-regressão caso algum
  // caminho (banner/aprovação direta) tente lançar sem os dados.
  if (!skipOc) {
    const faltando = camposObrigatoriosAusentes(codigoSsw, extras);
    if (faltando.length > 0) {
      throw new Error(
        `oc=${codigoSsw} exige campo(s) obrigatório(s) ausente(s): ${faltando.join(", ")}. ` +
          `A operadora precisa preencher no modal antes de aprovar (NF ${nf}).`,
      );
    }
  }

  // Caio 2026-06-08: `cnpjRemetenteParaSsw` removido — portal não envia
  // cnpj_remetente no submit (era exigência da WebAPI quando chaveCTe não
  // identificava). Portal usa seq_ctrc resolvido via buscarNFInterno.
  // cnpjRemetente segue indo só pro audit_log abaixo.

  // 3.5. ATOMICIDADE EMAIL+OC: se a aprovação inclui envio de email, manda
  // o email PRIMEIRO. Só lança a oc no SSW se o email saiu — porque a oc=54
  // sinaliza "notificamos o cliente, aguardamos retorno". Se o cliente não
  // recebeu o email, a oc=54 seria falsa.
  //
  // A decisão de enviar não depende mais SÓ do `tool` (que pode vir como
  // "lancar_ocorrencia" quando regra criou em modo sem_email por template
  // inativo). Olha pros extras: se tem skip_email=false E destinatários E
  // (texto custom OU template), envia.
  const argsObj = m.proposta_payload.args as Record<string, unknown>;
  const argsExtras = argsObj["extras"] as Record<string, unknown> | undefined;
  // Caio 2026-05-12 (NF 754750): aceita 2 flags equivalentes pra pular envio:
  //   - extras.skip_email = true       (opt-out, semântica antiga)
  //   - extras.enviar_email = false    (opt-in negativo, semântica nova do front
  //     onde o checkbox tem label "ENVIAR EMAIL" — desmarcado vira false).
  // Garante que se o front não converter checkbox-desmarcado em skip_email=true,
  // mandar enviar_email=false já desliga (e vice-versa).
  const skipEmail = argsExtras?.["skip_email"] === true ||
    argsExtras?.["enviar_email"] === false;
  const textoCustomizado = (argsExtras?.["texto_email_customizado"] as string | undefined) ?? null;
  const emailDestinatariosRaw = argsExtras?.["email_destinatarios"];
  const destinatariosArrCheck = Array.isArray(emailDestinatariosRaw)
    ? (emailDestinatariosRaw.filter((s) => typeof s === "string" && s.trim()) as string[])
    : [];
  // Hardening (Codex, Fase 2): trim — "" ou "   " NÃO conta como destinatário
  // válido (senão o guard B-DV e o envio veriam um destinatário em branco).
  const emailDestinoSingularCheck = (argsObj["email_destino"] as string | undefined)?.trim() || undefined;
  const templateIdCheck = argsObj["template_id"] as string | undefined;
  const tool = m.proposta_payload.tool;
  const temDestinatario = destinatariosArrCheck.length > 0 || !!emailDestinoSingularCheck;
  const temConteudo = !!textoCustomizado || !!templateIdCheck;
  // Envia email quando:
  //  - operadora não marcou skip_email
  //  - tem destinatário (selecionado pela operadora ou herdado da regra)
  //  - tem conteúdo (texto manual da operadora ou template configurado)
  //  - E uma das duas condições: tool original era "lancar_oc_e_enviar_email"
  //    (regra criou completa) OU operadora explicitamente forneceu texto/destinatários
  //    (composer manual no Cockpit, mesmo que regra original era "sem_email")
  const operadoraForneceuEmailManual =
    destinatariosArrCheck.length > 0 || !!textoCustomizado;
  const enviarEmail =
    !skipEmail &&
    temDestinatario &&
    temConteudo &&
    (tool === "lancar_oc_e_enviar_email" || operadoraForneceuEmailManual);

  // Blocker autoritativo (Codex, Fase 2 NF 66193): o sub-caso B-DV "54 + e-mail
  // pedindo descrição/valor" NUNCA pode virar "54 sem e-mail". Se não houver
  // destinatário válido (front não honrou meta.precisa_email_destino / cliente
  // sem contato), NÃO lança a oc 54 — reverte pro operador informar o e-mail.
  // Guard no BACKEND (não depende do front). Escopo: só o todo do B-DV.
  const metaBDV = m.proposta_payload.meta as Record<string, unknown> | undefined;
  if (deveBloquear54PedirDescValor(tool, metaBDV?.["origem"] as string | undefined, temDestinatario)) {
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "Destinatário obrigatório para a 54 + e-mail de descrição/valor (extravio parcial): informe o e-mail do cliente antes de aprovar. A oc 54 NÃO foi lançada.",
    });
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc54PedirDescricaoValorSemDestinatario",
      actor_type: "agent",
      actor_id: "executor",
      payload: { tool, todo_id: m.todo_id, motivo: "sem destinatário — 54+email de descrição/valor não pode virar 54 sem e-mail" },
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // ── GUARD B (INV-027 backend, P0 — Caio 2026-07-06, NF 28002): uma ação
  //    "54 + e-mail" NUNCA pode virar "54 sem e-mail" sem confirmação deliberada.
  //    Independe do front (Lovable): o Lovable já resolveu o botão pelo NÚMERO 54
  //    e submeteu o gêmeo "sem email" (garantirGemeosSemEmail) achando que era o
  //    "+email" — cliente não notificado + card em AGUARDANDO_CLIENTE. Este guard
  //    fecha isso no BACKEND. Fail-CLOSED: sem sinal deliberado, não lança.
  //    Escape hatch (deliberado, auditável): `skipEmail` (checkbox "ENVIAR EMAIL"
  //    desmarcado) OU extras.confirmou_sem_email_deliberado=true (linha "🚫 SEM
  //    E-MAIL" do banner). Dispara só quando a 54 sairia SEM e-mail (!enviarEmail).
  {
    const analiseCard = (card.analise_padrao_resultado ?? {}) as Record<string, unknown>;
    const avisoCard = (card.aviso_alteracao_oc ?? {}) as Record<string, unknown>;
    const destacada =
      (analiseCard["proposta_destacada_acao"] as string | undefined) ??
      (avisoCard["proposta_destacada_acao"] as string | undefined) ??
      null;
    const guard = avaliarGuardOc54SemEmail({
      codigoSsw,
      enviarEmail,
      skipOc,
      tool,
      skipEmail,
      confirmouSemEmailDeliberado:
        argsExtras?.["confirmou_sem_email_deliberado"] === true ||
        argsExtras?.["confirmou_sem_email_deliberado"] === "true",
      propostaDestacadaAcao: destacada,
    });
    if (guard.bloquear) {
      const motivo = guard.motivo ?? "Bloqueado pelo guard INV-027 (54+email vs sem email).";
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc54SemEmailBloqueadaRecomendacaoEraEmail",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          card_id: m.card_id,
          todo_id: m.todo_id,
          acao_key: (m.proposta_payload as Record<string, unknown>)["acao_key"] ?? null,
          tool,
          meta: (m.proposta_payload.meta as Record<string, unknown> | undefined) ?? null,
          operador: m.aprovado_por ?? null,
          proposta_destacada_acao: destacada,
          prong: guard.prong,
          motivo,
        },
      });
      await supabase.from("todos")
        .update({ status: "falhou", rejection_reason: motivo.slice(0, 400) })
        .eq("id", m.todo_id);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: motivo,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
  }

  let emailEnviadoOk = false;
  let emailMessageId: string | null = null;
  let emailThreadId: string | null = null;
  let emailFromHeader: string | null = null;

  // Larissa pode editar assunto e/ou trocar template no modal antes de aprovar
  // (Caio 2026-05-06). Se vierem em extras, sobrescrevem o que está em
  // proposta_payload.args.template_id e o assunto renderizado do template.
  const assuntoOverride = (argsExtras?.["assunto_override"] as string | undefined) ?? null;
  const templateIdOverride = (argsExtras?.["template_id_override"] as string | undefined) ?? null;

  // Caio 2026-06-10 (NF 156022): guard idempotência. Se email pra este
  // todo_id já saiu (PGMQ retry, re-aprovação pós-falha SSW), NÃO envia de
  // novo — só registra skip + continua pro SSW. Garante 1 email por todo,
  // sempre.
  let emailJaEnviadoAntes: EmailJaEnviado | null = null;
  if (enviarEmail) {
    emailJaEnviadoAntes = await verificarEmailJaEnviado(supabase, m.todo_id);
    if (emailJaEnviadoAntes) {
      await registrarEmailSkipReenvio(supabase, {
        card_id: m.card_id,
        todo_id: m.todo_id,
        envio_anterior: emailJaEnviadoAntes,
        motivo: "Reexecução do todo (retry PGMQ ou re-aprovação pós-falha SSW). Email original preservado.",
      });
      emailEnviadoOk = true;
      emailMessageId = emailJaEnviadoAntes.gmail_message_id;
      emailThreadId = emailJaEnviadoAntes.gmail_thread_id;
      console.log(
        `[executor] email skip pra todo ${m.todo_id} — já enviado em ${emailJaEnviadoAntes.sent_at} (msg ${emailJaEnviadoAntes.gmail_message_id})`,
      );
    }
  }

  if (enviarEmail && !emailJaEnviadoAntes) {
    let emailPayload: EmailPayloadPreparado;
    try {
      emailPayload = await prepararEmailParaEnvio(
        supabase,
        m,
        textoCustomizado,
        assuntoOverride,
        templateIdOverride,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`prepararEmailParaEnvio falhou: ${msg}`);
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "EmailNaoEnviado",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          todo_id: m.todo_id,
          fase: "preparacao",
          motivo: msg,
        },
      });
      // Não lança SSW — reverte
      await supabase.from("todos")
        .update({ status: "falhou", rejection_reason: `Email não preparado: ${msg.slice(0, 400)}` })
        .eq("id", m.todo_id);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email não enviado (preparação): ${msg.slice(0, 400)}. Ocorrência NÃO foi lançada no SSW.`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }

    // Caio 2026-05-06: anexos vêm em extras.anexos_ids — array de UUIDs.
    // Carrega do storage email_anexos antes de enviar.
    const anexosIds = Array.isArray(argsExtras?.["anexos_ids"])
      ? (argsExtras!["anexos_ids"] as string[]).filter((s) => typeof s === "string")
      : [];

    const attachments = anexosIds.length > 0
      ? await carregarAnexos(supabase, anexosIds)
      : [];

    // Caio 2026-06-16: email proativo CONTINUA a thread da tratativa do card por
    // padrão (mantém histórico junto), salvo override `nao_seguir_thread` ou
    // tratativa já encerrada (finalizadora 01/30/32 pós último email → helper
    // retorna null → thread nova). Best-effort: null = thread nova (sem regressão).
    const naoSeguirThread = argsExtras?.["nao_seguir_thread"] === true;
    const threadTratativa = naoSeguirThread
      ? null
      : await carregarThreadDaTratativaAtual(supabase, m.card_id);
    const subjectFinal = threadTratativa?.subject_reply ?? emailPayload.subject;
    const extraHeadersThread = threadTratativa
      ? {
        ...(threadTratativa.in_reply_to ? { "In-Reply-To": threadTratativa.in_reply_to } : {}),
        ...(threadTratativa.references ? { "References": threadTratativa.references } : {}),
        ...(threadTratativa.thread_index ? { "Thread-Index": threadTratativa.thread_index } : {}),
      }
      : undefined;

    const sendResult = await sendGmailMessage({
      supabase,
      operadorId: m.aprovado_por,
      destinatario: emailPayload.destinatario,
      cc: emailPayload.cc,
      subject: subjectFinal,
      texto: emailPayload.texto,
      fromName: emailPayload.fromName,
      attachments,
      threadId: threadTratativa?.gmail_thread_id ?? null,
      extraHeaders: extraHeadersThread,
    });

    if (!sendResult.ok) {
      console.error(`sendGmailMessage falhou: ${sendResult.error}`);
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "EmailNaoEnviado",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          todo_id: m.todo_id,
          fase: "envio",
          destinatario: emailPayload.destinatario,
          cc: emailPayload.cc,
          motivo: sendResult.error,
        },
      });
      // Email falhou — NÃO lança SSW. Reverte com motivo claro.
      await supabase.from("todos")
        .update({ status: "falhou", rejection_reason: `Email Gmail falhou: ${sendResult.error.slice(0, 400)}` })
        .eq("id", m.todo_id);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email NÃO foi enviado pro cliente (${sendResult.error.slice(0, 300)}). Ocorrência NÃO foi lançada no SSW. Verifique destinatário/Gmail e tente de novo.`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }

    emailEnviadoOk = true;
    emailMessageId = sendResult.messageId;
    emailThreadId = sendResult.threadId;
    emailFromHeader = sendResult.from;

    // Caio 2026-06-23 (NF 59354, MEDH 18917657000183): auto-cadastra o e-mail do
    // cliente em contatos_cliente quando ele não tinha contato logístico — assim
    // o resolver_email_cobranca_cliente acha nos PRÓXIMOS cards (fim do fallback
    // "sem email" pros ~62 clientes sem contato). Best-effort: NUNCA quebra o
    // lançamento SSW. Idempotente (dedup por e-mail no helper).
    try {
      const cnpjPag =
        (((card.agent_state ?? {}) as Record<string, unknown>)["cnpj_pagador"] as string | null) ?? null;
      const reg = await registrarContatoLogisticoSeNovo(supabase, {
        cnpjPagador: cnpjPag,
        email: emailPayload.destinatario,
        operadorId: m.aprovado_por,
        cardId: m.card_id,
        nf: (card.nf as string | null) ?? null,
        nomeClienteFallback: (card.empresa_cliente as string | null) ?? null,
        actorId: "executor",
      });
      if (reg.registrado) {
        console.log(`[executor] contato logístico auto-cadastrado p/ ${cnpjPag}: ${emailPayload.destinatario}`);
      }
    } catch (e) {
      console.error(`[executor] auto-cadastro de contato falhou (ignorado): ${e instanceof Error ? e.message : String(e)}`);
    }

    // Caio 2026-05-06: anexos enviados — limpa do storage (privacidade) e
    // marca enviado_em na metadata.
    if (attachments.length > 0) {
      await finalizarAnexosPosEnvio(
        supabase,
        attachments.map((a) => ({ storage_path: a.storage_path, meta_id: a.meta_id })),
      );
    }

    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "RespostaEnviada",
      actor_type: "system",
      actor_id: "executor",
      payload: {
        todo_id: m.todo_id,
        canal: "email",
        via: "gmail_oauth_inline",
        from: emailFromHeader,
        destinatario: emailPayload.destinatario,
        cc: emailPayload.cc,
        subject: emailPayload.subject,
        gmail_message_id: emailMessageId,
        gmail_thread_id: emailThreadId,
        origem_texto: emailPayload.origemTexto,
        texto_preview: emailPayload.texto.slice(0, 300),
        anexos_count: attachments.length,
        anexos_filenames: attachments.map((a) => a.filename),
      },
    });

    // Caio 2026-05-06: registra outbound em tabela dedicada pra lookup O(1)
    // quando cliente responde (gmail-poll-inbox). Aplica label cockpit-tracked
    // na thread pra que polling filtre só replies de threads do Cockpit.
    if (emailMessageId && emailThreadId) {
      await supabase.from("cards_emails_outbound").insert({
        card_id: m.card_id,
        todo_id: m.todo_id,
        operadora_id: m.aprovado_por,
        gmail_message_id: emailMessageId,
        gmail_thread_id: emailThreadId,
        from_email: emailFromHeader,
        to_email: emailPayload.destinatario,
        subject: emailPayload.subject,
        // Caio 2026-06-16: Message-ID que geramos no envio — permite o próximo
        // email da tratativa montar In-Reply-To e o Gmail agrupar na thread.
        message_id_header: sendResult.messageIdHeader,
        // Caio 2026-05-12 (NF 920161): persiste corpo renderizado pra
        // interpretador-resposta-cliente comparar perguntas vs respostas
        // cliente e detectar pendências (ex: pediu romaneio mas cliente não
        // anexou).
        corpo_renderizado: emailPayload.texto,
      });

      // Label é best-effort. Falha não bloqueia o fluxo (polling tem
      // fallback via In-Reply-To em cards_emails_outbound).
      try {
        const operadorId = m.aprovado_por as string | undefined;
        if (operadorId) {
          const creds = await loadOperadorGmailCreds(supabase, operadorId);
          if (creds) {
            const accessToken = await refreshGmailAccessToken(supabase, operadorId, creds);
            const { data: pollState } = await supabase
              .from("gmail_polling_state")
              .select("cockpit_label_id")
              .eq("operador_id", operadorId)
              .maybeSingle();
            let labelId = (pollState as { cockpit_label_id?: string } | null)?.cockpit_label_id ?? null;
            if (!labelId) {
              labelId = await garantirLabelCockpitTracked(accessToken);
              await supabase.from("gmail_polling_state").upsert({
                operador_id: operadorId,
                cockpit_label_id: labelId,
              });
            }
            await aplicarLabelEmThread(accessToken, emailThreadId, labelId);
          }
        }
      } catch (err) {
        console.warn(`[executor] aplicar label cockpit-tracked falhou (não-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Caio 2026-06-17: ação "só notificar e-mail" (extravios). E-mail já foi
  // enviado acima; NÃO lança ocorrência no SSW e NÃO muda o state — o card
  // permanece em EXTRAVIO_MONITORADO (continua na aba Extravios). Finaliza aqui.
  if (skipOc) {
    if (enviarEmail && !emailEnviadoOk) {
      // email não saiu (e era pra sair) — o bloco acima já reverteu e retornou;
      // chegar aqui sem emailEnviadoOk é defensivo.
      await supabase.from("todos")
        .update({ status: "falhou", rejection_reason: "E-mail não enviado (skip_oc)" })
        .eq("id", m.todo_id);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: "E-mail não enviado pro cliente. Nenhuma ocorrência lançada.",
      });
      summary.failed++;
    } else {
      await supabase.from("todos").update({ status: "executado" }).eq("id", m.todo_id);
      // Caio 2026-06-22: e-mail de extravio enviado com sucesso — devolve o card
      // pra EXTRAVIO_MONITORADO (continua na aba Extravios, kanban D1-D5). Sem
      // isso o card ficava preso em EXECUTANDO_ACAO (aprovar_e_executar moveu pra
      // lá no approve) e sumia da aba. Gated em meta.origem=extravio_cockpit pra
      // não afetar eventuais skip_oc de outras origens. Limpa lock + banner de
      // falha (auto-heal de uma tentativa anterior que falhou e voltou pra cá).
      const metaOrigem = m.proposta_payload.meta?.["origem"];
      if (metaOrigem === "extravio_cockpit") {
        await supabase.from("cards")
          .update({
            state: "EXTRAVIO_MONITORADO",
            lock_aguardando_validacao: false,
            acao_falhou_motivo: null,
          })
          .eq("id", m.card_id);
      }
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "ExtravioClienteNotificadoSemOc",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          todo_id: m.todo_id,
          gmail_message_id: emailMessageId,
          canal: "email",
          state_novo: metaOrigem === "extravio_cockpit" ? "EXTRAVIO_MONITORADO" : null,
        },
      });
      summary.executed++;
    }
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // 4. Chama SSW via portal interno (opção 101) através do envelope
  // `lancarSswPortal`. Caio 2026-06-08: substituiu WebAPI + guard chave_cte +
  // fallback DOCUMENTO CANCELADO. Detalhes em CLAUDE.md "REGRA CRÍTICA".
  //
  // === DOC STALE (mantida só pra contexto histórico, não reflete o código): ===
  // Antes (até 2026-06-07): schema cte.chaveCTe, codigo_api via lookup_codigo_api,
  // idempotency via SHA-256 do header, e fallback automático pra DOCUMENTO
  // CANCELADO via lookup_chaves_cte_alternativas. Tudo removido com a migração
  // pro portal — chave_cte deixou de existir.
  // funciona — futuras ações usam a nova chave.

  // Caio 2026-05-08: anexo SSW (oc emergencial com imagem/PDF). RPC
  // lancar_oc_emergencial_acao_executada injeta `extras.anexo_id` quando
  // Larissa anexa um arquivo no modal. Carrega aqui pra mandar como `imagem`
  // base64. Reutiliza helper de email_anexos (mesmo bucket, lifecycle igual:
  // deleta após sucesso pra privacidade).
  const sswAnexoId = typeof argsExtras?.["anexo_id"] === "string"
    ? (argsExtras["anexo_id"] as string)
    : null;
  let sswImagemBase64: string | undefined;
  let sswAnexoCarregado: { storage_path: string; meta_id: string; filename: string; mime_type: string } | null = null;
  if (sswAnexoId) {
    const carregados = await carregarAnexos(supabase, [sswAnexoId]);
    if (carregados.length > 0) {
      sswImagemBase64 = carregados[0].content_base64;
      sswAnexoCarregado = {
        storage_path: carregados[0].storage_path,
        meta_id: carregados[0].meta_id,
        filename: carregados[0].filename,
        mime_type: carregados[0].mime_type,
      };
    } else {
      // Anexo referenciado mas sumido do bucket (deletado/expirado). Falha
      // explícita — Larissa precisa re-subir. Não envia oc sem a imagem que
      // ela anexou, pra não falsear a expectativa.
      console.error(`[executor] anexo SSW ${sswAnexoId} não encontrado no bucket`);
      await supabase.from("todos")
        .update({ status: "falhou", rejection_reason: `Anexo ${sswAnexoId} não encontrado no bucket — re-subir e tentar de novo.` })
        .eq("id", m.todo_id);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Anexo da oc emergencial não foi encontrado no storage. Re-anexe a imagem e tente lançar de novo. Ocorrência NÃO foi enviada ao SSW.`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
  }

  // Caio 2026-06-08: lançamento via portal interno (opção 101).
  // Substituiu o guard `validarChaveCteCorrespondeCtrcDoCard` + WebAPI
  // `ssw.lancarOcorrencia` + fallback DOCUMENTO CANCELADO. Agora o envelope
  // `lancarSswPortal`:
  //   - Faz idempotência via UNIQUE em acoes_executadas_ssw (mig 194)
  //   - Aplica guard inviolável de tripé (CTRC + NF + Localização atual)
  //     dentro do lancarOcorrenciaPortal, ANTES do submit
  //   - Lança via portal SSW (opção 101) com código semântico direto, sem
  //     remap dexpara
  // Fallback DOCUMENTO CANCELADO foi REMOVIDO — o guard tripé impede
  // lançamento em CTRC cancelado/finalizado já no passo 1.
  let sswImagensPortal: Array<{ bytes: Uint8Array; filename: string; mimeType: string }> = [];
  if (sswImagemBase64 && sswAnexoCarregado) {
    const bin = Uint8Array.from(atob(sswImagemBase64), (c) => c.charCodeAt(0));
    sswImagensPortal = [{
      bytes: bin,
      filename: sswAnexoCarregado.filename,
      mimeType: sswAnexoCarregado.mime_type,
    }];
  }

  // Caio 2026-06-11 (NF 919611): override humano da checagem (c) do guard.
  // Operadora marca extras.forcar_lancamento_ctrc_baixado quando o CTRC foi
  // baixado por DEVOLUÇÃO (oc=30) mas a tratativa de ressarcimento ainda exige
  // lançar oc de relacionamento (ex: oc=54 pedir romaneio). NÃO dispensa
  // CTRC/NF (a/b). É flag de controle: NÃO entra na whitelist de texto SSW.
  const forcarCtrcBaixado =
    extras && typeof extras === "object" &&
    (extras["forcar_lancamento_ctrc_baixado"] === true ||
      extras["forcar_lancamento_ctrc_baixado"] === "true");

  const portalResult = await lancarSswPortal({
    supabase,
    env,
    card: { id: m.card_id, nf, ctrc: ctrcCard },
    codigoSsw,
    texto: descricao,
    imagens: sswImagensPortal,
    todoId: m.todo_id,
    permitirLocalizacaoBaixada: forcarCtrcBaixado,
  });

  // Caio 2026-06-08: bloqueio do guard tripé reverte o todo + grava
  // card_event e ABORTA (não lança no SSW). Mesma postura do antigo guard
  // chave_cte, mas com motivo do tripé (CTRC, NF, Localização).
  if (!portalResult.ok && portalResult.categoria === "guard_tripe") {
    console.error(`[executor] guard tripé REJEITOU todo ${m.todo_id}: ${portalResult.error}`);
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "TripeRejeitadoPeloGuard",
      actor_type: "system",
      actor_id: "executor",
      payload: {
        todo_id: m.todo_id,
        motivo: portalResult.error,
        ctrc_card: ctrcCard,
        nf,
        codigo_ssw: codigoSsw,
        acao_id: portalResult.acao_id,
      },
    });
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo:
        `Lançamento abortado pelo guard tripé (CTRC/NF/Localização) — ${portalResult.error}. ` +
        `CTRC do card: ${ctrcCard}. ` +
        `Verifique se o CTRC ainda está ativo no SSW e tente de novo.`,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Adapter: traduz LancarSswPortalResult pra shape antigo do sswResult que
  // o resto do executor (audit_log, card_event) espera. Mantém o blast radius
  // do refator dentro deste handler.
  const sswResult = portalResult.ok
    ? {
        ok: true as const,
        protocolo: portalResult.protocolo,
        idempotencyKey: portalResult.acao_id,
        raw: { idempotent_skip: portalResult.idempotent_skip, acao_id: portalResult.acao_id } as Record<string, unknown>,
        status: 200,
        error: null as string | null,
      }
    : {
        ok: false as const,
        protocolo: null as string | null,
        idempotencyKey: portalResult.acao_id ?? "n/a",
        raw: { categoria: portalResult.categoria, detalhe: portalResult.detalhe ?? null } as Record<string, unknown>,
        status: 502,
        error: portalResult.error,
      };

  // 5. audit_log
  // Caio 2026-06-08: chave_cte e codigo_api removidos (não fazem mais parte
  // do fluxo). idempotency_key agora vem do acao_id do envelope (UNIQUE em
  // acoes_executadas_ssw substitui SHA-256 do WebAPI).
  const auditPayload: Record<string, unknown> = {
    card_id: m.card_id,
    action_type: "lancar_ocorrencia",
    actor_type: "agent",
    actor_id: "executor",
    external_system: "ssw",
    idempotency_key: sswResult.idempotencyKey,
    request_payload: {
      cnpj_remetente: cnpjRemetente,
      ctrc: ctrcCard,
      nf,
      codigo_ssw: codigoSsw,
      descricao,
      via: "portal_101",
    },
    response_payload: sswResult.raw,
    status: sswResult.ok ? "success" : "failed",
    external_id: sswResult.ok ? sswResult.protocolo : null,
  };

  // INSERT audit_log com onConflict do idempotency_key — se já existe, ignora
  const { error: auditErr } = await supabase
    .from("audit_log")
    .insert(auditPayload)
    .select()
    .single();

  if (auditErr && !auditErr.message.includes("duplicate key")) {
    throw new Error(`INSERT audit_log: ${auditErr.message}`);
  }

  // 6. card_event AcaoExecutada (sucesso ou falha)
  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: sswResult.ok ? "AcaoExecutada" : "AcaoFalhou",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      action_id: m.action_id,
      tool: "lancar_ocorrencia",
      codigo_ssw: codigoSsw,
      nf,
      ctrc: ctrcCard,
      cnpj_remetente: cnpjRemetente,
      via: "portal_101",
      protocolo: sswResult.ok ? sswResult.protocolo : null,
      idempotency_key: sswResult.idempotencyKey,
      sucesso: sswResult.ok,
      error: sswResult.ok ? null : sswResult.error,
      status_http: sswResult.ok ? 200 : sswResult.status,
      tem_imagem: !!sswImagemBase64,
      anexo_filename: sswAnexoCarregado?.filename ?? null,
      anexo_mime_type: sswAnexoCarregado?.mime_type ?? null,
    },
  });

  // 7. UPDATE todo
  if (sswResult.ok) {
    await supabase
      .from("todos")
      .update({ status: "executando" })
      .eq("id", m.todo_id);

    // O par "agente sugeriu X · operador fez Y" — a matéria-prima do placar dos
    // agentes e do loop de melhoria. Centralizado em
    // _shared/feedback-implicito-agentes.ts (Fase 0, Caio 2026-08-13) pra que
    // TODO caminho que chega ao SSW registre — inclusive os handlers de oc 33,
    // que davam return antes daqui (499 execuções/60d perdidas).
    //
    // PLACAR HONESTO (rodada 2 da autonomia, Caio 2026-08-21): aprovação
    // AUTOMÁTICA (auto_approval_rule != null — fatia autônoma OU regra 13→21
    // do vinculador) NÃO vira "seguida" — o agente não se autoavalia. A
    // qualidade dos autônomos é medida pelo gabarito de erros (mig 340), que
    // exige exatamente auto_approval_rule preenchido. Guard: INV-089.
    const { data: todoAuto } = await supabase
      .from("todos").select("auto_approval_rule").eq("id", m.todo_id).maybeSingle();
    if (!(todoAuto as { auto_approval_rule?: string | null } | null)?.auto_approval_rule) {
      await registrarFeedbackImplicitoAgentes(supabase, m.card_id, codigoSsw);
    } else {
      console.log(`[executor] feedback implícito PULADO (aprovação automática: ${(todoAuto as { auto_approval_rule?: string }).auto_approval_rule}) — placar não se autoavalia`);
    }

    // Caio 2026-05-08: anexo SSW enviado com sucesso — remove do bucket
    // (privacidade) e marca enviado_em na metadata. Mesma regra dos anexos
    // de email. Se SSW falhou, mantém o arquivo pra retentativa manual.
    if (sswAnexoCarregado) {
      await finalizarAnexosPosEnvio(supabase, [{
        storage_path: sswAnexoCarregado.storage_path,
        meta_id: sswAnexoCarregado.meta_id,
      }]);
    }

    // Caio 2026-05-07: card vai SEMPRE pra ACAO_EXECUTADA (lock=true) até
    // Bastão confirmar a oc lançada. Pass A do sync-bastao libera quando
    // Bastão.oc == card.cod_ultima_ocorrencia.
    //
    // Por que: Bastão tem latência (até 1h+). Sem esse state intermediário,
    // sync-bastao regredia o card pra AGUARDANDO_VOCE com a oc antiga e
    // Larissa acabava aprovando duas vezes a mesma ação (bug NF 196537:
    // aprovou oc=54 sem email, bug regrediu, ela aprovou DE NOVO + email,
    // mandando 2 emails ao cliente).
    //
    // Atualiza tudo agora pra estado coerente:
    //  - state=ACAO_EXECUTADA + lock=true (bloqueia aprovação)
    //  - acao_executada_em=now() (front calcula countdown / alerta após 1h)
    //  - cod_ultima_ocorrencia=codigoSsw (oc lançada agora é a do card)
    //  - limpa contexto antigo (ia_sugestao, cliente_respondeu, aviso)
    //  - acao_falhou_motivo=null
    const stateFinal = "ACAO_EXECUTADA";
    const agora = new Date().toISOString();

    // Caio 2026-05-08: snapshot da oc Bastão NO MOMENTO do lançamento.
    // Pass G usa pra distinguir "Bastão avançou de verdade" (oc atual !=
    // snapshot) de "RPA só refrescou a row sem mudar a oc" (igual).
    //
    // Caio 2026-05-25 (NF 29920): em cadeia de lançamentos (oc=54 → cliente
    // responde → oc=44), `cards.cod_ultima_ocorrencia` JÁ foi sobrescrito pelo
    // 1º lançamento. Ler dele captura o valor anterior do EXECUTOR, não do
    // Bastão. Pass A perde o guard quando Bastão vem stale (oc=10) e snapshot
    // virou 54 (= nosso lançamento), e card reabre indevidamente.
    //
    // Fonte canônica do "que Bastão tinha" = agent_state.cod_ultima_ocorrencia
    // (populado pelo sync-bastao via snapshotFromPendencia, não tocado pelo
    // executor). Fallback pra cod_ultima_ocorrencia preserva retrocompat com
    // cards antigos sem agent_state.cod_ultima_ocorrencia.
    const agentStateLocal = (card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null;
    const ocBastaoNoLancamento =
      ((agentStateLocal?.["cod_ultima_ocorrencia"] as number | null | undefined) ?? null) ??
      ((card as Record<string, unknown>)["cod_ultima_ocorrencia"] as number | null);
    // Caio 2026-05-14: também salva timestamp do registro do Bastão (do
    // agent_state, populado pelo snapshotFromPendencia do sync-bastao).
    // Usado pela guarda anti-reabertura em Pass A — diferencia "mesmo
    // snapshot que originou o card" de "Bastão atualizou com nova tratativa
    // (mesma oc, updated_at novo)".
    const bastaoUpdatedAtNoLancamento = (((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.["bastao_updated_at"] as string | null | undefined) ?? null;
    // Caio 2026-05-14 (NF 1005270/177817 loop): snapshot da bastao_pendencia_id
    // no momento do lançamento. Regra "mesma atualização do Bastão não recria
    // card" — Pass A compara este id com a pendência atual; igual=NO-OP.
    // Cada nova atualização RPA do Bastão tem id diferente, então diff=potencial
    // re-tratativa real. Discriminador semanticamente correto (updated_at
    // sozinho não basta porque RPA refresh advance timestamp sem nova oc).
    const bastaoPendenciaIdNoLancamento = (card as Record<string, unknown>)["bastao_pendencia_id"] as string | null;

    // Caio 2026-05-12: combo 33+44 NÃO chega aqui — early return em
    // processarComboPortal33_44 logo após carregar card. Bloco anterior
    // (WebAPI + enfileirar parte 2) ficou obsoleto e foi removido.

    await supabase
      .from("cards")
      .update({
        state: stateFinal,
        lock_aguardando_validacao: true,
        acao_executada_em: agora,
        cod_ultima_ocorrencia: codigoSsw,
        bastao_oc_no_lancamento: ocBastaoNoLancamento,
        bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
        bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
        acao_falhou_motivo: null,
        aviso_alteracao_oc: null,
        ia_sugestao_oc_resposta: null,
        cliente_respondeu_em: null,
      })
      .eq("id", m.card_id);

    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "StateTransicaoPosSucesso",
      actor_type: "system",
      actor_id: "executor",
      payload: {
        todo_id: m.todo_id,
        codigo_ssw: codigoSsw,
        state_novo: stateFinal,
        acao_executada_em: agora,
        bastao_oc_no_lancamento: ocBastaoNoLancamento,
        bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
        bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
        motivo: "Caio 2026-05-07: card vai pra ACAO_EXECUTADA até Bastão confirmar oc lançada. Snapshot Bastão pré-lançamento usado pelo Pass G + guarda Pass A (Caio 2026-05-14).",
      },
    });

    // Caio 2026-05-13 (Fase 2): tenta confirmar via SSW interno on-time.
    await tentarConfirmarPosLancamento(supabase, m.card_id, "webapi");

    // Caio 2026-05-07: proporAutoAcao NÃO roda mais aqui — card está em
    // ACAO_EXECUTADA congelado. Quando Pass A do sync-bastao confirmar a oc
    // pelo Bastão e liberar pro state final (AGUARDANDO_CLIENTE etc), o
    // próprio Pass A chama proporAutoAcao no fluxo normal.

    // Email foi enviado inline ANTES de lançar a oc (atomicidade) — só
    // resta agendar cobrança D+4. Sem email mas tool original era composto:
    // operadora marcou skip_email → manual → também agenda D+4 (cliente foi
    // notificado por fora, presunção da operadora).
    if (emailEnviadoOk) {
      try {
        await supabase.rpc("agendar_cobranca_email", {
          p_card_id: m.card_id,
          p_template_id: "COBRANCA_LEMBRETE",
          p_dias: 4,
        });
      } catch (e) {
        console.error("agendar_cobranca_email (inline path):", e);
      }
    } else if (tool === "lancar_oc_e_enviar_email" && skipEmail) {
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "EmailMarcadoComoEnviadoManual",
        actor_type: "operator",
        actor_id: m.aprovado_por,
        payload: {
          todo_id: m.todo_id,
          motivo: "Operadora marcou que email já foi enviado manualmente pelo Gmail",
        },
      });
      try {
        await supabase.rpc("agendar_cobranca_email", {
          p_card_id: m.card_id,
          p_template_id: "COBRANCA_LEMBRETE",
          p_dias: 4,
        });
      } catch (e) {
        console.error("agendar_cobranca_email (manual path):", e);
      }
    }

    // Re-lançamento de oc=54 (origem: vinculador pós-resposta cliente):
    // Caio 2026-05-07: card já foi setado pra ACAO_EXECUTADA acima — só
    // reagenda cobrança D+4 aqui. Quando Pass A confirmar oc=54 no Bastão,
    // libera pra AGUARDANDO_CLIENTE.
    const meta = m.proposta_payload.meta;
    if (meta?.["tipo_acao"] === "relancamento_54") {
      const reagendadoPara = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();

      await supabase.from("acoes_agendadas").insert({
        card_id: m.card_id,
        tipo: "cobranca_email",
        executar_em: reagendadoPara,
        payload: {
          template_id: "COBRANCA_LEMBRETE",
          dias_aguardar: 4,
          agendado_em: new Date().toISOString(),
          origem: "relancamento_54",
        },
      });

      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Relancamento54Executado",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          todo_id: m.todo_id,
          state_novo: "ACAO_EXECUTADA",
          cobranca_reagendada_para: reagendadoPara,
        },
      });
    }

    // Caio 2026-05-18: cancelamento automático de reentrega 24h após oc=21.
    // Quando insucesso por culpa da Sal e cliente libera reentrega mas se nega
    // a pagar, operador marca checkbox `extras.cancelar_reentrega_24h=true` no
    // modal. Aqui agendamos a ação que vai rodar no cron diário (12h UTC) e
    // localizar o CTRC de reentrega complementar via opção 101 + cancelar via
    // opção 450 do SSW interno.
    const codigoSswExec = argsObj["codigo_ssw"] as number | undefined;

    // Caio 2026-05-23: oc=21 lançada pelo Cockpit RECOMEÇA O CICLO de
    // cobrança. Mesmo que card estava em 'cobrado'/'escalado' (ciclo anterior),
    // nova oc=21 reseta pra 'parada' — cobranças anteriores ficam no histórico
    // mas não contam pro novo ciclo. View v_prioridades_ai já filtra
    // cobranças por disparado_em > data_anchora (mig 156).
    if (codigoSswExec === 21) {
      const { error: kanbanErr } = await supabase
        .from("cards")
        .update({
          prioridades_kanban_status: "parada",
          prioridades_kanban_atualizado_em: new Date().toISOString(),
        })
        .eq("id", m.card_id);
      if (kanbanErr) {
        console.warn(`prioridades_kanban_status='parada' pós-oc=21 falhou (card=${m.card_id}): ${kanbanErr.message}`);
      }
    }

    // Caio 2026-05-26: feature "responder cliente em 1 clique". Pós-sucesso
    // de oc=21/44/55, se o modal trouxe extras.responder_thread_cliente
    // (toggle "Responder cliente por email" marcado pelo operador), envia o
    // texto editado respondendo a última thread inbound do cliente. Garante
    // que a autorização do cliente não fica sem retorno absoluto.
    // Best-effort: oc já foi lançada — se email falhar, registra
    // RespostaConfirmacaoNaoEnviada e segue (decisão Caio 2026-05-26: oc é
    // crítica, email é cortesia; operador vê erro no histórico e responde
    // manual se quiser).
    const RESPONDER_THREAD_OCS = new Set([21, 44, 55]);
    const respThread = argsExtras?.["responder_thread_cliente"] as
      | { enviar?: boolean; corpo?: string }
      | undefined;
    if (
      codigoSswExec != null &&
      RESPONDER_THREAD_OCS.has(codigoSswExec) &&
      respThread?.enviar === true &&
      typeof respThread.corpo === "string" &&
      respThread.corpo.trim().length > 0
    ) {
      try {
        const { carregarThreadingDaUltimaInbound } = await import("../_shared/email-threading.ts");
        const threading = await carregarThreadingDaUltimaInbound(supabase, m.card_id);
        if (!threading) {
          await supabase.from("card_events").insert({
            card_id: m.card_id,
            event_type: "RespostaConfirmacaoNaoEnviada",
            actor_type: "system",
            actor_id: "executor",
            payload: {
              todo_id: m.todo_id,
              codigo_ssw: codigoSswExec,
              motivo: "Sem mensagem inbound no card pra responder",
            },
          });
        } else {
          const extraHeadersRT: Record<string, string> = {};
          if (threading.in_reply_to) extraHeadersRT["In-Reply-To"] = threading.in_reply_to;
          if (threading.references) extraHeadersRT["References"] = threading.references;
          if (threading.thread_index) extraHeadersRT["Thread-Index"] = threading.thread_index;

          const { data: opRow } = await supabase
            .from("operadores")
            .select("nome, nome_email_outbound")
            .eq("id", m.aprovado_por)
            .maybeSingle();
          const fromNameRT =
            ((opRow as { nome_email_outbound?: string | null } | null)?.nome_email_outbound) ??
            ((opRow as { nome?: string | null } | null)?.nome) ??
            null;

          const corpoRT = respThread.corpo.trim();
          const sendResp = await sendGmailMessage({
            supabase,
            operadorId: m.aprovado_por,
            destinatario: threading.remetente,
            cc: null,
            subject: threading.subject_reply,
            texto: corpoRT,
            fromName: fromNameRT,
            extraHeaders: extraHeadersRT,
            threadId: threading.gmail_thread_id,
          });

          if (sendResp.ok) {
            if (sendResp.messageId && sendResp.threadId) {
              await supabase.from("cards_emails_outbound").upsert(
                {
                  card_id: m.card_id,
                  todo_id: m.todo_id,
                  operadora_id: m.aprovado_por,
                  gmail_message_id: sendResp.messageId,
                  gmail_thread_id: sendResp.threadId,
                  from_email: sendResp.from,
                  to_email: threading.remetente,
                  subject: threading.subject_reply,
                  message_id_header: sendResp.messageIdHeader,
                  corpo_renderizado: corpoRT,
                },
                { onConflict: "gmail_message_id" },
              );
            }
            await supabase.from("card_events").insert({
              card_id: m.card_id,
              event_type: "RespostaConfirmacaoEnviada",
              actor_type: "system",
              actor_id: "executor",
              payload: {
                todo_id: m.todo_id,
                codigo_ssw: codigoSswExec,
                canal: "email",
                via: "gmail_oauth_inline",
                from: sendResp.from,
                destinatario: threading.remetente,
                subject: threading.subject_reply,
                gmail_message_id: sendResp.messageId,
                gmail_thread_id: sendResp.threadId,
                mensagem_origem_id: threading.mensagem_origem_id,
                texto_preview: corpoRT.slice(0, 300),
              },
            });
          } else {
            console.error(`[executor] responder thread cliente falhou (card=${m.card_id}): ${sendResp.error}`);
            await supabase.from("card_events").insert({
              card_id: m.card_id,
              event_type: "RespostaConfirmacaoNaoEnviada",
              actor_type: "system",
              actor_id: "executor",
              payload: {
                todo_id: m.todo_id,
                codigo_ssw: codigoSswExec,
                fase: "envio",
                motivo: sendResp.error,
                destinatario: threading.remetente,
              },
            });
          }
        }
      } catch (errRT) {
        const msgRT = errRT instanceof Error ? errRT.message : String(errRT);
        console.error(`[executor] responder thread cliente erro inesperado (card=${m.card_id}): ${msgRT}`);
        await supabase.from("card_events").insert({
          card_id: m.card_id,
          event_type: "RespostaConfirmacaoNaoEnviada",
          actor_type: "system",
          actor_id: "executor",
          payload: {
            todo_id: m.todo_id,
            codigo_ssw: codigoSswExec,
            fase: "excecao",
            motivo: msgRT,
          },
        });
      }
    }

    if (codigoSswExec === 21 && argsExtras?.["cancelar_reentrega_24h"] === true) {
      // Carrega card pra meta (operador, ctrc original, pagador). Reusa
      // variável `card` se já carregada em escopo anterior; senão busca agora.
      const { data: cardData } = await supabase
        .from("cards")
        .select("id, nf, ctrc, agent_state, responsavel_relacionamento, assigned_operator_id, ia_sugestao_oc_resposta")
        .eq("id", m.card_id)
        .maybeSingle();

      if (cardData) {
        const cardRow = cardData as Record<string, unknown>;
        const ag = (cardRow["agent_state"] ?? {}) as Record<string, unknown>;
        const iaSug = (cardRow["ia_sugestao_oc_resposta"] ?? null) as Record<string, unknown> | null;
        const executarEm = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        // Motivo do cancelamento: vem da IA quando ela validou o argumento do
        // cliente; senão fallback default "PARA FINS DE ROMANEIO" (Caio
        // 2026-05-18 — usado quando operador marca manual sem IA).
        const motivoCancelamento =
          (argsExtras?.["motivo_cancelamento"] as string | undefined)?.trim() ||
          (iaSug?.["motivo_cliente_recusa_pagar"] as string | undefined)?.trim() ||
          "PARA FINS DE ROMANEIO";

        await supabase.from("acoes_agendadas").insert({
          card_id: m.card_id,
          tipo: "cancelar_reentrega_ssw",
          executar_em: executarEm,
          payload: {
            nf: cardRow["nf"],
            ctrc_original: cardRow["ctrc"],
            cnpj_pagador: ag["cnpj_pagador"] ?? null,
            responsavel_relacionamento: cardRow["responsavel_relacionamento"] ?? null,
            assigned_operator_id: cardRow["assigned_operator_id"] ?? null,
            oc_lancada: 21,
            lancamento_em: new Date().toISOString(),
            motivo_cancelamento: motivoCancelamento,
            todo_id_origem: m.todo_id,
            origem_marcacao: iaSug?.["cliente_autorizou_reentrega_sem_pagar"] === true
              ? "ia_sugestao"
              : "operador_manual",
            tentativas: 0,
          },
        });

        await supabase.from("card_events").insert({
          card_id: m.card_id,
          event_type: "CancelamentoReentregaAgendado",
          actor_type: "system",
          actor_id: "executor",
          payload: {
            todo_id: m.todo_id,
            oc_lancada: 21,
            executar_em: executarEm,
            motivo_cancelamento: motivoCancelamento,
            origem_marcacao: iaSug?.["cliente_autorizou_reentrega_sem_pagar"] === true
              ? "ia_sugestao"
              : "operador_manual",
          },
        });
      }
    }

    summary.executed++;
  } else {
    // Falha no SSW: marca todo como falhou e chama RPC pra reverter card
    // pra AGUARDANDO_VALIDACAO_HUMANA com flag visual + ressuscita os todos
    // cancelados pela aprovação. Larissa pode escolher outra opção.
    //
    // Caso especial: se o email já foi enviado pro cliente (atomicidade
    // falhou DEPOIS do email), inclui aviso pra Larissa saber que cliente
    // já recebeu mas oc não foi lançada — precisa retentar a oc.
    await supabase
      .from("todos")
      .update({ status: "falhou", rejection_reason: sswResult.error.slice(0, 500) })
      .eq("id", m.todo_id);

    // Caio 2026-05-12 (NF 920161 combo): se essa é a parte 2 do combo 33+44,
    // a oc=33 já foi lançada com sucesso e a oc=44 falhou agora. Mensagem
    // de reverter deixa explícito pra Larissa retentar só a 44.
    const meta = (m.proposta_payload?.meta ?? {}) as Record<string, unknown>;
    const ehParte2DoCombo = meta["origem"] === "combo_33_44_parte2";
    const protocoloParte1 = meta["parte1_protocolo"] as string | undefined;

    let motivoFalha: string;
    if (ehParte2DoCombo && protocoloParte1) {
      motivoFalha = `Combo 33+44: oc=33 lançada com sucesso (protocolo ${protocoloParte1}) MAS a oc=44 falhou no SSW: ${sswResult.error.slice(0, 200)}. Retentar SOMENTE a oc=44 (não relançar 33).`;
    } else if (emailEnviadoOk) {
      motivoFalha =
        `ATENÇÃO: email JÁ FOI ENVIADO pro cliente, mas a ocorrência ${codigoSsw} FALHOU no SSW ` +
        `(${sswResult.error.slice(0, 200)}). ` +
        `Ao reaprovar este card, o email NÃO será reenviado — apenas a ocorrência será relançada no SSW. ` +
        `Se você quiser MANDAR um email diferente, cancele este todo e use a opção "email livre" (marque "novo e-mail — não seguir histórico" se quiser uma thread separada).`;
    } else {
      motivoFalha = sswResult.error.slice(0, 500);
    }

    const { error: revertErr } = await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: motivoFalha,
    });
    if (revertErr) {
      console.error(`reverter_acao_falhou: ${revertErr.message}`);
      // Fallback: ao menos não deixa card preso em EXECUTANDO_ACAO
      await supabase
        .from("cards")
        .update({
          state: "AGUARDANDO_VALIDACAO_HUMANA",
          lock_aguardando_validacao: true,
          acao_falhou_motivo: sswResult.error.slice(0, 500),
        })
        .eq("id", m.card_id);
    }

    summary.failed++;
  }

  // 8. Confirma processamento
  await deletarMsgExecutor(supabase, job);
}

// =============================================================================
// prepararEmailParaEnvio — monta payload completo (destinatário, assunto,
// texto renderizado com placeholders + link evidência). Retorna o payload OU
// null se decidiu que não vai mandar email (skip explícito ou faltando dados).
//
// Quando retorna payload, o chamador (executor inline OU enviar-resposta via
// fila) usa pra fazer o envio real via sendGmailMessage.
// =============================================================================

interface EmailPayloadPreparado {
  destinatario: string;
  cc: string[];
  subject: string;
  texto: string;
  fromName: string;
  templateId: string | null;
  origemTexto: "operador_manual" | "template";
}

async function prepararEmailParaEnvio(
  supabase: ReturnType<typeof createClient>,
  m: QueueMessage["message"],
  textoCustomizado: string | null = null,
  assuntoOverride: string | null = null,
  templateIdOverride: string | null = null,
): Promise<EmailPayloadPreparado> {
  const args = m.proposta_payload.args as Record<string, unknown>;
  const templateIdOriginal = args["template_id"] as string | undefined;
  const templateId = templateIdOverride ?? templateIdOriginal;
  const extras = args["extras"] as Record<string, unknown> | undefined;

  // Destinatário: aceita override via extras.email_destinatarios (array
  // selecionado pela Larissa no composer). Senão usa args.email_destino
  // (singular, vinha da regra automática). 1ª string vai como TO; demais
  // viram CC. Sem destino válido → throw.
  const emailDestinatariosRaw = extras?.["email_destinatarios"];
  const destinatariosArr = Array.isArray(emailDestinatariosRaw)
    ? (emailDestinatariosRaw.filter((s) => typeof s === "string" && s.trim()) as string[])
    : [];
  const emailDestino =
    destinatariosArr[0] ??
    // Hardening (Codex): "" / "   " → null (não é destino válido) → cai no throw.
    ((args["email_destino"] as string | undefined)?.trim() || null);
  const emailCc = destinatariosArr.slice(1);

  if (!emailDestino) {
    throw new Error(`Destino faltando: destino=null`);
  }

  // Se tem textoCustomizado (Larissa editou no Cockpit), template pode estar
  // inativo ou inexistente. Tentamos buscar pra extrair assunto, mas não
  // exigimos `ativo=true`. Sem template, usa assunto genérico.
  if (!templateId && !textoCustomizado) {
    throw new Error(`Template faltando: template=${templateId}`);
  }
  const { data: template } = templateId
    ? await supabase
        .from("templates_email")
        .select("id, assunto, corpo_template, ativo")
        .eq("id", templateId)
        .maybeSingle()
    : { data: null };

  if (!textoCustomizado && (!template || !(template as Record<string, unknown>)["ativo"])) {
    throw new Error(`Template ${templateId} não existe ou não está ativo`);
  }

  // Busca card pra resolver placeholders + cod_ultima_ocorrencia (Caio 2026-05-06)
  // — token de evidência precisa saber qual oc específica antes de gerar URL.
  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, empresa_cliente, agent_state, responsavel_relacionamento, assigned_operator_id, cod_ultima_ocorrencia")
    .eq("id", m.card_id)
    .single();

  if (!card) throw new Error("card não encontrado");

  // Resolve placeholders básicos disponíveis
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const nomeCliente = (card.empresa_cliente as string | null) ?? "";

  // Caio 2026-06-20 (mig 225): {primeiro_nome} resolvido por FONTE ÚNICA no
  // Postgres (resolver_primeiro_nome_email). Só devolve nome de PESSOA — nunca
  // empresa ("F E F DISTRIBUIDORA"→"F", "UNIÃO QUIMICA"→"União") nem rótulo
  // genérico (SAC, Central, Transporte). Deriva do email só com separador
  // (allyson.ferreira→Allyson; dbarcelos→vazio). Sem nome confiável → vazio e a
  // saudação vira Prezado(a)/Pessoal após a renderização (espelha a RPC preview).
  const _extrasForLookup = args["extras"] as Record<string, unknown> | undefined;
  const _destArr = Array.isArray(_extrasForLookup?.["email_destinatarios"])
    ? ((_extrasForLookup!["email_destinatarios"] as unknown[]).filter((s) => typeof s === "string" && (s as string).trim()) as string[])
    : [];
  const _emailDestinoForLookup =
    _destArr[0] ??
    (args["email_destino"] as string | undefined) ??
    null;
  // Nº de destinatários (TO+CC) decide a saudação genérica (Prezado(a)/Pessoal).
  const _numDestinatarios = _destArr.length > 0 ? _destArr.length : 1;

  let primeiroNome = "";
  if (_emailDestinoForLookup) {
    const { data: pnResolved } = await supabase.rpc("resolver_primeiro_nome_email", {
      p_email: _emailDestinoForLookup,
      p_empresa: nomeCliente,
    });
    if (typeof pnResolved === "string") primeiroNome = pnResolved.trim();
  }

  // Display name do From: prefere operadores.nome_email_outbound (custom) se
  // setado; senão usa card.responsavel_relacionamento. Caio 2026-05-25: DURAFA
  // → "DUILIO" no email outbound porque é a mesma pessoa real do segmento 022.
  let operadoraNome = (card.responsavel_relacionamento as string | null) ?? "Sal Express";
  const assignedOpId = card.assigned_operator_id as string | null | undefined;
  if (assignedOpId) {
    const { data: opRow } = await supabase
      .from("operadores")
      .select("nome_email_outbound")
      .eq("id", assignedOpId)
      .maybeSingle();
    const displayCustom = (opRow as { nome_email_outbound?: string | null } | null)?.nome_email_outbound;
    if (displayCustom && displayCustom.trim().length > 0) {
      operadoraNome = displayCustom;
    }
  }
  const codOcorrenciaCard = (card.cod_ultima_ocorrencia as number | null);

  // Gera token de evidência se template OU texto custom usa {link_evidencia}.
  // Caio 2026-05-06: bug NF 350898 mostrava foto de oc anterior. Token agora
  // armazena cod_ocorrencia.
  //
  // Validação de evidência (regra Caio 2026-05-06):
  //   - oc=10/11/35: SEMPRE valida (cliente recusou/endereço errado precisa
  //     mostrar foto da motorista). Sem foto → bloqueia envio.
  //   - oc=49 (volta de Operação): NÃO valida por padrão. oc=49 é usada pra
  //     vários motivos (faltavolume, devolução etc) — muitos NÃO precisam
  //     de evidência. Larissa marca checkbox `validar_evidencia=true` no
  //     modal SE o caso específico requer foto.
  //   - Outras ocs: NÃO valida (quando template tem {link_evidencia} mas
  //     case-by-case, operadora decide via flag).
  const OCS_EVIDENCIA_OBRIGATORIA: ReadonlySet<number> = new Set([10, 11, 35]);
  const corpoTemplate = (template?.corpo_template as string | undefined) ?? "";
  const usaLinkEvidencia =
    corpoTemplate.includes("{link_evidencia}") ||
    (textoCustomizado != null && textoCustomizado.includes("{link_evidencia}"));
  const ocObrigatoria = codOcorrenciaCard != null && OCS_EVIDENCIA_OBRIGATORIA.has(codOcorrenciaCard);
  const validarPorExtras = extras?.["validar_evidencia"] === true;
  // Caio 2026-05-11 (NF 353730): bypass de evidência pra ocs 10/11/35.
  // Caso real: operação lançou oc=26 errada (devia ser oc lançada manual depois).
  // Foto existe mas em outra oc — regra estrita bloqueia. Larissa marca
  // skip_evidencia=true na UI, assume responsabilidade de anexar manual no SSW
  // (ou avisar via outro canal), Cockpit prossegue com email + lançamento.
  // Auditoria registra quem ignorou e quando via card_event.
  const skipEvidencia = extras?.["skip_evidencia"] === true;
  const deveValidarEvidencia =
    usaLinkEvidencia && (ocObrigatoria || validarPorExtras) && !skipEvidencia;
  if (skipEvidencia && ocObrigatoria && usaLinkEvidencia) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "EvidenciaIgnoradaPorOperador",
      actor_type: "operator",
      actor_id: m.aprovado_por ?? "unknown",
      payload: {
        cod_ocorrencia: codOcorrenciaCard,
        todo_id: m.todo_id,
        motivo: "Operadora marcou skip_evidencia=true — anexa evidência manualmente no SSW",
      },
    });
  }

  let linkEvidencia = "";
  if (usaLinkEvidencia) {
    const cnpjPagador = (agentState["cnpj_pagador"] as string | null) ?? "";
    const nfCard = (card.nf as string | null) ?? "";
    if (cnpjPagador && nfCard && codOcorrenciaCard != null) {
      // Caio 2026-05-29 (NF 342013 LARISSA oc=49): bloco "omite link se oc
      // bloqueada no trackingpag" REMOVIDO. Era fallback de 2026-05-11 (NF
      // 920161) enquanto SSW interno não cobria essas ocs. Fase 3 (2026-05-13,
      // memory project_tracking_publico_deprecated) migrou r-evidencia +
      // foto-oc-card pro SSW interno — todas as ocs (incluindo bloqueadas
      // no /trackingpag público) resolvem via login interno. Manter o
      // bypass aqui fazia cliente receber email sem o link (caso NF 342013:
      // operadora aprovou texto com {link_evidencia}, email saiu com "no link:
      // <vazio>"). Agora sempre gera token + link, independente da oc.
      {
      if (deveValidarEvidencia) {
        // Caio 2026-05-07: valida evidência antes de gerar token. Bloqueia
        // se status != ok_com_foto_correlacionada (regra estrita: foto tem
        // que estar na linha da oc 10/11/35, senão cliente recebe link
        // pra "indisponível" e perde confiança).
        const { temEvidenciaParaOc } = await import("../_shared/verificar-evidencia.ts");
        // Caio 2026-05-14 (NF 20761): passa card.ctrc pra evitar falso negativo
        // em NFs com múltiplos CTRCs (reentrega/complementar). Sem isso,
        // buscarNFInterno throws "múltiplos CTRCs" → scrape_indisponivel falso
        // → email bloqueado indevidamente mesmo com evidência presente no SSW.
        const ctrcCard = (card as Record<string, unknown>)["ctrc"] as string | null | undefined;
        // Caio 2026-05-15 (multi-operador): passa responsavel_relacionamento
        // pra resolver creds SSW do operador do card. Sem isso, executor usa
        // creds Larissa pra cards do Duilio → login falha → falso negativo.
        const respCard = (card as Record<string, unknown>)["responsavel_relacionamento"] as string | null | undefined;
        const checkEvidencia = await temEvidenciaParaOc(
          supabase, nfCard, cnpjPagador, codOcorrenciaCard, ctrcCard ?? null, respCard ?? null,
        );
        if (checkEvidencia.status !== "ok_com_foto_correlacionada") {
          const motivo = checkEvidencia.status === "scrape_indisponivel"
            ? checkEvidencia.motivo
            : checkEvidencia.status;
          throw new Error(
            `Evidencia ausente pra oc=${codOcorrenciaCard} nf=${nfCard} — email bloqueado (status: ${motivo})`
          );
        }
      }
      // Sem validar (oc=49 sem flag): gera token mesmo assim — scraper de
      // /r vai mostrar "indisponível" se foto não existir, sem mostrar foto
      // de oc errada (correção da migration 055). Sem dano se template tiver
      // {link_evidencia} mas SSW não tiver foto.

      const expiraEm = novaExpiracaoTokenEvidencia();
      const { data: tokenRow } = await supabase
        .from("tokens_evidencia")
        .insert({
          card_id: m.card_id,
          todo_id: m.todo_id,
          cnpj_pagador: cnpjPagador,
          nf: nfCard,
          cod_ocorrencia: codOcorrenciaCard,
          expira_em: expiraEm,
        })
        .select("id")
        .single();

      if (tokenRow?.id) {
        // Vercel hospeda a página HTML auto-submit (Supabase força text/plain).
        const baseEvidencia = Deno.env.get("EVIDENCIA_BASE_URL") ?? "https://cockpit-r-evidencia.vercel.app";
        linkEvidencia = `${baseEvidencia}/r?t=${tokenRow.id}`;
      }
      } // fim do bloco geração de link (sempre executa agora — Caio 2026-05-29)
    }
  }

  // Caio 2026-05-29 (agente oc=49): se o operador aprovou um todo vindo da
  // sugestão IA (templates EXTRAVIO_PARCIAL / EXTRAVIO_TOTAL_PEDIR_ROMANEIO),
  // popula n_volumes_falta + qtde_volumes a partir de analise_padrao_resultado.
  // args.n_volumes_falta tem precedência (caso operador edite no modal).
  const analisePadrao = (card.analise_padrao_resultado ?? {}) as Record<string, unknown>;
  const qtdExtraviadosIA = analisePadrao["qtd_volumes_extraviados"] as number | null | undefined;
  const qtdNfIA = analisePadrao["qtd_volumes_nf"] as number | null | undefined;
  const nVolumesFaltaArg = args["n_volumes_falta"] as string | number | undefined;
  const nVolumesFalta =
    nVolumesFaltaArg != null && String(nVolumesFaltaArg).trim() !== ""
      ? String(nVolumesFaltaArg)
      : qtdExtraviadosIA != null
        ? String(qtdExtraviadosIA)
        : "";
  const qtdeVolumesCard = (card.qtde_volumes as number | null | undefined) ?? qtdNfIA ?? null;

  const vars: Record<string, string> = {
    nome_cliente: nomeCliente,
    primeiro_nome: primeiroNome,
    // {saudacao} (templates RESPOSTA_*: "Notado {saudacao},") = nome da pessoa.
    // Sem nome vira "Notado," limpo no bloco de fallback abaixo (mig 225).
    saudacao: primeiroNome,
    nf: (card.nf as string | null) ?? "",
    empresa: nomeCliente,
    operadora_nome: operadoraNome,
    cidade_destino: (agentState["cidade_destino"] as string | null) ?? "",
    previsao_atual: (agentState["previsao_entrega"] as string | null) ?? "",
    descricao_problema: (agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "",
    n_volumes_falta: nVolumesFalta,
    qtde_volumes: qtdeVolumesCard != null ? String(qtdeVolumesCard) : "",
    link_evidencia: linkEvidencia,
  };

  const renderTemplate = (s: string): string =>
    s.replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? `{${key}}`);

  // Assunto: prioridade assuntoOverride (Larissa editou no modal) > template
  // > fallback. Placeholders são renderizados em qualquer um dos casos.
  const assuntoBase = assuntoOverride
    ?? (template?.assunto as string | undefined)
    ?? `Mensagem Sal Express — NF ${vars.nf}`;
  const assuntoFinal = renderTemplate(assuntoBase);

  // Corpo: textoCustomizado tem prioridade (Larissa editou no Cockpit).
  // Senão, renderiza template normalmente.
  let corpoFinal = textoCustomizado
    ? renderTemplate(textoCustomizado)
    : renderTemplate(template!.corpo_template as string);

  // Caio 2026-06-20 (mig 225): sem nome da pessoa, a saudação vira genérica:
  //   1 destinatário   → "Prezado(a),"
  //   > 1 destinatário → "Pessoal,"
  // (substitui o antigo "Olá," neutro). Cobre "Olá, !", "Olá ,",
  // "Prezado(a) ," e "Notado ," (templates RESPOSTA_*). Espelha a RPC
  // preview_email_todo pra preview == envio.
  if (primeiroNome === "") {
    const _fb = _numDestinatarios > 1 ? "Pessoal" : "Prezado(a)";
    corpoFinal = corpoFinal
      .replace(/^Olá,\s*!/, `${_fb},`)
      .replace(/^Olá\s+,/, `${_fb},`)
      .replace(/^Prezado\(a\)\s+,/, `${_fb},`)
      .replace(/^Notado\s+,/, "Notado,");
  }

  return {
    destinatario: emailDestino,
    cc: emailCc,
    subject: assuntoFinal,
    texto: corpoFinal,
    fromName: operadoraNome,
    templateId: templateId ?? null,
    origemTexto: textoCustomizado ? "operador_manual" : "template",
  };
}

// =============================================================================
// lancarOcViaEnvelope — adapter Caio 2026-06-22 (NF 376924).
//
// Os handlers de ressarcimento/reversão/notificação (combo 33+44, oc=33 solo,
// PRATI, email-livre+33) historicamente chamavam `lancarOcorrenciaPortal` CRU,
// sem o envelope `lancarSswPortal`. Isso violava a REGRA CRÍTICA do CLAUDE.md
// ("TODO lançamento passa pelo envelope") e abria 3 buracos:
//   (1) NÃO gravava em acoes_executadas_ssw → o guard de CONFLITOS
//       (flagConflitoOcSemMover) ficava cego e re-flaggava a PRÓPRIA oc do
//       Cockpit como conflito (caso âncora NF 376924: oc=33 reversão aprovada
//       pela Larissa virou CONFLITOS 54→33);
//   (2) sem idempotência (UNIQUE card_id+oc+ctrc) → risco de lançar 2x em
//       redelivery do PGMQ;
//   (3) sem guard tripé CTRC+NF antes do submit.
//
// Este adapter roteia pelo envelope e devolve o MESMO shape
// { ok, error?, raw_response_snippet? } que esses handlers já consomem — assim
// o blast radius do refator fica em 1 bloco por handler (só a chamada de
// lançamento muda; card_events/state/anexos ficam idênticos).
//
// permitirLocalizacaoBaixada=true: oc=33/44 de reversão/ressarcimento rodam
// LEGITIMAMENTE sobre CTRC já baixado por devolução (oc=30) — a checagem (c) do
// tripé (localização encerrada) é dispensada nesse contexto, igual ao override
// `forcar_lancamento_ctrc_baixado` (NF 919611). As checagens (a) CTRC e (b) NF
// — as que evitam o desastre "CTRC errado" da REGRA CRÍTICA — CONTINUAM valendo.
async function lancarOcViaEnvelope(
  supabase: SupabaseClient,
  card: { id: string; nf: string; ctrc: string },
  codigoSsw: number,
  texto: string,
  imagens: AnexoBytes[],
  todoId: string,
): Promise<{ ok: boolean; error?: string; raw_response_snippet?: string }> {
  const r = await lancarSswPortal({
    supabase,
    env: Deno.env.toObject(),
    card,
    codigoSsw,
    texto,
    imagens,
    todoId,
    permitirLocalizacaoBaixada: true,
  });
  if (r.ok) {
    return { ok: true, raw_response_snippet: r.protocolo };
  }
  return { ok: false, error: r.error };
}

// =============================================================================
// gateOc33Enforce — gate AUTORITATIVO da oc 33 no extravio parcial (Caio
// 2026-07-01, NF 66193). Lê o dossiê VIVO do card na hora de lançar (evidências
// podem ter chegado depois da proposta). Só bloqueia quando TUDO isto vale:
//   (1) flag `extravio_parcial_gate_enforce` = ON (shadow-first: OFF só observa),
//   (2) card é extravio parcial (agent_state.extravio_parcial.caso setado),
//   (3) a oc 33 é de COMPLETUDE e o dossiê está incompleto (ou OPERACIONAL sem
//       romaneio), e
//   (4) o operador NÃO forçou via extras.forcar_oc33_dossie_incompleto.
// Fora disso → não bloqueia (extravio total e demais fluxos intactos).
// =============================================================================
async function gateOc33Enforce(
  supabase: SupabaseClient,
  cardId: string,
  ehCombo: boolean,
  extras: Record<string, unknown>,
): Promise<{ bloquear: boolean; faltando: string[]; forcado: boolean; natureza: "operacional" | "completude" | null }> {
  const sem = { bloquear: false, faltando: [] as string[], forcado: false, natureza: null as "operacional" | "completude" | null };

  const { data: flag } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", "extravio_parcial_gate_enforce")
    .maybeSingle();
  if ((flag as { enabled?: boolean } | null)?.enabled !== true) return sem;

  const { data: card } = await supabase
    .from("cards")
    .select("agent_state")
    .eq("id", cardId)
    .maybeSingle();
  const estado = lerExtravioParcial(card as { agent_state?: Record<string, unknown> } | null);
  if (!estado) return sem;

  // Natureza depende do CASO: combo é OPERACIONAL (romaneio-only) SÓ no Caso 2;
  // Caso 1 (e fallback conservador) → COMPLETUDE (exige as 3). Espelha classificarOc33.
  const natureza: "operacional" | "completude" = ehCombo && estado.caso === "2" ? "operacional" : "completude";
  const decisao = decidirGateOc33(natureza, estado.dossie ?? dossieVazio());
  if (!decisao.bloqueada) return { ...sem, natureza };

  const forcado = extras["forcar_oc33_dossie_incompleto"] === true ||
    extras["forcar_oc33_dossie_incompleto"] === "true";
  return { bloquear: !forcado, faltando: decisao.faltando, forcado, natureza };
}

// =============================================================================
// marcarDossieFresco — patch das flags de progresso do dossiê (oc33_operacional_
// lancada / indenizacao_completa) LENDO o agent_state FRESCO na hora (Emenda 4
// Codex): entre o dispatch e a marcação o sync-bastao pode ter reescrito o
// agent_state — usar o snapshot velho do dispatch sobrescreveria. No-op quando o
// card não é extravio parcial. Retorna true se marcou.
// =============================================================================
async function marcarDossieFresco(
  supabase: SupabaseClient,
  cardId: string,
  patch: { oc33_operacional_lancada?: boolean; indenizacao_completa?: boolean },
): Promise<boolean> {
  const { data: fresh } = await supabase
    .from("cards")
    .select("agent_state")
    .eq("id", cardId)
    .maybeSingle();
  const agentState = (fresh as { agent_state?: Record<string, unknown> } | null)?.agent_state;
  if (!agentState || !agentState["extravio_parcial"]) return false; // não é parcial → no-op
  const novo = marcarDossie(agentState, patch);
  const { error } = await supabase.from("cards").update({ agent_state: novo }).eq("id", cardId);
  return !error;
}

// =============================================================================
// reanexarEvidenciaDoDossie — re-baixa uma evidência (romaneio/descrição/valor)
// que veio em ANEXO da 1ª resposta (apagado do bucket pós-envio) via
// reprocessar-anexos-mensagem e devolve o email_anexos.id ATIVO que bate com a
// ref do dossiê (filename+size+mime). null se não conseguir.
// =============================================================================
async function reanexarEvidenciaDoDossie(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  ref: { message_inbox_id?: string | null; operador_id?: string | null; filename?: string | null; size_bytes?: number | null; mime_type?: string | null },
): Promise<string | null> {
  if (!ref.message_inbox_id) return null;
  let operadorEmail: string | null = null;
  if (ref.operador_id) {
    const { data: op } = await supabase.from("operadores").select("email").eq("id", ref.operador_id).maybeSingle();
    operadorEmail = (op as { email?: string } | null)?.email ?? null;
  }
  const url = env["SUPABASE_URL"] ?? Deno.env.get("SUPABASE_URL");
  const key = env["SUPABASE_SERVICE_ROLE_KEY"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/functions/v1/reprocessar-anexos-mensagem`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message_inbox_id: ref.message_inbox_id, operador_email: operadorEmail }),
    });
    const jsonRes = await res.json().catch(() => null) as
      | { ok?: boolean; anexos_disponiveis?: Array<{ id: string; filename: string; size_bytes: number; mime_type: string }> }
      | null;
    if (!jsonRes?.ok) return null;
    const match = acharAnexoDoDossie(jsonRes.anexos_disponiveis ?? [], {
      filename: ref.filename,
      size_bytes: ref.size_bytes,
      mime_type: ref.mime_type,
    });
    return match?.id ?? null;
  } catch (_e) {
    return null;
  }
}

// =============================================================================
// materializarOc33Completude (Emenda 2 + blockers 2/3 Codex; Caio 2026-07-17
// NF 135724 — materialização UNIVERSAL) — pra TODA oc 33 de COMPLETUDE (Caso 1
// E Caso 2):
//   - TEXTO sempre: desc+valor do dossiê SOMA com o texto do operador
//     (montarTextoOc33ComOperador) — anexo/texto do modal NÃO suprime mais o
//     dossiê (era o curto-circuito que deixou a NF 135724 sair só com
//     "Reversão de perdas iniciada." e sem descrição/valor no SSW);
//   - ANEXOS do dossiê: reanexa SÓ quando o operador NÃO anexou nada no modal
//     (os anexos dele valem — já passaram pela conversão PDF→JPEG do front;
//     reanexar por cima duplicaria: o dossiê referencia o PDF original);
//   - PDF cru NUNCA vai pro SSW (ssw1017 é upload de FOTO; o front sempre
//     converte) → evidência PDF sem anexo do operador entra em `faltando`
//     com instrução clara, e o handler REVERTE;
//   - imagem sintética quando o texto estoura o limite do SSW.
// Retorna `faltando[]` → handler REVERTE (não lança 33 de completude sem a
// evidência). No-op com flag OFF / card não-parcial (extravio total intacto).
// Flag: extravio_parcial_materializacao_enabled (mig 296). A antiga
// extravio_parcial_caso2_enabled segue valendo só pro Tier B-DV do relancar-54.
// =============================================================================
async function materializarOc33Completude(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  card: Record<string, unknown>,
  texto33In: string,
  anexosIdsIn: string[],
): Promise<{
  texto33: string;
  anexosIds: string[];
  imagensExtra: AnexoBytes[];
  faltando: string[];
  /** true = flag ON e card parcial (materialização rodou de fato). */
  ativo: boolean;
  /** desc/valor entrou no lançamento (texto, imagem ou anexo reanexado). */
  incluiuDescricaoValor: boolean;
  /** dossiê estava completo (3 evidências) no momento do lançamento. */
  dossieCompleto: boolean;
  reanexados: string[];
  imagemGerada: boolean;
}> {
  const vazio = {
    texto33: texto33In, anexosIds: anexosIdsIn, imagensExtra: [] as AnexoBytes[],
    faltando: [] as string[], ativo: false, incluiuDescricaoValor: false,
    dossieCompleto: false, reanexados: [] as string[], imagemGerada: false,
  };

  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", "extravio_parcial_materializacao_enabled").maybeSingle();
  if ((flag as { enabled?: boolean } | null)?.enabled !== true) return vazio;

  const estado = lerExtravioParcial(card as { agent_state?: Record<string, unknown> });
  if (!deveMaterializarCompletude(estado)) return vazio;
  const dossie = estado!.dossie;

  const operadorAnexou = anexosIdsIn.length > 0;
  const nf = (card["nf"] as string | null) ?? "";
  const anexosIds = [...anexosIdsIn];
  const imagensExtra: AnexoBytes[] = [];
  const faltando: string[] = [];
  const reanexados: string[] = [];
  let incluiuDvAnexo = false;

  // Auditoria 25/07 (NF 158084): "operador anexou" NÃO pode significar
  // "qualquer anexo" — um PNG de assinatura pulava a materialização inteira
  // e a oc 33 saía SEM o romaneio no SSW. Cobertura real é por FILENAME:
  // o próprio arquivo do romaneio (imagem) ou as páginas convertidas pelo
  // modal (`<base>_pN.jpg`). Anexos do operador SOMAM, não substituem.
  let romaneioCobertoPeloOperador = false;
  if (operadorAnexou && dossie.romaneio?.filename) {
    const { data: anexosSel } = await supabase
      .from("email_anexos")
      .select("filename")
      .in("id", anexosIdsIn);
    romaneioCobertoPeloOperador = anexosCobremRomaneio(
      ((anexosSel ?? []) as Array<{ filename: string | null }>).map((a) => a.filename),
      dossie.romaneio.filename,
    );
  }

  // TEXTO — sempre. Operador + dossiê somam; >500 → imagem com o texto ORIGINAL.
  const textoDossie = montarTextoDescricaoValor(dossie);
  const prep = montarTextoOc33ComOperador(texto33In, textoDossie, nf);
  let texto33 = prep.instrucao;

  // ROMANEIO — roda quando o operador não anexou nada OU quando a seleção
  // dele NÃO cobre o romaneio. Ação DEPENDE DA FONTE (emenda 1 Codex 2026-07-02):
  //   - "anexo"  → reanexa (se imagem); re-busca falhou → faltando (BLOQUEIA).
  //   - "ssw"    → evidência PROCESSUAL → NÃO reanexa, NÃO bloqueia; nota no texto.
  //   - ausente/desconhecida → conservador: não reanexa, não inventa, não bloqueia.
  const acaoRomaneio = decidirAcaoRomaneioCompletude(dossie);
  if (acaoRomaneio.tipo === "reanexar" && !romaneioCobertoPeloOperador) {
    if (!ehImagemMimeSsw(dossie.romaneio?.mime_type ?? null)) {
      faltando.push("romaneio (PDF — anexe pelo modal, que converte pra JPEG automaticamente)");
    } else {
      const id = await reanexarEvidenciaDoDossie(supabase, env, dossie.romaneio);
      if (id && !anexosIds.includes(id)) { anexosIds.push(id); reanexados.push("romaneio"); }
      else if (!id) faltando.push("romaneio");
    }
  } else if (acaoRomaneio.tipo === "processual" && !operadorAnexou) {
    texto33 = texto33.trim().length > 0
      ? `${texto33} | ${acaoRomaneio.nota}`.slice(0, LIMITE_TEXTO_SSW)
      : acaoRomaneio.nota;
  }

  // Descrição/valor que vieram em ANEXO precisam ir junto (blocker 3) — só
  // quando o operador não anexou nada (semântica original). Falha → faltando.
  if (!operadorAnexou) {
    for (const [rotulo, ev] of [
      ["descrição (anexo)", dossie.descricao],
      ["valor (anexo)", dossie.valor],
    ] as const) {
      if (!ev?.presente || ev.fonte !== "anexo") continue;
      if (!ehImagemMimeSsw(ev.mime_type ?? null)) {
        faltando.push(`${rotulo.replace(" (anexo)", "")} (PDF — anexe pelo modal, que converte pra JPEG automaticamente)`);
        continue;
      }
      const id = await reanexarEvidenciaDoDossie(supabase, env, ev);
      if (id) { anexosIds.push(id); reanexados.push(rotulo); incluiuDvAnexo = true; }
      else faltando.push(rotulo);
    }
  }

  // Imagem só quando o texto de desc/valor estourou o limite do SSW.
  let imagemGerada = false;
  if (prep.precisaImagem && prep.textoParaImagem) {
    try {
      const jpeg = await gerarJpegDescricaoValor(nf, prep.textoParaImagem);
      imagensExtra.push({ bytes: jpeg, filename: `descricao_valor_${nf}.jpg`, mimeType: "image/jpeg" });
      imagemGerada = true;
    } catch (_e) { /* imagem é best-effort; o resumo já foi pra instrução */ }
  }

  return {
    texto33, anexosIds, imagensExtra, faltando,
    ativo: true,
    incluiuDescricaoValor: textoDossie.trim().length > 0 || incluiuDvAnexo,
    dossieCompleto: dossie.completo === true,
    reanexados,
    imagemGerada,
  };
}

// =============================================================================
// materializarTextoOc33 (Caio 2026-07-17, NF 135724) — versão TEXTO-only da
// materialização, pros handlers email+33 (romaneio interno e email livre), que
// montam os PRÓPRIOS anexos: injeta desc/valor do dossiê na Instrução (soma com
// o texto existente) e gera imagem sintética se estourar o SSW. Mesma flag e
// mesmo critério (completude, Caso 1 e 2) do materializador principal. No-op
// com flag OFF / card não-parcial (extravio total — caso comum desses handlers
// — passa intacto).
// =============================================================================
async function materializarTextoOc33(
  supabase: SupabaseClient,
  card: Record<string, unknown>,
  textoIn: string,
): Promise<{ texto: string; imagensExtra: AnexoBytes[]; ativo: boolean; incluiuDescricaoValor: boolean; dossieCompleto: boolean }> {
  const vazio = { texto: textoIn, imagensExtra: [] as AnexoBytes[], ativo: false, incluiuDescricaoValor: false, dossieCompleto: false };
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", "extravio_parcial_materializacao_enabled").maybeSingle();
  if ((flag as { enabled?: boolean } | null)?.enabled !== true) return vazio;
  const estado = lerExtravioParcial(card as { agent_state?: Record<string, unknown> });
  if (!deveMaterializarCompletude(estado)) return vazio;
  const nf = (card["nf"] as string | null) ?? "";
  const textoDossie = montarTextoDescricaoValor(estado!.dossie);
  const prep = montarTextoOc33ComOperador(textoIn, textoDossie, nf);
  const imagensExtra: AnexoBytes[] = [];
  if (prep.precisaImagem && prep.textoParaImagem) {
    try {
      const jpeg = await gerarJpegDescricaoValor(nf, prep.textoParaImagem);
      imagensExtra.push({ bytes: jpeg, filename: `descricao_valor_${nf}.jpg`, mimeType: "image/jpeg" });
    } catch (_e) { /* best-effort; o resumo já foi pra instrução */ }
  }
  return {
    texto: prep.instrucao,
    imagensExtra,
    ativo: true,
    incluiuDescricaoValor: textoDossie.trim().length > 0,
    dossieCompleto: estado!.dossie.completo === true,
  };
}

// =============================================================================
// processarComboPortal33_44 — combo de ressarcimento via portal SSW interno.
// Caio 2026-05-12 (NF 920161):
//   1. Larissa aprovou tool='lancar_combo_33_44' com extras:
//        texto_descricao (oc=33), anexos_ids[] (imagens romaneio),
//        combo_44.{quantidade_volumes, motivo, filial} (oc=44).
//   2. Backend NÃO usa WebAPI nesse caso (campo `imagem` singular não
//      suporta N imagens). Usa portal interno opção 101 — mesmo caminho
//      que Larissa faz manual.
//   3. Lança oc=33 com texto + N imagens via lancarOcorrenciaPortal.
//   4. Se OK, lança oc=44 com texto agregado (volumes/motivo/filial).
//   5. Ambas OK → card vai pra ACAO_EXECUTADA com cod_ultima=44.
//   6. Falha oc=33: reverter_acao_falhou normal.
//   7. Falha oc=44 pós oc=33 OK: card vai pra AVH+lock com acao_falhou_motivo
//      explícito mencionando que 33 já foi lançada — retentar só a 44.
// =============================================================================
async function processarComboPortal33_44(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  m: QueueMessage["message"],
  job: QueueMessage,
  summary: RunSummary,
  card: Record<string, unknown>,
): Promise<void> {
  const nf = card["nf"] as string | null;
  const ctrcCard = card["ctrc"] as string | null;
  if (!nf || !ctrcCard) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: "Card sem nf/ctrc — combo não pode rodar" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "Combo 33+44 não pôde rodar — card sem nf/ctrc.",
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  const args = m.proposta_payload.args as Record<string, unknown>;
  const extras = (args["extras"] ?? {}) as Record<string, unknown>;
  const texto33 = (extras["texto_descricao"] as string | undefined)?.trim() ?? "";
  const anexosIds = Array.isArray(extras["anexos_ids"])
    ? (extras["anexos_ids"] as string[]).filter((s) => typeof s === "string")
    : [];

  // Gate autoritativo (extravio parcial): combo 33+44 é OPERACIONAL — exige só o
  // romaneio. Bloqueia (quando enforce ON) se o dossiê não tem romaneio.
  {
    const gate = await gateOc33Enforce(supabase, m.card_id, /*ehCombo*/ true, extras);
    if (gate.bloquear) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Combo 33+44 bloqueado: extravio parcial sem romaneio no dossiê (faltam: ${gate.faltando.join(", ")}). Anexe o romaneio ou force com extras.forcar_oc33_dossie_incompleto.`,
      });
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33BloqueadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { fonte: "executor_enforce", tool: "lancar_combo_33_44", natureza: gate.natureza, faltando: gate.faltando, todo_id: m.todo_id },
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    if (gate.forcado) {
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33ForcadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { tool: "lancar_combo_33_44", natureza: gate.natureza, todo_id: m.todo_id },
      });
    }
  }

  const combo44 = (extras["combo_44"] ?? {}) as Record<string, unknown>;
  const volumes44 = (combo44["quantidade_volumes"] as string | number | undefined) ?? "";
  const motivo44 = (combo44["motivo"] as string | undefined)?.trim() ?? "";
  const filial44 = (combo44["filial"] as string | undefined)?.trim() ?? "";

  // Caio 2026-06-24 (NF 59299): a oc=44 do combo TAMBÉM exige volumes + motivo —
  // o setor de Devolução não trata sem isso. Guarda ANTES de lançar a oc=33 no
  // SSW (33 não tem rollback), pra não deixar um combo meio-lançado por falta de
  // dado do modal. Espelha camposObrigatoriosAusentes(44) do fluxo standalone.
  const faltandoCombo44 = camposObrigatoriosAusentes(44, {
    quantidade_volumes: volumes44,
    motivo: motivo44,
  });
  if (faltandoCombo44.length > 0) {
    await supabase.from("todos")
      .update({
        status: "falhou",
        rejection_reason: `Combo 33+44: oc=44 exige ${faltandoCombo44.join(", ")} — preencher no modal.`,
      })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `Combo 33+44 não rodou: oc=44 sem campo(s) obrigatório(s): ${faltandoCombo44.join(", ")}.`,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Anexos do romaneio são OPCIONAIS (Caio 2026-05-14). Em alguns casos
  // não se aplica (ex: ressarcimento sem retorno físico).
  let carregados: Awaited<ReturnType<typeof carregarAnexos>> = [];
  let imagens: Array<{ bytes: Uint8Array; filename: string; mimeType: string }> = [];
  if (anexosIds.length > 0) {
    carregados = await carregarAnexos(supabase, anexosIds);
    if (carregados.length === 0) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Combo 33+44 falhou: anexos_ids fornecidos mas nenhum carregou do bucket. anexos_ids=${anexosIds.join(",")}`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    imagens = carregados.map((a) => {
      const binStr = atob(a.content_base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      return { bytes, filename: a.filename, mimeType: a.mime_type };
    });
  }

  // 2-3. Lança oc=33 (texto + N imagens) via envelope lancarSswPortal
  // (Caio 2026-06-22, NF 376924): idempotência + guard tripé + registro em
  // acoes_executadas_ssw. Antes chamava lancarOcorrenciaPortal cru.
  const result33 = await lancarOcViaEnvelope(
    supabase,
    { id: m.card_id, nf, ctrc: ctrcCard },
    33,
    // Caio 2026-07-01 (NF 66193): 500 (não 70) — a descrição/valor do extravio
    // parcial precisa chegar inteira. lancarOcorrenciaPortal já divide f6(70)+observ(500).
    texto33.slice(0, 500),
    imagens,
    m.todo_id,
  );

  // Audit log + card_event pra oc=33
  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: result33.ok ? "AcaoExecutadaPortalParte1" : "AcaoFalhouPortalParte1",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      tool: "lancar_combo_33_44",
      codigo_ssw: 33,
      via: "portal_interno",
      n_imagens: imagens.length,
      anexos_ids: anexosIds,
      ok: result33.ok,
      error: result33.ok ? null : (result33 as { error?: string }).error,
      raw: result33.ok ? (result33 as { raw_response_snippet?: string }).raw_response_snippet : null,
    },
  });

  if (!result33.ok) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: (result33 as { error?: string }).error?.slice(0, 500) ?? "oc=33 falhou no portal SSW" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `Combo 33+44: oc=33 FALHOU no portal SSW: ${(result33 as { error?: string }).error?.slice(0, 300) ?? "erro desconhecido"}. Nenhuma oc foi lançada.`,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Emenda 4 (Codex): oc 33 OPERACIONAL saiu OK → marca oc33_operacional_lancada
  // AGORA (mesmo se a oc 44 falhar depois — a 1ª oc 33 já foi lançada e destravou
  // a devolução). Lê agent_state FRESCO. No-op se não for extravio parcial.
  if (await marcarDossieFresco(supabase, m.card_id, { oc33_operacional_lancada: true })) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc33OperacionalLancada",
      actor_type: "agent",
      actor_id: "executor",
      payload: { tool: "lancar_combo_33_44", todo_id: m.todo_id },
    });
  }

  // 4. Lança oc=44 com texto agregado (volumes/motivo/filial)
  const texto44Partes: string[] = [];
  if (volumes44) texto44Partes.push(`Volumes: ${volumes44}`);
  if (motivo44) texto44Partes.push(`Motivo: ${motivo44}`);
  if (filial44) texto44Partes.push(`Filial: ${filial44}`);
  const texto44 = texto44Partes.join(" | ").slice(0, 70);

  const result44 = await lancarOcViaEnvelope(
    supabase,
    { id: m.card_id, nf, ctrc: ctrcCard },
    44,
    texto44,
    [], // oc=44 não leva imagem
    m.todo_id,
  );

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: result44.ok ? "AcaoExecutadaPortalParte2" : "AcaoFalhouPortalParte2",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      tool: "lancar_combo_33_44",
      codigo_ssw: 44,
      via: "portal_interno",
      texto: texto44,
      ok: result44.ok,
      error: result44.ok ? null : (result44 as { error?: string }).error,
      parte1_status: "ok",
    },
  });

  if (!result44.ok) {
    // oc=33 já foi lançada. Não dá pra rollback. Card vai pra AVH com aviso.
    const motivoFalha44 = `Combo 33+44: oc=33 LANÇADA no SSW (portal) com sucesso, MAS oc=44 FALHOU: ${(result44 as { error?: string }).error?.slice(0, 250) ?? "erro desconhecido"}. Retentar SOMENTE a oc=44 manualmente (não re-lançar 33).`;
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: motivoFalha44.slice(0, 500) })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: motivoFalha44,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Par sugestão×decisão (Fase 0): este caminho lança por conta própria e dá
  // return antes do ponto de feedback do processOne — sem isto, o combo 33+44
  // some do placar dos agentes.
  await registrarFeedbackImplicitoAgentes(supabase, m.card_id, 33);

  // 5. Ambas OK — card vai pra ACAO_EXECUTADA com cod_ultima=44 (regra geral)
  const agora = new Date().toISOString();
  // Caio 2026-05-25 (NF 29920): em cadeia de lançamentos, card.cod_ultima_ocorrencia
  // já foi sobrescrito por lançamento anterior. Fonte canônica de "que Bastão
  // tinha" = agent_state.cod_ultima_ocorrencia (sync-bastao popula, executor
  // nunca toca). Fallback retrocompat pro field do card.
  const agentStateCombo = (card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null;
  const ocBastaoNoLancamento =
    ((agentStateCombo?.["cod_ultima_ocorrencia"] as number | null | undefined) ?? null) ??
    (card["cod_ultima_ocorrencia"] as number | null);
  const bastaoUpdatedAtNoLancamento = (((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.["bastao_updated_at"] as string | null | undefined) ?? null;
  const bastaoPendenciaIdNoLancamento = (card as Record<string, unknown>)["bastao_pendencia_id"] as string | null;

  await supabase.from("todos")
    .update({ status: "executando" })
    .eq("id", m.todo_id);

  await supabase.from("cards")
    .update({
      state: "ACAO_EXECUTADA",
      lock_aguardando_validacao: true,
      acao_executada_em: agora,
      cod_ultima_ocorrencia: 44,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
      acao_falhou_motivo: null,
      aviso_alteracao_oc: null,
      ia_sugestao_oc_resposta: null,
      cliente_respondeu_em: null,
    })
    .eq("id", m.card_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "ComboPortalConcluido",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      via: "portal_interno",
      oc_33_ok: true,
      oc_44_ok: true,
      n_imagens: imagens.length,
      state_novo: "ACAO_EXECUTADA",
      cod_ultima: 44,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
    },
  });

  // Caio 2026-05-13 (Fase 2): tenta confirmar via SSW interno on-time.
  await tentarConfirmarPosLancamento(supabase, m.card_id, "combo33+44");

  // Cleanup: deleta anexos do bucket (mesma regra dos outros uploads SSW)
  await finalizarAnexosPosEnvio(supabase, carregados.map((c) => ({
    storage_path: c.storage_path,
    meta_id: c.meta_id,
  })));

  await deletarMsgExecutor(supabase, job);
  summary.executed++;
}

// =============================================================================
// processarOc33SoloPortal — oc=33 standalone via portal SSW interno.
// Caio 2026-05-12: 7ª opção pós-resposta cliente. Mesma estrutura do combo
// 33+44 (texto + N imagens do romaneio via opção 101) mas SEM encadear oc=44.
// Usado quando Perdas precisa iniciar indenização mas cliente não autorizou
// devolução (ou já há outra tratativa pra logística do volume).
// =============================================================================
async function processarOc33SoloPortal(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  m: QueueMessage["message"],
  job: QueueMessage,
  summary: RunSummary,
  card: Record<string, unknown>,
): Promise<void> {
  const nf = card["nf"] as string | null;
  const ctrcCard = card["ctrc"] as string | null;
  if (!nf || !ctrcCard) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: "Card sem nf/ctrc — oc=33 solo não pode rodar" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "oc=33 solo não pôde rodar — card sem nf/ctrc.",
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  const args = m.proposta_payload.args as Record<string, unknown>;
  const extras = (args["extras"] ?? {}) as Record<string, unknown>;
  let texto33 = (extras["texto_descricao"] as string | undefined)?.trim() ?? "";
  let anexosIds = Array.isArray(extras["anexos_ids"])
    ? (extras["anexos_ids"] as string[]).filter((s) => typeof s === "string")
    : [];

  // Gate autoritativo (extravio parcial): oc 33 SOLO é de COMPLETUDE — exige as
  // 3 evidências (romaneio + descrição + valor). Bloqueia (enforce ON) se o
  // dossiê está incompleto e o operador não forçou.
  {
    const gate = await gateOc33Enforce(supabase, m.card_id, /*ehCombo*/ false, extras);
    if (gate.bloquear) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `oc=33 de completude bloqueada: dossiê de extravio parcial incompleto (faltam: ${gate.faltando.join(", ")}). Cobre as evidências ou force com extras.forcar_oc33_dossie_incompleto.`,
      });
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33BloqueadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { fonte: "executor_enforce", tool: "lancar_oc33_solo_portal", natureza: gate.natureza, faltando: gate.faltando, todo_id: m.todo_id },
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    if (gate.forcado) {
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33ForcadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { tool: "lancar_oc33_solo_portal", natureza: gate.natureza, todo_id: m.todo_id },
      });
    }
  }

  // Caio 2026-07-17 (NF 135724): materialização UNIVERSAL da oc 33 de completude
  // (Caso 1 E Caso 2) — texto do dossiê SOMA com o do operador; anexos do dossiê
  // só quando o operador não anexou; imagem se estourar o SSW. No-op com flag
  // extravio_parcial_materializacao_enabled OFF / card não-parcial.
  const materializado = await materializarOc33Completude(supabase, env, card, texto33, anexosIds);
  // Blocker 2/3 (Codex): se uma evidência EXIGIDA (romaneio, ou descrição/valor
  // que veio em anexo) não pôde ser reanexada, NÃO lança a 33 de completude sem
  // ela — reverte com motivo claro pro operador tratar (re-anexar manual).
  if (materializado.faltando.length > 0) {
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `oc=33 de completude NÃO lançada: evidência pendente de anexo: ${materializado.faltando.join(", ")}. A oc 33 precisa de romaneio + descrição + valor anexados. Anexe pelo modal e reaprove.`,
    });
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc33CompletudeReanexoFalhou",
      actor_type: "agent",
      actor_id: "executor",
      payload: { tool: "lancar_oc33_solo_portal", faltando: materializado.faltando, todo_id: m.todo_id },
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }
  texto33 = materializado.texto33;
  anexosIds = materializado.anexosIds;

  // Anexos do romaneio são OPCIONAIS (Caio 2026-05-14). Em alguns casos
  // não se aplica (ex: ressarcimento sem retorno físico).
  let carregados: Awaited<ReturnType<typeof carregarAnexos>> = [];
  let imagens: Array<{ bytes: Uint8Array; filename: string; mimeType: string }> = [];
  if (anexosIds.length > 0) {
    carregados = await carregarAnexos(supabase, anexosIds);
    if (carregados.length === 0) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `oc=33 solo falhou: anexos_ids fornecidos mas nenhum carregou do bucket. anexos_ids=${anexosIds.join(",")}`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    imagens = carregados.map((a) => {
      const binStr = atob(a.content_base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      return { bytes, filename: a.filename, mimeType: a.mime_type };
    });
  }
  // Imagem gerada (desc/valor que estourou 500) entra direto como bytes.
  if (materializado.imagensExtra.length > 0) imagens = imagens.concat(materializado.imagensExtra);

  // 2-3. Lança oc=33 (texto + N imagens) via envelope lancarSswPortal
  // (Caio 2026-06-22, NF 376924): idempotência + guard tripé + registro em
  // acoes_executadas_ssw. Antes chamava lancarOcorrenciaPortal cru.
  const result33 = await lancarOcViaEnvelope(
    supabase,
    { id: m.card_id, nf, ctrc: ctrcCard },
    33,
    // Caio 2026-07-01 (NF 66193): 500 (não 70) — a descrição/valor do extravio
    // parcial precisa chegar inteira. lancarOcorrenciaPortal já divide f6(70)+observ(500).
    texto33.slice(0, 500),
    imagens,
    m.todo_id,
  );

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: result33.ok ? "AcaoExecutadaPortal" : "AcaoFalhouPortal",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      tool: "lancar_oc33_solo_portal",
      codigo_ssw: 33,
      via: "portal_interno",
      n_imagens: imagens.length,
      anexos_ids: anexosIds,
      ok: result33.ok,
      error: result33.ok ? null : (result33 as { error?: string }).error,
      raw: result33.ok ? (result33 as { raw_response_snippet?: string }).raw_response_snippet : null,
    },
  });

  if (!result33.ok) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: (result33 as { error?: string }).error?.slice(0, 500) ?? "oc=33 falhou no portal SSW" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `oc=33 solo FALHOU no portal SSW: ${(result33 as { error?: string }).error?.slice(0, 300) ?? "erro desconhecido"}.`,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Caio 2026-07-17 (NF 135724): auditabilidade — registra O QUE a materialização
  // levou pro SSW (texto do dossiê, anexos reanexados, imagem sintética).
  if (materializado.ativo) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc33CompletudeMaterializada",
      actor_type: "agent",
      actor_id: "executor",
      payload: {
        tool: "lancar_oc33_solo_portal",
        todo_id: m.todo_id,
        incluiu_descricao_valor: materializado.incluiuDescricaoValor,
        dossie_completo: materializado.dossieCompleto,
        reanexados: materializado.reanexados,
        imagem_gerada: materializado.imagemGerada,
        texto_len: texto33.length,
      },
    });
  }

  // Emenda 4 (Codex): oc 33 de COMPLETUDE saiu OK → indenizacao_completa (handoff
  // pro Ressarcimento concluído). agent_state FRESCO. No-op se não for parcial.
  // Caio 2026-07-17 (NF 135724): HONESTIDADE do estado — com a materialização
  // ATIVA, só marca handoff concluído se o dossiê estava COMPLETO no lançamento
  // (a NF 135724 marcou indenizacao_completa sem desc/valor ter chegado no SSW).
  // Flag OFF (materialização inativa) → comportamento atual preservado (marca).
  const podeMarcarCompleta = !materializado.ativo || materializado.dossieCompleto;
  if (podeMarcarCompleta && await marcarDossieFresco(supabase, m.card_id, { indenizacao_completa: true })) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc33CompletudeLancada",
      actor_type: "agent",
      actor_id: "executor",
      payload: { tool: "lancar_oc33_solo_portal", todo_id: m.todo_id },
    });
  }

  // 4. Sucesso — card vai pra ACAO_EXECUTADA com cod_ultima=33
  const agora = new Date().toISOString();
  const ocBastaoNoLancamento = (card["cod_ultima_ocorrencia"] as number | null);
  const bastaoUpdatedAtNoLancamento = (((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.["bastao_updated_at"] as string | null | undefined) ?? null;
  const bastaoPendenciaIdNoLancamento = (card as Record<string, unknown>)["bastao_pendencia_id"] as string | null;

  await supabase.from("todos")
    .update({ status: "executando" })
    .eq("id", m.todo_id);

  await supabase.from("cards")
    .update({
      state: "ACAO_EXECUTADA",
      lock_aguardando_validacao: true,
      acao_executada_em: agora,
      cod_ultima_ocorrencia: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
      acao_falhou_motivo: null,
      aviso_alteracao_oc: null,
      ia_sugestao_oc_resposta: null,
      cliente_respondeu_em: null,
    })
    .eq("id", m.card_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "Oc33SoloPortalConcluido",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      via: "portal_interno",
      n_imagens: imagens.length,
      state_novo: "ACAO_EXECUTADA",
      cod_ultima: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
    },
  });

  // Caio 2026-05-13 (Fase 2): tenta confirmar via SSW interno on-time.
  await tentarConfirmarPosLancamento(supabase, m.card_id, "oc33-solo");

  await finalizarAnexosPosEnvio(supabase, carregados.map((c) => ({
    storage_path: c.storage_path,
    meta_id: c.meta_id,
  })));

  await deletarMsgExecutor(supabase, job);
  summary.executed++;
}

// =============================================================================
// processarEmailELancar33ViaRomaneio — PRATI feature (Caio 2026-05-12).
// Fluxo:
//   1. Envia email formal (template EXTRAVIO_TOTAL_NOTIFICACAO ou similar
//      do cliente_config). Se falhar, registra evento e SEGUE — oc=33 lança
//      mesmo assim.
//   2. Busca romaneio na plataforma interna Sal Express. Se achar: pega JPEGs
//      direto. Senão: JPEG sintético "não encontrado". Erro plataforma: JPEG
//      sintético de erro.
//   3. Lança oc=33 via portal SSW interno (mesma cadeia do combo) com texto
//      + N imagens.
//   4. Sucesso: card → ACAO_EXECUTADA, cod_ultima=33. NÃO encadeia oc=54.
//   5. Falha oc=33: reverter_acao_falhou normal.
// =============================================================================
async function processarEmailELancar33ViaRomaneio(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  m: QueueMessage["message"],
  job: QueueMessage,
  summary: RunSummary,
  card: Record<string, unknown>,
): Promise<void> {
  const nf = card["nf"] as string | null;
  const ctrcCard = card["ctrc"] as string | null;
  if (!nf || !ctrcCard) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: "Card sem nf/ctrc — Email+oc33 (romaneio interno) não pode rodar" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "Email+oc33 (romaneio interno) não pôde rodar — card sem nf/ctrc.",
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  const args = m.proposta_payload.args as Record<string, unknown>;
  const extras = (args["extras"] ?? {}) as Record<string, unknown>;
  const textoCustomizado = (extras["texto_email_customizado"] as string | undefined) ?? null;
  const assuntoOverride = (extras["assunto_override"] as string | undefined) ?? null;
  const templateIdOverride = (extras["template_id_override"] as string | undefined) ?? null;
  const textoOc33 = ((extras["texto_oc33"] as string | undefined)?.trim() ||
    // Caio 2026-07-01 (NF 66193): 500 (não 70) — lancarOcorrenciaPortal já faz f6(70)+observ(500).
    "Extravio total - ressarcimento iniciado via romaneio interno").slice(0, 500);

  // Gate autoritativo (extravio parcial, Caio 2026-07-01): esta ação também lança
  // oc 33 → em card PARCIAL é COMPLETUDE. Bloqueia ANTES do e-mail (senão notifica
  // e falha a 33). Card não-parcial (o caso comum PRATI = extravio total) → no-op.
  {
    const gate = await gateOc33Enforce(supabase, m.card_id, /*ehCombo*/ false, extras);
    if (gate.bloquear) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email+oc 33 (romaneio interno) bloqueado: dossiê de extravio parcial incompleto (faltam: ${gate.faltando.join(", ")}). Cobre as evidências ou force com extras.forcar_oc33_dossie_incompleto.`,
      });
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33BloqueadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { fonte: "executor_enforce", tool: "enviar_email_e_lancar_33_romaneio_interno", natureza: gate.natureza, faltando: gate.faltando, todo_id: m.todo_id },
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    if (gate.forcado) {
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33ForcadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { tool: "enviar_email_e_lancar_33_romaneio_interno", natureza: gate.natureza, todo_id: m.todo_id },
      });
    }
  }

  // ───────────── 1. EMAIL ─────────────
  let emailOk = false;
  let emailMotivoFalha: string | null = null;
  let emailMessageId: string | null = null;
  let emailThreadId: string | null = null;
  let emailDestino: string | null = null;
  let emailCc: string[] = [];
  let emailSubject: string | null = null;

  // Caio 2026-06-10 (NF 156022): guard idempotência reutilizado pra fluxo
  // PRATI (email + oc=33 via romaneio interno). Mesma regra: 1 email por todo.
  const emailPraJaEnviadoPrati = await verificarEmailJaEnviado(supabase, m.todo_id);
  if (emailPraJaEnviadoPrati) {
    await registrarEmailSkipReenvio(supabase, {
      card_id: m.card_id,
      todo_id: m.todo_id,
      envio_anterior: emailPraJaEnviadoPrati,
      motivo: "Reexecução do todo (PRATI email+oc33). Email original preservado.",
    });
    emailOk = true;
    emailMessageId = emailPraJaEnviadoPrati.gmail_message_id;
    emailThreadId = emailPraJaEnviadoPrati.gmail_thread_id;
    emailDestino = emailPraJaEnviadoPrati.to_email;
    emailSubject = emailPraJaEnviadoPrati.subject;
    console.log(
      `[executor:prati] email skip pra todo ${m.todo_id} — já enviado em ${emailPraJaEnviadoPrati.sent_at}`,
    );
  }

  if (!emailPraJaEnviadoPrati) try {
    const emailPayload = await prepararEmailParaEnvio(
      supabase,
      m,
      textoCustomizado,
      assuntoOverride,
      templateIdOverride,
    );
    emailDestino = emailPayload.destinatario;
    emailCc = emailPayload.cc;

    // Caio 2026-06-16: continua a thread da tratativa (ver envio principal).
    const naoSeguirThreadPrati = extras["nao_seguir_thread"] === true;
    const threadTratativaPrati = naoSeguirThreadPrati
      ? null
      : await carregarThreadDaTratativaAtual(supabase, m.card_id);
    emailSubject = threadTratativaPrati?.subject_reply ?? emailPayload.subject;
    const extraHeadersPrati = threadTratativaPrati
      ? {
        ...(threadTratativaPrati.in_reply_to ? { "In-Reply-To": threadTratativaPrati.in_reply_to } : {}),
        ...(threadTratativaPrati.references ? { "References": threadTratativaPrati.references } : {}),
        ...(threadTratativaPrati.thread_index ? { "Thread-Index": threadTratativaPrati.thread_index } : {}),
      }
      : undefined;

    // Revisão 2026-07-22 (pré-merge PR #23): o EditarEmailModal agora atende
    // este fluxo e oferece o uploader de anexos (extras.anexos_ids) — antes
    // eram descartados silenciosamente (attachments hardcoded []). Mesma
    // semântica do caminho canônico lancar_oc_e_enviar_email.
    const anexosIdsPrati = Array.isArray(extras["anexos_ids"])
      ? (extras["anexos_ids"] as string[]).filter((s) => typeof s === "string")
      : [];
    const attachmentsPrati = anexosIdsPrati.length > 0
      ? await carregarAnexos(supabase, anexosIdsPrati)
      : [];

    const sendResult = await sendGmailMessage({
      supabase,
      operadorId: m.aprovado_por,
      destinatario: emailPayload.destinatario,
      cc: emailPayload.cc,
      subject: emailSubject,
      texto: emailPayload.texto,
      fromName: emailPayload.fromName,
      attachments: attachmentsPrati,
      threadId: threadTratativaPrati?.gmail_thread_id ?? null,
      extraHeaders: extraHeadersPrati,
    });

    if (!sendResult.ok) {
      emailMotivoFalha = sendResult.error ?? "erro desconhecido no envio Gmail";
    } else {
      emailOk = true;
      emailMessageId = sendResult.messageId;
      emailThreadId = sendResult.threadId;
      if (attachmentsPrati.length > 0) {
        await finalizarAnexosPosEnvio(
          supabase,
          attachmentsPrati.map((a) => ({ storage_path: a.storage_path, meta_id: a.meta_id })),
        );
      }

      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "RespostaEnviada",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          todo_id: m.todo_id,
          canal: "email",
          via: "gmail_oauth_inline",
          from: sendResult.from,
          destinatario: emailPayload.destinatario,
          cc: emailPayload.cc,
          subject: emailPayload.subject,
          gmail_message_id: sendResult.messageId,
          gmail_thread_id: sendResult.threadId,
          origem_texto: emailPayload.origemTexto,
          texto_preview: emailPayload.texto.slice(0, 300),
          anexos_count: 0,
          anexos_filenames: [],
          contexto: "extravio_total_romaneio_interno",
        },
      });

      if (sendResult.messageId && sendResult.threadId) {
        await supabase.from("cards_emails_outbound").insert({
          card_id: m.card_id,
          todo_id: m.todo_id,
          operadora_id: m.aprovado_por,
          gmail_message_id: sendResult.messageId,
          gmail_thread_id: sendResult.threadId,
          from_email: sendResult.from,
          to_email: emailPayload.destinatario,
          subject: emailPayload.subject,
          message_id_header: sendResult.messageIdHeader,
          corpo_renderizado: emailPayload.texto,
        });
      }
    }
  } catch (err) {
    emailMotivoFalha = err instanceof Error ? err.message : String(err);
  }

  if (!emailOk) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "EmailExtravioTotalFalhou",
      actor_type: "system",
      actor_id: "executor",
      payload: {
        todo_id: m.todo_id,
        motivo: emailMotivoFalha,
        observacao: "Email falhou mas oc=33 vai ser lançada mesmo assim (regra PRATI).",
      },
    });
  }

  // ───────────── 2. BUSCA ROMANEIO + PREPARA IMAGENS ─────────────
  let imagens: Array<{ bytes: Uint8Array; filename: string; mimeType: string }> = [];
  let romaneioStatus: "encontrado" | "nao_encontrado" | "erro_plataforma" = "nao_encontrado";
  let romaneioDocId: number | null = null;

  try {
    // SBD/Ingrid (Caio 2026-08-11): a chave de busca na plataforma é POR
    // CLIENTE — 'nf' (PRATI, default) ou 'numero_remessa_danfe' (Black &
    // Decker: resolve o Nº Remessa nos Dados Adicionais da NF-e via SSW
    // 101>DANFEs>XML e busca por ele). Falha na resolução NÃO trava: vira
    // evidência sintética + card_event e a oc 33 sobe (processo atual).
    let termoBusca = nf;
    let remessaFalhouMotivo: string | null = null;
    const agentStateBusca = (card["agent_state"] ?? {}) as Record<string, unknown>;
    const cnpjPagadorBusca =
      String(agentStateBusca["cnpj_pagador"] ?? card["pagador"] ?? "").replace(/\D/g, "");
    if (cnpjPagadorBusca) {
      const { data: cfgBusca } = await supabase
        .from("cliente_config")
        .select("romaneio_busca_chave")
        .eq("cnpj_pagador", cnpjPagadorBusca)
        .eq("ativo", true)
        .maybeSingle();
      if ((cfgBusca as { romaneio_busca_chave?: string } | null)?.romaneio_busca_chave === "numero_remessa_danfe") {
        try {
          const sessaoSsw = await obterSessaoSswInterno(readSswLancamentoEnv(Deno.env.toObject()));
          const r = await resolverNumeroRemessaViaDanfe(sessaoSsw, nf, ctrcCard);
          if (r.ok) {
            termoBusca = r.remessa;
          } else {
            remessaFalhouMotivo = `${r.motivo}${r.detalhe ? `: ${r.detalhe}` : ""}`;
          }
        } catch (err) {
          remessaFalhouMotivo = err instanceof Error ? err.message : String(err);
        }
        if (remessaFalhouMotivo) {
          await supabase.from("card_events").insert({
            card_id: m.card_id,
            event_type: "RemessaDanfeNaoExtraida",
            actor_type: "system",
            actor_id: "executor",
            payload: { nf, ctrc: ctrcCard, motivo: remessaFalhouMotivo, todo_id: m.todo_id },
          });
        }
      }
    }

    const romaneioEnv = readRomaneioEnv(Deno.env.toObject());
    const sessao = await obterSessaoRomaneio(romaneioEnv);
    if (remessaFalhouMotivo) {
      const jpeg = await gerarJpegRemessaNaoExtraida(nf, remessaFalhouMotivo);
      imagens = [{ bytes: jpeg, filename: `busca_remessa_${nf}.jpg`, mimeType: "image/jpeg" }];
    } else {
      const { encontrado, documento, jpegs } = termoBusca === nf
        ? await buscarFotosRomaneioPorNf(sessao, nf)
        : await buscarFotosRomaneioPorTermo(sessao, termoBusca);
      if (encontrado && jpegs.length > 0) {
        romaneioStatus = "encontrado";
        romaneioDocId = documento?.id ?? null;
        imagens = jpegs.map((bytes, i) => ({
          bytes,
          filename: `romaneio_${nf}_p${i + 1}.jpg`,
          mimeType: "image/jpeg",
        }));
      } else {
        const jpeg = await gerarJpegRomaneioNaoEncontrado(nf, new Date(), termoBusca);
        imagens = [{ bytes: jpeg, filename: `busca_${nf}.jpg`, mimeType: "image/jpeg" }];
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    romaneioStatus = "erro_plataforma";
    console.warn(`Romaneio plataforma erro pra NF ${nf}: ${msg}`);
    try {
      const jpeg = await gerarJpegErroPlataforma(nf, msg);
      imagens = [{ bytes: jpeg, filename: `busca_erro_${nf}.jpg`, mimeType: "image/jpeg" }];
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email${emailOk ? " enviado" : " falhou"}, mas falha em preparar imagem pra oc=33 (plataforma: ${msg.slice(0, 150)} / sintético: ${msg2.slice(0, 150)})`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
  }

  // Caio 2026-07-17 (NF 135724): card PARCIAL → injeta desc/valor do dossiê no
  // texto (soma; imagem se estourar). Extravio total (caso comum aqui) → no-op.
  const matTexto = await materializarTextoOc33(supabase, card, textoOc33);
  const textoOc33Final = matTexto.texto;
  if (matTexto.imagensExtra.length > 0) imagens = imagens.concat(matTexto.imagensExtra);

  // ───────────── 3. LANÇA oc=33 via portal SSW interno (envelope) ─────────────
  // Caio 2026-06-22 (NF 376924): via envelope lancarSswPortal — idempotência +
  // guard tripé + registro em acoes_executadas_ssw. Antes: lancarOcorrenciaPortal cru.
  const result33 = await lancarOcViaEnvelope(
    supabase,
    { id: m.card_id, nf, ctrc: ctrcCard },
    33,
    textoOc33Final,
    imagens,
    m.todo_id,
  );

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: result33.ok ? "AcaoExecutadaPortal" : "AcaoFalhouPortal",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      tool: "enviar_email_e_lancar_33_romaneio_interno",
      codigo_ssw: 33,
      via: "portal_interno",
      n_imagens: imagens.length,
      romaneio_status: romaneioStatus,
      romaneio_doc_id: romaneioDocId,
      email_ok: emailOk,
      email_motivo_falha: emailMotivoFalha,
      ok: result33.ok,
      error: result33.ok ? null : (result33 as { error?: string }).error,
    },
  });

  if (!result33.ok) {
    const errMsg = (result33 as { error?: string }).error ?? "erro desconhecido";
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: errMsg.slice(0, 500) })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `${emailOk ? "Email enviado" : "Email falhou"}, oc=33 FALHOU no portal SSW: ${errMsg.slice(0, 250)}. Retentar oc=33 manualmente.`,
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Par sugestão×decisão (Fase 0) — ver comentário no combo 33+44.
  await registrarFeedbackImplicitoAgentes(supabase, m.card_id, 33);

  // Emenda 4 (Codex): oc 33 de COMPLETUDE (email+33) saiu OK → indenizacao_completa.
  // Caio 2026-07-17 (NF 135724): honestidade — com materialização ATIVA, só marca
  // se o dossiê estava completo no lançamento. Flag OFF → comportamento atual.
  if ((!matTexto.ativo || matTexto.dossieCompleto) && await marcarDossieFresco(supabase, m.card_id, { indenizacao_completa: true })) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "Oc33CompletudeLancada",
      actor_type: "agent",
      actor_id: "executor",
      payload: { tool: "enviar_email_livre_e_lancar_oc33_portal", todo_id: m.todo_id },
    });
  }

  // ───────────── 4. SUCESSO — card vai pra ACAO_EXECUTADA ─────────────
  const agora = new Date().toISOString();
  const ocBastaoNoLancamento = card["cod_ultima_ocorrencia"] as number | null;
  const bastaoUpdatedAtNoLancamento = (((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.["bastao_updated_at"] as string | null | undefined) ?? null;
  const bastaoPendenciaIdNoLancamento = (card as Record<string, unknown>)["bastao_pendencia_id"] as string | null;

  const acaoFalhouMotivo = emailOk ? null
    : `Email NÃO foi enviado (${(emailMotivoFalha ?? "erro").slice(0, 200)}). oc=33 foi lançada normalmente.`;

  await supabase.from("todos")
    .update({ status: "executando" })
    .eq("id", m.todo_id);

  await supabase.from("cards")
    .update({
      state: "ACAO_EXECUTADA",
      lock_aguardando_validacao: true,
      acao_executada_em: agora,
      cod_ultima_ocorrencia: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
      acao_falhou_motivo: acaoFalhouMotivo,
      aviso_alteracao_oc: null,
      ia_sugestao_oc_resposta: null,
      cliente_respondeu_em: null,
    })
    .eq("id", m.card_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "EmailELancar33ViaRomaneioConcluido",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      via: "portal_interno",
      n_imagens: imagens.length,
      romaneio_status: romaneioStatus,
      romaneio_doc_id: romaneioDocId,
      email_ok: emailOk,
      email_motivo_falha: emailMotivoFalha,
      email_destino: emailDestino,
      email_cc: emailCc,
      email_subject: emailSubject,
      email_message_id: emailMessageId,
      email_thread_id: emailThreadId,
      state_novo: "ACAO_EXECUTADA",
      cod_ultima: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
    },
  });

  // Caio 2026-05-13 (Fase 2): tenta confirmar via SSW interno on-time.
  await tentarConfirmarPosLancamento(supabase, m.card_id, "prati-email+33");

  await deletarMsgExecutor(supabase, job);
  summary.executed++;
}

// =============================================================================
// processarEmailLivreELancarOc33Portal — Caio 2026-05-20
// Tool: enviar_email_livre_e_lancar_oc33_portal
// Caso âncora: NF 70080 (LARISSA, oc=49). Operador notifica cliente via email
// (texto LIVRE, sem template, sem aguardar resposta) E lança oc=33.
//
// Extras esperados em proposta_payload.args.extras:
//   email_destinatario:  string (obrigatório)
//   email_cc:            string[] (opcional)
//   email_subject:       string (obrigatório)
//   email_corpo:         string (obrigatório, texto puro)
//   email_anexos_ids:    string[] (opcional, UUIDs do bucket email_anexos)
//   oc33_texto:          string (opcional, descrição livre da oc=33)
//   oc33_anexos_ids:     string[] (opcional, mesmo bucket)
//
// Fluxo (igual padrão PRATI): envia email, depois lança oc=33. Se email
// falhar mas oc=33 OK, sucesso parcial registrado em acao_falhou_motivo.
// Se oc=33 falhar, reverte (mesmo se email já saiu).
//
// INV-011: passa ctrcEsperado=card.ctrc pra buscarNFInterno (NFs com múltiplos
// CTRCs precisam do CTRC do card pra evitar lançar em documento errado).
// =============================================================================
async function processarEmailLivreELancarOc33Portal(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  m: QueueMessage["message"],
  job: QueueMessage,
  summary: RunSummary,
  card: Record<string, unknown>,
): Promise<void> {
  const nf = card["nf"] as string | null;
  const ctrcCard = card["ctrc"] as string | null;
  if (!nf || !ctrcCard) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: "Card sem nf/ctrc — Email+oc33 livre não pode rodar" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "Email+oc33 livre não pôde rodar — card sem nf/ctrc.",
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  const args = m.proposta_payload.args as Record<string, unknown>;
  const extras = (args["extras"] ?? {}) as Record<string, unknown>;

  const emailDestinatario = (extras["email_destinatario"] as string | undefined)?.trim() ?? "";
  const emailCc = Array.isArray(extras["email_cc"])
    ? (extras["email_cc"] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  const emailSubject = (extras["email_subject"] as string | undefined)?.trim() ?? "";
  const emailCorpo = (extras["email_corpo"] as string | undefined)?.trim() ?? "";
  const emailAnexosIds = Array.isArray(extras["email_anexos_ids"])
    ? (extras["email_anexos_ids"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  // Caio 2026-07-01 (NF 66193): 500 (não 70) — descrição/valor do parcial inteira.
  const oc33Texto = ((extras["oc33_texto"] as string | undefined)?.trim() ?? "").slice(0, 500);
  const oc33AnexosIds = Array.isArray(extras["oc33_anexos_ids"])
    ? (extras["oc33_anexos_ids"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  if (!emailDestinatario || !emailSubject || !emailCorpo) {
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: "extras incompletos: email_destinatario/email_subject/email_corpo obrigatórios" })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: "Email+oc33 livre: faltou destinatario/assunto/corpo. Refaça a aprovação preenchendo os 3 campos.",
    });
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Gate autoritativo (extravio parcial): email+oc 33 é de COMPLETUDE. Bloqueia
  // ANTES de mandar o e-mail (senão notificaria o cliente e falharia a 33).
  {
    const gate = await gateOc33Enforce(supabase, m.card_id, /*ehCombo*/ false, extras);
    if (gate.bloquear) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email+oc 33 bloqueado: dossiê de extravio parcial incompleto (faltam: ${gate.faltando.join(", ")}). Cobre as evidências ou force com extras.forcar_oc33_dossie_incompleto.`,
      });
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33BloqueadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { fonte: "executor_enforce", tool: "enviar_email_livre_e_lancar_oc33_portal", natureza: gate.natureza, faltando: gate.faltando, todo_id: m.todo_id },
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    if (gate.forcado) {
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "Oc33ForcadaDossieIncompleto",
        actor_type: "agent",
        actor_id: "executor",
        payload: { tool: "enviar_email_livre_e_lancar_oc33_portal", natureza: gate.natureza, todo_id: m.todo_id },
      });
    }
  }

  // ───────────── 1. EMAIL ─────────────
  let emailOk = false;
  let emailMotivoFalha: string | null = null;
  let emailMessageId: string | null = null;
  let emailThreadId: string | null = null;

  // Caio 2026-06-10 (NF 156022): guard idempotência reutilizado pra fluxo
  // email livre + oc=33. Mesma regra: 1 email por todo.
  const emailJaEnviadoLivre = await verificarEmailJaEnviado(supabase, m.todo_id);
  if (emailJaEnviadoLivre) {
    await registrarEmailSkipReenvio(supabase, {
      card_id: m.card_id,
      todo_id: m.todo_id,
      envio_anterior: emailJaEnviadoLivre,
      motivo: "Reexecução do todo (email livre + oc=33). Email original preservado.",
    });
    emailOk = true;
    emailMessageId = emailJaEnviadoLivre.gmail_message_id;
    emailThreadId = emailJaEnviadoLivre.gmail_thread_id;
    console.log(
      `[executor:email_livre] skip pra todo ${m.todo_id} — já enviado em ${emailJaEnviadoLivre.sent_at}`,
    );
  }

  if (!emailJaEnviadoLivre) try {
    const emailAttachments = emailAnexosIds.length > 0
      ? await carregarAnexos(supabase, emailAnexosIds)
      : [];

    // Caio 2026-06-16: continua a thread da tratativa por padrão (override
    // `nao_seguir_thread` p/ thread nova). Diferente dos outros envios, aqui
    // PRESERVA o assunto digitado pelo operador (não vira "Re:"); o threadId já
    // agrupa no Gmail.
    const naoSeguirThreadLivre = extras["nao_seguir_thread"] === true;
    const threadTratativaLivre = naoSeguirThreadLivre
      ? null
      : await carregarThreadDaTratativaAtual(supabase, m.card_id);
    const extraHeadersLivre = threadTratativaLivre
      ? {
        ...(threadTratativaLivre.in_reply_to ? { "In-Reply-To": threadTratativaLivre.in_reply_to } : {}),
        ...(threadTratativaLivre.references ? { "References": threadTratativaLivre.references } : {}),
        ...(threadTratativaLivre.thread_index ? { "Thread-Index": threadTratativaLivre.thread_index } : {}),
      }
      : undefined;

    const sendResult = await sendGmailMessage({
      supabase,
      operadorId: m.aprovado_por,
      destinatario: emailDestinatario,
      cc: emailCc,
      subject: emailSubject,
      texto: emailCorpo,
      fromName: null,
      attachments: emailAttachments,
      threadId: threadTratativaLivre?.gmail_thread_id ?? null,
      extraHeaders: extraHeadersLivre,
    });

    if (!sendResult.ok) {
      emailMotivoFalha = sendResult.error ?? "erro desconhecido no envio Gmail";
    } else {
      emailOk = true;
      emailMessageId = sendResult.messageId;
      emailThreadId = sendResult.threadId;

      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "RespostaEnviada",
        actor_type: "operator",
        actor_id: m.aprovado_por ?? "executor",
        payload: {
          todo_id: m.todo_id,
          canal: "email",
          via: "gmail_oauth_inline",
          from: sendResult.from,
          destinatario: emailDestinatario,
          cc: emailCc,
          subject: emailSubject,
          gmail_message_id: sendResult.messageId,
          gmail_thread_id: sendResult.threadId,
          origem_texto: "operador_livre",
          texto_preview: emailCorpo.slice(0, 300),
          anexos_count: emailAttachments.length,
          anexos_filenames: emailAttachments.map((a) => a.filename),
          contexto: "email_livre_mais_oc33",
        },
      });

      if (sendResult.messageId && sendResult.threadId) {
        await supabase.from("cards_emails_outbound").insert({
          card_id: m.card_id,
          todo_id: m.todo_id,
          operadora_id: m.aprovado_por,
          gmail_message_id: sendResult.messageId,
          gmail_thread_id: sendResult.threadId,
          from_email: sendResult.from,
          to_email: emailDestinatario,
          subject: emailSubject,
          message_id_header: sendResult.messageIdHeader,
          corpo_renderizado: emailCorpo,
        });
      }

      if (emailAnexosIds.length > 0) {
        await finalizarAnexosPosEnvio(supabase, emailAnexosIds);
      }
    }
  } catch (err) {
    emailMotivoFalha = err instanceof Error ? err.message : String(err);
  }

  if (!emailOk) {
    await supabase.from("card_events").insert({
      card_id: m.card_id,
      event_type: "EmailLivreFalhou",
      actor_type: "system",
      actor_id: "executor",
      payload: {
        todo_id: m.todo_id,
        motivo: emailMotivoFalha,
        observacao: "Email falhou mas oc=33 vai ser lançada mesmo assim.",
        destinatario: emailDestinatario,
        subject: emailSubject,
      },
    });
  }

  // ───────────── 2. PREPARA IMAGENS DA oc=33 (opcionais) ─────────────
  let imagens: Array<{ bytes: Uint8Array; filename: string; mimeType: string }> = [];
  if (oc33AnexosIds.length > 0) {
    const carregados = await carregarAnexos(supabase, oc33AnexosIds);
    if (carregados.length === 0) {
      await supabase.rpc("reverter_acao_falhou", {
        p_todo_id: m.todo_id,
        p_motivo: `Email+oc33 livre: anexos_ids da oc=33 não carregaram do bucket. anexos_ids=${oc33AnexosIds.join(",")}. Email ${emailOk ? "enviado" : "falhou"}.`,
      });
      summary.failed++;
      await deletarMsgExecutor(supabase, job);
      return;
    }
    imagens = carregados.map((a) => {
      const binStr = atob(a.content_base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      return { bytes, filename: a.filename, mimeType: a.mime_type };
    });
  }

  // Caio 2026-07-17 (NF 135724): card PARCIAL → injeta desc/valor do dossiê no
  // texto (soma; imagem se estourar). Card não-parcial → no-op.
  const matTexto = await materializarTextoOc33(supabase, card, oc33Texto);
  const oc33TextoFinal = matTexto.texto;
  if (matTexto.imagensExtra.length > 0) imagens = imagens.concat(matTexto.imagensExtra);

  // ───────────── 3. LANÇA oc=33 via portal SSW interno (envelope, INV-011) ─────────────
  // Caio 2026-06-22 (NF 376924): via envelope lancarSswPortal — idempotência +
  // guard tripé + registro em acoes_executadas_ssw (que faz buscarNFInterno com
  // ctrcEsperado=card.ctrc internamente, preservando INV-011). Antes: cru.
  const result33 = await lancarOcViaEnvelope(
    supabase,
    { id: m.card_id, nf, ctrc: ctrcCard },
    33,
    oc33TextoFinal,
    imagens,
    m.todo_id,
  );

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: result33.ok ? "AcaoExecutadaPortal" : "AcaoFalhouPortal",
    actor_type: "agent",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      tool: "enviar_email_livre_e_lancar_oc33_portal",
      codigo_ssw: 33,
      via: "portal_interno",
      n_imagens: imagens.length,
      email_ok: emailOk,
      email_motivo_falha: emailMotivoFalha,
      ok: result33.ok,
      error: result33.ok ? null : (result33 as { error?: string }).error,
    },
  });

  if (!result33.ok) {
    const errMsg = (result33 as { error?: string }).error ?? "erro desconhecido";
    await supabase.from("todos")
      .update({ status: "falhou", rejection_reason: errMsg.slice(0, 500) })
      .eq("id", m.todo_id);
    await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: `${emailOk ? "Email enviado" : "Email falhou"}, oc=33 FALHOU no portal SSW: ${errMsg.slice(0, 250)}. Retentar oc=33 manualmente.`,
    });
    if (oc33AnexosIds.length > 0) {
      await finalizarAnexosPosEnvio(supabase, oc33AnexosIds);
    }
    summary.failed++;
    await deletarMsgExecutor(supabase, job);
    return;
  }

  // Par sugestão×decisão (Fase 0) — ver comentário no combo 33+44.
  await registrarFeedbackImplicitoAgentes(supabase, m.card_id, 33);

  // ───────────── 4. SUCESSO — card → ACAO_EXECUTADA (INV-002 preservado) ─────────────
  const agora = new Date().toISOString();
  const ocBastaoNoLancamento = card["cod_ultima_ocorrencia"] as number | null;
  const bastaoUpdatedAtNoLancamento = (((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.["bastao_updated_at"] as string | null | undefined) ?? null;
  const bastaoPendenciaIdNoLancamento = (card as Record<string, unknown>)["bastao_pendencia_id"] as string | null;

  const acaoFalhouMotivo = emailOk ? null
    : `Email NÃO foi enviado (${(emailMotivoFalha ?? "erro").slice(0, 200)}). oc=33 foi lançada normalmente.`;

  await supabase.from("todos")
    .update({ status: "executando" })
    .eq("id", m.todo_id);

  await supabase.from("cards")
    .update({
      state: "ACAO_EXECUTADA",
      lock_aguardando_validacao: true,
      acao_executada_em: agora,
      cod_ultima_ocorrencia: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
      bastao_updated_at_no_lancamento: bastaoUpdatedAtNoLancamento,
      bastao_pendencia_id_no_lancamento: bastaoPendenciaIdNoLancamento,
      acao_falhou_motivo: acaoFalhouMotivo,
      aviso_alteracao_oc: null,
      ia_sugestao_oc_resposta: null,
      cliente_respondeu_em: null,
    })
    .eq("id", m.card_id);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "EmailLivreEOc33Concluido",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      via: "portal_interno",
      n_imagens: imagens.length,
      email_ok: emailOk,
      email_motivo_falha: emailMotivoFalha,
      email_destino: emailDestinatario,
      email_cc: emailCc,
      email_subject: emailSubject,
      email_message_id: emailMessageId,
      email_thread_id: emailThreadId,
      state_novo: "ACAO_EXECUTADA",
      cod_ultima: 33,
      bastao_oc_no_lancamento: ocBastaoNoLancamento,
    },
  });

  if (oc33AnexosIds.length > 0) {
    await finalizarAnexosPosEnvio(supabase, oc33AnexosIds);
  }

  await tentarConfirmarPosLancamento(supabase, m.card_id, "email-livre+33");

  await deletarMsgExecutor(supabase, job);
  summary.executed++;
}
