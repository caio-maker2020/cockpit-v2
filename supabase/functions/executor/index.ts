// =============================================================================
// executor — consome pgmq.agent_executor, chama SSW pra lançar ocorrência,
// grava audit_log + card_event AcaoExecutada, marca todo.status='executando'.
//
// TEST_FILTER: Durante a fase de teste, executor SÓ processa cards atribuídos
// a operadores na lista (env EXECUTOR_TEST_OPERATORS). Em produção, deixar
// vazio pra liberar todos. Garantia extra contra disparo acidental no SSW
// de produção.
//
// Idempotency: lib/ssw-client deriva chave SHA256(card_id, codigo, nf).
// audit_log.idempotency_key é UNIQUE — mesmo se executor for chamado 2x
// (network retry, cron race), apenas 1 INSERT vence; outros falham com
// duplicate key e a gente reusa o resultado.
//
// Fluxo:
//   1. Lê msg da fila com vt=180s (ações SSW podem demorar)
//   2. Pega card + agent_state (pra pegar cnpj_remetente quando não vem no payload)
//   3. Aplica TEST_FILTER
//   4. Chama lib/ssw-client.lancarOcorrencia()
//   5. Grava audit_log (success/failed)
//   6. Grava card_event AcaoExecutada
//   7. UPDATE todo.status='executando' — Pass C do sync-bastao confirma depois
//   8. Confirma processamento (delete_from_pgmq)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { createSswClient, readSswEnvFromProcess } from "../_shared/ssw-client.ts";
import { sendGmailMessage, loadOperadorGmailCreds, refreshGmailAccessToken } from "../_shared/gmail-sender.ts";
import { garantirLabelCockpitTracked, aplicarLabelEmThread } from "../_shared/gmail-reader.ts";
import { carregarAnexosParaEnvio as carregarAnexos, finalizarAnexosPosEnvio } from "../_shared/anexos-storage.ts";

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

    const ssw = createSswClient({ env: readSswEnvFromProcess(env) });

    const testOperatorsRaw = env["EXECUTOR_TEST_OPERATORS"] ?? "";
    const testOperators = testOperatorsRaw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const filterEnabled = testOperators.length > 0;

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
      try {
        await processOne(supabase, ssw, job, testOperators, filterEnabled, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ msg_id: job.msg_id, todo_id: job.message?.todo_id, message: msg });

        // Reverter imediato pra erros determinísticos (não-retryable) — sem
        // esperar 3 tentativas (~7min). Operadora vê problema rápido.
        // Erros transientes (SSW timeout/5xx, network) seguem o retry de 3x.
        const isDeterministic = isDeterministicError(msg);
        const shouldFinalize = isDeterministic || job.read_ct >= MAX_ATTEMPTS;

        if (shouldFinalize) {
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
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_executor",
            source_msg_id: job.msg_id,
            motivo: `executor: ${msg.slice(0, 200)}${isDeterministic ? " (deterministico — sem retry)" : ` (após ${job.read_ct} tentativas)`}`,
            original_payload: job.message,
          });
          summary.archived++;
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
type SswClient = ReturnType<typeof createSswClient>;

async function processOne(
  supabase: SupabaseClient,
  ssw: SswClient,
  job: QueueMessage,
  testOperators: string[],
  filterEnabled: boolean,
  summary: RunSummary,
): Promise<void> {
  const m = job.message;

  // 1. Pega card pra TEST_FILTER + cnpj_remetente fallback + snapshot Bastão
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select(`
      id,
      nf,
      ctrc,
      assigned_operator_id,
      agent_state,
      cod_ultima_ocorrencia,
      operadores!cards_assigned_operator_id_fkey(nome)
    `)
    .eq("id", m.card_id)
    .single();

  if (cardErr) throw new Error(`SELECT card: ${cardErr.message}`);
  if (!card) throw new Error(`Card ${m.card_id} não encontrado`);

  // 2. TEST_FILTER
  if (filterEnabled) {
    const opData = (card as Record<string, unknown>)["operadores"] as
      | { nome: string }
      | { nome: string }[]
      | null;
    const opNome = (Array.isArray(opData) ? opData[0]?.nome : opData?.nome) ?? "";
    if (!testOperators.includes(opNome.toUpperCase())) {
      // Filtrado — log e descarta da fila pra não acumular
      console.warn(
        `executor TEST_FILTER bloqueou todo=${m.todo_id} card=${m.card_id} ` +
          `operador="${opNome}" não está em [${testOperators.join(",")}]`,
      );
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "AcaoExecutadaBloqueadaPorTestFilter",
        actor_type: "system",
        actor_id: "executor",
        payload: { todo_id: m.todo_id, motivo: "test_filter", operador: opNome },
      });
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
      summary.filtered_out++;
      return;
    }
  }

  // 3. Resolve cnpj_remetente: payload.args primeiro, fallback agent_state
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const cnpjRemetente =
    m.proposta_payload.args.cnpj_remetente ??
    (agentState["cnpj_remetente"] as string | null | undefined) ??
    null;

  // chave CT-e fiscal (44 dígitos): agent_state PRIMEIRO (fresh — pode ter
  // sido corrigida depois da criação da proposta), payload como fallback.
  //
  // Caio 2026-05-11 (NF 351960): inversão da prioridade. Antes era
  // `payload.args ?? agent_state` — propostas guardam snapshot da chave no
  // momento da criação; se a chave for corrigida depois (manual ou pelo
  // lookup_chave_cte v3), a proposta segue com a chave antiga e SSW devolve
  // "DOCUMENTO BAIXADO OU ENTREGUE" no lançamento. Agora `agent_state.chave_cte`
  // é a fonte da verdade; payload fica como compat retro.
  const chaveCTe =
    (agentState["chave_cte"] as string | null | undefined) ??
    m.proposta_payload.args.chave_cte ??
    null;

  const nf = m.proposta_payload.args.nf ?? card.nf ?? null;

  // Resolve codigo_ssw: prefere args.codigo_ssw; fallback args.codigo (compat retro).
  const codigoSswRaw = m.proposta_payload.args.codigo_ssw ?? m.proposta_payload.args.codigo;
  const codigoSsw =
    typeof codigoSswRaw === "number"
      ? codigoSswRaw
      : codigoSswRaw != null
        ? parseInt(String(codigoSswRaw), 10)
        : NaN;

  if (!chaveCTe) {
    throw new Error(
      `chave_cte não disponível pro todo ${m.todo_id} — necessário pra lançar ocorrência`,
    );
  }
  if (!Number.isFinite(codigoSsw)) {
    throw new Error(`codigo_ssw de ocorrência não fornecido no proposta_payload`);
  }

  // Traduz codigo_ssw → codigo_api via tabela ocorrencias_dexpara (migration 019).
  // Operador/agente trabalham na linguagem do SSW (oc 21 = reentrega); a API
  // do SSW exige outro número (29) por causa do de-para interno.
  const { data: codigoApiResult, error: lookupErr } = await supabase.rpc(
    "lookup_codigo_api",
    { p_codigo_ssw: codigoSsw },
  );
  if (lookupErr) {
    throw new Error(`lookup_codigo_api falhou: ${lookupErr.message}`);
  }
  const codigoApi = codigoApiResult as number | null;
  if (codigoApi == null) {
    throw new Error(
      `Sem mapeamento de-para pra codigo_ssw=${codigoSsw}. ` +
        `Adicione em ocorrencias_dexpara antes de aprovar este todo.`,
    );
  }

  const baseDescricao =
    m.proposta_payload.args.descricao ?? `Ocorrência ${codigoSsw} lançada via Cockpit`;

  // Extras são informações que a operadora preencheu no momento da aprovação
  // (ex: oc=44 retorno de carga — Larissa informa quantidade_volumes, motivo,
  // filial). Concatena na descrição que vai pro SSW pra ficar registrado lá
  // tb. Limite defensivo de 500 chars.
  const extras = (m.proposta_payload.args as Record<string, unknown>)["extras"] as
    | Record<string, string | number>
    | undefined;
  const labelExtras: Record<string, string> = {
    quantidade_volumes: "Volumes",
    motivo: "Motivo",
    filial: "Filial",
  };
  let descricao = baseDescricao;
  // Caso especial pra ocs com texto livre (41, 56): o texto que a Larissa
  // digitou substitui a descrição base — ele é A descrição da oc no SSW.
  // Resto dos extras (volumes/motivo/filial da 44) continua agregando.
  const textoLivre =
    extras && typeof extras === "object"
      ? (extras["texto_descricao"] as string | number | undefined)
      : undefined;
  if (textoLivre != null && String(textoLivre).trim() !== "") {
    descricao = String(textoLivre).slice(0, 500);
  } else if (extras && typeof extras === "object" && Object.keys(extras).length > 0) {
    const partes: string[] = [baseDescricao];
    for (const [key, value] of Object.entries(extras)) {
      if (key === "texto_descricao") continue;
      if (value == null || value === "") continue;
      const label = labelExtras[key] ?? key;
      partes.push(`${label}: ${value}`);
    }
    descricao = partes.join(" | ").slice(0, 500);
  }

  // SSW tracking público não retorna cnpj_remetente — quando vier do SSW
  // tracking, manda string vazia. SSW aceita vazio quando chaveCTe identifica.
  const cnpjRemetenteParaSsw = cnpjRemetente ?? "";

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
  const skipEmail = argsExtras?.["skip_email"] === true;
  const textoCustomizado = (argsExtras?.["texto_email_customizado"] as string | undefined) ?? null;
  const emailDestinatariosRaw = argsExtras?.["email_destinatarios"];
  const destinatariosArrCheck = Array.isArray(emailDestinatariosRaw)
    ? (emailDestinatariosRaw.filter((s) => typeof s === "string" && s.trim()) as string[])
    : [];
  const emailDestinoSingularCheck = argsObj["email_destino"] as string | undefined;
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

  let emailEnviadoOk = false;
  let emailMessageId: string | null = null;
  let emailThreadId: string | null = null;
  let emailFromHeader: string | null = null;

  // Larissa pode editar assunto e/ou trocar template no modal antes de aprovar
  // (Caio 2026-05-06). Se vierem em extras, sobrescrevem o que está em
  // proposta_payload.args.template_id e o assunto renderizado do template.
  const assuntoOverride = (argsExtras?.["assunto_override"] as string | undefined) ?? null;
  const templateIdOverride = (argsExtras?.["template_id_override"] as string | undefined) ?? null;

  if (enviarEmail) {
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
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
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

    const sendResult = await sendGmailMessage({
      supabase,
      operadorId: m.aprovado_por,
      destinatario: emailPayload.destinatario,
      cc: emailPayload.cc,
      subject: emailPayload.subject,
      texto: emailPayload.texto,
      fromName: emailPayload.fromName,
      attachments,
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
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
      return;
    }

    emailEnviadoOk = true;
    emailMessageId = sendResult.messageId;
    emailThreadId = sendResult.threadId;
    emailFromHeader = sendResult.from;

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

  // 4. Chama SSW (schema cte.chaveCTe — não numeroNFe/serieNFe).
  // codigo enviado pra API é o codigo_api (29), que vira oc 21 no painel SSW.
  // todoId no idempotency permite múltiplos lançamentos da mesma oc na mesma NF.
  //
  // Caio 2026-05-06: fallback automático pra DOCUMENTO CANCELADO. Se chave
  // atual foi cancelada no SSW, busca alternativas em nf_chave_cte (mesma
  // NF + cnpj_pagador) e retenta. Atualiza agent_state.chave_cte se alternativa
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
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
      return;
    }
  }

  let sswResult = await ssw.lancarOcorrencia({
    cardId: m.card_id,
    todoId: m.todo_id,
    cnpjRemetente: cnpjRemetenteParaSsw,
    chaveCTe,
    codigo: String(codigoApi),
    descricao,
    imagem: sswImagemBase64,
  });

  let chaveUsada = chaveCTe;
  if (!sswResult.ok && /DOCUMENTO\s+CANCELADO/i.test(sswResult.error ?? "")) {
    const cnpjPagadorCard = (agentState?.["cnpj_pagador"] as string | undefined) ?? null;
    const { data: alternativas } = await supabase.rpc("lookup_chaves_cte_alternativas", {
      p_nf: nf,
      p_cnpj_pagador: cnpjPagadorCard,
      p_chave_excluir: chaveCTe,
    });
    const lista = (alternativas as Array<{ chave_cte: string }> | null) ?? [];
    console.log(`[executor] DOCUMENTO CANCELADO pra chave ${chaveCTe.slice(-12)} — tentando ${lista.length} alternativa(s)`);

    for (const alt of lista) {
      const altKey = alt.chave_cte;
      if (!altKey || altKey === chaveCTe) continue;
      const tentativa = await ssw.lancarOcorrencia({
        cardId: m.card_id,
        todoId: m.todo_id,
        cnpjRemetente: cnpjRemetenteParaSsw,
        chaveCTe: altKey,
        codigo: String(codigoApi),
        descricao,
        imagem: sswImagemBase64,
      });
      if (tentativa.ok || !/DOCUMENTO\s+CANCELADO/i.test(tentativa.error ?? "")) {
        sswResult = tentativa;
        chaveUsada = altKey;
        break;
      }
    }

    // Se alguma alternativa deu sucesso, atualiza agent_state pra próxima ação
    // já partir da chave correta. Card_event documenta a troca.
    if (sswResult.ok && chaveUsada !== chaveCTe) {
      const novoState = { ...(agentState ?? {}), chave_cte: chaveUsada };
      await supabase.from("cards")
        .update({ agent_state: novoState })
        .eq("id", m.card_id);
      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "ChaveCteSubstituidaAposCancelado",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          chave_anterior: chaveCTe,
          chave_nova: chaveUsada,
          motivo: "SSW retornou DOCUMENTO CANCELADO na chave anterior; alternativa encontrada em nf_chave_cte",
          nf,
          todo_id: m.todo_id,
        },
      });
    }
  }

  // 5. audit_log
  const auditPayload: Record<string, unknown> = {
    card_id: m.card_id,
    action_type: "lancar_ocorrencia",
    actor_type: "agent",
    actor_id: "executor",
    external_system: "ssw",
    idempotency_key: sswResult.idempotencyKey,
    request_payload: {
      cnpj_remetente: cnpjRemetente,
      chave_cte: chaveUsada,
      nf,
      codigo_ssw: codigoSsw,
      codigo_api: codigoApi,
      descricao,
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
      codigo_api: codigoApi,
      nf,
      chave_cte: chaveUsada,
      cnpj_remetente: cnpjRemetente,
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
    // snapshot) de "RPA só refrescou a row sem mudar a oc" (igual). O valor
    // anterior de cards.cod_ultima_ocorrencia é exatamente o que o último
    // sync escreveu — i.e., a oc que Bastão tinha quando Cockpit lançou.
    const ocBastaoNoLancamento = (card as Record<string, unknown>)["cod_ultima_ocorrencia"] as number | null;

    // Caio 2026-05-12 (NF 920161): combo 33+44. Se a tool aprovada era
    // lancar_combo_33_44, a oc=33 acabou de ser lançada com sucesso. Em vez
    // de ir pra ACAO_EXECUTADA, cria+enfileira segundo todo (oc=44 com
    // volumes/motivo/filial). Card permanece em EXECUTANDO_ACAO até oc=44
    // concluir. Se oc=44 falhar depois, reverter_acao_falhou volta o card
    // pra AVH+lock=true com acao_falhou_motivo que menciona protocolo da 33.
    const ehComboParte1 = tool === "lancar_combo_33_44";
    if (ehComboParte1) {
      const combo44Args = (argsExtras?.["combo_44"] ?? {}) as Record<string, unknown>;
      const newActionId = crypto.randomUUID();
      const proposta44 = {
        tool: "lancar_ocorrencia",
        args: {
          codigo_ssw: 44,
          nf,
          chave_cte: chaveUsada,
          cnpj_remetente: cnpjRemetente,
          descricao: "Retorno de carga (encaminhar p/ Devolução) — parte 2 do combo 33+44",
          extras: {
            quantidade_volumes: combo44Args["quantidade_volumes"] ?? null,
            motivo: combo44Args["motivo"] ?? null,
            filial: combo44Args["filial"] ?? null,
          },
        },
        rationale: `Parte 2 do combo 33+44. oc=33 lançada com protocolo ${sswResult.protocolo}.`,
        texto: null,
        meta: {
          tinha_intencao_email: false,
          modo: "sem_email",
          origem: "combo_33_44_parte2",
          tipo_acao: "combo_33_44",
          parte1_protocolo: sswResult.protocolo,
          parte1_todo_id: m.todo_id,
        },
      };

      const { data: novoTodo, error: insTodoErr } = await supabase
        .from("todos")
        .insert({
          card_id: m.card_id,
          action_id: newActionId,
          descricao: "Parte 2 do combo: lançar oc=44 (retorno de carga)",
          status: "aprovado",
          approved_by: m.aprovado_por,
          approved_at: agora,
          proposta_payload: proposta44,
        })
        .select("id")
        .single();

      if (insTodoErr || !novoTodo) {
        // Não conseguimos enfileirar oc=44 — card vai pra AVH com aviso. oc=33
        // já foi lançada e não dá pra desfazer (protocolo SSW emitido).
        await supabase.from("card_events").insert({
          card_id: m.card_id,
          event_type: "ComboParte2NaoEnfileirado",
          actor_type: "system",
          actor_id: "executor",
          payload: {
            parte1_protocolo: sswResult.protocolo,
            erro: insTodoErr?.message ?? "INSERT todo retornou null",
          },
        });
        await supabase.rpc("reverter_acao_falhou", {
          p_todo_id: m.todo_id,
          p_motivo: `Combo 33+44: oc=33 lançada com sucesso (protocolo ${sswResult.protocolo}) MAS falha ao enfileirar oc=44: ${insTodoErr?.message ?? "INSERT null"}. Larissa precisa lançar oc=44 manualmente.`,
        });
        summary.failed++;
        await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
        return;
      }

      // Enfileira a parte 2 — executor consome em seguida como tool normal.
      await supabase.rpc("enqueue_to_pgmq", {
        queue_name: "agent_executor",
        payload: {
          todo_id: novoTodo.id,
          card_id: m.card_id,
          action_id: newActionId,
          proposta_payload: proposta44,
          aprovado_por: m.aprovado_por,
          card_nf: m.card_nf ?? null,
          card_ctrc: m.card_ctrc ?? null,
        },
      });

      // Marca parte 1 como executando_combo (não executando puro pra
      // distinguir nos relatórios). Card mantém EXECUTANDO_ACAO até parte 2
      // resolver. Estado intermediário: parte 1 OK, parte 2 enfileirada.
      await supabase.from("todos")
        .update({ status: "executando" })
        .eq("id", m.todo_id);

      await supabase.from("card_events").insert({
        card_id: m.card_id,
        event_type: "ComboParte2Enfileirado",
        actor_type: "system",
        actor_id: "executor",
        payload: {
          parte1_todo_id: m.todo_id,
          parte1_protocolo: sswResult.protocolo,
          parte2_todo_id: novoTodo.id,
          parte2_action_id: newActionId,
          motivo: "Combo 33+44 — oc=33 OK, oc=44 enfileirada como segundo todo aprovado.",
        },
      });

      // Card_event StateTransicaoPosSucesso NÃO roda (não vamos pra
      // ACAO_EXECUTADA agora). Audit_log + AcaoExecutada da parte 1 já
      // registrados acima.
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
      summary.executed++;
      return;
    }

    await supabase
      .from("cards")
      .update({
        state: stateFinal,
        lock_aguardando_validacao: true,
        acao_executada_em: agora,
        cod_ultima_ocorrencia: codigoSsw,
        bastao_oc_no_lancamento: ocBastaoNoLancamento,
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
        motivo: "Caio 2026-05-07: card vai pra ACAO_EXECUTADA até Bastão confirmar oc lançada. Snapshot Bastão pré-lançamento usado pelo Pass G.",
      },
    });

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
      motivoFalha = `ATENÇÃO: email JÁ FOI ENVIADO pro cliente, mas a ocorrência ${codigoSsw} FALHOU no SSW (${sswResult.error.slice(0, 200)}). Cliente já foi notificado. Retentar a oc separadamente.`;
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
  await supabase.rpc("delete_from_pgmq", { queue_name: "agent_executor", msg_id: job.msg_id });
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
    (args["email_destino"] as string | undefined) ??
    null;
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
    .select("nf, empresa_cliente, agent_state, responsavel_relacionamento, cod_ultima_ocorrencia")
    .eq("id", m.card_id)
    .single();

  if (!card) throw new Error("card não encontrado");

  // Resolve placeholders básicos disponíveis
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const nomeCliente = (card.empresa_cliente as string | null) ?? "";
  const primeiroNome = nomeCliente.split(/\s+/)[0] ?? "";
  const operadoraNome = (card.responsavel_relacionamento as string | null) ?? "Sal Express";
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
      // Caio 2026-05-11 (bug NF 920161): se oc atual está bloqueada no
      // /trackingpag SSW público (31 ocs internas como 49/56/44/...), o
      // scraper que serve o {link_evidencia} hoje (r-evidencia → trackingpag)
      // NÃO encontra a foto da oc correlacionada — SSW oculta essas linhas
      // do portal cliente. Resultado: cliente clica e vê foto errada (de
      // alguma oc visível). Fallback: omite link enquanto o caminho
      // definitivo (login interno SSW) não está em pé.
      const { loadOcsBloqueadasTracking } = await import("../_shared/ocs-bloqueadas-tracking.ts");
      const ocsBloqueadas = await loadOcsBloqueadasTracking(supabase);
      if (ocsBloqueadas.has(codOcorrenciaCard)) {
        await supabase.from("card_events").insert({
          card_id: m.card_id,
          event_type: "LinkEvidenciaOmitido",
          actor_type: "system",
          actor_id: "executor",
          payload: {
            cod_ocorrencia: codOcorrenciaCard,
            nf: nfCard,
            motivo: "oc_bloqueada_no_trackingpag",
            observacao: "Link de evidência omitido — oc está na tabela ocorrencias_bloqueadas_tracking. SSW público omite essas ocs do /trackingpag e o scraper atual entregaria foto errada. Fix definitivo via login interno SSW está em construção.",
          },
        });
        // Pula geração de token + link; renderTemplate vai substituir
        // {link_evidencia} por string vazia (limpa o placeholder).
      } else {
      if (deveValidarEvidencia) {
        // Caio 2026-05-07: valida evidência antes de gerar token. Bloqueia
        // se status != ok_com_foto_correlacionada (regra estrita: foto tem
        // que estar na linha da oc 10/11/35, senão cliente recebe link
        // pra "indisponível" e perde confiança).
        const { temEvidenciaParaOc } = await import("../_shared/verificar-evidencia.ts");
        const checkEvidencia = await temEvidenciaParaOc(
          supabase, nfCard, cnpjPagador, codOcorrenciaCard,
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

      const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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
      } // fim do else (ocs não bloqueada) — Caio 2026-05-11
    }
  }

  const vars: Record<string, string> = {
    nome_cliente: nomeCliente,
    primeiro_nome: primeiroNome,
    nf: (card.nf as string | null) ?? "",
    empresa: nomeCliente,
    operadora_nome: operadoraNome,
    cidade_destino: (agentState["cidade_destino"] as string | null) ?? "",
    previsao_atual: (agentState["previsao_entrega"] as string | null) ?? "",
    descricao_problema: (agentState["instrucao_ultima_ocorrencia"] as string | null) ?? "",
    n_volumes_falta: (args["n_volumes_falta"] as string | undefined) ?? "",
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
  const corpoFinal = textoCustomizado
    ? renderTemplate(textoCustomizado)
    : renderTemplate(template!.corpo_template as string);

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
