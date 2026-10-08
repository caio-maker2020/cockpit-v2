// =============================================================================
// lancar-ssw-portal-operacao — o envelope do SSW para a área de Operação (ADR 0041, D7).
//
// A Operação lança em CTRC SEM card ativo (a nota com tratativa aberta nem entra na
// fila dela), então o envelope do Relacionamento (`lancarSswPortal`, que exige um
// card e grava em acoes_executadas_ssw por card) não serve como está — e ele NÃO
// é tocado: zero diff, pinado byte a byte em ponte-operacao-flags-off.test.ts.
// Este envelope COMPÕE as mesmas peças, na mesma ordem, com as mesmas garantias:
//
//   1. Cercas ANTES de consumir a chave de idempotência (recusa não pode queimar a
//      chave, senão o relançamento correto cairia em skip — mesmo motivo da parede
//      da 44 no envelope do Relacionamento):
//        - código proibido para a Operação (49/54/59/33/44/6/9/16) → recusa;
//        - 41 e 56 sem o texto do operador → recusa (INV-046, camada 2).
//   2. Idempotência: INSERT em op_acoes_executadas_ssw com UNIQUE(op_item_id,
//      codigo_oc, ctrc) ANTES do SSW. Hit com sucesso=true → decide pela MESMA
//      função do Relacionamento (`decidirIdempotenciaRelancamento`): skip se
//      recente, se a leitura do SSW falhou ou se a oc já está no topo; senão
//      relança. sucesso=null → outro em voo, aborta. sucesso=false → retry.
//   3. Sessão SEMPRE pela conta de serviço `ai.salex` (`readSswLancamentoEnv`,
//      INV-013). Nunca por operador.
//   4. Tripé inviolável (`validarTripeCtrcNfPagador`) dentro do
//      `lancarOcorrenciaPortal`, com o HTML do act=O, ANTES do submit. A Operação
//      NUNCA dispensa a checagem de localização (sem `permitirLocalizacaoBaixada`).
//   5. Body latin-1, Instrução ≤ 500 — feito pelo próprio `lancarOcorrenciaPortal`.
// =============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { decidirIdempotenciaRelancamento } from "./lancar-ssw-portal.ts";
import {
  buscarNFInterno,
  descobrirUltimaOcSsw,
  lancarOcorrenciaPortal,
  obterSessao,
  readSswLancamentoEnv,
} from "./ssw-internal-client.ts";
import { validarTripeCtrcNfPagador } from "./validar-tripe-ssw.ts";
import { OCS_PROIBIDAS_OPERACAO, OCS_TEXTO_OBRIGATORIO_OPERACAO, TEXTO_OBRIGATORIO_MIN } from "./operacao-comum.ts";

export const SSW_INSTRUCAO_MAXLEN = 500;

export type CategoriaFalhaOperacao =
  | "guard_codigo"
  | "texto_obrigatorio"
  | "guard_tripe"
  | "ssw_erro"
  | "sessao_invalida"
  | "db_erro"
  | "outro";

export type LancarSswPortalOperacaoResult =
  | { ok: true; protocolo: string; idempotent_skip: boolean; acao_id: string }
  | { ok: false; error: string; categoria: CategoriaFalhaOperacao; acao_id?: string };

/** Linha de op_acoes_executadas_ssw que o envelope lê de volta no conflito. */
export interface AcaoOpExistente {
  id: string;
  sucesso: boolean | null;
  finalizado_em: string | null;
}

/** Acesso a op_acoes_executadas_ssw (injetável: deno test usa memória). */
export interface RepoAcoesOperacao {
  /** INSERT; "conflito" quando bate no UNIQUE(op_item_id, codigo_oc, ctrc). */
  inserir(a: { op_item_id: string; op_lancamento_id: string; codigo_oc: number; ctrc: string; nf: string }):
    Promise<{ id: string } | "conflito" | { erro: string }>;
  existente(a: { op_item_id: string; codigo_oc: number; ctrc: string }): Promise<AcaoOpExistente | null>;
  apagar(id: string): Promise<void>;
  finalizar(id: string, r: { sucesso: boolean; motivo_erro?: string | null; excerpt?: string | null; protocolo?: string | null }): Promise<void>;
}

/** As peças do SSW (injetáveis). Padrão = as do ssw-internal-client, as mesmas do Relacionamento. */
export interface PecasSsw {
  readSswLancamentoEnv: typeof readSswLancamentoEnv;
  obterSessao: typeof obterSessao;
  buscarNFInterno: typeof buscarNFInterno;
  lancarOcorrenciaPortal: typeof lancarOcorrenciaPortal;
  descobrirUltimaOcSsw: typeof descobrirUltimaOcSsw;
  validarTripeCtrcNfPagador: typeof validarTripeCtrcNfPagador;
  agoraMs: () => number;
}

export const PECAS_SSW_REAIS: PecasSsw = {
  readSswLancamentoEnv,
  obterSessao,
  buscarNFInterno,
  lancarOcorrenciaPortal,
  descobrirUltimaOcSsw,
  validarTripeCtrcNfPagador,
  agoraMs: () => Date.now(),
};

export interface LancarSswPortalOperacaoArgs {
  env: Record<string, string | undefined>;
  repo: RepoAcoesOperacao;
  /** O item da fila. CTRC e NF vêm DELE (gravados pelo materializador a partir do Bastão). */
  item: { id: string; ctrc: string; nf: string };
  lancamentoId: string;
  codigoSsw: number;
  /** O que a PESSOA escreveu (INV-046: 41/56 exigem). */
  textoOperador: string;
  /** O que vai na Instrução do SSW (texto + origem). Cortado em 500. */
  textoSsw: string;
  pecas?: PecasSsw;
}

/** Pura: cercas antes da idempotência. null = pode seguir. */
export function cercaAntesDoSsw(codigo: number, textoOperador: string): { categoria: CategoriaFalhaOperacao; motivo: string } | null {
  if (!Number.isInteger(codigo) || codigo < 1 || codigo > 999) {
    return { categoria: "guard_codigo", motivo: `código inválido: ${codigo}` };
  }
  if (OCS_PROIBIDAS_OPERACAO.has(codigo)) {
    return { categoria: "guard_codigo", motivo: `a oc ${codigo} nunca é lançada pela Operação` };
  }
  if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(codigo) && (textoOperador ?? "").trim().length < TEXTO_OBRIGATORIO_MIN) {
    return { categoria: "texto_obrigatorio", motivo: `a oc ${codigo} exige o texto do operador (INV-046); nada foi enviado ao SSW` };
  }
  return null;
}

export async function lancarSswPortalOperacao(args: LancarSswPortalOperacaoArgs): Promise<LancarSswPortalOperacaoResult> {
  const p = args.pecas ?? PECAS_SSW_REAIS;
  const { repo, item, codigoSsw } = args;
  if (!item.ctrc || !item.nf) {
    return { ok: false, error: `item ${item.id} sem CTRC ou sem NF — impossível validar o tripé`, categoria: "db_erro" };
  }
  const cerca = cercaAntesDoSsw(codigoSsw, args.textoOperador);
  if (cerca) return { ok: false, error: cerca.motivo, categoria: cerca.categoria };

  // ─── 1. idempotência ─────────────────────────────────────────────────────
  let acaoId: string;
  const chave = { op_item_id: item.id, codigo_oc: codigoSsw, ctrc: item.ctrc };
  const ins = await repo.inserir({ ...chave, op_lancamento_id: args.lancamentoId, nf: item.nf });
  if (ins === "conflito") {
    const ex = await repo.existente(chave);
    if (!ex) return { ok: false, error: "UNIQUE em conflito mas a linha não foi achada", categoria: "db_erro" };
    if (ex.sucesso === null) {
      return { ok: false, error: `acao ${ex.id} em voo (sucesso=null); não lança por cima`, categoria: "db_erro", acao_id: ex.id };
    }
    if (ex.sucesso === true) {
      const verdade = await p.descobrirUltimaOcSsw(item.nf, item.ctrc, args.env);
      const decisao = decidirIdempotenciaRelancamento({
        finalizadoEm: ex.finalizado_em,
        agoraMs: p.agoraMs(),
        leituraOk: verdade.sucesso === true,
        ocAtualSsw: verdade.sucesso ? verdade.oc : null,
        codigoSsw,
      });
      if (decisao === "skip") {
        return { ok: true, protocolo: `idempotent_skip (acao=${ex.id})`, idempotent_skip: true, acao_id: ex.id };
      }
    }
    await repo.apagar(ex.id);
    const retry = await repo.inserir({ ...chave, op_lancamento_id: args.lancamentoId, nf: item.nf });
    if (retry === "conflito" || "erro" in retry) {
      return { ok: false, error: `retry do INSERT de idempotência falhou: ${retry === "conflito" ? "conflito" : retry.erro}`, categoria: "db_erro" };
    }
    acaoId = retry.id;
  } else if ("erro" in ins) {
    return { ok: false, error: `INSERT op_acoes_executadas_ssw: ${ins.erro}`, categoria: "db_erro" };
  } else {
    acaoId = ins.id;
  }

  const falhar = async (categoria: CategoriaFalhaOperacao, motivo: string, excerpt?: string): Promise<LancarSswPortalOperacaoResult> => {
    await repo.finalizar(acaoId, { sucesso: false, motivo_erro: motivo.slice(0, 1000), excerpt: excerpt?.slice(0, 500) ?? null });
    return { ok: false, error: motivo, categoria, acao_id: acaoId };
  };

  // ─── 2. sessão pela conta de serviço (INV-013) ───────────────────────────
  let sessao;
  try {
    sessao = await p.obterSessao(p.readSswLancamentoEnv(args.env));
  } catch (e) {
    return await falhar("sessao_invalida", `Falha ao abrir sessão SSW: ${e instanceof Error ? e.message : String(e)}`);
  }
  let detalhe;
  try {
    detalhe = await p.buscarNFInterno(sessao, item.nf, { ctrcEsperado: item.ctrc });
  } catch (e) {
    return await falhar("ssw_erro", `buscarNFInterno falhou: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ─── 3. lançamento com o tripé injetado (nunca dispensado) ───────────────
  const r = await p.lancarOcorrenciaPortal(sessao, detalhe, {
    codigoSsw,
    texto: args.textoSsw.slice(0, SSW_INSTRUCAO_MAXLEN),
    validarAntesDoSubmit: (htmlO: string) => {
      const v = p.validarTripeCtrcNfPagador({ cardCtrc: item.ctrc, cardNf: item.nf, htmlAtoO: htmlO });
      return Promise.resolve(v.ok ? { ok: true as const } : { ok: false as const, motivo: v.motivo, detalhe: v.detalhe });
    },
  });
  if (!r.ok) {
    if (r.bloqueado_por_guard) {
      return await falhar("guard_tripe", `bloqueado_por_guard: ${r.bloqueado_por_guard.detalhe}`, r.raw_response_snippet);
    }
    return await falhar("ssw_erro", r.error, r.raw_response_snippet);
  }
  await repo.finalizar(acaoId, { sucesso: true, excerpt: r.raw_response_snippet.slice(0, 500), protocolo: r.seq_oc });
  return { ok: true, protocolo: r.seq_oc, idempotent_skip: false, acao_id: acaoId };
}

/** Adaptador real de op_acoes_executadas_ssw (service_role). */
export function criarRepoAcoesOperacao(supabase: SupabaseClient): RepoAcoesOperacao {
  return {
    async inserir(a) {
      const { data, error } = await supabase.from("op_acoes_executadas_ssw").insert(a).select("id").maybeSingle();
      if (error) {
        const unico = error.code === "23505" || /duplicate key|unique constraint/i.test(error.message ?? "");
        return unico ? "conflito" : { erro: error.message };
      }
      return data ? { id: data.id as string } : { erro: "INSERT sem linha" };
    },
    async existente(a) {
      const { data } = await supabase
        .from("op_acoes_executadas_ssw")
        .select("id, sucesso, finalizado_em")
        .eq("op_item_id", a.op_item_id)
        .eq("codigo_oc", a.codigo_oc)
        .eq("ctrc", a.ctrc)
        .maybeSingle();
      return (data as AcaoOpExistente | null) ?? null;
    },
    async apagar(id) {
      await supabase.from("op_acoes_executadas_ssw").delete().eq("id", id);
    },
    async finalizar(id, r) {
      await supabase.from("op_acoes_executadas_ssw").update({
        sucesso: r.sucesso,
        finalizado_em: new Date().toISOString(),
        motivo_erro: r.motivo_erro ?? null,
        portal_response_excerpt: r.excerpt ?? null,
        protocolo: r.protocolo ?? null,
      }).eq("id", id);
    },
  };
}

/**
 * Leitura da última oc para CONFIRMAR um lançamento (nunca para decidir lançar).
 * Mesma `descobrirUltimaOcSsw` do Relacionamento — que já resolve a conta de
 * serviço (SSW_LANCAMENTO_*, INV-063). Fica aqui para o worker não importar o
 * cliente SSW direto: a única porta da Operação para o SSW é este arquivo.
 */
export async function lerUltimaOcOperacao(
  nf: string,
  ctrc: string,
  env: Record<string, string | undefined>,
  pecas: Pick<PecasSsw, "descobrirUltimaOcSsw"> = PECAS_SSW_REAIS,
) {
  return await pecas.descobrirUltimaOcSsw(nf, ctrc, env);
}
