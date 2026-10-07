// =============================================================================
// baixa-motorista-repo — I/O (Supabase) da baixa do motorista (ADR 0040). As
// decisões moram nos módulos puros (baixa-motorista-*.ts); aqui só leitura/gravação.
//
// Escritas que existem aqui, e SÓ estas:
//   - baixas_motorista (INSERT da baixa; UPDATE de status com guarda de status)
//     e as RPCs da mig 420 (reservar, expirar);
//   - audit_log: 1 linha por baixa que foi ao SSW (external_system='ssw',
//     card_id NULL — a baixa não tem card).
// NADA em cards / card_events: a baixa não tem card (exceção do ADR 0040).
// O repositório da RECEPÇÃO (POST/GET) só insere a baixa e lê listas.
// =============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { BaixaRow, NovaBaixaRow, RepoRecepcao } from "./baixa-motorista-contrato.ts";
import { CANAIS_BAIXA, type CanalBaixa } from "./lancar-ssw-baixa.ts";
import type { RepoWorkerBaixas } from "./baixa-motorista-worker.ts";

const NAO_FINAIS = ["recebido", "na_fila", "lancando"];

async function flagLigada(supabase: SupabaseClient, key: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
    if (error) return false; // fail-closed: sem ler a flag, desligado
    return (data as { enabled?: boolean } | null)?.enabled === true;
  } catch {
    return false;
  }
}

async function codigoInsucessoPermitido(supabase: SupabaseClient, codigo: number): Promise<boolean> {
  try {
    const [lista, dic] = await Promise.all([
      supabase.from("baixa_motorista_codigos").select("codigo").eq("codigo", codigo).eq("ativo", true).maybeSingle(),
      supabase.from("ocorrencias_dicionario").select("responsabilidade").eq("codigo", codigo).maybeSingle(),
    ]);
    if (lista.error || dic.error) return false;
    // Duas cercas: ATIVO na lista E da Operação no dicionário (a tabela também tem trigger).
    return !!lista.data && (dic.data as { responsabilidade?: string } | null)?.responsabilidade === "Operação";
  } catch {
    return false;
  }
}

export function criarRepoRecepcao(supabase: SupabaseClient): RepoRecepcao {
  return {
    flagLigada: (key) => flagLigada(supabase, key),
    async buscar(id) {
      const { data, error } = await supabase.from("baixas_motorista").select("*").eq("baixa_id", id).maybeSingle();
      if (error) throw new Error(`baixas_motorista: ${error.message}`);
      return (data as BaixaRow | null) ?? null;
    },
    async buscarVarias(ids) {
      const { data, error } = await supabase.from("baixas_motorista")
        .select("baixa_id, status, status_em, motivo, finalizado_em").in("baixa_id", ids);
      if (error) throw new Error(`baixas_motorista: ${error.message}`);
      return (data ?? []) as BaixaRow[];
    },
    codigoInsucessoPermitido: (c) => codigoInsucessoPermitido(supabase, c),
    async inserir(row: NovaBaixaRow) {
      const { error } = await supabase.from("baixas_motorista").insert(row);
      if (!error) return "inserido";
      if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) return "conflito";
      throw new Error(`baixas_motorista insert: ${error.message}`);
    },
  };
}

export function criarRepoWorkerBaixas(supabase: SupabaseClient): RepoWorkerBaixas {
  const agoraIso = () => new Date().toISOString();
  return {
    flagLigada: (key) => flagLigada(supabase, key),

    async canal() {
      try {
        const { data, error } = await supabase.from("baixa_motorista_config").select("canal").eq("id", true).maybeSingle();
        if (error) return null;
        const c = (data as { canal?: string | null } | null)?.canal ?? null;
        return CANAIS_BAIXA.includes(c as CanalBaixa) ? (c as CanalBaixa) : null;
      } catch {
        return null;
      }
    },

    async expirar(travadoMin) {
      const { data, error } = await supabase.rpc("baixa_motorista_expirar", { p_travado_min: travadoMin });
      if (error) throw new Error(`baixa_motorista_expirar: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },

    async paraPreparar(limite) {
      const { data, error } = await supabase.from("baixas_motorista").select("*")
        .eq("status", "recebido").order("seq", { ascending: true }).limit(limite);
      if (error) throw new Error(`baixas_motorista: ${error.message}`);
      return (data ?? []) as BaixaRow[];
    },

    async noPiloto(base, motoristaId) {
      try {
        const { data, error } = await supabase.from("baixa_motorista_piloto")
          .select("base, motorista_id").eq("ativo", true);
        if (error || !Array.isArray(data)) return false;
        return (data as Array<{ base: string | null; motorista_id: string | null }>).some((p) =>
          (p.base === null || p.base === base) && (p.motorista_id === null || p.motorista_id === motoristaId)
        );
      } catch {
        return false;
      }
    },

    codigoInsucessoPermitido: (c) => codigoInsucessoPermitido(supabase, c),

    async marcarNaFila(id) {
      const agora = agoraIso();
      const { error } = await supabase.from("baixas_motorista")
        .update({ status: "na_fila", status_em: agora, atualizado_em: agora })
        .eq("baixa_id", id).eq("status", "recebido");
      if (error) throw new Error(`marcarNaFila: ${error.message}`);
    },

    async finalizar(id, f) {
      const agora = agoraIso();
      const { error } = await supabase.from("baixas_motorista")
        .update({
          status: f.status,
          categoria: f.categoria,
          motivo: f.motivo.slice(0, 1000),
          protocolo: f.protocolo ?? null,
          canal: f.canal ?? null,
          finalizado_em: agora,
          status_em: agora,
          atualizado_em: agora,
        })
        .eq("baixa_id", id).in("status", NAO_FINAIS);
      if (error) throw new Error(`finalizar: ${error.message}`);
    },

    async reservar(limitePorMinuto, quarentenaMin) {
      const { data, error } = await supabase.rpc("baixa_motorista_reservar", {
        p_limite_por_minuto: limitePorMinuto,
        p_quarentena_min: quarentenaMin,
      });
      if (error) throw new Error(`baixa_motorista_reservar: ${error.message}`);
      return (data ?? []) as BaixaRow[];
    },

    async devolverParaFila(id, d) {
      const agora = agoraIso();
      const { data: atual, error: e1 } = await supabase.from("baixas_motorista")
        .select("tentativas").eq("baixa_id", id).maybeSingle();
      if (e1) throw new Error(`devolverParaFila: ${e1.message}`);
      const tentativas = Number((atual as { tentativas?: number } | null)?.tentativas ?? 0) + (d.contarTentativa ? 1 : 0);
      const { error } = await supabase.from("baixas_motorista")
        .update({
          status: "na_fila",
          tentativas,
          ultima_categoria: d.categoria,
          ultima_falha_em: agora,
          motivo: d.motivo.slice(0, 1000),
          status_em: agora,
          atualizado_em: agora,
        })
        .eq("baixa_id", id).eq("status", "lancando");
      if (error) throw new Error(`devolverParaFila: ${error.message}`);
    },

    async relacionamentoExecutandoNoCtrc(ctrc) {
      const { count, error } = await supabase.from("cards").select("id", { count: "exact", head: true })
        .eq("ctrc", ctrc).eq("state", "EXECUTANDO_ACAO");
      if (error) throw new Error(`cards: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async duplicidade(b) {
      const [feita, voo] = await Promise.all([
        supabase.from("baixas_motorista").select("baixa_id")
          .eq("ctrc", b.ctrc).eq("tipo", "entrega").in("status", ["executado", "ja_no_ssw"])
          .neq("baixa_id", b.baixa_id).limit(1).maybeSingle(),
        // Só as reservadas ANTES desta (outra rodada ainda lançando). As irmãs da
        // mesma reserva (mesmo reservado_em) seguem em série nesta rodada.
        b.reservado_em
          ? supabase.from("baixas_motorista").select("baixa_id")
            .eq("ctrc", b.ctrc).eq("status", "lancando").lt("reservado_em", b.reservado_em)
            .neq("baixa_id", b.baixa_id).limit(1).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (feita.error) throw new Error(`duplicidade: ${feita.error.message}`);
      if (voo.error) throw new Error(`duplicidade: ${voo.error.message}`);
      return {
        entregaFeitaPor: (feita.data as { baixa_id?: string } | null)?.baixa_id ?? null,
        emVooPor: (voo.data as { baixa_id?: string } | null)?.baixa_id ?? null,
      };
    },

    async registrarAudit(a) {
      const { error } = await supabase.from("audit_log").insert({
        card_id: null,
        action_type: "lancar_ocorrencia",
        actor_type: "system",
        actor_id: "baixa-motorista",
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
