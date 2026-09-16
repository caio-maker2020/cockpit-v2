// =============================================================================
// confirmar-dossie-oc33 — INV-155. A operadora confirma, na tela, que o cliente
// mandou a descricao/valor dos itens DENTRO de um anexo, e digita o conteudo.
//
// REGRA (Carlos 2026-09-16): "a opcao tem q estar liberado desde q ela confirme
// q o dossie esta completo e anexado / se ela marcar SIM, libera lancar a 33
// confirmando que o dossie esta completo / se ela marcar NAO, nao libera".
//
// O QUE ESTA FUNCAO FAZ, NESTA ORDEM (a ordem importa):
//   1. Valida TUDO no servidor. Nao confia em nada que a tela mandou.
//   2. Grava card_event ANTES de mexer no estado. Se o passo 3 falhar, fica o
//      registro de que a operadora confirmou — o contrario (dossie mudado, sem
//      registro de quem) e o que nao se pode admitir.
//   3. Escreve a evidencia no DOSSIE (agent_state.extravio_parcial.dossie).
//   4. RECARIMBA os to-dos de oc 33 abertos do card a partir do dossie novo.
//
// POR QUE NAO BASTA RECARIMBAR (passo 4 sem passo 3):
//   O carimbo e recalculado a partir do dossie em TRES lugares
//   (propostas-pos-resposta-cliente.ts:518, regras-auto-acao.ts:1392 e o repatch
//   do interpretador-resposta-cliente/index.ts:1217). Mexer so no carimbo seria
//   desfeito pela proxima mensagem do cliente, em silencio.
//
// O QUE ELA **NAO** FAZ:
//   - Nao lanca nada no SSW. Devolve o carimbo novo; quem lanca continua sendo
//     a RPC aprovar_e_executar, chamada pela tela depois, com a parede intacta.
//   - Nao libera execucao AUTONOMA: veto-elegibilidade.ts:68 le o mesmo carimbo,
//     entao o robo continua barrado ate o dossie fechar de verdade.
//   - Nao toca em romaneio. Card sem romaneio e recusado aqui.
//
// IRREVERSIVEL: mergeEvidencia e monotonico. Um SIM errado marca o card como
// completo para sempre. Por isso operador_id + visto_em entram na evidencia E no
// evento.
//
// Ver ADR 0030, INV-155 e a flag popup_confirma_dossie_oc33_enabled (mig 400).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";
import {
  classificarOc33,
  decidirGateOc33,
  type DossieExtravioParcial,
  dossieVazio,
  lerExtravioParcial,
  mergeEvidencia,
  montarTextoDescricaoValor,
} from "../_shared/extravio-parcial-dossie.ts";
import {
  type ConfirmacaoOperador,
  decidirPerguntaOc33,
  evidenciasDaConfirmacao,
  validarConfirmacao,
} from "../_shared/oc33-confirmacao-operador.ts";

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

/** Mensagens de recusa em portugues, pra tela nao ter de traduzir codigo. */
const MOTIVO_HUMANO: Record<string, string> = {
  sem_dossie: "Este card nao tem dossie de extravio parcial.",
  nao_bloqueada: "A oc 33 deste card ja esta liberada — nao ha o que confirmar.",
  natureza_operacional: "O combo 33+44 nao entra nesta rodada.",
  falta_romaneio: "Falta o romaneio de coleta assinado. Sem ele o SSW reverte a 33 — confirmar descricao nao resolve.",
  nada_faltando: "O dossie ja esta completo.",
  card_sem_anexo: "Este card nao tem nenhum anexo do cliente.",
};

Deno.serve(async (req) => {
  {
    const travaAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const bloqueio = await bloquearSeModoVisualizacao(req, travaAdmin, corsHeaders());
    if (bloqueio) return bloqueio;
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUser = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
    global: { headers: { Authorization: authHeader } },
  });
  const svc = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: {
    card_id?: string;
    todo_id?: string;
    confirmou?: boolean;
    descricao?: string | null;
    valor?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON invalido" }, 400);
  }
  if (!body.card_id || !body.todo_id) {
    return json({ ok: false, error: "{ card_id, todo_id } obrigatorios" }, 400);
  }

  // ---------------------------------------------------------------------------
  // Chave desligada = funcao inerte. Nasce FALSE (mig 400). Enquanto estiver OFF
  // a tela nunca chega aqui, mas o servidor recusa mesmo assim: flag e parede,
  // nao sugestao.
  // ---------------------------------------------------------------------------
  const { data: flagRow } = await svc
    .from("feature_flags")
    .select("enabled")
    .eq("key", "popup_confirma_dossie_oc33_enabled")
    .maybeSingle();
  if ((flagRow as { enabled?: boolean } | null)?.enabled !== true) {
    return json({ ok: false, error: "confirmacao pelo operador desligada", motivo: "flag_off" }, 403);
  }

  // ---------------------------------------------------------------------------
  // QUEM e ela. Sem operador identificado nao ha confirmacao: o registro de
  // autoria e metade do valor desta funcao.
  // ---------------------------------------------------------------------------
  const { data: userRes } = await supabaseUser.auth.getUser();
  const userId = userRes?.user?.id ?? null;
  if (!userId) return json({ ok: false, error: "nao autenticado" }, 401);
  const { data: op } = await svc
    .from("operadores")
    .select("id, nome")
    .eq("user_id", userId)
    .maybeSingle();
  const operadorId = (op as { id?: string } | null)?.id ?? null;
  const operadorNome = (op as { nome?: string } | null)?.nome ?? null;
  if (!operadorId) return json({ ok: false, error: "operador nao encontrado" }, 403);

  // ---------------------------------------------------------------------------
  // Card via RLS (ela so confirma em card que enxerga) e to-do do card.
  // ---------------------------------------------------------------------------
  const { data: card, error: cardErr } = await supabaseUser
    .from("cards")
    .select("id, nf, agent_state")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: "card nao encontrado ou sem acesso" }, 404);

  const { data: todo, error: todoErr } = await supabaseUser
    .from("todos")
    .select("id, card_id, status, proposta_payload")
    .eq("id", body.todo_id)
    .maybeSingle();
  if (todoErr) return json({ ok: false, error: `SELECT todo: ${todoErr.message}` }, 500);
  if (!todo) return json({ ok: false, error: "to-do nao encontrado ou sem acesso" }, 404);
  if ((todo as { card_id?: string }).card_id !== card.id) {
    return json({ ok: false, error: "to-do nao pertence a este card" }, 400);
  }
  const statusTodo = (todo as { status?: string }).status;
  if (statusTodo !== "pendente" && statusTodo !== "aprovado") {
    return json({ ok: false, error: `to-do em status ${statusTodo} — nao da pra confirmar` }, 409);
  }

  const pp = ((todo as { proposta_payload?: Record<string, unknown> }).proposta_payload ?? {}) as Record<string, unknown>;
  const ep = lerExtravioParcial(card as { agent_state?: Record<string, unknown> | null });
  const dossieAntes: DossieExtravioParcial = ep ? ep.dossie : dossieVazio();
  const natureza = classificarOc33({ proposta_payload: pp } as never, ep?.caso ?? null);
  const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
  const carimbo = (meta["gate_oc33"] ?? null) as { bloqueada?: boolean } | null;

  // ---------------------------------------------------------------------------
  // Tem anexo vivo do cliente no card? Mesma consulta que a tela faz, pra as
  // duas nunca discordarem sobre "este card tem anexo".
  // ---------------------------------------------------------------------------
  const { data: msgs } = await svc.from("messages_inbox").select("id").eq("card_id", card.id);
  const msgIds = ((msgs ?? []) as { id: string }[]).map((m) => m.id);
  let temAnexoNoCard = false;
  if (msgIds.length > 0) {
    const { count } = await svc
      .from("email_anexos")
      .select("id", { count: "exact", head: true })
      .in("message_inbox_id", msgIds)
      .eq("origem", "inbound")
      .is("deletado_em", null);
    temAnexoNoCard = (count ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // A MESMA decisao pura que a tela usou pra abrir o pop-up. Se divergir, quem
  // vale e esta — a tela e so a porta.
  // ---------------------------------------------------------------------------
  const decisao = decidirPerguntaOc33({
    natureza,
    bloqueada: carimbo?.bloqueada === true,
    dossie: ep ? dossieAntes : null,
    temAnexoNoCard,
  });
  if (!decisao.perguntar) {
    return json({
      ok: false,
      motivo: decisao.motivo,
      error: MOTIVO_HUMANO[decisao.motivo ?? ""] ?? "confirmacao nao se aplica a este to-do",
    }, 409);
  }

  const agora = new Date().toISOString();
  const confirmacao: ConfirmacaoOperador = {
    confirmou: body.confirmou === true,
    descricao: body.descricao ?? null,
    valor: body.valor ?? null,
    operador_id: operadorId,
    visto_em: agora,
  };
  const v = validarConfirmacao(confirmacao, decisao.alvos);

  // NAO: registra a recusa (serve pra medir quantas vezes o anexo nao tinha a
  // informacao) e sai sem tocar em nada.
  if (!confirmacao.confirmou) {
    await svc.from("card_events").insert({
      card_id: card.id,
      event_type: "Oc33ConfirmacaoOperadorRecusada",
      actor_type: "human",
      actor_id: operadorId,
      payload: {
        todo_id: todo.id,
        operador_nome: operadorNome,
        faltando: decisao.rotulos,
        motivo: "operadora marcou NAO — cliente nao informou por anexo",
      },
    });
    return json({ ok: true, confirmou: false, bloqueada: true, faltando: decisao.rotulos });
  }

  if (!v.ok) return json({ ok: false, error: v.erros.join(" "), erros: v.erros, motivo: "texto_invalido" }, 400);

  // ---------------------------------------------------------------------------
  // 1. EVENTO ANTES DO ESTADO (convencao nº 1 + autoria nunca se perde).
  // ---------------------------------------------------------------------------
  const evidencias = evidenciasDaConfirmacao(v, confirmacao);
  const dossieDepois = mergeEvidencia(dossieAntes, evidencias);
  const { error: evErr } = await svc.from("card_events").insert({
    card_id: card.id,
    event_type: "Oc33DossieConfirmadoPeloOperador",
    actor_type: "human",
    actor_id: operadorId,
    payload: {
      todo_id: todo.id,
      operador_nome: operadorNome,
      nf: (card as { nf?: string }).nf ?? null,
      faltava: decisao.rotulos,
      descricao: v.descricao,
      valor: v.valor,
      texto_para_o_ssw: montarTextoDescricaoValor(dossieDepois),
      confirmado_em: agora,
      // Registro honesto: isto e afirmacao humana, nao leitura de arquivo.
      fonte: "operador",
    },
  });
  if (evErr) return json({ ok: false, error: `card_events: ${evErr.message}` }, 500);

  // ---------------------------------------------------------------------------
  // 2. DOSSIE. Read-modify-write: dois cliques simultaneos poderiam se atropelar,
  // mas mergeEvidencia e monotonico — o pior caso perde o TEXTO de um dos dois,
  // nunca a completude. O evento acima guarda os dois textos.
  // ---------------------------------------------------------------------------
  const agentState = ((card as { agent_state?: Record<string, unknown> | null }).agent_state ?? {}) as Record<string, unknown>;
  const epAtual = (agentState["extravio_parcial"] ?? {}) as Record<string, unknown>;
  const { error: upErr } = await svc
    .from("cards")
    .update({
      agent_state: {
        ...agentState,
        extravio_parcial: { ...epAtual, dossie: dossieDepois },
      },
    })
    .eq("id", card.id);
  if (upErr) return json({ ok: false, error: `UPDATE card: ${upErr.message}` }, 500);

  // ---------------------------------------------------------------------------
  // 3. RECARIMBA os to-dos abertos de oc 33 do card com o dossie novo. Mesmo
  // codigo do repatch do interpretador — um so criterio de verdade.
  // ---------------------------------------------------------------------------
  const { data: todosAtivos } = await svc
    .from("todos")
    .select("id, proposta_payload")
    .eq("card_id", card.id)
    .in("status", ["pendente", "aprovado"]);

  let recarimbados = 0;
  for (const t of (todosAtivos ?? []) as { id: string; proposta_payload: Record<string, unknown> | null }[]) {
    const p = t.proposta_payload;
    if (!p) continue;
    const nat = classificarOc33({ proposta_payload: p } as never, ep?.caso ?? null);
    if (!nat) continue;
    const g = decidirGateOc33(nat, dossieDepois);
    const m = (p["meta"] ?? {}) as Record<string, unknown>;
    const gateNovo = { natureza: nat, bloqueada: g.bloqueada, faltando: g.faltando };
    if (JSON.stringify(m["gate_oc33"]) === JSON.stringify(gateNovo)) continue;
    const { error } = await svc
      .from("todos")
      .update({ proposta_payload: { ...p, meta: { ...m, gate_oc33: gateNovo } } })
      .eq("id", t.id);
    if (!error) recarimbados++;
  }

  const gateFinal = decidirGateOc33("completude", dossieDepois);
  return json({
    ok: true,
    confirmou: true,
    bloqueada: gateFinal.bloqueada,
    faltando: gateFinal.faltando,
    recarimbados,
    texto_para_o_ssw: montarTextoDescricaoValor(dossieDepois),
  });
});
