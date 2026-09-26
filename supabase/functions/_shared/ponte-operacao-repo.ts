// =============================================================================
// ponte-operacao-repo — I/O (Supabase) da ponte v2 (ADR 0035). As decisões moram
// nos módulos puros (ponte-operacao-*.ts); aqui só leitura/gravação.
//
// Escritas que existem aqui, e SÓ estas:
//   - ponte_operacao_pedidos (INSERT/UPDATE de etapa) e as RPCs da mig 411;
//   - cards: INSERT do card que nasce de pedido `devolver_ao_relacionamento`
//     (mesmo formato do vinculador.createCardFromBastao) — nunca UPDATE de state;
//   - audit_log: 1 linha por ida ao SSW (external_system='ssw').
// O repositório de LEITURA (tratativas) não tem nenhum método de escrita.
// =============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { STATES_TERMINAIS } from "./ponte-operacao-comum.ts";
import type { CardTratativaRow, OcDicionario, RepoTratativas } from "./ponte-operacao-tratativas.ts";
import type { CardResumo, PedidoRow, RepoPedidos } from "./ponte-operacao-pedido.ts";
import type { CardResumoWorker, RepoWorker } from "./ponte-operacao-worker.ts";
import { enfileirarScanEmailPreCard } from "./scan-email-enqueue.ts";

// .in() vai na URL do PostgREST — lote conservador (memória "Cadastros .in 414").
const LOTE_IN_CTRC = 100;
const TERMINAIS_IN = `(${STATES_TERMINAIS.join(",")})`;

async function flagLigada(supabase: SupabaseClient, key: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
    if (error) return false; // fail-closed: sem ler a flag, desligado
    return (data as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}

async function codigoPermitido(supabase: SupabaseClient, codigo: number): Promise<boolean> {
  try {
    const [lista, dic] = await Promise.all([
      supabase.from("ponte_operacao_codigos_permitidos").select("codigo").eq("codigo", codigo).eq("ativo", true).maybeSingle(),
      supabase.from("ocorrencias_dicionario").select("responsabilidade").eq("codigo", codigo).maybeSingle(),
    ]);
    if (lista.error || dic.error) return false;
    // Duas cercas: estar ATIVO na lista E ser da Operação no dicionário (a tabela
    // também tem trigger; aqui é a mesma regra lida na hora, fail-closed).
    return !!lista.data && (dic.data as { responsabilidade?: string } | null)?.responsabilidade === "Operação";
  } catch {
    return false;
  }
}

// ── leitura (ponte-tratativas) ───────────────────────────────────────────────

const SELECT_TRATATIVA_BASE = "id, ctrc, state, tipo, responsavel_relacionamento, cod_ultima_ocorrencia, created_at, updated_at";
const SELECT_TRATATIVA_ESTADO = `${SELECT_TRATATIVA_BASE}, situacao:estado_tratativa->>situacao, aguardando:estado_tratativa->aguardando`;
const DICIONARIO_TTL_MS = 10 * 60_000;
let cacheDicionario: { em: number; mapa: Map<number, OcDicionario> } | null = null;

export function criarRepoTratativas(supabase: SupabaseClient): RepoTratativas {
  return {
    flagLigada: (key) => flagLigada(supabase, key),

    async cardsPorCtrcs(ctrcs) {
      const out: CardTratativaRow[] = [];
      for (let i = 0; i < ctrcs.length; i += LOTE_IN_CTRC) {
        const lote = ctrcs.slice(i, i + LOTE_IN_CTRC);
        let r: { data: unknown[] | null; error: { message?: string } | null } =
          await supabase.from("cards").select(SELECT_TRATATIVA_ESTADO).in("ctrc", lote);
        // Sem a memória do card (mig 404) a leitura continua, só sem situacao/aguardando.
        if (r.error && /estado_tratativa/i.test(r.error.message ?? "")) {
          r = await supabase.from("cards").select(SELECT_TRATATIVA_BASE).in("ctrc", lote);
        }
        if (r.error) throw new Error(`cards por ctrc: ${r.error.message}`);
        for (const row of (r.data ?? []) as Array<Record<string, unknown>>) {
          const ag = row["aguardando"];
          out.push({
            id: String(row["id"]),
            ctrc: (row["ctrc"] as string | null) ?? null,
            state: String(row["state"]),
            tipo: (row["tipo"] as string | null) ?? null,
            responsavel_relacionamento: (row["responsavel_relacionamento"] as string | null) ?? null,
            cod_ultima_ocorrencia: typeof row["cod_ultima_ocorrencia"] === "number" ? row["cod_ultima_ocorrencia"] as number : null,
            created_at: String(row["created_at"]),
            updated_at: String(row["updated_at"]),
            situacao: typeof row["situacao"] === "string" ? row["situacao"] as string : null,
            aguardando: ag && typeof ag === "object" ? ag as CardTratativaRow["aguardando"] : null,
          });
        }
      }
      return out;
    },

    async dicionario() {
      if (cacheDicionario && Date.now() - cacheDicionario.em < DICIONARIO_TTL_MS) return cacheDicionario.mapa;
      const mapa = new Map<number, OcDicionario>();
      try {
        const { data, error } = await supabase.from("ocorrencias_dicionario").select("codigo, descricao, responsabilidade");
        if (error) return mapa; // desconhecida → a regra bloqueia (fail-safe)
        for (const d of (data ?? []) as Array<{ codigo: number; descricao: string; responsabilidade: string }>) {
          mapa.set(d.codigo, { descricao: d.descricao, responsabilidade: d.responsabilidade });
        }
        cacheDicionario = { em: Date.now(), mapa };
      } catch { /* mapa vazio */ }
      return mapa;
    },
  };
}

// ── pedidos (ponte-pedido-operacao) ──────────────────────────────────────────

async function buscarPedido(supabase: SupabaseClient, pedidoId: string): Promise<PedidoRow | null> {
  const { data, error } = await supabase.from("ponte_operacao_pedidos").select("*").eq("pedido_id", pedidoId).maybeSingle();
  if (error) throw new Error(`pedido ${pedidoId}: ${error.message}`);
  return (data as PedidoRow | null) ?? null;
}

async function vincularCard(
  supabase: SupabaseClient,
  args: { pedidoId: string; cardId: string; cardCriado: boolean; payloadCriacao: Record<string, unknown> | null },
): Promise<void> {
  const { error } = await supabase.rpc("ponte_operacao_vincular_card", {
    p_pedido_id: args.pedidoId,
    p_card_id: args.cardId,
    p_card_criado: args.cardCriado,
    p_payload_criacao: args.payloadCriacao,
  });
  if (error) throw new Error(`vincular: ${error.message}`);
}

const SELECT_CARD_RESUMO = "id, ctrc, nf, state, cod_ultima_ocorrencia, created_at";

export function criarRepoPedidos(supabase: SupabaseClient): RepoPedidos {
  return {
    flagLigada: (key) => flagLigada(supabase, key),
    buscarPedido: (id) => buscarPedido(supabase, id),
    async inserirPedido(p) {
      const { error } = await supabase.from("ponte_operacao_pedidos").insert(p);
      if (!error) return "inserido";
      if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) return "conflito";
      throw new Error(`inserir pedido: ${error.message}`);
    },
    codigoPermitido: (codigo) => codigoPermitido(supabase, codigo),
    async cardsDoCtrc(ctrc) {
      const { data, error } = await supabase.from("cards").select(SELECT_CARD_RESUMO)
        .eq("ctrc", ctrc).order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(`cards do ctrc: ${error.message}`);
      return (data ?? []) as CardResumo[];
    },
    vincularCard: (args) => vincularCard(supabase, args),
  };
}

// ── worker (processar-pedidos-operacao) ──────────────────────────────────────

async function pedidosNaEtapa(supabase: SupabaseClient, etapa: string, limite: number): Promise<PedidoRow[]> {
  const { data, error } = await supabase.from("ponte_operacao_pedidos").select("*")
    .eq("status", "recebido").eq("etapa", etapa).order("recebido_em", { ascending: true }).limit(limite);
  if (error) throw new Error(`pedidos ${etapa}: ${error.message}`);
  return (data ?? []) as PedidoRow[];
}

export function criarRepoWorker(supabase: SupabaseClient): RepoWorker {
  return {
    flagLigada: (key) => flagLigada(supabase, key),

    async expirarVencidos(ttlHoras, travadoMin) {
      const { data, error } = await supabase.rpc("ponte_operacao_expirar", { p_ttl_horas: ttlHoras, p_travado_min: travadoMin });
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },

    pedidosParaVincular: (limite) => pedidosNaEtapa(supabase, "vincular_card", limite),
    pedidosVinculados: (limite) => pedidosNaEtapa(supabase, "vinculado", limite),

    async cardsDoCtrc(ctrc) {
      const { data, error } = await supabase.from("cards")
        .select(`${SELECT_CARD_RESUMO}, pedido_operacao_id:agent_state->>pedido_operacao_id`)
        .eq("ctrc", ctrc).order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(`cards do ctrc: ${error.message}`);
      return (data ?? []) as CardResumoWorker[];
    },

    async cardsAtivosDaNf(nf) {
      const { data, error } = await supabase.from("cards").select(SELECT_CARD_RESUMO)
        .eq("nf", nf).not("state", "in", TERMINAIS_IN).order("created_at", { ascending: false }).limit(5);
      if (error) throw new Error(`cards ativos da nf: ${error.message}`);
      return (data ?? []) as CardResumo[];
    },

    async terminaisDaNf24h(nf) {
      const desde = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const { count, error } = await supabase.from("cards").select("id", { count: "exact", head: true })
        .eq("nf", nf).in("state", [...STATES_TERMINAIS]).gte("created_at", desde);
      // Diferente do guard do sync (fail-open): aqui a dúvida NÃO cria card.
      if (error) throw new Error(`guard INV-040: ${error.message}`);
      return count ?? 0;
    },

    async criarCard(novo) {
      const { data, error } = await supabase.from("cards").insert({
        ...novo,
        canal_origem: "sistema",
        empresa_cliente: novo.pagador,
        tipo: null,
        risco: "baixo",
        bastao_synced_at: new Date().toISOString(),
      }).select("id").single();
      if (error) {
        // uniq_cards_nf_active / uniq_cards_bastao_pendencia_active: outro caminho criou antes.
        if (error.code === "23505") return "conflito";
        throw new Error(`criar card: ${error.message}`);
      }
      const id = (data as { id: string }).id;
      // Igual aos outros nascimentos de card: só enfileira (gated por flag, nunca lança).
      try {
        await enfileirarScanEmailPreCard(supabase, {
          card_id: id,
          nf: novo.nf,
          cnpj_pagador: (novo.agent_state["cnpj_pagador"] as string | null) ?? null,
          assigned_operator_id: novo.assigned_operator_id,
          origem: "ponte_operacao",
        });
      } catch { /* best-effort */ }
      return { id };
    },

    vincularCard: (args) => vincularCard(supabase, args),

    async moverParaFila(pedidoId) {
      const { error } = await supabase.from("ponte_operacao_pedidos")
        .update({ etapa: "fila_ssw", atualizado_em: new Date().toISOString() })
        .eq("pedido_id", pedidoId).eq("status", "recebido").eq("etapa", "vinculado");
      if (error) throw new Error(`fila: ${error.message}`);
    },

    async finalizar(pedidoId, a) {
      const { error } = await supabase.rpc("ponte_operacao_finalizar", {
        p_pedido_id: pedidoId,
        p_status: a.status,
        p_detalhe: a.detalhe,
        p_ocorrencia_lancada: a.ocorrenciaLancada ?? null,
        p_acao_ssw_id: a.acaoSswId ?? null,
        p_categoria: a.categoria ?? null,
        p_evento_tipo: a.evento?.tipo ?? null,
        p_evento_payload: a.evento?.payload ?? null,
      });
      if (error) throw new Error(`finalizar: ${error.message}`);
    },

    async reservarLancamentos(limitePorMinuto, ttlHoras, quarentenaMin) {
      const { data, error } = await supabase.rpc("ponte_operacao_reservar_lancamentos", {
        p_limite_por_minuto: limitePorMinuto,
        p_ttl_horas: ttlHoras,
        p_quarentena_min: quarentenaMin,
      });
      if (error) throw new Error(`reservar: ${error.message}`);
      return (data ?? []) as PedidoRow[];
    },

    async devolverParaFila(ids) {
      if (ids.length === 0) return;
      const { error } = await supabase.from("ponte_operacao_pedidos")
        .update({ etapa: "fila_ssw", atualizado_em: new Date().toISOString() })
        .in("pedido_id", ids).eq("status", "recebido").eq("etapa", "lancando_ssw");
      if (error) throw new Error(`devolver para fila: ${error.message}`);
    },

    async cardParaLancar(cardId) {
      const { data, error } = await supabase.from("cards").select("id, nf, ctrc, state, cod_ultima_ocorrencia")
        .eq("id", cardId).maybeSingle();
      if (error) throw new Error(`card ${cardId}: ${error.message}`);
      return (data as { id: string; nf: string | null; ctrc: string | null; state: string; cod_ultima_ocorrencia: number | null } | null) ?? null;
    },

    async fatosDuplicidade(p, cardId, janelaHoras) {
      const desde = new Date(Date.now() - janelaHoras * 60 * 60_000).toISOString();
      const [outro, acao] = await Promise.all([
        supabase.from("ponte_operacao_pedidos").select("pedido_id, executado_em")
          .eq("ctrc", p.ctrc).eq("codigo_ocorrencia", p.codigo_ocorrencia).eq("status", "executado")
          .not("ocorrencia_lancada", "is", null).neq("pedido_id", p.pedido_id).gte("executado_em", desde)
          .order("executado_em", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("acoes_executadas_ssw").select("id, sucesso, iniciado_em, finalizado_em")
          .eq("card_id", cardId).eq("codigo_oc", p.codigo_ocorrencia)
          .order("iniciado_em", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (outro.error) throw new Error(`duplicidade (pedidos): ${outro.error.message}`);
      if (acao.error) throw new Error(`duplicidade (acoes_executadas_ssw): ${acao.error.message}`);
      return {
        outroPedido: (outro.data as { pedido_id: string; executado_em: string | null } | null) ?? null,
        ultimaAcao: (acao.data as { id: string; sucesso: boolean | null; iniciado_em: string; finalizado_em: string | null } | null) ?? null,
      };
    },

    codigoPermitido: (codigo) => codigoPermitido(supabase, codigo),

    async registrarAudit(a) {
      const { error } = await supabase.from("audit_log").insert({
        card_id: a.card_id,
        action_type: "lancar_ocorrencia",
        actor_type: "system",
        actor_id: "ponte-operacao",
        external_system: "ssw",
        idempotency_key: a.idempotency_key,
        request_payload: a.request_payload,
        response_payload: a.response_payload,
        status: a.status,
        external_id: a.external_id,
      });
      if (error && !/duplicate key/i.test(error.message ?? "")) throw new Error(`audit_log: ${error.message}`);
    },
  };
}
