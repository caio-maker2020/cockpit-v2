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
// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005): 3ª fonte
// "SSW tracking público" REMOVIDA do vinculador. Cards só são criados via
// Bastão (input canônico) ou cockpit_existing. Cliente que cobra NF não-
// pendente não criará card automático — vai pro fluxo "incomplete" e
// processing_status fica como "nf não localizada". Foco no go-live é
// pendências reais. Evolução futura (cliente cobra antes da pendência aparecer)
// fica fora desse plano.
import { invokeNext } from "../_shared/invoke-next.ts";
import { resolverEPersistirChaveCte } from "../_shared/chave-cte-resolver.ts";
import { verificarEvidenciaESinalizar } from "../_shared/verificar-evidencia.ts";
import { resolverCamposAtribuicaoDoCard } from "../_shared/operador-resolver.ts";
import { clampOcAoDicionario } from "../_shared/safe-oc-update.ts";
import {
  aplicarRegraExtravioComCobrancaCliente,
  OCORRENCIAS_EXTRAVIO_PERDAS,
  proporAutoAcaoSeAplicavel,
} from "../_shared/regras-auto-acao.ts";
import { OCORRENCIAS_DE_RELACIONAMENTO, ehOcAguardandoCliente } from "../_shared/bastao-rules.ts";
import {
  decidirAcionamentoPorRespostaCliente,
  STATES_TERMINAIS_ANEXA_SEM_MOVER,
} from "../_shared/acionamento-resposta-cliente.ts";
import {
  loadRemetenteAuthIndex,
  remetenteAutorizado,
  type RemetenteAuthIndex,
} from "../_shared/remetente-autorizado.ts";
// Caio 2026-06-23 (NF 761583, INV-016): criação de propostas pós-resposta
// cliente extraída pra módulo compartilhado (fonte única). Antes vivia só aqui,
// atrás do triador LLM — Anthropic 529 dropava a mensagem no DLQ e o card ficava
// "cliente respondeu, IA sugeriu, ZERO botões". Agora scan-email-pre-card e o
// cron de retry também chamam essa função, de forma determinística.
import { acionarRespostaCliente } from "../_shared/acionar-resposta-cliente.ts";
import {
  atualizarPropostasAposRespostaCliente,
  type PropostasInfo,
} from "../_shared/propostas-pos-resposta-cliente.ts";

const VT_SECONDS = 120;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;

// Allowlist de NFs que podem auto-executar reentrega (sem operador clicar
// Aprovar). FASE TESTE desativada em 2026-05-04 — Caio pediu pra desativar
// porque oc=13 é de Operações; só vai aplicar pra clientes específicos depois,
// com gate por cliente (não por NF). Mantém vazia até regra nova chegar.
const AUTO_APPROVE_REENTREGA_NFS: string[] = [];

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
      cliente_autorizou_reentrega?: boolean;
    };
    canal: "whatsapp" | "email" | "sistema";
    remetente: string;
    conteudo: string;
    recebido_em: string;
  };
}

type LookupStrategy =
  | { source: "cockpit_existing"; card_id: string; previous_state: string }
  | { source: "bastao"; pendencia: BastaoPendencia }
  | { source: "incomplete"; reason: string };
// Caio 2026-05-13: branch "ssw_tracking" removida (Fase 3 plano hoje-usamos-o-bastao).

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

    // Caio 2026-05-13 (Fase 3): SSW tracking público removido. Vinculador
    // não consulta mais como 3ª fonte de lookup de NF. Bastão é INPUT canônico.

    // Carrega whitelist de domínios autorizados (contatos_cliente + slugs de
    // clientes.nome). Filtra notificações automáticas (sswemail@ssw.inf.br etc).
    const remetenteAuthIndex = await loadRemetenteAuthIndex(supabase);

    // Caio 2026-05-14 (multi-operador): operador é resolvido por card via
    // resolveOperadorDoCard (hints: responsavel_relacionamento → carteira →
    // segmento). Substitui o fallback hardcoded "LARISSA" da fase de teste.
    // Paths que ainda recebem `defaultOperatorId` (createCardFromSswTracking +
    // createIncompleteCard) são dead code pós-Fase 3 — recebem null aqui pra
    // não quebrar assinatura até cleanup.
    const defaultOperatorId: string | null = null;

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
        await processOne(supabase, bastao, remetenteAuthIndex, defaultOperatorId, job, summary);
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
// Caio 2026-05-13: SswTrackingClient type alias removido (Fase 3).

async function processOne(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  remetenteAuthIndex: RemetenteAuthIndex,
  defaultOperatorId: string | null,
  job: QueueMessage,
  summary: RunSummary,
): Promise<void> {
  const m = job.message;
  const nf = m.classification.nfs[0] ?? null;
  const ctrc = m.classification.ctrcs[0] ?? null;

  // 0. Lookup por thread (In-Reply-To): se email novo é resposta a outro
  //    que já tem card_id, linka direto sem precisar de NF nova.
  //    Cobre o caso "cliente respondeu email anterior pra continuar tratativa".
  //    Pula a regra "incomplete = ignorar" porque a thread já contextualiza.
  const threadCardId = await lookupThreadCardId(supabase, m.message_id);
  if (threadCardId) {
    await supabase.from("messages_inbox").update({ card_id: threadCardId }).eq("id", m.message_id);
    await supabase.from("card_events").insert({
      card_id: threadCardId,
      event_type: "MensagemAnexadaPorThread",
      actor_type: "system",
      actor_id: "vinculador",
      payload: {
        message_id: m.message_id,
        canal: m.canal,
        remetente: m.remetente,
        motivo: "cliente respondeu email anterior (linkado via In-Reply-To)",
      },
    });

    // Caio 2026-05-06: thread linkada num card AGUARDANDO_CLIENTE = cliente
    // respondeu email enviado pelo Cockpit. Mesma lógica do else-if abaixo
    // (linha ~313) — transita pra AGUARDANDO_VALIDACAO_HUMANA + dispara IA.
    const { data: cardRow } = await supabase
      .from("cards")
      .select("nf, state, cliente_respondeu_em, cod_ultima_ocorrencia")
      .eq("id", threadCardId)
      .maybeSingle();
    const cardState = (cardRow as { state?: string } | null)?.state;
    const cardNf = (cardRow as { nf?: string | null } | null)?.nf ?? null;
    const tinhaCliRespondeu = (cardRow as { cliente_respondeu_em?: string | null } | null)?.cliente_respondeu_em != null;
    const cardOc = (cardRow as { cod_ultima_ocorrencia?: number | null } | null)?.cod_ultima_ocorrencia ?? null;

    // Corrida do TRANSFERIDO transitório (Duílio 2026-07-28, NFs 1494200/174873/
    // 20219): o confirmador marca TRANSFERIDO no INSTANTE do lançamento, mas
    // cod_ultima_ocorrencia só sincroniza a oc de relacionamento minutos depois
    // (Bastão). Resposta que chega nessa janela é avaliada com a oc DEFASADA
    // (ocPertenceAoCockpit=false) e era engolida — mesmo o card sendo aguardando-
    // cliente de verdade. Sinal robusto e independente da oc: houve ação SSW
    // bem-sucedida do Cockpit no card nos últimos 60 min → transitório → aciona.
    // Só consulta em card TERMINAL (evita a query no caminho comum de card ativo).
    const JANELA_ACAO_RECENTE_MS = 60 * 60 * 1000;
    let acaoCockpitRecente = false;
    if (cardState != null && STATES_TERMINAIS_ANEXA_SEM_MOVER.includes(cardState)) {
      const { data: acaoRecente } = await supabase
        .from("acoes_executadas_ssw")
        .select("id")
        .eq("card_id", threadCardId)
        .eq("sucesso", true)
        .gte("iniciado_em", new Date(Date.now() - JANELA_ACAO_RECENTE_MS).toISOString())
        .limit(1)
        .maybeSingle();
      acaoCockpitRecente = acaoRecente != null;
    }

    // Caio 2026-05-19 (NF 1492103, Duilio): cliente pode responder N vezes
    // em sequência — re-resposta em AVH com carimbo re-aciona IA.
    // PREMISSA Caio 2026-07-23 (refinada pós-NF 73220 e 25/07 pós-NF 150431),
    // fonte única decidirAcionamentoPorRespostaCliente (INV-042):
    //   1. card ATIVO → move, sempre;
    //   2. terminal com oc FORA de relacionamento/cliente = tratado → anexa
    //      SEM mover; terminal com oc DO cockpit é transitório → ACIONA
    //      (regra da oc, Caio 25/07);
    //      se a NF tem OUTRO card ativo, a resposta é ROTEADA pra ele;
    //   3. card novo criado depois entra na premissa 1.
    let alvoCardId = threadCardId;
    let alvoState = cardState;
    let alvoTinha = tinhaCliRespondeu;
    let roteadoDeCardTerminal = false;
    let decisaoAcionamento = decidirAcionamentoPorRespostaCliente(alvoState, alvoTinha, cardOc, acaoCockpitRecente);

    if (decisaoAcionamento.acao === "anexar_sem_mover" && cardNf) {
      // Premissa 2/C: procura card ATIVO da mesma NF pra rotear a resposta.
      const { data: ativos } = await supabase
        .from("cards")
        .select("id, state, cliente_respondeu_em, cod_ultima_ocorrencia")
        .eq("nf", cardNf)
        .neq("id", threadCardId)
        .not("state", "in", "(TRANSFERIDO,RESOLVIDO,CANCELADO)")
        .order("created_at", { ascending: false })
        .limit(1);
      const ativo = (ativos ?? [])[0] as
        | { id: string; state: string; cliente_respondeu_em: string | null; cod_ultima_ocorrencia: number | null }
        | undefined;
      if (ativo) {
        await supabase.from("messages_inbox").update({ card_id: ativo.id }).eq("id", m.message_id);
        await supabase.from("card_events").insert({
          card_id: ativo.id,
          event_type: "MensagemRoteadaParaCardAtivo",
          actor_type: "system",
          actor_id: "vinculador",
          payload: {
            message_id: m.message_id,
            de_card_id: threadCardId,
            de_card_state: cardState ?? null,
            nf: cardNf,
            motivo:
              "Resposta em thread de card terminal, mas a NF tem card ATIVO — premissa 1 do Caio (23/07) vale pro card vivo.",
          },
        });
        alvoCardId = ativo.id;
        alvoState = ativo.state;
        alvoTinha = ativo.cliente_respondeu_em != null;
        roteadoDeCardTerminal = true;
        decisaoAcionamento = decidirAcionamentoPorRespostaCliente(
          alvoState,
          alvoTinha,
          ativo.cod_ultima_ocorrencia,
        );
      } else {
        // Premissa 2/D: sem card ativo — anexa muda + auditoria; card não volta.
        await supabase.from("card_events").insert({
          card_id: threadCardId,
          event_type: "RespostaClienteEmCardTransferido",
          actor_type: "system",
          actor_id: "vinculador",
          payload: {
            message_id: m.message_id,
            card_state: cardState ?? null,
            remetente: m.remetente,
            motivo:
              "Card terminal com oc FORA de relacionamento/cliente = tratado de verdade (premissa 2 + regra da oc, Caio 25/07) — mensagem anexada, card NÃO reaberto, sem card ativo da NF pra rotear.",
          },
        });
      }
    }

    const acionaIa = decisaoAcionamento.acao === "acionar";

    if (acionaIa) {
      // Efeito do acionamento: FONTE ÚNICA em _shared/acionar-resposta-cliente.ts
      // (Caio 2026-08-11). Antes vivia inline aqui; o reconciliador de respostas
      // pendentes precisa do MESMO efeito, e duplicar o bloco recriaria a
      // divergência que originou o INV-042. Semântica idêntica à anterior.
      await acionarRespostaCliente(supabase, {
        cardId: alvoCardId,
        messageId: m.message_id,
        stateAnterior: alvoState,
        canal: m.canal,
        remetente: m.remetente,
        actorId: "vinculador",
        motivoCancelamentoAgendadas: "cliente respondeu (via thread)",
        payloadExtra: {
          roteado_de_card_terminal: roteadoDeCardTerminal,
          via: "thread",
        },
      });
    }

    // Aplica regra de extravio se cabível (cobrança em card oc=6/9/16).
    // Usa o card-alvo (roteado quando a thread era de card terminal).
    await aplicarExtravioSeCabivel(supabase, alvoCardId);

    // Caio 2026-05-07: BUG CRÍTICO corrigido — early-return sem delete_from_pgmq
    // causava loop infinito (msg re-aparecia a cada visibility timeout).
    // NF 196537 oscilava entre AGUARDANDO_VOCE/CLIENTE a cada 2-3min porque
    // vinculador re-processava a mesma mensagem.
    await supabase.rpc("delete_from_pgmq", {
      queue_name: "agent_specialist",
      msg_id: job.msg_id,
    });
    return;
  }

  // 0.5. Filtro de remetente (regra Caio 2026-05-04): só email de domínio
  // cadastrado em contatos_cliente OU que bate com slug do nome de algum
  // cliente cadastrado pode CRIAR card. Notificações automáticas SSW
  // (sswemail@ssw.inf.br etc) ficam fora.
  // Email com thread já passou no early-return acima — não cai aqui.
  if (m.canal === "email") {
    const auth = remetenteAutorizado(m.remetente, remetenteAuthIndex);
    if (!auth.ok) {
      await supabase
        .from("messages_inbox")
        .update({ processing_status: `ignored_remetente_${auth.motivo}` })
        .eq("id", m.message_id);
      await supabase.rpc("delete_from_pgmq", { queue_name: "agent_specialist", msg_id: job.msg_id });
      return;
    }
  }

  // 1. Lookup chain (cockpit/bastão/incomplete). Caio 2026-05-13: branch
  // ssw_tracking removida (Fase 3) — vinculador não tenta mais NFs não-
  // pendentes via SSW público. Foco em pendências reais.
  const found = await runLookupChain(supabase, bastao, nf, ctrc);

  let cardId: string;

  switch (found.source) {
    case "cockpit_existing": {
      cardId = found.card_id;
      summary.attached_to_existing++;

      // Caio 2026-05-12: state TRATATIVA_PENDENTE SUSPENSO. Antes,
      // cliente cobrar sobre card RESOLVIDO/TRANSFERIDO movia o card pra
      // TRATATIVA_PENDENTE pra Larissa revisar. Agora a prioridade é só
      // "Bastão tem oc relacionamento → card visível no estado correto"
      // (via Camada 5a do sync-bastao). Cliente cobrar sem Bastão acompanhar
      // será tratado manualmente pela Larissa via outro caminho enquanto
      // estamos em go-live. O evento RetornoCobrancaCliente continua gravado
      // pra auditoria — só o state não muda mais.
      // PREMISSA Caio 2026-07-23 (refinada pós-NF 73220, INV-042):
      //   1. card ATIVO → resposta move, sempre;
      //   2. TRANSFERIDO/RESOLVIDO = tratado → anexa SEM mover (nunca reabre);
      //   3. card novo criado depois entra na premissa 1.
      // O lookup por NF (runLookupChain) PREFERE card ativo — se chegou aqui
      // com previous_state terminal, NÃO existe card ativo pra NF: anexa muda
      // + evento de auditoria (branch anexar_sem_mover abaixo).
      // Card em AGUARDANDO_CLIENTE (oc=54 lançada) e cliente respondeu →
      // vira AGUARDANDO_VALIDACAO_HUMANA + lock=true.
      //
      // Atualiza propostas pendentes pro novo conjunto pós-resposta:
      //   [21 (mantém), 44 (retorno carga), 56 (falta info), 54 (re-lançar)]
      // - 21 fica como estava (já existia da regra oc=54)
      // - 55 que existia é CANCELADO (operadora não escolhe mais autorizar
      //   entrega genérica nesse momento)
      // - 44, 56, 54-relançar são CRIADOS (idempotente — não duplica)
      //
      // Cancela ações agendadas (cobrança automática para — cliente
      // respondeu). Operadora pode aprovar uma das 4, Voltar p/ to-do, ou
      // Voltar p/ aguardando cliente (se resposta inconclusiva).
      // Premissa 2/D: terminal anexa SEM mover (lookup já preferiu ativo —
      // terminal aqui = sem card ativo da NF). Regra da oc (Caio 25/07):
      // terminal com oc de relacionamento/cliente é TRANSITÓRIO → aciona.
      const { data: cardOcRow } = await supabase
        .from("cards")
        .select("cod_ultima_ocorrencia")
        .eq("id", cardId)
        .maybeSingle();
      const ocDoCardNf =
        (cardOcRow as { cod_ultima_ocorrencia?: number | null } | null)
          ?.cod_ultima_ocorrencia ?? null;
      // Mesma corrida do TRANSFERIDO transitório do call-site principal (NFs
      // 1494200/174873/20219): ação Cockpit SSW recente = card ainda no fluxo →
      // aciona, mesmo com cod_ultima_ocorrencia defasado. Só consulta em terminal.
      let acaoCockpitRecenteNf = false;
      if (
        found.previous_state != null &&
        STATES_TERMINAIS_ANEXA_SEM_MOVER.includes(found.previous_state)
      ) {
        const { data: acaoRecenteNf } = await supabase
          .from("acoes_executadas_ssw")
          .select("id")
          .eq("card_id", cardId)
          .eq("sucesso", true)
          .gte("iniciado_em", new Date(Date.now() - 60 * 60 * 1000).toISOString())
          .limit(1)
          .maybeSingle();
        acaoCockpitRecenteNf = acaoRecenteNf != null;
      }
      const decisaoNfPrevia = decidirAcionamentoPorRespostaCliente(
        found.previous_state,
        false,
        ocDoCardNf,
        acaoCockpitRecenteNf,
      );
      if (decisaoNfPrevia.acao === "anexar_sem_mover") {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "RespostaClienteEmCardTransferido",
          actor_type: "system",
          actor_id: "vinculador",
          payload: {
            message_id: m.message_id,
            card_state: found.previous_state,
            remetente: m.remetente,
            motivo:
              "Card terminal com oc FORA de relacionamento/cliente = tratado de verdade (premissa 2 + regra da oc, Caio 25/07) — mensagem anexada, card NÃO reaberto, sem card ativo da NF pra rotear.",
          },
        });
        break;
      }

      if (
        found.previous_state === "AGUARDANDO_CLIENTE" ||
        found.previous_state === "AGUARDANDO_VALIDACAO_HUMANA"
      ) {
        // Caio 2026-05-19 (NF 1492103, Duilio): cliente pode responder N vezes
        // em sequência. 1ª resposta move pra AGUARDANDO_VALIDACAO_HUMANA + IA;
        // 2ª/3ª ficavam só anexadas sem re-rodar IA. Agora se card já é AVH
        // COM cliente_respondeu_em (sinal "está em CLIENTE RESPONDEU"), nova
        // mensagem re-aciona IA com a msg fresca.
        let tinhaCliRespondeu = false;
        if (found.previous_state === "AGUARDANDO_VALIDACAO_HUMANA") {
          const { data: cardRow } = await supabase
            .from("cards")
            .select("cliente_respondeu_em")
            .eq("id", cardId)
            .maybeSingle();
          tinhaCliRespondeu = (cardRow as { cliente_respondeu_em?: string | null } | null)?.cliente_respondeu_em != null;
          if (!tinhaCliRespondeu) {
            // AVH "normal" sem cliente_respondeu_em — cai no else (MensagemAnexada).
            await supabase.from("card_events").insert({
              card_id: cardId,
              event_type: "MensagemAnexada",
              actor_type: "system",
              actor_id: "vinculador",
              payload: {
                message_id: m.message_id,
                lookup: "cockpit_existing",
                previous_state: found.previous_state,
                motivo: "AVH sem cliente_respondeu_em — não dispara IA (card já tem propostas pendentes por outro motivo)",
              },
            });
            break;
          }
        }
        // Efeito do acionamento: FONTE ÚNICA (Caio 2026-08-11, INV-067). Este é
        // o caminho por NF; o por thread já usava o helper. Eram duas cópias do
        // mesmo efeito — a divergência é o que originou o INV-042.
        // Comportamento idêntico ao anterior: só se chega aqui com
        // previous_state AGUARDANDO_CLIENTE ou AVH-com-carimbo, e nos dois a
        // regra default do helper coincide com a que estava escrita aqui.
        await acionarRespostaCliente(supabase, {
          cardId,
          messageId: m.message_id,
          stateAnterior: found.previous_state,
          canal: m.canal,
          remetente: m.remetente,
          actorId: "vinculador",
          motivoCancelamentoAgendadas: "cliente respondeu",
          payloadExtra: { lookup: "cockpit_existing", via: "nf" },
        });
      }
      else {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "MensagemAnexada",
          actor_type: "system",
          actor_id: "vinculador",
          payload: {
            message_id: m.message_id,
            lookup: "cockpit_existing",
            previous_state: found.previous_state,
          },
        });
      }
      break;
    }
    case "bastao": {
      const ocBastao = found.pendencia.cod_ultima_ocorrencia;
      if (!ocPermiteCriarCard(ocBastao)) {
        await supabase
          .from("messages_inbox")
          .update({ processing_status: `ignored_oc_fora_escopo_${ocBastao ?? "null"}` })
          .eq("id", m.message_id);
        await supabase.rpc("delete_from_pgmq", { queue_name: "agent_specialist", msg_id: job.msg_id });
        return;
      }
      cardId = await createCardFromBastao(supabase, found.pendencia, m);
      summary.created_from_bastao++;
      break;
    }
    // Caio 2026-05-13 (Fase 3): branch "ssw_tracking" REMOVIDA. createCardFromSswTracking,
    // disparAutoPropostaParaCardSswTracking, extractCodFromSswTracking ficam como dead
    // code até remoção total no próximo sprint.
    case "incomplete": {
      // Regra 2026-05-04: emails sem NF localizável NÃO criam card.
      // Marcamos a mensagem como ignorada (processing_status) pra ter
      // observabilidade do que foi descartado, mas nada vai pro Kanban.
      await supabase
        .from("messages_inbox")
        .update({ processing_status: `ignored_${found.reason}` })
        .eq("id", m.message_id);
      summary.created_incomplete++; // mantém contador como "ignored count"
      // Caio 2026-05-07: SEM delete_from_pgmq antes do return causava loop
      // infinito (mesmo bug do early-return de threadCardId).
      await supabase.rpc("delete_from_pgmq", {
        queue_name: "agent_specialist",
        msg_id: job.msg_id,
      });
      return; // sai sem criar card, sem anexar mensagem
    }
  }

  // 2. Anexa messages_inbox.card_id
  await supabase.from("messages_inbox").update({ card_id: cardId }).eq("id", m.message_id);

  // 2.5. Cliente cobrou + NF tem oc de extravio (6/9/16) → aplicar regra
  // especial Sal Express: card vai pra TRATATIVA_PENDENTE com 2 propostas
  // (Lançar 55 ou Lançar 44). Aplica DEPOIS do switch pra cobrir os 3
  // caminhos (cockpit_existing, bastao, ssw_tracking) numa só linha.
  // No-op se cod não for {6,9,16}.
  const aplicouExtravio = await aplicarExtravioSeCabivel(supabase, cardId);

  // 3. Se classificação foi 'reentrega' OU 'rastreamento' e o card tá em estado "ativo",
  //    cria to-do "Lançar ocorrência 21" (somente reentrega no MVP).
  // ATENÇÃO: se o passo 2.5 já aplicou regra de extravio (TRATATIVA_PENDENTE
  // com propostas 55/44), pula esse branch — senão sobrescreveria state pra
  // AGUARDANDO_VALIDACAO_HUMANA.
  if (m.classification.tipo === "reentrega" && !aplicouExtravio) {
    const { todoId, codUltimaOcorrencia } = await createReentregaTodo(supabase, cardId, m);
    summary.todos_created++;

    // Sempre publica AcaoPropostaPeloAgente — é o evento da timeline que mostra
    // o agente sugeriu lançar 21. Auditoria visual.
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AcaoPropostaPeloAgente",
      actor_type: "agent",
      actor_id: "vinculador",
      payload: {
        tipo: "reentrega",
        proposta: "lancar_ocorrencia_21",
        resumo: m.classification.resumo,
        cliente_autorizou_reentrega: m.classification.cliente_autorizou_reentrega ?? false,
        cod_ultima_ocorrencia: codUltimaOcorrencia,
      },
    });

    // Auto-aprovação (FASE TESTE — restrita à allowlist):
    //   NF na allowlist + última ocorrência SSW = 13 + IA detectou autorização
    //   → marca todo como aprovado, registra AutoAprovacaoPermitida, enfileira
    //     no executor. Card vai pra EM_EXECUCAO (não AGUARDANDO_VALIDACAO_HUMANA).
    const autorizou = m.classification.cliente_autorizou_reentrega === true;
    const isAllowlisted =
      m.classification.nfs.length > 0 &&
      AUTO_APPROVE_REENTREGA_NFS.includes(m.classification.nfs[0]!);
    const ocorrencia13 = codUltimaOcorrencia === 13;

    if (isAllowlisted && ocorrencia13 && autorizou) {
      const regra = "ultima_oc_13_e_cliente_autorizou_reentrega";
      const { error: autoErr } = await supabase.rpc("auto_aprovar_e_executar", {
        p_todo_id: todoId,
        p_regra: regra,
      });
      if (autoErr) {
        console.warn(`auto_aprovar_e_executar falhou (${todoId}): ${autoErr.message}`);
        // Cai pro fluxo manual
        await supabase
          .from("cards")
          .update({ state: "AGUARDANDO_VALIDACAO_HUMANA", tipo: m.classification.tipo, risco: m.classification.risco })
          .eq("id", cardId);
      } else {
        // Card sai pra EM_EXECUCAO. Executor depois move pra AGUARDANDO_TERCEIRO.
        await supabase
          .from("cards")
          .update({ state: "EXECUTANDO_ACAO", tipo: m.classification.tipo, risco: m.classification.risco })
          .eq("id", cardId);
        // Acorda executor na hora — não esperar cron.
        invokeNext({
          functionName: "executor",
          supabaseUrl: Deno.env.get("SUPABASE_URL")!,
          serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        });
      }
    } else {
      // Fluxo padrão: aguarda operador humano clicar Aprovar.
      // lock_aguardando_validacao=true garante que sync-bastao não move o
      // card de volta pra AGUARDANDO_CLIENTE no próximo ciclo, mesmo que a
      // oc no Bastão ainda esteja em 54. Só sai do lock via aprovar/rejeitar.
      await supabase
        .from("cards")
        .update({
          state: "AGUARDANDO_VALIDACAO_HUMANA",
          tipo: m.classification.tipo,
          risco: m.classification.risco,
          lock_aguardando_validacao: true,
        })
        .eq("id", cardId);
    }
  } else {
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

  // 5. Dispara redator em background pra gerar sugestão de resposta.
  // Não bloqueia o vinculador. Quando Larissa abre o card, sugestão já está
  // pronta no painel Resposta.
  // Skipa em casos onde não faz sentido responder (cards sem nf agora são
  // ignorados antes do switch — early return). Aqui sempre temos card.
  {
    invokeNext({
      functionName: "redator",
      supabaseUrl: Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      body: { card_id: cardId },
    });
  }
}

// =============================================================================
// Filtro de oc — Caio 2026-05-04:
//   - PARA FAZER (state=AGUARDANDO_AGENTE) é 100% ocorrências de relacionamento
//     (3,8,10,11,17,19,20,23,26,28,35,43,49,52,54,58).
//   - oc=6/9/16 (extravio) cria card também, MAS direto em TRATATIVA_PENDENTE
//     via `aplicarExtravioSeCabivel` no fluxo abaixo. Nunca passa por PARA FAZER.
//   - Outras oc (1, 7, 13, etc): ignoradas (não criam card).
// =============================================================================

function ocPermiteCriarCard(cod: number | null | undefined): boolean {
  if (cod == null) return false;
  return OCORRENCIAS_DE_RELACIONAMENTO.has(cod) || OCORRENCIAS_EXTRAVIO_PERDAS.has(cod);
}

function extractCodFromSswTracking(data: SswTrackingSuccessResponse): number | null {
  const d = data as Record<string, unknown>;
  const tracking = (d["tracking"] as Array<Record<string, unknown>> | undefined) ?? [];
  const last = tracking[tracking.length - 1];
  if (!last) return null;
  const ocorrenciaTxt = (last["ocorrencia"] as string | null) ?? null;
  if (!ocorrenciaTxt) return null;
  const m = ocorrenciaTxt.match(/\((\d{1,3})\)\s*$/);
  return m ? parseInt(m[1]!, 10) : null;
}

// =============================================================================
// Lookup chain
// =============================================================================

async function runLookupChain(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  nf: string | null,
  _ctrc: string | null,
): Promise<LookupStrategy> {
  if (!nf) {
    return { source: "incomplete", reason: "sem_nf_extraida_pelo_triador" };
  }

  // 1. Cockpit já tem card pra essa NF?
  // Premissa Caio 2026-07-23 (item C, NF 73220): PREFERE card ATIVO da NF —
  // se existir, a resposta move ELE (premissa 1). Terminal (TRANSFERIDO/
  // RESOLVIDO) só é retornado quando NÃO há ativo — e aí a resposta anexa
  // sem mover (premissa 2). CANCELADO continua excluído (fim manual).
  const { data: existing } = await supabase
    .from("cards")
    .select("id, state")
    .eq("nf", nf)
    .not("state", "in", "(CANCELADO)")
    .order("created_at", { ascending: false })
    .limit(10);

  if (existing && existing.length > 0) {
    const lista = existing as Array<{ id: string; state: string }>;
    const ativo = lista.find((c) => c.state !== "TRANSFERIDO" && c.state !== "RESOLVIDO");
    const escolhido = ativo ?? lista[0]!;
    return {
      source: "cockpit_existing",
      card_id: escolhido.id,
      previous_state: escolhido.state,
    };
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

  // Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
  // 3ª fonte (SSW tracking público iterando senhas de pagadores) REMOVIDA.
  // Cards são criados só via cockpit_existing ou bastao. NFs que cliente
  // cobra mas ainda não viraram pendência caem em "incomplete" — processamento
  // segue (message marcada com processing_status) sem criar card incompleto.
  return { source: "incomplete", reason: `nf_${nf}_nao_localizada_em_bastao` };
}

// =============================================================================
// Card creators
// =============================================================================

async function createCardFromBastao(
  supabase: SupabaseClient,
  p: BastaoPendencia,
  m: QueueMessage["message"],
): Promise<string> {
  // Caio 2026-07-13: `=== 54` virou ehOcAguardandoCliente — card que nasce do
  // Bastão já com oc 'Cliente' (54 ou 59) começa em AGUARDANDO_CLIENTE (não AGUARDANDO_AGENTE).
  const newState = ehOcAguardandoCliente(p.cod_ultima_ocorrencia) ? "AGUARDANDO_CLIENTE" : "AGUARDANDO_AGENTE";

  // Caio 2026-05-19 (bug NF 568107 NORTEL): usa helper que retorna campos
  // coerentes (responsavel_relacionamento + assigned_operator_id). Cascata
  // nova é carteira > nome > segmento. Se CNPJ pertence a operador dormente
  // (cockpit_ativo=false, ex: Ingrid), helper devolve NULL/NULL — card fica
  // órfão até dono ativar Cockpit, evitando atribuir erroneamente via nome
  // do Bastão (caso NORTEL→DUILIO).
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
      canal_origem: m.canal,
      remetente_inicial: m.remetente,
      empresa_cliente: p.pagador ?? m.classification.empresa_cliente,
      nome_cliente: m.classification.nome_cliente,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: atribuicao.responsavel_relacionamento,
      assigned_operator_id: atribuicao.assigned_operator_id,
      state: newState,
      tipo: m.classification.tipo,
      risco: m.classification.risco,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      tipo_cte: p.tipo_documento,
      qtde_volumes: p.qtd_volumes,
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

  // Caio 2026-06-08: REMOVIDA chamada a resolverEPersistirChaveCte.
  // Executor agora lança via portal interno — chave_cte 44 dígitos não é
  // mais necessária. Ver mig 195.

  // Caio 2026-05-07: oc=10/11/35 → SEM ação autônoma. Helper grava
  // cards.evidencia_status + diagnostico pro front mostrar banner amarelo.
  // Larissa decide manualmente entre as 4 propostas.
  // Caio 2026-05-14 (NF 20761): propaga p.ctrc — múltiplos CTRCs (reentrega/
  // complementar) faziam helper retornar scrape_indisponivel erradamente.
  // Caio 2026-05-15 (multi-operador): propaga responsavel_relacionamento
  // pra resolver creds SSW por operador.
  await verificarEvidenciaESinalizar(
    supabase, cardId, p.nf, p.cnpj_pagador ?? null, p.cod_ultima_ocorrencia, p.ctrc ?? null, p.responsavel_relacionamento ?? null,
  );

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
  const codUltOcorRaw = codMatch ? parseInt(codMatch[1]!, 10) : null;
  // Camada 2: clamp ao dicionário. Tracking pode retornar 88/84 (SSWMOBILE).
  const codUltOcor = await clampOcAoDicionario(
    supabase,
    codUltOcorRaw,
    null, // card sendo criado agora; sem oc anterior
    "vinculador/criacao-ssw-tracking",
    null,
  );

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

  // Caio 2026-06-08: REMOVIDA chamada a resolverEPersistirChaveCte.
  // Portal interno usa card.ctrc + NF — chave_cte 44 dígitos dispensada.
  // Mig 195 dropou nf_chave_cte e os RPCs de lookup.

  // Caio 2026-05-07: oc=10/11/35 → SEM ação autônoma. Helper sinaliza via flag.
  // Caio 2026-05-14: caminho via tracking SSW público (deprecated). Não temos
  // ctrc canônico disponível aqui — passa null. Em NFs com múltiplos CTRCs
  // o helper retorna scrape_indisponivel; aceitável dado que caminho está
  // sendo removido (ver INV-001 + project_tracking_publico_deprecated).
  await verificarEvidenciaESinalizar(supabase, cardId, nf, pagador, codUltOcor, null);

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
): Promise<{ todoId: string; codUltimaOcorrencia: number | null }> {
  // Pega cnpj_remetente + cnpj_pagador do agent_state.
  // Heurística: cnpj_remetente cai no cnpj_pagador como default (caso típico
  // de CT-e normal — Caio confirmou: remetente=pagador na maioria das NFs).
  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, agent_state")
    .eq("id", cardId)
    .single();

  const agentState = (card?.agent_state ?? {}) as Record<string, unknown>;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ??
    cnpjPagador ??
    null;
  const nf = card?.nf as string | null;
  const codUltimaOcorrencia =
    (agentState["cod_ultima_ocorrencia"] as number | undefined) ?? null;

  // Caio 2026-06-08: lookup chave_cte removido. Executor usa portal interno
  // direto (ctrc do card + NF). Código semântico oc=21 vai direto sem remap
  // de-para (mig 195 dropou ocorrencias_dexpara).
  const actionId = crypto.randomUUID();

  const { data: insertedTodo, error: todoErr } = await supabase
    .from("todos")
    .insert({
      card_id: cardId,
      action_id: actionId,
      descricao: "Lançar ocorrência 21 no SSW — reentrega solicitada",
      status: "pendente",
      proposta_payload: {
        tool: "lancar_ocorrencia",
        args: {
          codigo_ssw: 21,
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: `Reentrega solicitada — ${m.classification.resumo}`,
        },
        rationale: m.classification.descricao_problema,
        texto: null,
      },
    })
    .select("id")
    .single();

  if (todoErr) throw new Error(`INSERT todos: ${todoErr.message}`);

  return {
    todoId: insertedTodo.id as string,
    codUltimaOcorrencia,
  };
}

// =============================================================================
// Auto-proposta pra cards criados via SSW Tracking (incompletos)
// =============================================================================

/**
 * Card criado por SSW Tracking ainda não tem pendência no Bastão (NF não venceu
 * prazo, cliente cobrou antes). Mesmo assim já tem cod_ultima_ocorrencia e
 * chave_cte vindos do tracking — então roda REGRAS_AUTO_ACAO igual sync-bastao.
 */
/**
 * Lookup por thread: dado o ID da mensagem nova em messages_inbox, lê o
 * header In-Reply-To e procura mensagem anterior cujo Message-ID bate.
 * Se essa mensagem anterior já tem card_id, retorna esse card (= thread
 * já tem contexto, nova mensagem linka direto).
 * Retorna null se: sem In-Reply-To, sem mensagem anterior, ou anterior
 * sem card_id.
 */
async function lookupThreadCardId(
  supabase: SupabaseClient,
  messageInboxId: string,
): Promise<string | null> {
  const { data: msg } = await supabase
    .from("messages_inbox")
    .select("card_id, in_reply_to_header, raw_payload")
    .eq("id", messageInboxId)
    .maybeSingle();

  // Caio 2026-05-06: gmail-poll-inbox já preenche card_id no INSERT (lookup
  // via cards_emails_outbound). Se vier preenchido, usa direto.
  const preCardId = (msg as Record<string, unknown> | null)?.["card_id"] as string | null | undefined;
  if (preCardId) return preCardId;

  const inReplyTo = (msg as Record<string, unknown> | null)?.["in_reply_to_header"] as
    | string
    | null
    | undefined;

  if (inReplyTo) {
    // 1. Procura mensagem anterior em messages_inbox (Postmark legado)
    const { data: anterior } = await supabase
      .from("messages_inbox")
      .select("card_id")
      .eq("message_id_header", inReplyTo)
      .not("card_id", "is", null)
      .order("recebido_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const carda = (anterior as Record<string, unknown> | null)?.["card_id"] as string | null;
    if (carda) return carda;

    // 2. Caio 2026-05-06: emails enviados pelo Cockpit ficam em
    //    cards_emails_outbound (não em messages_inbox). Lookup canônico aqui.
    const { data: outRow } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .or(`gmail_message_id.eq.${inReplyTo},message_id_header.eq.${inReplyTo}`)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const cardb = (outRow as Record<string, unknown> | null)?.["card_id"] as string | null;
    if (cardb) return cardb;
  }

  // 3. Fallback por gmail_thread_id (gmail-poll-inbox grava em raw_payload)
  const rawPayload = (msg as Record<string, unknown> | null)?.["raw_payload"] as
    Record<string, unknown> | null | undefined;
  const threadId = rawPayload?.["gmail_thread_id"] as string | undefined;
  if (threadId) {
    const { data: outRow } = await supabase
      .from("cards_emails_outbound")
      .select("card_id")
      .eq("gmail_thread_id", threadId)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const cardc = (outRow as Record<string, unknown> | null)?.["card_id"] as string | null;
    if (cardc) return cardc;
  }

  return null;
}

/**
 * Aplica regra de extravio (oc=6/9/16 + cliente cobrou) se cod do card cair
 * nessa lista. Move pra TRATATIVA_PENDENTE com 2 propostas (55, 44).
 * Retorna true se aplicou (chamador pode decidir pular outras regras).
 */
async function aplicarExtravioSeCabivel(
  supabase: SupabaseClient,
  cardId: string,
): Promise<boolean> {
  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, cod_ultima_ocorrencia, agent_state")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return false;
  const cod = card.cod_ultima_ocorrencia as number | null;
  if (cod == null || !OCORRENCIAS_EXTRAVIO_PERDAS.has(cod)) return false;

  const result = await aplicarRegraExtravioComCobrancaCliente(supabase, {
    cardId,
    cardNf: card.nf as string | null,
    cardCtrc: (card.ctrc as string | null) ?? null,
    codUltimaOc: cod,
    agentState: (card.agent_state ?? {}) as Record<string, unknown>,
    actorId: "vinculador",
  });
  return result.aplicou;
}

async function disparAutoPropostaParaCardSswTracking(
  supabase: SupabaseClient,
  cardId: string,
): Promise<void> {
  // Antes da regra padrão, checa se é caso de extravio (oc=6/9/16) — esse
  // tem regra própria (TRATATIVA_PENDENTE com 2 propostas, sem disparar
  // REGRAS_AUTO_ACAO).
  const aplicouExtravio = await aplicarExtravioSeCabivel(supabase, cardId);
  if (aplicouExtravio) return;

  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, cod_ultima_ocorrencia, state, lock_aguardando_validacao, agent_state")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return;

  await proporAutoAcaoSeAplicavel(supabase, {
    cardId,
    cardNf: card.nf as string | null,
    cardCtrc: (card.ctrc as string | null) ?? null,
    codUltimaOc: card.cod_ultima_ocorrencia as number | null,
    agentState: (card.agent_state ?? {}) as Record<string, unknown>,
    cardState: card.state as string,
    cardLock: !!(card as Record<string, unknown>)["lock_aguardando_validacao"],
    actorId: "vinculador",
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

