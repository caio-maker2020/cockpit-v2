// =============================================================================
// operacao-repo — adaptadores Supabase (service_role) da área de Operação (ADR 0041).
// Fino de propósito: toda decisão está nas funções puras (operacao-materializar,
// operacao-lancamentos-worker) e nas RPCs da mig 430. Aqui só há leitura/escrita.
// =============================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { normalizarCtrcOp, STATES_TERMINAIS_CARD } from "./operacao-comum.ts";
import type { ItemAberto, RegraUnidade, RepoMaterializacao } from "./operacao-materializar.ts";
import type { CercaNaHora, LancamentoRow, RepoLancamentosOp } from "./operacao-lancamentos-worker.ts";

const PAGINA = 1000;

async function flag(supabase: SupabaseClient, key: string): Promise<boolean> {
  const { data, error } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
  if (error) throw new Error(`feature_flags ${key}: ${error.message}`);
  return data?.enabled === true;
}

/** Lê todas as páginas de um select (Range). Lança em erro. */
async function todasAsPaginas<T>(montar: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await montar(de, de + PAGINA - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGINA) break;
    if (de > 200_000) throw new Error("paginação passou de 200 mil linhas");
  }
  return out;
}

export function criarRepoMaterializacao(supabase: SupabaseClient): RepoMaterializacao {
  return {
    flagLigada: (key) => flag(supabase, key),
    async codigosOperacao() {
      const { data, error } = await supabase.from("ocorrencias_dicionario").select("codigo").eq("responsabilidade", "Operação");
      if (error) throw new Error(`ocorrencias_dicionario: ${error.message}`);
      return (data ?? []).map((r) => Number(r.codigo)).filter(Number.isInteger);
    },
    async ctrcsComCardAtivo() {
      const linhas = await todasAsPaginas<{ ctrc: string | null }>((de, ate) =>
        supabase.from("cards").select("ctrc")
          .not("ctrc", "is", null)
          .not("state", "in", `(${STATES_TERMINAIS_CARD.join(",")})`)
          .order("id").range(de, ate)
      );
      const s = new Set<string>();
      for (const l of linhas) {
        const c = normalizarCtrcOp(l.ctrc);
        if (c) s.add(c);
      }
      return s;
    },
    async itensAbertos() {
      const itens = await todasAsPaginas<{ id: string; ctrc: string; snapshot_hash: string | null }>((de, ate) =>
        supabase.from("op_itens").select("id, ctrc, snapshot_hash").neq("status", "encerrado").order("id").range(de, ate)
      );
      const lancs = await todasAsPaginas<{ id: string; op_item_id: string; codigo_oc: number; status: "fila" | "lancando" | "lancado" }>((de, ate) =>
        supabase.from("op_lancamentos").select("id, op_item_id, codigo_oc, status")
          .in("status", ["fila", "lancando", "lancado"]).order("id").range(de, ate)
      );
      const porItem = new Map(lancs.map((l) => [l.op_item_id, l]));
      return itens.map((i): ItemAberto => {
        const l = porItem.get(i.id);
        return { id: i.id, ctrc: i.ctrc, snapshot_hash: i.snapshot_hash, lancamento_ativo: l ? { id: l.id, codigo_oc: l.codigo_oc, status: l.status } : null };
      });
    },
    async encerradosPorCtrc24h() {
      const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
      const linhas = await todasAsPaginas<{ ctrc: string }>((de, ate) =>
        supabase.from("op_itens").select("ctrc").eq("status", "encerrado").gte("created_at", desde).order("id").range(de, ate)
      );
      const m = new Map<string, number>();
      for (const l of linhas) m.set(l.ctrc, (m.get(l.ctrc) ?? 0) + 1);
      return m;
    },
    async regrasUnidade() {
      const { data, error } = await supabase.from("op_regra_unidade_por_oc").select("codigo_oc, campo_bastao, prioridade, ativo").eq("ativo", true);
      if (error) throw new Error(`op_regra_unidade_por_oc: ${error.message}`);
      return (data ?? []) as RegraUnidade[];
    },
    async codigosLancaveisAtivos() {
      const { data, error } = await supabase.from("op_codigos_lancaveis").select("codigo").eq("ativo", true);
      if (error) throw new Error(`op_codigos_lancaveis: ${error.message}`);
      return new Set((data ?? []).map((r) => Number(r.codigo)));
    },
    async aplicar(lote) {
      const { data, error } = await supabase.rpc("op_materializar_aplicar", {
        p_upserts: lote.upserts,
        p_encerrar: lote.encerrar,
        p_confirmar: lote.confirmar,
        p_bloqueados: lote.bloqueados,
      });
      if (error) throw new Error(`op_materializar_aplicar: ${error.message}`);
      return (data ?? {}) as Record<string, number>;
    },
    async registrarRodada(r) {
      await supabase.from("op_materializacoes").insert({
        iniciado_em: r.iniciadoEm, finalizado_em: new Date().toISOString(), ok: r.ok, resumo: r.resumo,
      });
    },
  };
}

export function criarRepoLancamentosOp(supabase: SupabaseClient): RepoLancamentosOp {
  return {
    flagLigada: (key) => flag(supabase, key),
    async expirar(ttlHoras, travadoMin) {
      const { data, error } = await supabase.rpc("op_expirar_lancamentos", { p_ttl_horas: ttlHoras, p_travado_min: travadoMin });
      if (error) throw new Error(`op_expirar_lancamentos: ${error.message}`);
      return Number(data ?? 0);
    },
    async reservar(limite, ttl, quarentena) {
      const { data, error } = await supabase.rpc("op_reservar_lancamentos", {
        p_limite_por_minuto: limite, p_ttl_horas: ttl, p_quarentena_min: quarentena,
      });
      if (error) throw new Error(`op_reservar_lancamentos: ${error.message}`);
      return (data ?? []) as LancamentoRow[];
    },
    async devolverParaFila(ids) {
      const { error } = await supabase.rpc("op_devolver_para_fila", { p_ids: ids });
      if (error) throw new Error(`op_devolver_para_fila: ${error.message}`);
    },
    async cercaNaHora(l) {
      const { data, error } = await supabase.rpc("op_cerca_na_hora", { p_lancamento_id: l.id });
      if (error) throw new Error(`op_cerca_na_hora: ${error.message}`);
      const d = (data ?? {}) as Record<string, unknown>;
      // Sem resposta = trata como cerca FECHADA (não lança).
      return {
        cardAtivo: d.card_ativo !== false,
        codigoAtivo: d.codigo_ativo === true,
        itemAberto: d.item_aberto === true,
        nfItem: (d.nf_item as string | null) ?? null,
      } satisfies CercaNaHora;
    },
    async finalizar(id, r) {
      const { data, error } = await supabase.rpc("op_finalizar_lancamento", {
        p_id: id, p_status: r.status, p_detalhe: r.detalhe, p_categoria: r.categoria,
        p_acao_ssw_id: r.acaoSswId, p_protocolo: r.protocolo,
      });
      if (error) throw new Error(`op_finalizar_lancamento: ${error.message}`);
      return data === true;
    },
    async aConfirmar(timeoutMin, limite) {
      const { data, error } = await supabase.rpc("op_lancamentos_a_confirmar", { p_timeout_min: timeoutMin, p_limite: limite });
      if (error) throw new Error(`op_lancamentos_a_confirmar: ${error.message}`);
      return (data ?? []) as LancamentoRow[];
    },
    async registrarConfirmacao(id, r) {
      const { error } = await supabase.rpc("op_registrar_confirmacao", {
        p_id: id, p_resultado: r.resultado, p_oc_vista: r.ocVista, p_detalhe: r.detalhe, p_por: "ssw",
      });
      if (error) throw new Error(`op_registrar_confirmacao: ${error.message}`);
    },
  };
}

/**
 * Gate "só service_role" por CAPACIDADE (mesma ideia de _shared/service-auth.ts):
 * o token do chamador tenta a RPC op_vigia_resumo, que a mig 430 concede SÓ ao
 * service_role. Usuário logado (Operação ou Relacionamento) e anon recebem
 * permission denied. Não depende da mig 431 (o probe do service-auth.ts usa uma
 * RPC que só a 431 fecha de verdade — ver docs/OPERACAO-SEPARACAO-RLS.md).
 */
export async function ehServiceRoleOperacao(
  supabaseUrl: string,
  authHeader: string | null,
  criar: typeof createClient = createClient,
): Promise<boolean> {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const probe = criar(supabaseUrl, token, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await probe.rpc("op_vigia_resumo");
    return !error;
  } catch {
    return false;
  }
}
