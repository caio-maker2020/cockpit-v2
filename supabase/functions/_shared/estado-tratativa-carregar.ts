// =============================================================================
// estado-tratativa-carregar — I/O da memória do card: carrega as fontes,
// monta (lib pura) e persiste com trava otimista de rev (monotonia = INV).
//
// Usos:
//  - garantirEstadoFresco(): consumidores de DECISÃO (interpretador, oc49,
//    veto-agendamento, vencimento) — recompute DETERMINÍSTICO inline (~4 selects
//    indexados por card). NUNCA chama LLM e NUNCA limpa o dirty (o resumo é do
//    worker). Sem estado e sem necessidade → devolve null (comportamento de hoje).
//  - carregarFontes()/persistirEstado(): usados pelo worker (que também renova
//    o resumo via Haiku quando há texto novo).
// Regra dura: este módulo NUNCA insere card_events (recompute não gera evento —
// teste do plano) e NUNCA mexe em nenhuma outra coluna do card.
// =============================================================================

// (sem import de tipos do supabase-js: os callers criam o client com generics
// diferentes — <any,"public",any> no worker, default no interpretador — e
// qualquer alias concreto quebra um dos lados; o contrato aqui é estrutural)
import { EVENTOS_ABERTURA_CICLO } from "./ciclos-tratativa.ts";
import {
  type CorrecaoOperador,
  type EstadoTratativa,
  estadoDentroDoTeto,
  type FontesEstado,
  hashFontes,
  montarEstado,
} from "./estado-tratativa.ts";

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export const EVENTO_ESTADO_CORRIGIDO = "EstadoCorrigidoPeloOperador" as const;
export const EVENTO_INFO_EXTERNA = "InformacaoExternaRegistrada" as const;

interface CardRow {
  id: string;
  state: string;
  cod_ultima_ocorrencia: number | null;
  cliente_respondeu_em: string | null;
  historico_ssw: FontesEstado["historicoSsw"] | null;
  historico_ssw_atualizado_em: string | null;
  agent_state: Record<string, unknown> | null;
  estado_tratativa: EstadoTratativa | null;
  estado_tratativa_dirty_at: string | null;
  last_event_id: string | null;
  last_event_at: string | null;
}

const SELECT_CARD =
  "id, state, cod_ultima_ocorrencia, cliente_respondeu_em, historico_ssw, " +
  "historico_ssw_atualizado_em, agent_state, estado_tratativa, " +
  "estado_tratativa_dirty_at, last_event_id, last_event_at";

export async function carregarFontes(
  supabase: SupabaseClient,
  cardId: string,
  gatilho: string,
): Promise<{ fontes: FontesEstado; anterior: EstadoTratativa | null } | null> {
  const { data: card } = await supabase.from("cards")
    .select(SELECT_CARD).eq("id", cardId).maybeSingle();
  if (!card) return null;
  const c = card as unknown as CardRow;

  const [aberturas, overlay, acoes, respostaEnviada, agendada] = await Promise.all([
    supabase.from("card_events").select("created_at")
      .eq("card_id", cardId).in("event_type", [...EVENTOS_ABERTURA_CICLO])
      .order("created_at").limit(50),
    supabase.from("card_events").select("event_type, payload, created_at, actor_id")
      .eq("card_id", cardId)
      .in("event_type", [EVENTO_ESTADO_CORRIGIDO, EVENTO_INFO_EXTERNA])
      .order("created_at").limit(100),
    supabase.from("acoes_executadas_ssw").select("id, codigo_oc, iniciado_em, sucesso")
      .eq("card_id", cardId).order("iniciado_em").limit(100),
    supabase.from("card_events").select("created_at")
      .eq("card_id", cardId).eq("event_type", "RespostaEnviada")
      .order("created_at", { ascending: false }).limit(1),
    supabase.from("acoes_agendadas").select("id")
      .eq("card_id", cardId).eq("tipo", "executar_acao_autonoma")
      .eq("status", "pendente").limit(1),
  ]);

  const correcoes: CorrecaoOperador[] = [];
  const infoExterna: FontesEstado["infoExterna"][number][] = [];
  for (const ev of (overlay.data ?? []) as Array<{ event_type: string; payload: Record<string, unknown>; created_at: string; actor_id: string | null }>) {
    const p = ev.payload ?? {};
    if (ev.event_type === EVENTO_ESTADO_CORRIGIDO) {
      correcoes.push({
        op: (p["op"] as CorrecaoOperador["op"]) ?? "remover_fato",
        fato_id: p["fato_id"] as string | undefined,
        fato: p["fato"] as CorrecaoOperador["fato"],
        em: ev.created_at,
        por: `operador:${ev.actor_id ?? "?"}`,
      });
    } else {
      infoExterna.push({
        texto: String(p["texto"] ?? ""),
        por: `operador:${ev.actor_id ?? "?"}`,
        em: ev.created_at,
      });
    }
  }

  const agentState = (c.agent_state ?? {}) as Record<string, unknown>;
  const extravio = agentState["extravio_parcial"] as { dossie?: FontesEstado["dossie"] } | undefined;

  const fontes: FontesEstado = {
    cardState: c.state,
    codUltimaOcorrencia: c.cod_ultima_ocorrencia,
    clienteRespondeuEm: c.cliente_respondeu_em,
    historicoSsw: (c.historico_ssw ?? []) as FontesEstado["historicoSsw"],
    historicoAtualizadoEm: c.historico_ssw_atualizado_em,
    aberturasCicloIso: ((aberturas.data ?? []) as Array<{ created_at: string }>).map((r) => r.created_at),
    acoesExecutadas: ((acoes.data ?? []) as FontesEstado["acoesExecutadas"][number][]),
    ultimoEmailEnviadoEm: ((respostaEnviada.data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null,
    acaoAgendadaPendente: ((agendada.data ?? []).length > 0),
    dossie: extravio?.dossie ?? null,
    correcoes,
    infoExterna,
    baseEventId: c.last_event_id,
    baseEventAt: c.last_event_at,
    gatilho,
    agoraIso: new Date().toISOString(),
  };
  return { fontes, anterior: c.estado_tratativa };
}

/** Persiste com trava otimista de rev (monotonia). Corrida → devolve o vigente. */
export async function persistirEstado(
  supabase: SupabaseClient,
  cardId: string,
  novo: EstadoTratativa,
  revEsperadaDoAnterior: number | null,
): Promise<EstadoTratativa> {
  if (!estadoDentroDoTeto(novo)) {
    // INV ≤6KB: encolhe as listas antes de gravar (nunca falha o fluxo do caller)
    novo = { ...novo, fatos_confirmados: novo.fatos_confirmados.slice(0, 10), divida: [] };
  }
  let q = supabase.from("cards").update({ estado_tratativa: novo }).eq("id", cardId);
  if (revEsperadaDoAnterior == null) q = q.is("estado_tratativa", null);
  else q = q.eq("estado_tratativa->>rev", String(revEsperadaDoAnterior));
  const { data } = await q.select("estado_tratativa").maybeSingle();
  if (data) return (data as { estado_tratativa: EstadoTratativa }).estado_tratativa;
  // corrida: alguém gravou antes — o vigente vence (rev nunca regride)
  const { data: atual } = await supabase.from("cards")
    .select("estado_tratativa").eq("id", cardId).maybeSingle();
  return ((atual as { estado_tratativa: EstadoTratativa | null } | null)?.estado_tratativa) ?? novo;
}

/**
 * Consumidores de decisão: devolve a memória FRESCA (recompute determinístico
 * se necessário) ou null (sem memória ainda — comportamento de hoje).
 */
export async function garantirEstadoFresco(
  supabase: SupabaseClient,
  cardId: string,
  gatilho: string,
): Promise<EstadoTratativa | null> {
  try {
    const carga = await carregarFontes(supabase, cardId, gatilho);
    if (!carga) return null;
    const { fontes, anterior } = carga;
    if (anterior == null) return null;   // F1 ainda não populou este card — sem memória, sem cerca
    const fresco =
      anterior.base_event_id === fontes.baseEventId &&
      anterior.hash_fontes === hashFontes(fontes);
    if (fresco) return anterior;
    const novo = montarEstado(fontes, anterior);
    return await persistirEstado(supabase, cardId, novo, anterior.rev);
  } catch (e) {
    // memória NUNCA derruba decisão: falhou = sem estado = comportamento de hoje
    console.warn(`[estado-tratativa] garantirEstadoFresco(${cardId}) falhou: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
