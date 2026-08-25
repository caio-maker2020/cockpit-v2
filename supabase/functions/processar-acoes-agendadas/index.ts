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
import {
  cancelarReentregaPortal,
  listarCTRCsDaNF,
  loadSswInternalEnvForCard,
  obterSessao,
} from "../_shared/ssw-internal-client.ts";
import {
  EVENTO_DEVOLVIDA,
  EVENTO_EXPIRADA,
  FLAG_VETO,
  hashDaProposta,
  TIPO_EXECUTAR_ACAO_AUTONOMA,
  TTL_EXECUCAO_ATRASADA_MIN,
} from "../_shared/acao-autonoma-veto.ts";

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

  // Orçamento por run do trilho de veto (risco 30 do plano 25/08): rajada
  // pós-outage não engarrafa os outros tipos; o que sobrar fica pendente pro
  // próximo run (5min) — e o TTL de 30min expira o que atrasar demais.
  const orcamentoVeto = { restante: 20 };

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
        await supabase
          .from("acoes_agendadas")
          .update({ status: "processado", processed_at: new Date().toISOString() })
          .eq("id", acao.id);
        summary.processados++;
      } else if (acao.tipo === "cancelar_reentrega_ssw") {
        // Handler tem controle próprio sobre status (processado | cancelado |
        // pendente-reagendado) pq lida com retries +24h e falhas definitivas.
        await processarCancelarReentregaSsw(supabase, acao, env);
        summary.processados++;
      } else if (acao.tipo === TIPO_EXECUTAR_ACAO_AUTONOMA) {
        // Janela de veto (plano 25/08). Handler controla o próprio status
        // (processado | cancelado/devolvido | expirado | pendente-adiado).
        await processarExecutarAcaoAutonoma(
          supabase as Parameters<typeof processarExecutarAcaoAutonoma>[0],
          acao,
          orcamentoVeto,
        );
        summary.processados++;
      } else {
        throw new Error(`Tipo desconhecido: ${acao.tipo}`);
      }
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

// =============================================================================
// processarCancelarReentregaSsw — handler do tipo 'cancelar_reentrega_ssw'.
// Caio 2026-05-18.
//
// Fluxo:
//   1. Carrega card + valida que tem ctrc + cnpj_pagador
//   2. Login SSW interno como operador responsável (loadSswInternalEnvForCard)
//   3. Opção 101: listarCTRCsDaNF(nf) → lista todos CT-es
//   4. Filtra CTRC de reentrega:
//        - mesmo cnpj_pagador (proteção contra NF de outro pagador)
//        - tipo == "" (vazio = complementar; NUNCA "NORMAL")
//        - cancelado == false (ignora já cancelados)
//        - se múltiplos: pega o mais recente por data_emissao
//   5. Opção 450: cancelarReentregaPortal({letras, numero, motivo})
//   6. Sucesso → status='processado' + card_event ReentregaCanceladaAutomaticamente
//      Falha "CT-e ainda não emitido" → reagenda +24h (até 3 tentativas)
//      Falha definitiva → status='cancelado' + card_event ReentregaCancelamentoFalhou
//
// IMPORTANTE: nunca cancelar o CT-e NORMAL (original) — isso trava a operação.
// Filtro tipo=="" é a defesa primária. Caller confirma no payload qual foi
// cancelado pra auditoria.
// =============================================================================
const MAX_TENTATIVAS_CANCELAMENTO = 3;

async function processarCancelarReentregaSsw(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  env: Record<string, string>,
): Promise<void> {
  // Caio 2026-05-18: handler usa PAYLOAD como fonte primária. Card 24h após
  // oc=21 normalmente já saiu do Cockpit (state=TRANSFERIDO; oc=21 não é
  // de relacionamento). Card AINDA existe no banco mas não dependemos de
  // estado/dados dele — o snapshot do agendamento (payload) é a fonte canônica.
  // Card é usado só pra resolver credenciais SSW por operador (fallback final).
  const payload = (acao.payload ?? {}) as Record<string, unknown>;
  const nf = (payload["nf"] as string | undefined) ?? null;
  const ctrcOriginal = (payload["ctrc_original"] as string | undefined) ?? null;
  const cnpjPagadorPayload = (payload["cnpj_pagador"] as string | undefined) ?? null;
  const operadorNomePayload = (payload["responsavel_relacionamento"] as string | undefined) ?? null;

  if (!nf) {
    await marcarCancelamentoDefinitivo(supabase, acao, "Payload sem 'nf' — agendamento inválido");
    return;
  }
  if (!cnpjPagadorPayload) {
    await marcarCancelamentoDefinitivo(supabase, acao, "Payload sem 'cnpj_pagador' — não dá pra validar match na lista do SSW");
    return;
  }

  // Card é só best-effort pra credenciais SSW. Se não existir, tenta resolver
  // operador pelo nome direto do payload (responsavel_relacionamento).
  const { data: cardOpt } = await supabase
    .from("cards")
    .select("id, nf, ctrc, state, responsavel_relacionamento, assigned_operator_id")
    .eq("id", acao.card_id)
    .maybeSingle();

  // Aliases pra reusar variáveis no resto do handler sem mudar nome
  const ctrcCard = ctrcOriginal;
  const cnpjPagadorCard = cnpjPagadorPayload;

  const tentativasAtuais = (acao.payload?.["tentativas"] as number | undefined) ?? 0;
  const motivoCancelamento = (acao.payload?.["motivo_cancelamento"] as string | undefined)?.trim() ||
    "PARA FINS DE ROMANEIO";

  // 1. Login SSW como operador.
  // Estratégia: usa card_id se card ainda existe (loadSswInternalEnvForCard
  // resolve via responsavel_relacionamento ou assigned_operator_id). Caso o
  // card tenha sido removido (raro), cai no fallback via operadorNomePayload
  // → readSswInternalEnv direto.
  let sswEnv: Awaited<ReturnType<typeof loadSswInternalEnvForCard>>;
  if (cardOpt?.id) {
    sswEnv = await loadSswInternalEnvForCard(supabase, env, cardOpt.id as string);
  } else if (operadorNomePayload) {
    const { readSswInternalEnv } = await import("../_shared/ssw-internal-client.ts");
    sswEnv = readSswInternalEnv(env, operadorNomePayload);
  } else {
    await marcarCancelamentoDefinitivo(supabase, acao, "Sem card_id válido e sem responsavel_relacionamento no payload — não dá pra resolver credenciais SSW");
    return;
  }
  const sessao = await obterSessao(sswEnv);

  // 2. Opção 101: lista todos os CT-es da NF
  const todosCtrcs = await listarCTRCsDaNF(sessao, nf);

  if (todosCtrcs.length === 0) {
    await tentarReagendarOuFalhar(
      supabase,
      acao,
      tentativasAtuais,
      "Nenhum CT-e retornado pela opção 101 (NF inexistente no SSW ou ainda não aparece)",
    );
    return;
  }

  // 3. Filtra: mesmo pagador (busca pelo CNPJ NORMALIZADO — SSW retorna texto
  // "razão social"; usamos como pista mas a chave de match real é cancelar
  // apenas CTRC com tipo vazio = COMPLEMENTAR/REENTREGA, e nunca o CT-e
  // original do card).
  const ctrcOriginalNorm = (ctrcCard ?? "").toUpperCase().trim();
  // Uma linha é "reentrega/complementar" se: tipo vazio, não é NORMAL e não é o
  // CT-e original do card. O flag `cancelado` NÃO entra aqui de propósito — ele
  // separa reentrega ATIVA (candidata a cancelar) de reentrega JÁ CANCELADA.
  const ehReentrega = (row: typeof todosCtrcs[number]) =>
    row.tipo.toUpperCase() !== "NORMAL" &&
    row.ctrc.toUpperCase() !== ctrcOriginalNorm &&
    row.tipo.trim() === "";

  const candidatos = todosCtrcs.filter((row) => ehReentrega(row) && !row.cancelado);
  const reentregasJaCanceladas = todosCtrcs.filter((row) => ehReentrega(row) && row.cancelado);

  if (candidatos.length === 0) {
    // Caio 2026-06-19 (NF 806554 DUILIO): distinguir DOIS cenários que antes
    // colapsavam no mesmo "Nenhum CT-e de reentrega encontrado" → retry → precisa_acao:
    //   (a) reentrega JÁ CANCELADA no SSW (por humano/operação) → objetivo já
    //       atingido, encerra como tratado. Antes o operador ficava clicando
    //       "Forçar agora" à toa por dias (caso âncora: DUILIO cancelou a
    //       reentrega SSP896106-9 manualmente em 10/06 21:53, mas o Cockpit
    //       reportava "não foi feito" indefinidamente).
    //   (b) reentrega AINDA não emitida → continua reagendando (comportamento atual).
    if (reentregasJaCanceladas.length > 0) {
      await marcarReentregaJaCancelada(supabase, acao, reentregasJaCanceladas);
      return;
    }
    await tentarReagendarOuFalhar(
      supabase,
      acao,
      tentativasAtuais,
      `Nenhum CT-e de reentrega encontrado na lista de ${todosCtrcs.length} CT-es. ` +
      `Tipos: ${todosCtrcs.map((c) => `${c.ctrc}=${c.tipo || "(vazio)"}${c.cancelado ? "[CANCELADO]" : ""}`).join(", ")}`,
    );
    return;
  }

  // Se múltiplos candidatos: pega o mais recente por data_emissao (formato
  // dd/mm/yy do XML — converte pra Date pra comparar).
  candidatos.sort((a, b) => {
    const da = parseDataDDMMYY(a.data_emissao);
    const db = parseDataDDMMYY(b.data_emissao);
    return db.getTime() - da.getTime();
  });
  const escolhido = candidatos[0]!;

  // Quebra "OVD395536-2" em letras + número+dígito pra o helper
  const match = escolhido.ctrc.match(/^([A-Z]{3})(\d+-\d)$/);
  if (!match) {
    await marcarCancelamentoDefinitivo(
      supabase,
      acao,
      `CTRC de reentrega "${escolhido.ctrc}" não bate o formato esperado LLLNNNNNN-N`,
    );
    return;
  }

  // 4. Opção 450: cancela
  const result = await cancelarReentregaPortal(sessao, {
    ctrcLetras: match[1]!,
    ctrcNumero: match[2]!,
    motivo: motivoCancelamento,
    unidade: "MTZ",
  });

  if (result.ok) {
    // Marca processado + grava evento de sucesso. Atualiza payload com o
    // CTRC cancelado pra view de monitoramento.
    const novoPayload = {
      ...acao.payload,
      ctrc_cancelado: escolhido.ctrc,
      ctrc_cancelado_data_emissao: escolhido.data_emissao,
      cancelamento_resposta_snippet: result.raw_response_snippet,
      cancelamento_debug: result.debug,
    };
    await supabase
      .from("acoes_agendadas")
      .update({
        status: "processado",
        processed_at: new Date().toISOString(),
        payload: novoPayload,
      })
      .eq("id", acao.id);

    await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: "ReentregaCanceladaAutomaticamente",
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: {
        acao_id: acao.id,
        nf,
        ctrc_original: ctrcCard,
        ctrc_cancelado: escolhido.ctrc,
        motivo: motivoCancelamento,
        tentativas_total: tentativasAtuais + 1,
      },
    });
    return;
  }

  // Falha SSW — distingue definitivo (precisa_acao) de temporário (reagenda).
  // Caio 2026-05-18: erro definitivo (CTRC faturado, sem permissão, fora de
  // prazo) vai pra status='precisa_acao' com sugestão contextual pro operador
  // agir manualmente na aba. NÃO entra em retry loop.
  if (result.definitivo) {
    await marcarPrecisaAcao(supabase, acao, result.subcategoria, result.error, result.raw_response_snippet ?? "");
    return;
  }

  // Falha temporária (CTRC ainda não emitido, tela inesperada, erro genérico)
  // → reagenda até MAX_TENTATIVAS_CANCELAMENTO. Após N falhas, vira precisa_acao.
  await tentarReagendarOuFalhar(
    supabase,
    acao,
    tentativasAtuais,
    `SSW recusou cancelamento: ${result.error}. Raw: ${(result.raw_response_snippet ?? "").slice(0, 300)}`,
    result.subcategoria,
  );
}

async function tentarReagendarOuFalhar(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  tentativasAtuais: number,
  motivoFalha: string,
  subcategoria?: string,
): Promise<void> {
  if (tentativasAtuais + 1 >= MAX_TENTATIVAS_CANCELAMENTO) {
    // Esgotou retries → vira precisa_acao (operador precisa investigar
    // pq CTRC não foi cancelado após N tentativas).
    await marcarPrecisaAcao(
      supabase,
      acao,
      (subcategoria ?? "outro") as string,
      `Falha após ${MAX_TENTATIVAS_CANCELAMENTO} tentativas. Última: ${motivoFalha}`,
      motivoFalha,
    );
    return;
  }
  // Reagenda +24h e incrementa tentativas
  const novoExecutarEm = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const novoPayload = {
    ...acao.payload,
    tentativas: tentativasAtuais + 1,
    ultima_falha: motivoFalha,
    ultima_falha_em: new Date().toISOString(),
    subcategoria_falha_temporaria: subcategoria,
  };
  await supabase
    .from("acoes_agendadas")
    .update({
      executar_em: novoExecutarEm,
      payload: novoPayload,
    })
    .eq("id", acao.id);

  await supabase.from("card_events").insert({
    card_id: acao.card_id,
    event_type: "ReentregaCancelamentoReagendado",
    actor_type: "system",
    actor_id: "processar-acoes-agendadas",
    payload: {
      acao_id: acao.id,
      tentativa: tentativasAtuais + 1,
      max_tentativas: MAX_TENTATIVAS_CANCELAMENTO,
      reagendado_para: novoExecutarEm,
      motivo: motivoFalha,
      subcategoria,
    },
  });
}

// Mapa de sugestões de ação contextual por subcategoria. Renderizado na aba
// de monitoramento como texto pro operador agir (ex: pedir Maisa, escalar,
// marcar tratado). Pode evoluir pra IA gerar sugestões customizadas no futuro.
const SUGESTOES_POR_SUBCATEGORIA: Record<string, string> = {
  ctrc_faturado:
    "CTRC já foi faturado pela equipe financeira (Maisa). Envie pedido de exclusão da fatura. Após confirmação da exclusão, clique em 'Forçar cancelamento agora' nesta linha.",
  ctrc_inexistente:
    "CT-e de reentrega NÃO foi encontrado no SSW mesmo após várias tentativas. Verificar com a operação se a reentrega foi de fato programada/emitida.",
  ctrc_ja_cancelado:
    "CTRC já foi cancelado anteriormente (manual ou outra automação). Pode marcar como tratado.",
  sem_permissao:
    "Login do operador não tem permissão pra cancelar este CTRC. Pedir ao admin SSW pra liberar acesso à unidade MTZ.",
  fora_prazo:
    "Prazo limite SSW pra cancelamento expirou. Não há cancelamento via opção 450 possível. Avaliar se vale negociar com financeiro/Maisa.",
  tela_inesperada:
    "SSW retornou tela que o sistema não reconhece. Verificar raw_response no debug pra mapear caso novo.",
  outro:
    "Falha não categorizada. Investigar raw_response no histórico ou avisar dev pra mapear o caso.",
};

async function marcarPrecisaAcao(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  subcategoria: string,
  errorMessage: string,
  rawSnippet: string,
): Promise<void> {
  const sugestao = SUGESTOES_POR_SUBCATEGORIA[subcategoria] ?? SUGESTOES_POR_SUBCATEGORIA["outro"];

  const novoPayload = {
    ...acao.payload,
    subcategoria_falha: subcategoria,
    sugestao_acao: sugestao,
    ultima_falha: errorMessage,
    ultima_falha_em: new Date().toISOString(),
    cancelamento_resposta_snippet: rawSnippet,
  };
  await supabase
    .from("acoes_agendadas")
    .update({
      status: "precisa_acao",
      payload: novoPayload,
    })
    .eq("id", acao.id);

  await supabase.from("card_events").insert({
    card_id: acao.card_id,
    event_type: "ReentregaCancelamentoPrecisaAcao",
    actor_type: "system",
    actor_id: "processar-acoes-agendadas",
    payload: {
      acao_id: acao.id,
      subcategoria,
      sugestao_acao: sugestao,
      motivo: errorMessage,
    },
  });
}

async function marcarCancelamentoDefinitivo(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  motivo: string,
): Promise<void> {
  await supabase
    .from("acoes_agendadas")
    .update({
      status: "cancelado",
      cancelado_motivo: motivo.slice(0, 500),
      processed_at: new Date().toISOString(),
    })
    .eq("id", acao.id);

  await supabase.from("card_events").insert({
    card_id: acao.card_id,
    event_type: "ReentregaCancelamentoFalhou",
    actor_type: "system",
    actor_id: "processar-acoes-agendadas",
    payload: {
      acao_id: acao.id,
      motivo,
    },
  });
}

// marcarReentregaJaCancelada — caso "objetivo já atingido". A reentrega/complementar
// já constava CANCELADA no SSW (cancelada manualmente pela operação/operador, fora
// do Cockpit). Não há nada pra cancelar: encerra a ação como `tratado_manualmente`
// (bucket terminal que o front já renderiza) em vez de ficar em retry → precisa_acao.
// NÃO usamos status 'processado' de propósito: o Cockpit NÃO executou cancelamento
// nenhum, então não pode constar como "cancelado pelo Cockpit". Caio 2026-06-19.
async function marcarReentregaJaCancelada(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  reentregasJaCanceladas: Array<{ ctrc: string; data_emissao: string }>,
): Promise<void> {
  const ctrcs = reentregasJaCanceladas.map((r) => r.ctrc);
  const lista = ctrcs.join(", ");
  const agora = new Date().toISOString();
  const novoPayload = {
    ...acao.payload,
    tratado_em: agora,
    tratado_por: "sistema",
    tratado_motivo:
      `Reentrega já constava CANCELADA no SSW (CTRC ${lista}). ` +
      `Cancelamento feito manualmente fora do Cockpit — objetivo já atingido. ` +
      `Encerrado automaticamente, sem nova chamada ao SSW.`,
    cancelado_externamente: true,
    ctrc_cancelado_externamente: lista,
    resolucao: "reentrega_ja_cancelada_no_ssw",
  };
  await supabase
    .from("acoes_agendadas")
    .update({
      status: "tratado_manualmente",
      processed_at: agora,
      payload: novoPayload,
    })
    .eq("id", acao.id);

  await supabase.from("card_events").insert({
    card_id: acao.card_id,
    event_type: "ReentregaJaEstavaCanceladaNoSsw",
    actor_type: "system",
    actor_id: "processar-acoes-agendadas",
    payload: {
      acao_id: acao.id,
      ctrc_cancelado_externamente: ctrcs,
      observacao:
        "Reentrega já estava cancelada no SSW (cancelada fora do Cockpit). " +
        "Ação encerrada como tratada — o Cockpit não executou cancelamento.",
    },
  });
}

function parseDataDDMMYY(s: string): Date {
  // formato dd/mm/yy do XML do SSW
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return new Date(0);
  const dd = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const yy = 2000 + Number(m[3]);
  return new Date(Date.UTC(yy, mm, dd));
}

// =============================================================================
// JANELA DE VETO (plano 25/08) — executa a ação autônoma cujo prazo venceu.
//
// Ordem das defesas (cada uma com evento auditável):
//   kill-switch (risco 10) → orçamento (30) → TTL duro (31) → claim atômico
//   (26) → re-validação completa (6/23/27/28/34) → RPC com pré-voo humano
//   (15/16/21/32, mig 354). Falhou qualquer degrau → DEVOLVE pro humano com
//   motivo; o card segue nas abas de hoje com as sugestões de hoje. NADA aqui
//   marca "executado": isso é do executor após confirmação REAL do SSW.
// =============================================================================
async function processarExecutarAcaoAutonoma(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  orcamento: { restante: number },
): Promise<void> {
  const payload = acao.payload ?? {};
  const todoId = payload["todo_id"] as string | undefined;
  const acaoKey = payload["acao_key"] as string | undefined;
  const regra = (payload["regra"] as string | undefined) ?? `veto_janela:desconhecida:${acaoKey}`;

  const devolver = async (motivo: string) => {
    await supabase
      .from("acoes_agendadas")
      .update({ status: "cancelado", cancelado_motivo: motivo, processed_at: new Date().toISOString() })
      .eq("id", acao.id);
    await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: EVENTO_DEVOLVIDA,
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: { agendamento_id: acao.id, acao_key: acaoKey, todo_id: todoId, motivo },
    });
    console.log(`[veto] DEVOLVIDO card=${acao.card_id} ag=${acao.id}: ${motivo}`);
  };

  // ── Kill-switch limpo (risco 10): flag OFF → nada executa, tudo devolve.
  const { data: flagRow } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_VETO).maybeSingle();
  if ((flagRow as { enabled?: boolean } | null)?.enabled !== true) {
    await devolver("kill-switch: flag master desligada");
    return;
  }

  // ── Orçamento por run (risco 30): estourou → fica pendente pro próximo run.
  if (orcamento.restante <= 0) {
    console.log(`[veto] orçamento do run esgotado — ag=${acao.id} fica pro próximo (5min)`);
    return;
  }

  // ── TTL duro (risco 31): atrasado NUNCA executa.
  const atrasoMin = (Date.now() - new Date(acao.executar_em).getTime()) / 60000;
  if (atrasoMin > TTL_EXECUCAO_ATRASADA_MIN) {
    await supabase
      .from("acoes_agendadas")
      .update({ status: "expirado", processed_at: new Date().toISOString(),
                cancelado_motivo: `TTL: venceu há ${Math.round(atrasoMin)}min sem processar` })
      .eq("id", acao.id)
      .eq("status", "pendente");
    await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: EVENTO_EXPIRADA,
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: { agendamento_id: acao.id, acao_key: acaoKey, atraso_min: Math.round(atrasoMin) },
    });
    return;
  }

  // ── Claim atômico (risco 26): pendente→executando ou aborta (corrida com
  // cancelamento do operador / outro run). O espelho no card atualiza junto.
  const { data: claim } = await supabase
    .from("acoes_agendadas")
    .update({ status: "executando", claimed_at: new Date().toISOString() })
    .eq("id", acao.id)
    .eq("status", "pendente")
    .select("id");
  if (!claim || (claim as unknown[]).length === 0) {
    console.log(`[veto] claim perdido ag=${acao.id} (cancelado/executado por outro caminho)`);
    return;
  }

  // ── Re-validação completa no vencimento (risco 6): o mundo pode ter mudado.
  if (!todoId || !acaoKey) {
    await devolver("agendamento sem todo_id/acao_key no payload");
    return;
  }

  const { data: todo } = await supabase
    .from("todos").select("id, status, proposta_payload")
    .eq("id", todoId).maybeSingle();
  if (!todo || (todo as { status?: string }).status !== "pendente") {
    await devolver(`todo não está mais pendente (${(todo as { status?: string } | null)?.status ?? "sumiu"})`);
    return;
  }

  // hash da proposta (risco 23): payload mutado na janela nunca executa às
  // cegas. Edição LEGÍTIMA do operador atualiza payload.hash_proposta (RPC da
  // etapa E) — aí os hashes batem de novo.
  const hashAtual = hashDaProposta((todo as { proposta_payload?: unknown }).proposta_payload);
  if (hashAtual !== payload["hash_proposta"]) {
    await devolver("proposta mudou durante a janela (hash divergente)");
    return;
  }

  // resposta do cliente no meio (defensivo — o cancelamento amplo já cobre)
  const agendadoEm = (payload["agendado_em"] as string | undefined) ?? acao.executar_em;
  const { data: msgsNovas } = await supabase
    .from("messages_inbox").select("id")
    .eq("card_id", acao.card_id)
    .gt("recebido_em", agendadoEm)
    .limit(1);
  if ((msgsNovas ?? []).length > 0) {
    await devolver("cliente respondeu durante a janela — sugestão precisa ser refeita");
    return;
  }

  // fontes de destaque (risco 28): se ALGUMA fonte viva aponta outra ação,
  // o Pass D/re-análise divergiu do agendado → humano decide.
  const { data: cardAtual } = await supabase
    .from("cards")
    .select("cod_ultima_ocorrencia, aviso_alteracao_oc, ia_sugestao_oc_resposta, assigned_operator_id")
    .eq("id", acao.card_id).maybeSingle();
  const aviso = (cardAtual as { aviso_alteracao_oc?: { proposta_destacada_acao?: string } | null } | null)
    ?.aviso_alteracao_oc ?? null;
  const iaResp = (cardAtual as { ia_sugestao_oc_resposta?: { proposta_destacada_acao?: string } | null } | null)
    ?.ia_sugestao_oc_resposta ?? null;
  const fontes = [aviso?.proposta_destacada_acao, iaResp?.proposta_destacada_acao]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  if (fontes.length > 0 && !fontes.includes(acaoKey)) {
    await devolver(`destaque atual (${fontes.join("|")}) divergiu do agendado (${acaoKey})`);
    return;
  }

  // oc do card mudou (risco 34, camada 1): snapshot do agendamento vs agora.
  // Camada 2 é o guard tripé do executor, que valida o estado REAL no SSW
  // (act=O em mãos) imediatamente antes do submit — INV-006.
  const ocCardSnapshot = payload["oc_card"] as number | null | undefined;
  const ocCardAgora = (cardAtual as { cod_ultima_ocorrencia?: number | null } | null)?.cod_ultima_ocorrencia ?? null;
  if (ocCardSnapshot != null && ocCardAgora != null && ocCardSnapshot !== ocCardAgora) {
    await devolver(`oc do card mudou na janela (${ocCardSnapshot}→${ocCardAgora})`);
    return;
  }

  // poll do Gmail fresco (risco 27) — só pra ações com e-mail: a janela real
  // é a janela MENOS a latência do poll. Poll velho → ADIA (volta pra
  // pendente; o TTL expira se ficar velho demais).
  if (acaoKey.includes("email")) {
    const dono = (cardAtual as { assigned_operator_id?: string | null } | null)?.assigned_operator_id ?? null;
    if (dono) {
      const { data: poll } = await supabase
        .from("gmail_polling_state").select("last_success_at")
        .eq("operador_id", dono).maybeSingle();
      const lastOk = (poll as { last_success_at?: string | null } | null)?.last_success_at ?? null;
      const pollVelhoMin = lastOk ? (Date.now() - new Date(lastOk).getTime()) / 60000 : Infinity;
      if (pollVelhoMin > 20) {
        await supabase
          .from("acoes_agendadas")
          .update({ status: "pendente", claimed_at: null })
          .eq("id", acao.id)
          .eq("status", "executando");
        console.log(`[veto] ADIADO ag=${acao.id}: poll Gmail do dono com ${Math.round(pollVelhoMin)}min — espera a rodada`);
        return;
      }
    }
  }

  // ── Execução: RPC com o pré-voo humano completo (mig 354). Exceção da RPC
  // (chave, multi-thread, todo mudou) → devolve com o motivo dela.
  orcamento.restante--;
  const { data: rpcData, error: rpcErr } = await supabase.rpc("auto_aprovar_e_executar_veto", {
    p_todo_id: todoId,
    p_agendamento_id: acao.id,
    p_regra: regra,
  });
  if (rpcErr) {
    await devolver(`pré-voo recusou: ${rpcErr.message}`);
    return;
  }

  await supabase
    .from("acoes_agendadas")
    .update({ status: "processado", processed_at: new Date().toISOString() })
    .eq("id", acao.id);
  console.log(`[veto] EXECUTADO card=${acao.card_id} ag=${acao.id} ${acaoKey}:`, JSON.stringify(rpcData));
}
