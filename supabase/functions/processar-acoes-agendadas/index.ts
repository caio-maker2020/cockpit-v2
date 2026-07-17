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
import { decidirProximoPassoFalhaCobranca } from "../_shared/fila-acoes-agendadas.ts";

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
  // Review 2026-07-17: falha reagendada/definitiva NÃO conta como processado —
  // o summary all-green mascarava exatamente a saturação de 07/2026.
  cobrancas_reagendadas: number;
  cobrancas_falha_definitiva: number;
  cobrancas_encerradas_concorrente: number;
  erros: Array<{ acao_id: number; message: string }>;
  duration_ms: number;
}

type ResultadoCobranca =
  | "processado"
  | "obsoleto"
  | "reagendado"
  | "falha_definitiva"
  // Ação foi encerrada por outro ator (vinculador cancelou) enquanto a rodada
  // estava em voo — guard status='pendente' casou 0 linhas; nada a fazer.
  | "encerrada_concorrente";

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
    cobrancas_reagendadas: 0,
    cobrancas_falha_definitiva: 0,
    cobrancas_encerradas_concorrente: 0,
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
        // Handler controla o próprio status (processado | pendente-reagendado |
        // cancelado-com-alerta). INV-fila (fix 2026-07-16): falha NUNCA mantém
        // a ação pendente com executar_em no passado — era isso que saturava a
        // janela LIMIT 200 e starvava os cancelamentos de reentrega.
        const resultado = await processarCobrancaEmail(supabase, acao);
        if (resultado === "reagendado") summary.cobrancas_reagendadas++;
        else if (resultado === "falha_definitiva") summary.cobrancas_falha_definitiva++;
        else if (resultado === "encerrada_concorrente") summary.cobrancas_encerradas_concorrente++;
        else summary.processados++;
      } else if (acao.tipo === "cancelar_reentrega_ssw") {
        // Handler tem controle próprio sobre status (processado | cancelado |
        // pendente-reagendado) pq lida com retries +24h e falhas definitivas.
        await processarCancelarReentregaSsw(supabase, acao, env);
        summary.processados++;
      } else {
        throw new Error(`Tipo desconhecido: ${acao.tipo}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.erros.push({ acao_id: acao.id, message });

      // Review 2026-07-17: INV-fila também nos paths de EXCEÇÃO da cobrança
      // (SELECT card / INSERT todo / UPDATE que falhou). Best-effort: reagenda
      // ou encerra via o mesmo decisor; se até isso falhar, a ação fica onde
      // está mas o erro já está no summary (visível) — nunca falha silenciosa.
      //
      // Exceção marcada [pos-sucesso] NÃO entra no best-effort (review R2): a
      // proposta JÁ foi criada (todo + card travado + evento) e só o UPDATE de
      // bookkeeping falhou — reagendar aqui criaria um SEGUNDO todo no ciclo.
      // Deixar pendente é seguro: na próxima rodada o card está fora de
      // AGUARDANDO_CLIENTE → path obsoleto marca processado (self-healing).
      //
      // Escopo deliberado cobranca_email-only: o handler de reentrega já é
      // dono dos próprios retries (+24h, teto 3, precisa_acao); exceção lá
      // (ex.: SSW fora do ar) é transiente e re-tentada a cada 15 min por
      // design — reagendar +24h atrasaria cancelamentos legítimos. A saúde da
      // fila como um todo é vigiada pelo alerta do audit-invariante.
      if (acao.tipo === "cobranca_email" && !message.startsWith("[pos-sucesso]")) {
        try {
          const resultadoBestEffort = await adiarOuEscalarCobranca(supabase as SupabaseClient, acao, {
            eventTypePrimeiraFalha: "CobrancaAdiadaPorErro",
            motivo: `Exceção no processamento: ${message}`.slice(0, 500),
            eventPayloadExtra: {},
          });
          // Review R2: paths de exceção também contam no summary
          if (resultadoBestEffort === "reagendado") summary.cobrancas_reagendadas++;
          else if (resultadoBestEffort === "falha_definitiva") summary.cobrancas_falha_definitiva++;
        } catch (e2) {
          console.error(
            `INV-fila best-effort falhou pra acao ${acao.id}:`,
            e2 instanceof Error ? e2.message : String(e2),
          );
        }
      }
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
 *
 * Fix 2026-07-16 (fila saturada): controla o PRÓPRIO status, como o handler
 * de reentrega. Falha (sem contato / sem template) NUNCA mais deixa a ação
 * 'pendente' com o mesmo executar_em — reagenda +24h com teto de tentativas
 * e depois encerra como 'cancelado' + alerta visível. Ver INV-fila em
 * _shared/fila-acoes-agendadas.ts. Devolve o resultado pro summary não
 * mascarar falha como processado (review 2026-07-17).
 */
async function processarCobrancaEmail(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
): Promise<ResultadoCobranca> {
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
    await marcarCobrancaProcessada(supabase, acao.id, "obsoleto");
    return "obsoleto";
  }

  const templateId = (acao.payload?.["template_id"] as string | undefined) ?? "COBRANCA_LEMBRETE";

  // Verifica se template existe e está ativo
  const { data: template } = await supabase
    .from("templates_email")
    .select("id, assunto, corpo_template, ativo")
    .eq("id", templateId)
    .maybeSingle();

  if (!template || !template.ativo) {
    return await adiarOuEscalarCobranca(supabase, acao, {
      eventTypePrimeiraFalha: "CobrancaAdiadaSemTemplate",
      motivo: `Template ${templateId} não existe ou não está ativo. Aguardando Larissa popular templates_email.`,
      eventPayloadExtra: { template_id: templateId },
    });
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
    return await adiarOuEscalarCobranca(supabase, acao, {
      eventTypePrimeiraFalha: "CobrancaAdiadaSemContato",
      motivo: `Nenhum contato email cadastrado pra ${card.pagador} em contatos_cliente`,
      eventPayloadExtra: { documento_cliente: card.pagador },
    });
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

  await marcarCobrancaProcessada(supabase, acao.id, "sucesso");
  return "processado";
}

async function marcarCobrancaProcessada(
  supabase: SupabaseClient,
  acaoId: number,
  contexto: "sucesso" | "obsoleto",
): Promise<void> {
  // Guard status='pendente' (review 2026-07-17): se o vinculador cancelou a
  // ação enquanto a rodada estava em voo, não sobrescrever o cancelamento.
  // Prefixo [pos-sucesso] SÓ no contexto sucesso (review R3): sinaliza pro
  // catch do loop que a proposta JÁ foi criada — não reagendar (criaria todo
  // duplicado). No path obsoleto nada foi criado, então o best-effort de
  // reagendamento é seguro e evita pendência eterna se este UPDATE falhar
  // persistentemente.
  const { error } = await supabase
    .from("acoes_agendadas")
    .update({ status: "processado", processed_at: new Date().toISOString() })
    .eq("id", acaoId)
    .eq("status", "pendente");
  if (error) {
    const prefixo = contexto === "sucesso" ? "[pos-sucesso] " : "";
    throw new Error(`${prefixo}UPDATE processado acao ${acaoId}: ${error.message}`);
  }
}

// adiarOuEscalarCobranca — caminho de falha do cobranca_email (sem contato /
// sem template / exceção). Garante o INV-fila: reagenda +24h com tentativas++
// até o teto, depois encerra como 'cancelado' + linha em `alerts` (review
// 2026-07-17: 'precisa_acao' é invisível pra tipo cobranca_email — nenhuma
// tela/view/RPC olha esse status fora de cancelar_reentrega_ssw). O evento
// CobrancaAdiadaSem* sai SÓ na 1ª falha — re-gravar a cada rodada gerou ~19 mil
// card_events/dia durante a saturação de 07/2026. UPDATEs checam {error} e têm
// guard status='pendente' (não ressuscitar ação cancelada concorrentemente).
async function adiarOuEscalarCobranca(
  supabase: SupabaseClient,
  acao: AcaoAgendada,
  opts: {
    eventTypePrimeiraFalha: string;
    motivo: string;
    eventPayloadExtra: Record<string, unknown>;
  },
): Promise<"reagendado" | "falha_definitiva" | "encerrada_concorrente"> {
  const tentativasAtuais = (acao.payload?.["tentativas"] as number | undefined) ?? 0;
  const passo = decidirProximoPassoFalhaCobranca(tentativasAtuais);
  const agora = new Date().toISOString();

  if (passo.acao === "falha_definitiva") {
    // .select("id") pra saber quantas linhas o guard deixou passar (review R2:
    // 0 linhas = vinculador cancelou concorrentemente → NÃO gravar evento nem
    // alerta falsos; a ação foi encerrada corretamente por outro ator).
    const { data: updRows, error: updErr } = await supabase
      .from("acoes_agendadas")
      .update({
        status: "cancelado",
        cancelado_motivo:
          `Cobrança automática falhou ${passo.tentativasTotais} tentativas. Última: ${opts.motivo}`.slice(0, 500),
        processed_at: agora,
        payload: {
          ...acao.payload,
          tentativas: passo.tentativasTotais,
          ultima_falha: opts.motivo,
          ultima_falha_em: agora,
        },
      })
      .eq("id", acao.id)
      .eq("status", "pendente")
      .select("id");
    if (updErr) throw new Error(`UPDATE falha_definitiva acao ${acao.id}: ${updErr.message}`);
    if (!updRows || updRows.length === 0) return "encerrada_concorrente";

    const { error: evErr } = await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: "CobrancaCanceladaAposFalhas",
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: {
        acao_id: acao.id,
        tentativas: passo.tentativasTotais,
        motivo: opts.motivo,
        ...opts.eventPayloadExtra,
      },
    });
    if (evErr) console.error(`card_event CobrancaCanceladaAposFalhas acao ${acao.id}:`, evErr.message);

    // Visibilidade: cobrança que morreu no teto vira alerta (o fluxo de alerts
    // já é monitorado) — sem isso o encerramento seria silencioso.
    const { error: alErr } = await supabase.from("alerts").insert({
      tipo: "cobranca_falha_definitiva",
      severidade: "warning",
      mensagem: (
        `Cobrança automática da ação ${acao.id} (card ${acao.card_id}) cancelada após ` +
        `${passo.tentativasTotais} tentativas: ${opts.motivo}`
      ).slice(0, 900),
      metadata: { acao_id: acao.id, card_id: acao.card_id, ...opts.eventPayloadExtra },
    });
    if (alErr) console.error(`alert cobranca_falha_definitiva acao ${acao.id}:`, alErr.message);
    return "falha_definitiva";
  }

  // Ordem (review R3): UPDATE guardado PRIMEIRO, evento depois. Se o evento
  // viesse antes: (a) update lança → best-effort do catch re-insere o evento
  // (duplicata); (b) update casa 0 linhas (cancelamento concorrente) → evento
  // falso pra ação que nunca vai rodar. Com o update primeiro, o evento só sai
  // quando o reagendamento de fato aconteceu; a flag no payload garante
  // re-tentativa do evento na próxima falha se o insert falhar transiente.
  const jaRegistrado = acao.payload?.["evento_primeira_falha_registrado"] === true;
  const novoExecutarEm = new Date(Date.now() + passo.delayHoras * 60 * 60 * 1000).toISOString();
  const novoPayload = {
    ...acao.payload,
    tentativas: passo.novaTentativa,
    ultima_falha: opts.motivo,
    ultima_falha_em: agora,
  };

  const { data: reagRows, error: reagErr } = await supabase
    .from("acoes_agendadas")
    .update({ executar_em: novoExecutarEm, payload: novoPayload })
    .eq("id", acao.id)
    .eq("status", "pendente")
    .select("id");
  if (reagErr) throw new Error(`UPDATE reagendar acao ${acao.id}: ${reagErr.message}`);
  if (!reagRows || reagRows.length === 0) return "encerrada_concorrente";

  if (!jaRegistrado) {
    const { error: evErr } = await supabase.from("card_events").insert({
      card_id: acao.card_id,
      event_type: opts.eventTypePrimeiraFalha,
      actor_type: "system",
      actor_id: "processar-acoes-agendadas",
      payload: {
        acao_id: acao.id,
        motivo: opts.motivo,
        reagendado_para: novoExecutarEm,
        ...opts.eventPayloadExtra,
      },
    });
    if (evErr) {
      // Flag não persistida → próxima falha re-tenta o registro
      console.error(`card_event ${opts.eventTypePrimeiraFalha} acao ${acao.id}:`, evErr.message);
    } else {
      const { error: flagErr } = await supabase
        .from("acoes_agendadas")
        .update({ payload: { ...novoPayload, evento_primeira_falha_registrado: true } })
        .eq("id", acao.id)
        .eq("status", "pendente");
      // Falha aqui = pior caso um evento duplicado na próxima falha; só logar.
      if (flagErr) console.error(`persistir flag evento acao ${acao.id}:`, flagErr.message);
    }
  }
  return "reagendado";
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
