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

const VT_SECONDS = 180;
const BATCH_SIZE = 3;
const MAX_ATTEMPTS = 3;

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
        if (job.read_ct >= MAX_ATTEMPTS) {
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_executor",
            source_msg_id: job.msg_id,
            motivo: `executor: ${msg.slice(0, 200)} (após ${job.read_ct} tentativas)`,
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

  // 1. Pega card pra TEST_FILTER + cnpj_remetente fallback
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select(`
      id,
      nf,
      ctrc,
      assigned_operator_id,
      agent_state,
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

  // chave CT-e fiscal (44 dígitos): payload primeiro, fallback agent_state
  const chaveCTe =
    m.proposta_payload.args.chave_cte ??
    (agentState["chave_cte"] as string | null | undefined) ??
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

  // 4. Chama SSW (schema cte.chaveCTe — não numeroNFe/serieNFe).
  // codigo enviado pra API é o codigo_api (29), que vira oc 21 no painel SSW.
  // todoId no idempotency permite múltiplos lançamentos da mesma oc na mesma NF
  // (1 por to-do aprovado — cliente pode cobrar reentrega novamente).
  const sswResult = await ssw.lancarOcorrencia({
    cardId: m.card_id,
    todoId: m.todo_id,
    cnpjRemetente: cnpjRemetenteParaSsw,
    chaveCTe,
    codigo: String(codigoApi),
    descricao,
  });

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
      chave_cte: chaveCTe,
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
      chave_cte: chaveCTe,
      cnpj_remetente: cnpjRemetente,
      protocolo: sswResult.ok ? sswResult.protocolo : null,
      idempotency_key: sswResult.idempotencyKey,
      sucesso: sswResult.ok,
      error: sswResult.ok ? null : sswResult.error,
      status_http: sswResult.ok ? 200 : sswResult.status,
    },
  });

  // 7. UPDATE todo
  if (sswResult.ok) {
    await supabase
      .from("todos")
      .update({ status: "executando" })
      .eq("id", m.todo_id);

    await supabase
      .from("cards")
      .update({ state: "EXECUTANDO_ACAO", acao_falhou_motivo: null })
      .eq("id", m.card_id);

    // Tool composto "lancar_oc_e_enviar_email": após lançar oc com sucesso,
    // renderiza template + enfileira em respostas_envio. O envio em si
    // fica com a Edge Function `enviar-resposta` (consumer da queue).
    //
    // 2026-05-04: Larissa pode editar texto antes (composer no Cockpit) ou
    // marcar como "email já enviado manual" — aprovação passa via p_extras:
    //   - extras.skip_email = true        → pula disparEmailComposto
    //   - extras.texto_email_customizado  → usa esse texto em vez do template
    const tool = m.proposta_payload.tool;
    const argsExtras = (m.proposta_payload.args as Record<string, unknown>)?.["extras"] as
      | Record<string, unknown>
      | undefined;
    const skipEmail = argsExtras?.["skip_email"] === true;
    const textoCustomizado = (argsExtras?.["texto_email_customizado"] as string | undefined) ?? null;

    if (tool === "lancar_oc_e_enviar_email" && !skipEmail) {
      try {
        await disparEmailComposto(supabase, m, textoCustomizado);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`disparEmailComposto: ${msg}`);
        await supabase.from("card_events").insert({
          card_id: m.card_id,
          event_type: "EmailNaoDisparadoAposOc",
          actor_type: "system",
          actor_id: "executor",
          payload: { todo_id: m.todo_id, motivo: msg },
        });
      }
    } else if (tool === "lancar_oc_e_enviar_email" && skipEmail) {
      // Larissa marcou "email já enviado manual" — registra audit, não dispara.
      // Cobrança D+4 ainda é agendada por disparEmailComposto path quando email
      // sai. Como não vai sair, agenda manualmente aqui (cliente foi notificado).
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

      // Reagenda cobrança D+4 (mesmo comportamento do path normal)
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
    // após lançar com sucesso, card volta pra AGUARDANDO_CLIENTE (não fica em
    // EXECUTANDO_ACAO esperando sync) e reagenda cobrança D+4. Mesmo padrão
    // de marcar_retorno_inconclusivo, mas disparado pela aprovação do todo
    // de re-lançamento.
    const meta = m.proposta_payload.meta;
    if (meta?.["tipo_acao"] === "relancamento_54") {
      const reagendadoPara = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("cards")
        .update({ state: "AGUARDANDO_CLIENTE" })
        .eq("id", m.card_id);

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
          state_novo: "AGUARDANDO_CLIENTE",
          cobranca_reagendada_para: reagendadoPara,
        },
      });
    }

    summary.executed++;
  } else {
    // Falha no SSW: marca todo como falhou e chama RPC pra reverter card
    // pra AGUARDANDO_VALIDACAO_HUMANA com flag visual + ressuscita os todos
    // cancelados pela aprovação. Larissa pode escolher outra opção.
    await supabase
      .from("todos")
      .update({ status: "falhou", rejection_reason: sswResult.error.slice(0, 500) })
      .eq("id", m.todo_id);

    const { error: revertErr } = await supabase.rpc("reverter_acao_falhou", {
      p_todo_id: m.todo_id,
      p_motivo: sswResult.error.slice(0, 500),
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
// disparEmailComposto — após lançar oc com sucesso, dispara email pro cliente
// usando template_email do banco. Renderiza placeholders e enfileira em
// pgmq.respostas_envio (consumer: enviar-resposta).
// =============================================================================

async function disparEmailComposto(
  supabase: ReturnType<typeof createClient>,
  m: QueueMessage["message"],
  textoCustomizado: string | null = null,
): Promise<void> {
  const args = m.proposta_payload.args as Record<string, unknown>;
  const templateId = args["template_id"] as string | undefined;
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

  // Busca card pra resolver placeholders
  const { data: card } = await supabase
    .from("cards")
    .select("nf, empresa_cliente, agent_state, responsavel_relacionamento")
    .eq("id", m.card_id)
    .single();

  if (!card) throw new Error("card não encontrado");

  // Resolve placeholders básicos disponíveis
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const nomeCliente = (card.empresa_cliente as string | null) ?? "";
  const primeiroNome = nomeCliente.split(/\s+/)[0] ?? "";
  const operadoraNome = (card.responsavel_relacionamento as string | null) ?? "Sal Express";

  // Gera token de evidência se template OU texto custom usa {link_evidencia}.
  // (oc=10/11/35: cliente clica e cai no SSW autenticado com a foto)
  // Quando Larissa escreve email manual no Cockpit, ela pode incluir o
  // placeholder {link_evidencia} — é renderizado igual ao template.
  const corpoTemplate = (template?.corpo_template as string | undefined) ?? "";
  const usaLinkEvidencia =
    corpoTemplate.includes("{link_evidencia}") ||
    (textoCustomizado != null && textoCustomizado.includes("{link_evidencia}"));
  let linkEvidencia = "";
  if (usaLinkEvidencia) {
    const cnpjPagador = (agentState["cnpj_pagador"] as string | null) ?? "";
    const nfCard = (card.nf as string | null) ?? "";
    if (cnpjPagador && nfCard) {
      const expiraEm = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: tokenRow } = await supabase
        .from("tokens_evidencia")
        .insert({
          card_id: m.card_id,
          todo_id: m.todo_id,
          cnpj_pagador: cnpjPagador,
          nf: nfCard,
          expira_em: expiraEm,
        })
        .select("id")
        .single();

      if (tokenRow?.id) {
        // Vercel hospeda a página HTML auto-submit (Supabase força text/plain).
        const baseEvidencia = Deno.env.get("EVIDENCIA_BASE_URL") ?? "https://cockpit-r-evidencia.vercel.app";
        linkEvidencia = `${baseEvidencia}/r?t=${tokenRow.id}`;
      }
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

  // Assunto: vem do template (mesmo se inativo, quando texto é customizado).
  // Se nem template nem assunto disponível, usa fallback.
  const assuntoBase = (template?.assunto as string | undefined) ?? `Mensagem Sal Express — NF ${vars.nf}`;
  const assuntoFinal = renderTemplate(assuntoBase);

  // Corpo: textoCustomizado tem prioridade (Larissa editou no Cockpit).
  // Senão, renderiza template normalmente.
  const corpoFinal = textoCustomizado
    ? renderTemplate(textoCustomizado)
    : renderTemplate(template!.corpo_template as string);

  // Enfileira em pgmq.respostas_envio (enviar-resposta consome).
  // emailCc: contatos extras selecionados pela Larissa entram como CC
  // (1 só envio, com múltiplos no Cc — bate com como Gmail trata thread).
  const { error: sendErr } = await supabase.rpc("send_to_pgmq", {
    queue_name: "respostas_envio",
    message: {
      todo_id: m.todo_id,
      card_id: m.card_id,
      operador_id: m.aprovado_por,
      canal: "email",
      destinatario: emailDestino,
      cc: emailCc.length > 0 ? emailCc : null,
      from_email: null,        // enviar-resposta resolve via operador
      from_name: operadoraNome,
      subject: assuntoFinal,
      texto: corpoFinal,
      template_id: templateId ?? null,
    },
  });

  if (sendErr) throw new Error(`send_to_pgmq: ${sendErr.message}`);

  await supabase.from("card_events").insert({
    card_id: m.card_id,
    event_type: "EmailEnfileiradoAposOc",
    actor_type: "system",
    actor_id: "executor",
    payload: {
      todo_id: m.todo_id,
      template_id: templateId ?? null,
      email_destino: emailDestino,
      email_cc: emailCc,
      assunto: assuntoFinal,
      origem_texto: textoCustomizado ? "operador_manual" : "template",
    },
  });
}
