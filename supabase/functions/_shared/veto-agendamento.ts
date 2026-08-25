// =============================================================================
// veto-agendamento — AGENDA a ação autônoma com janela de veto (Etapa D, 25/08).
//
// Chamado pelos agentes no ponto onde hoje vive a autonomia por fatia
// (unificação do risco 25: o veto é O modo; a via instantânea é aposentada).
// Fluxo: agente destacou a ação → este módulo levanta as cercas
// (veto-elegibilidade) → elegível: INSERT em acoes_agendadas tipo
// executar_acao_autonoma com executar_em = agora + 60 MINUTOS ÚTEIS + hash da
// proposta (risco 23) → evento AcaoAutonomaAgendada. O espelho
// cards.acao_autonoma atualiza via trigger (mig 353) e o front mostra o
// countdown. Inelegível: devolve o motivo (log/telemetria) e o fluxo humano
// segue EXATAMENTE como hoje.
//
// Índice único (mig 353) garante 1 agendamento vivo por card; re-análise com
// proposta diferente SUBSTITUI (cancela antigo + evento AcaoAutonomaSubstituida).
// NUNCA lança — qualquer erro = fluxo humano normal (fail-safe).
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  EVENTO_AGENDADA,
  EVENTO_SUBSTITUIDA,
  FLAG_VETO,
  hashDaProposta,
  JANELA_VETO_MINUTOS_UTEIS,
  TIPO_EXECUTAR_ACAO_AUTONOMA,
} from "./acao-autonoma-veto.ts";
import { adicionarMinutosUteis } from "./minutos-uteis.ts";
import { decidirElegibilidadeVeto, type PropostaVeto } from "./veto-elegibilidade.ts";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** Piso de confiança do trilho autônomo (cerca situacional do plano). */
export const PISO_CONFIANCA_VETO = 0.7;

/** Janela da cerca "falha recente no card" (risco 22). */
const FALHA_RECENTE_DIAS = 3;

/** Janela da cerca por cliente (alimentada pelos cancelamentos). */
const EXCECAO_CLIENTE_DIAS = 90;

/** Eventos que ABREM ciclo — espelho de apps/cockpit-web/src/lib/ciclosTratativa.ts
 *  (edge não importa do front; mudança tem que acontecer nos DOIS). */
const EVENTOS_ABERTURA_CICLO = [
  "BastaoCardImportado",
  "ExtravioImportado",
  "BastaoReabriuNFFonteRelacionamento",
  "CardReaberto",
  "CardReabertoPorRespostaCliente",
];

export function montarRegraVeto(agentName: string, acaoKey: string): string {
  return `veto_janela:${agentName}:${acaoKey}`;
}

export interface EntradaAgendamentoVeto {
  cardId: string;
  agentName: string;
  acaoKey: string | null;
  ocCard: number | null;
  ocSugerida: number | null;
  confianca: number | null;
}

export type ResultadoAgendamento =
  | { agendou: true; agendamentoId: number; executarEm: string }
  | { agendou: false; motivo: string };

export async function agendarAcaoAutonomaSeElegivel(
  supabase: SupabaseClient,
  i: EntradaAgendamentoVeto,
): Promise<ResultadoAgendamento> {
  try {
    if (!i.acaoKey) return { agendou: false, motivo: "sem_acao_key" };

    // cercas de sistema — flag master + degrau da escada
    const { data: flagRow } = await supabase
      .from("feature_flags").select("enabled").eq("key", FLAG_VETO).maybeSingle();
    const flagOn = (flagRow as { enabled?: boolean } | null)?.enabled === true;
    if (!flagOn) return { agendou: false, motivo: "flag_master_off" };

    const { data: degrau } = await supabase
      .from("acoes_autonomas_veto_config")
      .select("ativa").eq("acao_key", i.acaoKey).maybeSingle();
    const escadaOn = (degrau as { ativa?: boolean } | null)?.ativa === true;
    if (!escadaOn) return { agendou: false, motivo: "acao_inativa_na_escada" };

    // "Sugeriu aguardar" (25/08): também é ação autônoma — no vencimento o
    // motor executa o ignorar-e-continuar-aguardando (core da mig 356). NÃO há
    // todo nem lançamento no SSW → cercas de SSW/conteúdo não se aplicam.
    const ehAguardar = i.acaoKey.startsWith("ignorar_e_aguardar:");

    // card + todo alvo
    const { data: card } = await supabase
      .from("cards")
      .select("id, assigned_operator_id, pagador, cod_ultima_ocorrencia")
      .eq("id", i.cardId).maybeSingle();
    if (!card) return { agendou: false, motivo: "card_nao_encontrado" };

    const { data: todos } = await supabase
      .from("todos")
      .select("id, proposta_payload")
      .eq("card_id", i.cardId)
      .eq("status", "pendente")
      .order("created_at", { ascending: false })
      .limit(30);
    const alvo = ehAguardar
      ? null
      : ((todos ?? []) as Array<{ id: string; proposta_payload: PropostaVeto & { acao_key?: string } | null }>)
        .find((t) => (t.proposta_payload as { acao_key?: string } | null)?.acao_key === i.acaoKey);

    // cercas situacionais (queries pequenas, todas indexadas por card)
    const desdeFalha = new Date(Date.now() - FALHA_RECENTE_DIAS * 24 * 3600 * 1000).toISOString();
    const { data: falhas } = await supabase
      .from("card_events").select("id")
      .eq("card_id", i.cardId)
      .eq("event_type", "AcaoRevertidaPosFalha")
      .gte("created_at", desdeFalha)
      .limit(1);

    // risco 35: mesma oc já executada pelo Cockpit no CICLO atual
    const { data: aberturas } = await supabase
      .from("card_events").select("created_at")
      .eq("card_id", i.cardId)
      .in("event_type", EVENTOS_ABERTURA_CICLO)
      .order("created_at", { ascending: false })
      .limit(1);
    const inicioCiclo = (aberturas?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
    const codigoDaAcao = Number(i.acaoKey.split(":").pop());
    let mesmaAcaoNoCiclo = false;
    if (Number.isFinite(codigoDaAcao)) {
      let q = supabase
        .from("acoes_executadas_ssw").select("id")
        .eq("card_id", i.cardId)
        .eq("codigo_oc", codigoDaAcao)
        .eq("sucesso", true)
        .limit(1);
      if (inicioCiclo) q = q.gte("iniciado_em", inicioCiclo);
      const { data: execs } = await q;
      mesmaAcaoNoCiclo = (execs ?? []).length > 0;
    }

    // cerca por cliente (formulário de cancelamento alimenta)
    let clienteComExcecao = false;
    const pagador = (card as { pagador?: string | null }).pagador ?? null;
    if (pagador) {
      const desdeExc = new Date(Date.now() - EXCECAO_CLIENTE_DIAS * 24 * 3600 * 1000).toISOString();
      const { data: excecoes } = await supabase
        .from("cancelamentos_acao_autonoma")
        .select("id, cards!inner(pagador)")
        .eq("cards.pagador", pagador)
        .eq("respostas->>excecao_cliente", "true")
        .gte("created_at", desdeExc)
        .limit(1);
      clienteComExcecao = (excecoes ?? []).length > 0;
    }

    // proposta sintética pro aguardar (não há todo; nada vai pro SSW)
    const propostaAguardar: PropostaVeto = {
      tool: "ignorar_e_aguardar",
      args: { codigo_ssw: Number(i.acaoKey.split(":").pop()) },
    };
    const decisao = decidirElegibilidadeVeto({
      flagMasterOn: flagOn,
      acaoAtivaNaEscada: escadaOn,
      acaoKey: i.acaoKey,
      proposta: ehAguardar ? propostaAguardar : ((alvo?.proposta_payload ?? null) as PropostaVeto | null),
      temTodoPendente: ehAguardar ? true : !!alvo,
      operadorDonoId: (card as { assigned_operator_id?: string | null }).assigned_operator_id ?? null,
      falhaRecenteNoCard: (falhas ?? []).length > 0,
      // aguardar repetido no ciclo é inofensivo (não lança nada no SSW)
      mesmaAcaoNoCicloAtual: ehAguardar ? false : mesmaAcaoNoCiclo,
      clienteComExcecao,
      confianca: i.confianca,
      pisoConfianca: PISO_CONFIANCA_VETO,
    });
    if (!decisao.elegivel) return { agendou: false, motivo: decisao.motivo };

    // janela de 60 minutos ÚTEIS (feriados da tabela — risco 29)
    const { data: feriadosRows } = await supabase.from("feriados").select("data");
    const feriados = new Set(
      ((feriadosRows ?? []) as Array<{ data: string }>).map((f) => f.data),
    );
    const executarEm = adicionarMinutosUteis(new Date(), JANELA_VETO_MINUTOS_UTEIS, feriados);

    const hash = hashDaProposta(ehAguardar ? propostaAguardar : alvo!.proposta_payload);
    const payloadAgendamento = {
      acao_key: i.acaoKey,
      todo_id: ehAguardar ? null : alvo!.id,
      modo: ehAguardar ? "aguardar" : "todo",
      hash_proposta: hash,
      agent_name: i.agentName,
      regra: montarRegraVeto(i.agentName, i.acaoKey),
      oc_card: i.ocCard,
      oc_sugerida: i.ocSugerida,
      confianca: i.confianca,
      operador_dono: (card as { assigned_operator_id?: string | null }).assigned_operator_id,
      agendado_em: new Date().toISOString(),
    };

    // 1 agendamento vivo por card (risco 17): existente igual → no-op;
    // existente diferente → substitui com evento.
    const { data: vivos } = await supabase
      .from("acoes_agendadas")
      .select("id, payload")
      .eq("card_id", i.cardId)
      .eq("tipo", TIPO_EXECUTAR_ACAO_AUTONOMA)
      .in("status", ["pendente", "executando"]);
    const vivo = (vivos ?? [])[0] as { id: number; payload: Record<string, unknown> } | undefined;
    const todoIdNovo = ehAguardar ? null : alvo!.id;
    if (vivo) {
      if (
        (vivo.payload?.["todo_id"] ?? null) === todoIdNovo &&
        vivo.payload?.["hash_proposta"] === hash
      ) {
        return { agendou: false, motivo: "ja_agendado_identico" };
      }
      const { error: cancErr } = await supabase
        .from("acoes_agendadas")
        .update({ status: "cancelado", cancelado_motivo: "substituído por nova análise (proposta mudou)" })
        .eq("id", vivo.id)
        .eq("status", "pendente"); // nunca mata um claim em voo
      if (cancErr || !(await agendamentoEstaMorto(supabase, vivo.id))) {
        return { agendou: false, motivo: "agendamento_em_execucao_nao_substituivel" };
      }
      await supabase.from("card_events").insert({
        card_id: i.cardId,
        event_type: EVENTO_SUBSTITUIDA,
        actor_type: "system",
        actor_id: i.agentName,
        payload: { agendamento_anterior: vivo.id, novo_todo_id: todoIdNovo, novo_hash: hash },
      });
    }

    const { data: novo, error: insErr } = await supabase
      .from("acoes_agendadas")
      .insert({
        card_id: i.cardId,
        tipo: TIPO_EXECUTAR_ACAO_AUTONOMA,
        executar_em: executarEm.toISOString(),
        payload: payloadAgendamento,
      })
      .select("id")
      .single();
    if (insErr || !novo) {
      // corrida com outro agendador (índice único) → fail-safe: humano segue
      return { agendou: false, motivo: `insert_falhou:${insErr?.message ?? "?"}` };
    }

    await supabase.from("card_events").insert({
      card_id: i.cardId,
      event_type: EVENTO_AGENDADA,
      actor_type: "system",
      actor_id: i.agentName,
      payload: {
        agendamento_id: (novo as { id: number }).id,
        acao_key: i.acaoKey,
        todo_id: todoIdNovo,
        executar_em: executarEm.toISOString(),
        hash_proposta: hash,
        regra: payloadAgendamento.regra,
      },
    });

    console.log(
      `[veto] AGENDADO card=${i.cardId} ${i.acaoKey} todo=${todoIdNovo ?? "(aguardar)"} executa=${executarEm.toISOString()}`,
    );
    return {
      agendou: true,
      agendamentoId: (novo as { id: number }).id,
      executarEm: executarEm.toISOString(),
    };
  } catch (e) {
    console.warn(
      `[veto] agendamento falhou isolado (card ${i.cardId}): ${e instanceof Error ? e.message : e} — fluxo humano segue`,
    );
    return { agendou: false, motivo: "erro" };
  }
}

async function agendamentoEstaMorto(supabase: SupabaseClient, id: number): Promise<boolean> {
  const { data } = await supabase
    .from("acoes_agendadas").select("status").eq("id", id).maybeSingle();
  const st = (data as { status?: string } | null)?.status;
  return st !== "pendente" && st !== "executando";
}
