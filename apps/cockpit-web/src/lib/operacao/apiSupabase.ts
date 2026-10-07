// OpApi de verdade: as RPCs e a view do ADR 0041 (migs 430–433).
import { supabase } from "@/lib/supabase";
import { falhaDeComunicacao, type OpApi } from "./api";
import type {
  OpCodigo,
  OpFilaLinha,
  OpRespostaAssumir,
  OpRespostaCancelar,
  OpRespostaDesfazerEncaminhamento,
  OpRespostaEncaminhamentos,
  OpRespostaEncaminhar,
  OpRespostaPreviaEncaminhamento,
  OpRespostaDetalhe,
  OpRespostaPrevia,
  OpRespostaSolicitar,
  OpSessao,
} from "./tipos";

/** Teto de linhas por leitura (max_rows do PostgREST). A tela avisa quando bate. */
export const LIMITE_FILA = 1000;

async function rpcJson<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return falhaDeComunicacao(error.message) as T;
  if (data == null) return falhaDeComunicacao("resposta vazia do servidor") as T;
  return data as T;
}

export function criarOpApiSupabase(): OpApi {
  return {
    modo: "supabase",

    async minhaSessao() {
      const { data, error } = await supabase.rpc("op_minha_sessao");
      if (error) {
        // Fail-open: sem a mig 430 (ou com a RPC fechada) ninguém vira "da Operação".
        console.warn("[operacao] op_minha_sessao indisponível:", error.message);
        return null;
      }
      return (data ?? null) as OpSessao | null;
    },

    async fila() {
      const { data, error } = await supabase
        .from("op_v_fila")
        .select("*")
        .order("data_ultima_ocorrencia", { ascending: true, nullsFirst: false })
        .limit(LIMITE_FILA);
      if (error) throw new Error(error.message);
      return (data ?? []) as OpFilaLinha[];
    },

    itemDetalhe(opItemId) {
      return rpcJson<OpRespostaDetalhe>("op_item_detalhe", { p_op_item_id: opItemId });
    },

    async codigosDisponiveis() {
      const { data, error } = await supabase.rpc("op_codigos_disponiveis");
      if (error) throw new Error(error.message);
      return (data ?? []) as OpCodigo[];
    },

    assumir(opItemId, forcar = false) {
      return rpcJson<OpRespostaAssumir>("op_assumir", { p_op_item_id: opItemId, p_forcar: forcar });
    },

    previa(opItemId, codigoOc, texto) {
      return rpcJson<OpRespostaPrevia>("op_previa_lancamento", {
        p_op_item_id: opItemId,
        p_codigo_oc: codigoOc,
        p_texto: texto,
      });
    },

    solicitar(opItemId, codigoOc, texto, confirmacao) {
      return rpcJson<OpRespostaSolicitar>("op_solicitar_lancamento", {
        p_op_item_id: opItemId,
        p_codigo_oc: codigoOc,
        p_texto: texto,
        p_confirmacao: confirmacao,
      });
    },

    aceitarSugestao(opItemId, confirmacao) {
      return rpcJson<OpRespostaSolicitar>("op_aceitar_sugestao", {
        p_op_item_id: opItemId,
        p_confirmacao: confirmacao,
      });
    },

    cancelar(lancamentoId) {
      return rpcJson<OpRespostaCancelar>("op_cancelar_lancamento", { p_lancamento_id: lancamentoId });
    },

    previaEncaminhamento(opItemId, texto) {
      return rpcJson<OpRespostaPreviaEncaminhamento>("op_previa_encaminhamento", { p_op_item_id: opItemId, p_texto: texto });
    },

    encaminhar(opItemId, texto, confirmacao) {
      return rpcJson<OpRespostaEncaminhar>("op_encaminhar_relacionamento", {
        p_op_item_id: opItemId,
        p_texto: texto,
        p_confirmacao: confirmacao,
      });
    },

    desfazerEncaminhamento(encaminhamentoId) {
      return rpcJson<OpRespostaDesfazerEncaminhamento>("op_desfazer_encaminhamento", { p_encaminhamento_id: encaminhamentoId });
    },

    encaminhamentosDoItem(opItemId) {
      return rpcJson<OpRespostaEncaminhamentos>("op_encaminhamentos_do_item", { p_op_item_id: opItemId });
    },
  };
}
