// =============================================================================
// processar-acoes-agendadas — varre acoes_agendadas pendentes cujo
// executar_em já passou e dispara as ações correspondentes.
//
// Cron: 1x ao dia, 9h BRT (12h UTC). Pode ser chamado manualmente
// também (idempotente — não duplica ações já processadas).
//
// Tipos suportados:
//   - cobranca_email: cria todo no card propondo "enviar email cobrança",
//                     move card pra AGUARDANDO_VALIDACAO_HUMANA + lock=true.
//                     Larissa decide aprovar ou voltar p/ to-do.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

interface AcaoAgendada {
  id: number;
  card_id: string;
  tipo: string;
  executar_em: string;
  payload: Record<string, unknown>;
}

interface Summary {
  pendentes_encontrados: number;
  processados: number;
  erros: Array<{ acao_id: number; message: string }>;
  duration_ms: number;
}

serve(async (_req) => {
  const startedAt = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const summary: Summary = {
    pendentes_encontrados: 0,
    processados: 0,
    erros: [],
    duration_ms: 0,
  };

  const { data: pendentes, error: selErr } = await supabase
    .from("acoes_agendadas")
    .select("id, card_id, tipo, executar_em, payload")
    .eq("status", "pendente")
    .lte("executar_em", new Date().toISOString())
    .order("executar_em", { ascending: true })
    .limit(200);

  if (selErr) {
    return new Response(
      JSON.stringify({ error: selErr.message }),
      { status: 500 },
    );
  }

  summary.pendentes_encontrados = pendentes?.length ?? 0;

  for (const acao of (pendentes ?? []) as AcaoAgendada[]) {
    try {
      if (acao.tipo === "cobranca_email") {
        await processarCobrancaEmail(supabase, acao);
      } else {
        throw new Error(`Tipo desconhecido: ${acao.tipo}`);
      }

      await supabase
        .from("acoes_agendadas")
        .update({ status: "processado", processed_at: new Date().toISOString() })
        .eq("id", acao.id);

      summary.processados++;
    } catch (err) {
      summary.erros.push({
        acao_id: acao.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  summary.duration_ms = Date.now() - startedAt;

  console.log("processar-acoes-agendadas:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

type SupabaseClient = ReturnType<typeof createClient>;

/**
 * Processa cobranca_email:
 *   1. Verifica se card ainda está em AGUARDANDO_CLIENTE (se cliente
 *      respondeu e mudou de state, a ação está obsoleta — só marca
 *      processada sem fazer nada)
 *   2. Cria todo propondo enviar email do template configurado
 *   3. Move card pra AGUARDANDO_VALIDACAO_HUMANA com lock=true
 */
async function processarCobrancaEmail(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
): Promise<void> {
  const { data: card, error: cardErr } = await supabase
    .from("cards")
    .select("id, nf, state, lock_aguardando_validacao, pagador, empresa_cliente, agent_state")
    .eq("id", acao.card_id)
    .single();

  if (cardErr) throw new Error(`SELECT card: ${cardErr.message}`);
  if (!card) throw new Error("card não encontrado");

  // Skip se card não está mais em AGUARDANDO_CLIENTE — ação obsoleta
  if (card.state !== "AGUARDANDO_CLIENTE") {
    console.log(
      `acao ${acao.id} obsoleta — card ${card.id} agora em ${card.state}, pulando cobrança`,
    );
    return;
  }

  const templateId = (acao.payload?.["template_id"] as string | undefined) ?? "COBRANCA_LEMBRETE";

  // Verifica se template existe e está ativo
  const { data: template } = await supabase
    .from("templates_email")
    .select("id, assunto, corpo_template, ativo")
    .eq("id", templateId)
    .maybeSingle();

  if (!template || !template.ativo) {
    // Template ainda não foi populado/ativado pela Larissa — registra evento
    // e mantém ação como pendente (cron tenta de novo amanhã)
    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "CobrancaAdiadaSemTemplate",
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: {
        acao_id: acao.id,
        template_id: templateId,
        motivo: "Template não existe ou não está ativo. Aguardando Larissa popular templates_email.",
      },
    });
    throw new Error(`Template ${templateId} indisponível — adiado`);
  }

  // Verifica se cliente tem email cadastrado
  let emailDestino: string | null = null;
  if (card.pagador) {
    const { data: emailRpc } = await supabase.rpc("resolver_email_cobranca_cliente", {
      p_documento_cliente: card.pagador,
      p_tipo_uso: "cobranca",
    });
    emailDestino = typeof emailRpc === "string" ? emailRpc : null;
  }

  if (!emailDestino) {
    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "CobrancaAdiadaSemContato",
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: {
        acao_id: acao.id,
        documento_cliente: card.pagador,
        motivo: "Nenhum contato email cadastrado pra esse cliente em contatos_cliente",
      },
    });
    throw new Error(`Sem contato email pra ${card.pagador} — adiado`);
  }

  // Tudo OK — cria todo, move card pra AGUARDANDO_VALIDACAO_HUMANA, lock
  const actionId = crypto.randomUUID();
  const { data: novoTodo, error: todoErr } = await supabase
    .from("todos")
    .insert({
      card_id: card.id,
      action_id: actionId,
      descricao: `Reenviar cobrança — sem retorno do cliente há ${acao.payload?.["dias_aguardar"] ?? 4} dias`,
      status: "pendente",
      proposta_payload: {
        tool: "enviar_email_template",
        args: {
          template_id: template.id,
          email_destino: emailDestino,
          nf: card.nf,
        },
        rationale:
          `Auto-proposta sync-cobranca: cliente não respondeu há ${acao.payload?.["dias_aguardar"] ?? 4} dias do email anterior`,
        texto: null,
      },
    })
    .select("id")
    .single();

  if (todoErr) throw new Error(`INSERT todo: ${todoErr.message}`);

  await supabase
    .from("cards")
    .update({
      state: "AGUARDANDO_VALIDACAO_HUMANA",
      lock_aguardando_validacao: true,
    })
    .eq("id", card.id);

  await supabase.from("card_events").insert({
    card_id: card.id,
    event_type: "CobrancaPropostaAutomaticamente",
    actor_type: "system",
    actor_id: "processar-acoes-agendadas",
    payload: {
      acao_id: acao.id,
      todo_id: novoTodo.id,
      action_id: actionId,
      template_id: template.id,
      email_destino: emailDestino,
      dias_sem_retorno: acao.payload?.["dias_aguardar"] ?? 4,
    },
  });
}
