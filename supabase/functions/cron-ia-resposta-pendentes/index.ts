// =============================================================================
// cron-ia-resposta-pendentes — retry da IA pra cards que tiveram cliente
// respondido mas ficaram sem ia_sugestao_oc_resposta.
//
// Caio 2026-05-11 (NFs 351849 / 351077): vinculador faz chamada SÍNCRONA pro
// interpretador-resposta-cliente com timeout 30s. Se Anthropic responde lento
// ou dá erro transitório, só `console.warn` — card fica `cliente_respondeu_em`
// preenchido mas `ia_sugestao_oc_resposta=null` indefinidamente.
//
// Este cron roda a cada 1min, pega cards em AGUARDANDO_VALIDACAO_HUMANA com
// `cliente_respondeu_em != null AND ia_sugestao_oc_resposta IS NULL`, e chama
// interpretador-resposta-cliente pra cada um. Idempotente — se IA tiver sido
// preenchida entre o SELECT e o POST, simplesmente sobrescreve (= mesma).
//
// Cobertura: cards onde a chamada síncrona do vinculador falhou OU cards
// corrigidos manualmente (cliente_respondeu_em foi setado por outra rota).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
// Caio 2026-06-23 (NF 761583, INV-016): rede de segurança DETERMINÍSTICA pra
// propostas. Antes este cron só retentava a IA (ia_sugestao). Mas quando a
// mensagem do cliente caía no DLQ (triador 529), o vinculador nunca rodava e as
// PROPOSTAS (botões) nunca eram criadas — assimetria que deixava o card em
// "CLIENTE RESPONDEU, IA sugeriu, ZERO botões". Agora o cron também garante as
// propostas, sem depender de LLM nenhum.
import { atualizarPropostasAposRespostaCliente } from "../_shared/propostas-pos-resposta-cliente.ts";
// Caio 2026-08-11 (INV-067): 3ª rede de segurança — reconciliador de resposta
// de cliente que nunca foi acionada. Usa a MESMA fonte única do vinculador.
import { acionarRespostaCliente } from "../_shared/acionar-resposta-cliente.ts";
// Caio 2026-06-23 (INV-016): dispara o reprocessador de DLQ daqui (fire-and-forget)
// em vez de um cron novo — o apagão deste dia teve thundering herd de cron como
// causa #2 (14 jobs vs 6 worker slots). invokeNext = zero worker slot adicional.
import { invokeNext } from "../_shared/invoke-next.ts";

const MAX_POR_RUN = 20; // limita pra evitar burst Anthropic em runs grandes
const IA_TIMEOUT_MS = 60_000;
const MAX_HEAL_PROPOSTAS = 50; // rede de segurança de propostas é barata (sem LLM)
// INV-067 (reconciliador). Cada acionamento chama o interpretador (Anthropic),
// por isso o teto é baixo — com cron de 1min drena qualquer backlog em minutos.
const MAX_RECONCILIAR = 10;
const RECONCILIAR_GRACE_MIN = 5;   // deixa o caminho normal (vinculador) agir antes
const RECONCILIAR_JANELA_DIAS = 90;

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return resp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // INV-016: dispara o reprocessador de DLQ em fire-and-forget (drena mensagens
  // de cliente presas no dead_letter de volta pras filas). Sem cron próprio pra
  // não somar worker slot (apagão 2026-06-23 = thundering herd de cron).
  invokeNext({ functionName: "reprocessar-dlq", supabaseUrl, serviceRoleKey: serviceKey });

  // 1. Lista cards alvo: cliente respondeu mas IA não sugeriu ainda.
  //
  // Caio 2026-05-13: ampliado pra incluir AGUARDANDO_CLIENTE. O caminho
  // canônico é vinculador mover pra AGUARDANDO_VALIDACAO_HUMANA quando cliente
  // responde, mas retroativos (ex: RetroativoBugRemocao54DoSet) podem deixar
  // cards em AGUARDANDO_CLIENTE com cliente_respondeu_em != null. Antes esses
  // cards ficavam sem sugestão IA indefinidamente. Cards em ACAO_EXECUTADA
  // também são pegos pra cobrir casos onde cliente respondeu durante janela
  // pós-lançamento (vinculador linha 249 trata mas pode falhar silencioso).
  const { data: cardsRaw, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cliente_respondeu_em")
    .in("state", ["AGUARDANDO_VALIDACAO_HUMANA", "AGUARDANDO_CLIENTE", "ACAO_EXECUTADA"])
    .not("cliente_respondeu_em", "is", null)
    .is("ia_sugestao_oc_resposta", null)
    .order("cliente_respondeu_em", { ascending: true })
    .limit(MAX_POR_RUN);

  if (selErr) {
    return resp({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);
  }
  const cards = (cardsRaw ?? []) as Array<{ id: string; nf: string | null; cliente_respondeu_em: string }>;

  if (cards.length === 0) {
    return resp({ ok: true, processados: 0, duration_ms: Date.now() - startedAt }, 200);
  }

  const summaries: Array<Record<string, unknown>> = [];

  for (const card of cards) {
    // 2. Pega o último message_id de messages_inbox desse card (o que deve
    //    informar a IA — geralmente a última resposta do cliente).
    const { data: msgRow } = await supabase
      .from("messages_inbox")
      .select("id, recebido_em")
      .eq("card_id", card.id)
      .order("recebido_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const messageId = (msgRow as { id?: string } | null)?.id ?? null;

    if (!messageId) {
      summaries.push({ card_id: card.id, nf: card.nf, skip: "sem_messages_inbox" });
      continue;
    }

    // 3. Chama interpretador. Timeout 45s pra cobrir Anthropic lento.
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), IA_TIMEOUT_MS);
      // Caio 2026-05-11 (NF 919304): 401 quando só Authorization Bearer. Edge
      // gateway exige apikey + Authorization em chamadas edge-to-edge.
      const iaResp = await fetch(`${supabaseUrl}/functions/v1/interpretador-resposta-cliente`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_id: card.id, message_id: messageId }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await iaResp.json().catch(() => null) as Record<string, unknown> | null;
      summaries.push({
        card_id: card.id,
        nf: card.nf,
        status: iaResp.status,
        ok: !!body?.["ok"],
        oc_sugerida: body?.["oc_sugerida"] ?? null,
        confianca: body?.["confianca"] ?? null,
        err_preview: !body?.["ok"] ? (body?.["error"] ?? body?.["msg"] ?? null) : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summaries.push({ card_id: card.id, nf: card.nf, error: msg });
    }
  }

  // ===========================================================================
  // Rede de segurança DETERMINÍSTICA de propostas (INV-016, NF 761583).
  // Card em CLIENTE RESPONDEU (AGUARDANDO_VALIDACAO_HUMANA + cliente_respondeu_em)
  // SEM nenhuma proposta pendente = caminho primário (vinculador/scan-email)
  // falhou (ex: mensagem do cliente caiu no DLQ por Anthropic 529). Recria as
  // propostas SEM LLM — o operador SEMPRE tem os botões. Marca evento pro
  // health-check alertar o Caio que a rede de segurança precisou agir.
  // ===========================================================================
  const heal: Array<Record<string, unknown>> = [];
  try {
    const { data: alvos } = await supabase.rpc("cards_cliente_respondeu_sem_proposta", {
      p_limit: MAX_HEAL_PROPOSTAS,
    });
    for (const alvo of (alvos ?? []) as Array<{ id: string; nf: string | null }>) {
      try {
        const info = await atualizarPropostasAposRespostaCliente(supabase, alvo.id);
        if (info.criados.length > 0) {
          await supabase.from("card_events").insert({
            card_id: alvo.id,
            event_type: "PropostasRecuperadasPeloCron",
            actor_type: "system",
            actor_id: "cron-ia-resposta-pendentes",
            payload: {
              nf: alvo.nf,
              criados: info.criados,
              motivo: "INV-016: card em CLIENTE RESPONDEU sem propostas — rede de segurança recriou (caminho primário falhou, provável DLQ/Anthropic)",
            },
          });
        }
        heal.push({ card_id: alvo.id, nf: alvo.nf, criados: info.criados.length });
      } catch (e) {
        heal.push({ card_id: alvo.id, nf: alvo.nf, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    console.error(`heal propostas falhou: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ===========================================================================
  // 3ª REDE — RECONCILIADOR DE RESPOSTA NÃO ACIONADA (INV-067, Caio 2026-08-11).
  //
  // As duas redes acima pressupõem que o card JÁ foi acordado (têm
  // `cliente_respondeu_em`). O buraco que elas não cobrem: a resposta chegou
  // quando o card estava num estado que não acorda (extravio monitorado,
  // terminal transitório, ou revertido por falha de ação) e NUNCA foi
  // reavaliada depois que o card voltou a ficar ativo — ficando órfã pra
  // sempre. Medido: 15 cards, o mais antigo parado há 54 dias.
  //
  // A invariante do Caio é contínua ("card acionável + resposta não tratada =
  // card SE MOVE, sempre, em todo ciclo"), então a verificação também é.
  // O efeito vem da fonte única — nunca reimplementar aqui (lição do INV-042).
  // ===========================================================================
  const reconciliados: Array<Record<string, unknown>> = [];
  let reconciliadorAtivo = false;
  try {
    const { data: flagRow } = await supabase
      .from("feature_flags")
      .select("enabled")
      .eq("key", "reconciliador_resposta_pendente_enabled")
      .maybeSingle();
    reconciliadorAtivo = !!(flagRow as { enabled?: boolean } | null)?.enabled;

    const { data: pendentes, error: errPend } = await supabase.rpc(
      "cards_resposta_cliente_nao_acionada",
      {
        p_limit: MAX_RECONCILIAR,
        p_grace_minutos: RECONCILIAR_GRACE_MIN,
        p_dias: RECONCILIAR_JANELA_DIAS,
      },
    );
    if (errPend) throw new Error(errPend.message);

    for (
      const alvo of (pendentes ?? []) as Array<
        { id: string; nf: string | null; state: string; capturada_em: string; message_id: string | null }
      >
    ) {
      // Modo SOMBRA (flag OFF): só reporta o que faria. Padrão shadow-first do
      // projeto — o Caio confere a lista antes de ligar.
      if (!reconciliadorAtivo) {
        reconciliados.push({
          card_id: alvo.id,
          nf: alvo.nf,
          state: alvo.state,
          capturada_em: alvo.capturada_em,
          modo: "sombra",
        });
        continue;
      }
      try {
        const r = await acionarRespostaCliente(supabase, {
          cardId: alvo.id,
          messageId: alvo.message_id,
          stateAnterior: alvo.state,
          canal: "email",
          actorId: "reconciliador-resposta-pendente",
          motivoCancelamentoAgendadas: "cliente respondeu (reconciliador INV-067)",
          payloadExtra: {
            via: "reconciliador",
            capturada_em: alvo.capturada_em,
            motivo:
              "INV-067: resposta de cliente capturada em card acionável e nunca acionada (decisão do vinculador ficou presa ao estado do instante). Reconciliador aplicou o acionamento.",
          },
        });
        reconciliados.push({
          card_id: alvo.id,
          nf: alvo.nf,
          state_anterior: alvo.state,
          acionado: true,
          interpretador_ok: r.interpretadorOk,
        });
      } catch (e) {
        reconciliados.push({
          card_id: alvo.id,
          nf: alvo.nf,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.error(`reconciliador INV-067 falhou: ${e instanceof Error ? e.message : String(e)}`);
  }

  return resp({
    ok: true,
    processados: cards.length,
    summaries,
    propostas_recuperadas: heal,
    reconciliador: { ativo: reconciliadorAtivo, casos: reconciliados },
    duration_ms: Date.now() - startedAt,
  }, 200);
});

function resp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
