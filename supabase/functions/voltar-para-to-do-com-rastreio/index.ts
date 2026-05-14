// =============================================================================
// voltar-para-to-do-com-rastreio
//
// Endpoint do botão "RECUSAR AÇÕES SUGERIDAS" (ex "Voltar pra TO-DO").
//
// Caio 2026-05-13 (REESCRITO): usa SSW interno (opção 101) como fonte canônica
// pra decidir o destino do card. Antes consultava tracking SSW público, que
// tem latência de RPA Bastão + ocs ocultas. Decisão a partir do SSW real-time
// elimina o bug do loop onde:
//   - Larissa recusa propostas em oc=10 (AVH+lock)
//   - voltar_para_to_do cancela propostas, lock=false, state=AGUARDANDO_AGENTE
//   - próximo sync vê oc=10 no Bastão (RPA não atualizou) + propostas vazias →
//     re-cria as 4 propostas via proporAutoAcaoSeAplicavel → AVH+lock de volta
//   - loop até Bastão refletir oc nova
//
// Novo fluxo:
//   1. Consulta SSW interno → última oc real
//   2. Cancela todas propostas pendentes do card
//   3. Decide destino pela última oc:
//      - finalizadora (1/30/32) → RESOLVIDO
//      - oc=54                  → AGUARDANDO_CLIENTE
//      - fora de relacionamento → TRANSFERIDO (DevolvidoParaSetor)
//      - relacionamento c/ regra ≠ atual → AVH + lock + propostas da regra nova
//      - relacionamento s/ regra ou = atual → AGUARDANDO_AGENTE
//   4. Seta agent_state.propostas_recusadas_em pra cooldown 10min em
//      proporAutoAcaoSeAplicavel — defesa quando OC ainda for relacionamento.
//
// Fallback: SSW interno fora do ar → cai na RPC voltar_para_to_do antiga e
// emite ScrapingSswFalhouRecuoFluxoAntigo. Operadora nunca fica bloqueada.
//
// Princípio arquitetural (ADR 0005, plano 2026-05-13):
//   Bastão = INPUT (criação/reabertura). SSW interno = SAÍDA (decisão de destino).
//
// Input:  { todo_id, motivo? }
// Output: { ok, card_id, decisao, oc_ssw, state_anterior, state_novo,
//           todos_cancelados, propostas_criadas, fonte: 'ssw_internal'|'fallback_rpc' }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  listarOcorrenciasNF,
  obterSessao,
  readSswInternalEnv,
} from "../_shared/ssw-internal-client.ts";
import { stateFinalAposBastao } from "../_shared/bastao-rules.ts";
import {
  proporAutoAcaoSeAplicavel,
  REGRAS_AUTO_ACAO,
} from "../_shared/regras-auto-acao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Decisao =
  | "resolvido"
  | "aguardando_cliente"
  | "transferido"
  | "aguardando_voce_nova_oc"
  | "para_fazer_sem_regra"
  | "para_fazer_oc_inalterada";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const env = Deno.env.toObject();
    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Cliente "como user" pra validar permissão e usar como fallback (RPC valida auth.uid()).
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUser = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_ANON_KEY"]!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const body = await req.json().catch(() => ({}));
    const todoId: string | undefined = body.todo_id;
    const motivo: string | null = body.motivo ?? null;

    if (!todoId) return json({ ok: false, error: "todo_id obrigatório" }, 400);

    // Carrega todo + card (service role pra ler todos os campos)
    const { data: todo } = await supabaseSvc
      .from("todos")
      .select("id, card_id, status")
      .eq("id", todoId)
      .maybeSingle();
    if (!todo) return json({ ok: false, error: `todo ${todoId} não encontrado` }, 404);
    if (todo.status !== "pendente") {
      return json({ ok: false, error: `todo ${todoId} em status='${todo.status}' (só funciona em pendente)` }, 400);
    }

    const { data: card } = await supabaseSvc
      .from("cards")
      .select("id, nf, ctrc, state, cod_ultima_ocorrencia, agent_state, assigned_operator_id")
      .eq("id", todo.card_id)
      .maybeSingle();
    if (!card) return json({ ok: false, error: `card ${todo.card_id} não encontrado` }, 404);

    // Tenta SSW interno primeiro. Se falhar → fallback pra RPC antiga.
    let ssw: { oc: number; codigos_oc: number[] } | null = null;
    let sswErrorMsg: string | null = null;

    if (card.nf) {
      try {
        const sswEnv = readSswInternalEnv(env);
        const sessao = await obterSessao(sswEnv);
        const detalhe = await buscarNFInterno(sessao, card.nf as string, {
          ctrcEsperado: (card.ctrc as string | null) ?? null,
        });
        const ocs = await listarOcorrenciasNF(sessao, detalhe);
        const primeiraReal = ocs.find((o) => o.codigo != null);
        if (primeiraReal?.codigo != null) {
          ssw = {
            oc: primeiraReal.codigo,
            codigos_oc: ocs.map((o) => o.codigo).filter((c): c is number => c != null),
          };
        } else {
          sswErrorMsg = `SSW retornou ${ocs.length} entradas sem código válido`;
        }
      } catch (err) {
        sswErrorMsg = err instanceof Error ? err.message : String(err);
      }
    } else {
      sswErrorMsg = "card sem NF";
    }

    // Fallback: SSW falhou → caminho antigo (RPC) + evento de auditoria.
    if (!ssw) {
      const { data: rpcData, error: rpcError } = await supabaseUser.rpc("voltar_para_to_do", {
        p_todo_id: todoId,
        p_motivo: motivo,
      });
      if (rpcError) {
        return json({ ok: false, error: `voltar_para_to_do (fallback): ${rpcError.message}` }, 500);
      }
      await supabaseSvc.from("card_events").insert({
        card_id: card.id,
        event_type: "ScrapingSswFalhouRecuoFluxoAntigo",
        actor_type: "system",
        actor_id: "voltar-para-to-do-com-rastreio",
        payload: {
          motivo_falha: sswErrorMsg,
          motivo_recusa: motivo,
          observacao: "SSW interno indisponível — usou RPC voltar_para_to_do tradicional",
        },
      });
      return json({
        ok: true,
        card_id: card.id,
        fonte: "fallback_rpc",
        new_state: (rpcData as Record<string, unknown>)?.["new_state"],
        todos_cancelados: (rpcData as Record<string, unknown>)?.["todos_cancelados"] ?? 0,
        ssw_error: sswErrorMsg,
      }, 200);
    }

    // SSW respondeu — fluxo canônico (decisão no ato).
    const ocSsw = ssw.oc;
    const ocAnterior = (card.cod_ultima_ocorrencia as number | null) ?? null;
    const stateAnterior = card.state as string;
    const ocMudou = ocSsw !== ocAnterior;
    const ocTemRegra = REGRAS_AUTO_ACAO[ocSsw] != null;
    const stateFinal = stateFinalAposBastao(ocSsw, ocTemRegra);

    let decisao: Decisao;
    if (stateFinal.state === "RESOLVIDO") decisao = "resolvido";
    else if (stateFinal.state === "AGUARDANDO_CLIENTE") decisao = "aguardando_cliente";
    else if (stateFinal.state === "TRANSFERIDO") decisao = "transferido";
    else if (ocMudou && ocTemRegra) decisao = "aguardando_voce_nova_oc";
    else if (ocMudou) decisao = "para_fazer_sem_regra";
    else decisao = "para_fazer_oc_inalterada";

    // 1. Cancela TODAS propostas pendentes (semântica core de "RECUSAR")
    const { data: canceladas } = await supabaseSvc
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: motivoCancelamento(motivo, decisao, ocAnterior, ocSsw),
      })
      .eq("card_id", card.id)
      .eq("status", "pendente")
      .select("id");
    const todosCancelados = (canceladas ?? []).length;

    // 2. Atualiza agent_state — marca propostas_recusadas_em pra cooldown
    //    em proporAutoAcaoSeAplicavel (defesa contra re-criação por sync).
    const agentStateAtual = (card.agent_state ?? {}) as Record<string, unknown>;
    const agentStateNovo = {
      ...agentStateAtual,
      propostas_recusadas_em: new Date().toISOString(),
    };

    // 3. Update do card (state, lock, oc, agent_state) — single UPDATE
    const updateCard: Record<string, unknown> = {
      state: stateFinal.state,
      lock_aguardando_validacao: stateFinal.lock,
      cod_ultima_ocorrencia: ocSsw,
      agent_state: agentStateNovo,
      aviso_alteracao_oc: null,
      acao_falhou_motivo: null,
      bastao_synced_at: new Date().toISOString(),
    };
    if (decisao === "resolvido" || decisao === "transferido") {
      updateCard["acao_executada_em"] = null;
    }

    const { error: upErr } = await supabaseSvc
      .from("cards")
      .update(updateCard)
      .eq("id", card.id);
    if (upErr) return json({ ok: false, error: `UPDATE card: ${upErr.message}` }, 500);

    // 4. Eventos de auditoria — sempre TodoVoltadoParaToDo (compat) +
    //    evento específico do destino.
    await supabaseSvc.from("card_events").insert({
      card_id: card.id,
      event_type: "TodoVoltadoParaToDo",
      actor_type: "system",
      actor_id: "voltar-para-to-do-com-rastreio",
      payload: {
        todo_id: todoId,
        motivo: motivo ?? "(sem motivo informado)",
        state_anterior: stateAnterior,
        state_novo: stateFinal.state,
        todos_cancelados: todosCancelados,
        oc_ssw: ocSsw,
        oc_anterior: ocAnterior,
        decisao,
        fonte: "ssw_internal",
        observacao: "v3 2026-05-13: decisão pelo SSW interno (opção 101). Plano hoje-usamos-o-bastao.",
      },
    });

    const eventoEspecifico = eventoPorDecisao(decisao);
    if (eventoEspecifico) {
      await supabaseSvc.from("card_events").insert({
        card_id: card.id,
        event_type: eventoEspecifico,
        actor_type: "system",
        actor_id: "voltar-para-to-do-com-rastreio",
        payload: {
          oc_anterior: ocAnterior,
          oc_atual: ocSsw,
          state_anterior: stateAnterior,
          state_novo: stateFinal.state,
          fonte_oc: "ssw_internal",
          motivo_recusa: motivo,
        },
      });
    }

    // 5. Se mudou pra oc com regra → cria propostas da regra nova
    let propostasCriadas = 0;
    if (decisao === "aguardando_voce_nova_oc") {
      const { count: antes } = await supabaseSvc
        .from("todos")
        .select("*", { count: "exact", head: true })
        .eq("card_id", card.id)
        .in("status", ["pendente", "aprovado"]);
      const antesQtd = antes ?? 0;

      // ATENÇÃO: o cooldown propostas_recusadas_em vai bloquear esta chamada
      // se a oc nova == oc anterior. Como aqui ocMudou é true, isso não
      // dispara o cooldown — mas pra garantir, removo o campo temporariamente
      // no agent_state passado.
      const { agentStateSemCooldown } = stripCooldown(agentStateNovo);
      await proporAutoAcaoSeAplicavel(supabaseSvc, {
        cardId: card.id as string,
        cardNf: card.nf as string,
        cardCtrc: (card.ctrc as string | null) ?? null,
        codUltimaOc: ocSsw,
        agentState: agentStateSemCooldown,
        cardState: stateFinal.state,
        cardLock: stateFinal.lock,
        actorId: "voltar-para-to-do-com-rastreio",
      });

      const { count: depois } = await supabaseSvc
        .from("todos")
        .select("*", { count: "exact", head: true })
        .eq("card_id", card.id)
        .in("status", ["pendente", "aprovado"]);
      propostasCriadas = (depois ?? 0) - antesQtd;
    }

    return json({
      ok: true,
      card_id: card.id,
      fonte: "ssw_internal",
      decisao,
      oc_ssw: ocSsw,
      oc_anterior: ocAnterior,
      state_anterior: stateAnterior,
      state_novo: stateFinal.state,
      todos_cancelados: todosCancelados,
      propostas_criadas: propostasCriadas,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("voltar-para-to-do-com-rastreio fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function motivoCancelamento(
  motivo: string | null,
  decisao: Decisao,
  ocAnterior: number | null,
  ocSsw: number,
): string {
  const base = `RECUSAR AÇÕES SUGERIDAS via SSW interno (oc anterior=${ocAnterior ?? "?"} → SSW=${ocSsw}, decisão=${decisao})`;
  return motivo ? `${base} — motivo: ${motivo}` : base;
}

function eventoPorDecisao(decisao: Decisao): string | null {
  switch (decisao) {
    case "resolvido":
      return "CardEncerradoViaRecusaSugestoes";
    case "transferido":
      return "DevolvidoParaSetor";
    case "aguardando_cliente":
      return "RecusaSugestoesAguardandoCliente";
    case "aguardando_voce_nova_oc":
      return "RecusaSugestoesOcMudouNovaRegra";
    case "para_fazer_sem_regra":
      return "RecusaSugestoesOcMudouSemRegra";
    case "para_fazer_oc_inalterada":
      return "RecusaSugestoesOcInalterada";
    default:
      return null;
  }
}

function stripCooldown(
  agentState: Record<string, unknown>,
): { agentStateSemCooldown: Record<string, unknown> } {
  const { propostas_recusadas_em: _, ...rest } = agentState;
  return { agentStateSemCooldown: rest };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
