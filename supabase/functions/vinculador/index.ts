// =============================================================================
// vinculador — consome pgmq.agent_specialist (mensagens classificadas), busca
// ou cria card, anexa mensagem, e cria to-dos quando aplicável.
//
// Lookup chain (ordem):
//   1. Card ATIVO no Cockpit com a NF → anexa mensagem
//   2. Bastão tem pendência com a NF → cria card a partir do Bastão
//   3. SSW tracking (itera tracking_credentials.ativo=true) → cria card
//   4. Sem match → cria card "incompleto" (precisa preenchimento manual)
//
// Quando classification.tipo='reentrega' E o card foi criado/anexado com
// sucesso, cria to-do "Lançar ocorrência 21 no SSW" + transiciona o card
// pra AGUARDANDO_VALIDACAO_HUMANA.
//
// Disparado por: cron 1min OU invocação HTTP direta.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";
import {
  createSswTrackingClient,
  isTrackingSuccess,
  loadTrackingSenhasFromSupabase,
  readSswTrackingEnvFromProcess,
  type SswTrackingSuccessResponse,
} from "../_shared/ssw-tracking-client.ts";
import { DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS } from "../_shared/bastao-rules.ts";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    message_id: string;
    classification: {
      tipo: string;
      risco: string;
      resumo: string;
      descricao_problema: string;
      nfs: string[];
      ctrcs: string[];
      nome_cliente: string | null;
      empresa_cliente: string | null;
      requer_acompanhamento: boolean;
    };
    canal: "whatsapp" | "email" | "sistema";
    remetente: string;
    conteudo: string;
    recebido_em: string;
  };
}

type LookupStrategy =
  | { source: "cockpit_existing"; card_id: string }
  | { source: "bastao"; pendencia: BastaoPendencia }
  | { source: "ssw_tracking"; pagador: string; data: SswTrackingSuccessResponse }
  | { source: "incomplete"; reason: string };

interface RunSummary {
  read: number;
  attached_to_existing: number;
  created_from_bastao: number;
  created_from_ssw: number;
  created_incomplete: number;
  todos_created: number;
  archived: number;
  errors: Array<{ msg_id: number | null; message_id?: string; message: string }>;
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

    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    // Carrega senhas tracking_credentials
    const senhaByCnpj = await loadTrackingSenhasFromSupabase(supabase);
    const sswTracking = createSswTrackingClient({
      env: { ...readSswTrackingEnvFromProcess(env), senhaByCnpj },
    });

    // Resolve operador default (LARISSA na fase de teste). Se não achar,
    // cards são criados com assigned_operator_id NULL (gestor vê via RLS).
    let defaultOperatorId: string | null = null;
    if (DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS) {
      const { data: opRow } = await supabase
        .from("operadores")
        .select("id")
        .eq("nome", DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS)
        .eq("ativo", true)
        .maybeSingle();
      defaultOperatorId = (opRow?.id as string | undefined) ?? null;
    }

    // Lê N msgs da fila
    const { data: msgs, error: readErr } = await supabase.rpc("read_from_pgmq", {
      queue_name: "agent_specialist",
      vt_seconds: VT_SECONDS,
      qty: BATCH_SIZE,
    });

    if (readErr) throw new Error(`read_from_pgmq: ${readErr.message}`);

    const queue = (msgs ?? []) as QueueMessage[];
    const summary: RunSummary = {
      read: queue.length,
      attached_to_existing: 0,
      created_from_bastao: 0,
      created_from_ssw: 0,
      created_incomplete: 0,
      todos_created: 0,
      archived: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const job of queue) {
      try {
        await processOne(supabase, bastao, sswTracking, senhaByCnpj, defaultOperatorId, job, summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.errors.push({ msg_id: job.msg_id, message_id: job.message?.message_id, message: msg });
        if (job.read_ct >= MAX_ATTEMPTS) {
          await supabase.rpc("archive_to_dead_letter", {
            source_queue: "agent_specialist",
            source_msg_id: job.msg_id,
            motivo: `vinculador: ${msg.slice(0, 200)} (após ${job.read_ct} tentativas)`,
            original_payload: job.message,
          });
          summary.archived++;
        }
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log("vinculador done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("vinculador fatal:", msg);
    return new Response(JSON.stringify({ error: msg, duration_ms: Date.now() - startedAt }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type BastaoClient = ReturnType<typeof createBastaoClient>;
type SswTrackingClient = ReturnType<typeof createSswTrackingClient>;

async function processOne(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  sswTracking: SswTrackingClient,
  senhaByCnpj: Record<string, string>,
  defaultOperatorId: string | null,
  job: QueueMessage,
  summary: RunSummary,
): Promise<void> {
  const m = job.message;
  const nf = m.classification.nfs[0] ?? null;
  const ctrc = m.classification.ctrcs[0] ?? null;

  // 1. Lookup chain
  const found = await runLookupChain(supabase, bastao, sswTracking, senhaByCnpj, nf, ctrc);

  let cardId: string;

  switch (found.source) {
    case "cockpit_existing": {
      cardId = found.card_id;
      summary.attached_to_existing++;
      // Reabertura: se card está RESOLVIDO, volta pra EM_TRIAGEM
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "MensagemAnexada",
        actor_type: "system",
        actor_id: "vinculador",
        payload: { message_id: m.message_id, lookup: "cockpit_existing" },
      });
      break;
    }
    case "bastao": {
      cardId = await createCardFromBastao(supabase, found.pendencia, m);
      summary.created_from_bastao++;
      break;
    }
    case "ssw_tracking": {
      cardId = await createCardFromSswTracking(supabase, found.pagador, found.data, nf, m, defaultOperatorId);
      summary.created_from_ssw++;
      break;
    }
    case "incomplete": {
      cardId = await createIncompleteCard(supabase, found.reason, nf, ctrc, m, defaultOperatorId);
      summary.created_incomplete++;
      break;
    }
  }

  // 2. Anexa messages_inbox.card_id
  await supabase.from("messages_inbox").update({ card_id: cardId }).eq("id", m.message_id);

  // 3. Se classificação foi 'reentrega' OU 'rastreamento' e o card tá em estado "ativo",
  //    cria to-do "Lançar ocorrência 21" (somente reentrega no MVP).
  if (m.classification.tipo === "reentrega" && found.source !== "incomplete") {
    await createReentregaTodo(supabase, cardId, m);
    summary.todos_created++;

    // Card → AGUARDANDO_VALIDACAO_HUMANA
    await supabase
      .from("cards")
      .update({ state: "AGUARDANDO_VALIDACAO_HUMANA", tipo: m.classification.tipo, risco: m.classification.risco })
      .eq("id", cardId);

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AcaoPropostaPeloAgente",
      actor_type: "agent",
      actor_id: "vinculador",
      payload: {
        tipo: "reentrega",
        proposta: "lancar_ocorrencia_21",
        resumo: m.classification.resumo,
      },
    });
  } else if (found.source !== "incomplete") {
    // Outros tipos: atualiza tipo+risco; mantém state existente ou aguardando agente
    await supabase
      .from("cards")
      .update({
        tipo: m.classification.tipo,
        risco: m.classification.risco,
      })
      .eq("id", cardId);
  }

  // 4. Confirma processamento
  await supabase.rpc("delete_from_pgmq", { queue_name: "agent_specialist", msg_id: job.msg_id });
}

// =============================================================================
// Lookup chain
// =============================================================================

async function runLookupChain(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  sswTracking: SswTrackingClient,
  senhaByCnpj: Record<string, string>,
  nf: string | null,
  _ctrc: string | null,
): Promise<LookupStrategy> {
  if (!nf) {
    return { source: "incomplete", reason: "sem_nf_extraida_pelo_triador" };
  }

  // 1. Cockpit já tem card ATIVO com essa NF?
  const { data: existing } = await supabase
    .from("cards")
    .select("id, state")
    .eq("nf", nf)
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .limit(1);

  if (existing && existing.length > 0) {
    return { source: "cockpit_existing", card_id: existing[0]!.id as string };
  }

  // 2. Bastão tem pendência com essa NF?
  try {
    const pendencia = await bastao.fetchPendenciaByNf(nf);
    if (pendencia) {
      return { source: "bastao", pendencia };
    }
  } catch (err) {
    console.warn(`Bastão lookup falhou pra NF ${nf}:`, err);
  }

  // 3. SSW tracking: tenta cada (pagador, senha) cadastrado
  for (const pagador of Object.keys(senhaByCnpj)) {
    try {
      const result = await sswTracking.fetchByNf(pagador, nf);
      if (isTrackingSuccess(result)) {
        return { source: "ssw_tracking", pagador, data: result };
      }
    } catch (err) {
      console.warn(`SSW tracking falhou pagador=${pagador} nf=${nf}:`, err);
    }
  }

  // 4. Incomplete
  return { source: "incomplete", reason: `nf_${nf}_nao_localizada_em_bastao_nem_ssw` };
}

// =============================================================================
// Card creators
// =============================================================================

async function createCardFromBastao(
  supabase: SupabaseClient,
  p: BastaoPendencia,
  m: QueueMessage["message"],
): Promise<string> {
  const newState = p.cod_ultima_ocorrencia === 54 ? "AGUARDANDO_CLIENTE" : "AGUARDANDO_AGENTE";

  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf: p.nf,
      ctrc: p.ctrc,
      canal_origem: m.canal,
      remetente_inicial: m.remetente,
      empresa_cliente: p.pagador ?? m.classification.empresa_cliente,
      nome_cliente: m.classification.nome_cliente,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: p.responsavel_relacionamento,
      state: newState,
      tipo: m.classification.tipo,
      risco: m.classification.risco,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      agent_state: {
        bastao_pendencia_id: p.id,
        cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
        instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
        cnpj_remetente: p.cnpj_remetente,
        cnpj_pagador: p.cnpj_pagador,
        dias_atraso: p.atraso_original,
        criado_via: "vinculador.bastao",
      },
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards (bastao): ${insErr.message}`);
  const cardId = insertedCard.id as string;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "BastaoCardImportado",
    actor_type: "system",
    actor_id: "vinculador",
    payload: { bastao_pendencia_id: p.id, source: "vinculador.bastao", message_id: m.message_id },
  });

  return cardId;
}

async function createCardFromSswTracking(
  supabase: SupabaseClient,
  pagador: string,
  data: SswTrackingSuccessResponse,
  nf: string,
  m: QueueMessage["message"],
  defaultOperatorId: string | null,
): Promise<string> {
  // Schema empírico (curl 2026-04-29):
  //   { success, message, header: { remetente, destinatario }, tracking: [{ data_hora, dominio, filial, cidade, ocorrencia, descricao, tipo, ... }] }
  //
  // CNPJs NÃO vêm nessa API pública (só nomes legais). cnpj_remetente fica
  // null aqui — executor lida com null mandando "" pro SSW (v1 fazia o mesmo).
  const d = data as Record<string, unknown>;
  const header = (d["header"] as Record<string, unknown> | undefined) ?? {};
  const tracking = (d["tracking"] as Array<Record<string, unknown>> | undefined) ?? [];

  const remetente = pickStr(header, ["remetente"]) ?? pickStr(d, ["remetente"]);
  const destinatario = pickStr(header, ["destinatario"]) ?? pickStr(d, ["destinatario"]);

  // Última ocorrência = último item do array tracking[]
  const lastOcor = tracking[tracking.length - 1];
  const ocorrenciaTxt = lastOcor ? pickStr(lastOcor, ["ocorrencia"]) : null;
  const descricaoTxt = lastOcor ? pickStr(lastOcor, ["descricao"]) : null;
  const filialAtual = lastOcor ? pickStr(lastOcor, ["filial"]) : null;
  const cidadeAtual = lastOcor ? pickStr(lastOcor, ["cidade"]) : null;
  const dataUltimaOc = lastOcor ? pickStr(lastOcor, ["data_hora"]) : null;

  // Tenta extrair "(NN)" do texto da última ocorrência → código numérico
  const codMatch = ocorrenciaTxt ? ocorrenciaTxt.match(/\((\d{1,3})\)\s*$/) : null;
  const codUltOcor = codMatch ? parseInt(codMatch[1]!, 10) : null;

  // Tenta extrair "Destino: UF/CIDADE" da descrição da ocorrência (heurístico)
  const destMatch = descricaoTxt ? descricaoTxt.match(/Destino:\s*([A-Z]{2})\s*\/\s*([A-Z][A-Z\s]+?)(?:\.|$)/i) : null;
  const ufDestino = destMatch ? destMatch[1]!.toUpperCase() : null;
  const cidadeDestino = destMatch ? destMatch[2]!.trim() : null;

  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf,
      ctrc: null,
      canal_origem: m.canal,
      remetente_inicial: m.remetente,
      empresa_cliente: destinatario ?? m.classification.empresa_cliente,
      nome_cliente: m.classification.nome_cliente,
      pagador: pagador, // CNPJ/CPF pagador veio do tracking_credentials lookup
      base_destino: filialAtual,
      state: "AGUARDANDO_AGENTE",
      tipo: m.classification.tipo,
      risco: m.classification.risco,
      assigned_operator_id: defaultOperatorId,
      cod_ultima_ocorrencia: codUltOcor,
      bastao_synced_at: null,
      agent_state: {
        criado_via: "vinculador.ssw_tracking",
        cnpj_pagador: pagador,
        remetente_carga: remetente,
        destinatario,
        cidade_destino: cidadeDestino,
        uf_destino: ufDestino,
        cidade_atual: cidadeAtual,
        filial_atual: filialAtual,
        cod_ultima_ocorrencia: codUltOcor,
        instrucao_ultima_ocorrencia: descricaoTxt,
        ocorrencia_label: ocorrenciaTxt,
        data_ultima_ocorrencia: dataUltimaOc,
        ssw_tracking_count: tracking.length,
      },
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards (ssw): ${insErr.message}`);
  const cardId = insertedCard.id as string;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "SswTrackingImportado",
    actor_type: "system",
    actor_id: "vinculador",
    payload: {
      pagador,
      nf,
      message_id: m.message_id,
      header: { remetente, destinatario },
      ultima_ocorrencia: ocorrenciaTxt,
      cod_ultima_ocorrencia: codUltOcor,
      tracking_count: tracking.length,
    },
  });

  return cardId;
}

async function createIncompleteCard(
  supabase: SupabaseClient,
  reason: string,
  nf: string | null,
  ctrc: string | null,
  m: QueueMessage["message"],
  defaultOperatorId: string | null,
): Promise<string> {
  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf,
      ctrc,
      canal_origem: m.canal,
      remetente_inicial: m.remetente,
      empresa_cliente: m.classification.empresa_cliente,
      nome_cliente: m.classification.nome_cliente,
      state: "AGUARDANDO_CONTEXTO",
      tipo: m.classification.tipo,
      risco: m.classification.risco,
      assigned_operator_id: defaultOperatorId,
      agent_state: {
        criado_via: "vinculador.incompleto",
        motivo: reason,
        precisa_preenchimento_manual: true,
      },
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards (incompleto): ${insErr.message}`);
  const cardId = insertedCard.id as string;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "ContextoFaltando",
    actor_type: "system",
    actor_id: "vinculador",
    payload: { motivo: reason, message_id: m.message_id },
  });

  return cardId;
}

// =============================================================================
// To-do creator
// =============================================================================

async function createReentregaTodo(
  supabase: SupabaseClient,
  cardId: string,
  m: QueueMessage["message"],
): Promise<void> {
  // Pega cnpj_remetente do agent_state pra montar o payload completo da ação
  const { data: card } = await supabase
    .from("cards")
    .select("nf, agent_state")
    .eq("id", cardId)
    .single();

  const agentState = (card?.agent_state ?? {}) as Record<string, unknown>;
  const cnpjRemetente = (agentState["cnpj_remetente"] as string | undefined) ?? null;
  const nf = card?.nf as string | null;

  const actionId = crypto.randomUUID();

  await supabase.from("todos").insert({
    card_id: cardId,
    action_id: actionId,
    descricao: "Lançar ocorrência 21 no SSW — reentrega solicitada",
    status: "pendente",
    proposta_payload: {
      tool: "lancar_ocorrencia",
      args: {
        codigo: "21",
        nf,
        cnpj_remetente: cnpjRemetente,
        descricao: `Reentrega solicitada — ${m.classification.resumo}`,
      },
      rationale: m.classification.descricao_problema,
      texto: null,
    },
  });
}

// =============================================================================
// Helpers
// =============================================================================

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

