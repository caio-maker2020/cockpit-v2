// =============================================================================
// lancar-ssw-portal.ts — envelope unificado pra lançar ocorrência via portal
// interno SSW (opção 101) com idempotência + guard inviolável.
//
// Caio 2026-06-08: substitui o caminho WebAPI `ssw.lancarOcorrencia` (que
// dependia de chave_cte 44 dígitos + tabela nf_chave_cte + RPA OPC 455).
// Agora TUDO via portal interno — chave_cte e RPA serão deprecados.
//
// Garantias do envelope (acima do que `lancarOcorrenciaPortal` cru oferece):
//
//   1. **Idempotência via tabela `acoes_executadas_ssw`** (mig 194):
//      - INSERT antes do submit (status=null). UNIQUE(card_id, codigo_oc, ctrc)
//        impede duplicação. Se já existe com sucesso=true → idempotent_skip.
//      - Se já existe com sucesso=false → retry permitido (limpa linha antiga).
//      - Atualiza linha com sucesso/motivo_erro/portal_response_excerpt pós.
//
//   2. **Guard tripé inviolável** (`validarTripeCtrcNfPagador`):
//      - Antes do submit, valida CTRC + NF + Localização do CTRC no SSW.
//      - Substitui o `validarChaveCteCorrespondeCtrcDoCard` (que dependia de
//        nf_chave_cte).
//      - Falha do guard NÃO retenta — espera intervenção humana.
//
//   3. **Sessão SSW por operador** via `loadSswInternalEnvForCard`.
//      Multi-operador já testado em produção.
//
// API igual ao retorno antigo do WebAPI pra callers (executor) não precisarem
// mudar tipos — { ok, error?, protocolo? }.
// =============================================================================

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  lancarOcorrenciaPortal,
  loadSswInternalEnvForCard,
  obterSessao,
  type AnexoBytes,
} from "./ssw-internal-client.ts";
import { validarTripeCtrcNfPagador } from "./validar-tripe-ssw.ts";

export interface LancarSswPortalArgs {
  /** Service-role client. Envelope precisa pra acoes_executadas_ssw + secrets SSW. */
  supabase: SupabaseClient;
  /** env Deno (Deno.env.toObject()) — pra resolver SSW_INTERNAL_<OPERADOR>_*. */
  env: Record<string, string | undefined>;
  /** Card alvo. Precisa { id, nf, ctrc } no mínimo. */
  card: { id: string; nf: string; ctrc: string };
  /** OC semântica a lançar (21, 33, 44, 49, 54, etc.) — SEM remap dexpara. */
  codigoSsw: number;
  /** Texto livre que vai no campo `Instrução` (textarea, máx 500 chars). */
  texto?: string;
  /** Anexos opcionais (JPEG/PDF). Vetor vazio = sem upload no portal. */
  imagens?: AnexoBytes[];
  /** Vincula ao todo que disparou (auditoria). */
  todoId?: string;
  /**
   * Caio 2026-06-11: override humano explícito da checagem (c) do guard
   * (localização "CTRC encerrado"). Quando true, permite lançar oc em CTRC
   * baixado por DEVOLUÇÃO (oc=30) cuja tratativa de ressarcimento ainda exige
   * relacionamento (ex: oc=54 pedir romaneio). NÃO afeta CTRC/NF (a/b).
   * Origem: extras.forcar_lancamento_ctrc_baixado marcado pela operadora.
   * Caso âncora NF 919611. Lançamento forçado gera card_event auditável.
   */
  permitirLocalizacaoBaixada?: boolean;
}

export type LancarSswPortalResult =
  | {
      ok: true;
      /** SSW não retorna seq_oc estável — usamos string descritiva. */
      protocolo: string;
      /** True quando hit no UNIQUE → não chamou SSW (já executado antes). */
      idempotent_skip: boolean;
      acao_id: string;
    }
  | {
      ok: false;
      error: string;
      /** Categoria pra logging/alerta. */
      categoria:
        | "guard_tripe"
        | "ssw_erro"
        | "sessao_invalida"
        | "db_erro"
        | "parse_falhou"
        | "outro";
      acao_id?: string;
      detalhe?: Record<string, unknown>;
    };

export async function lancarSswPortal(
  args: LancarSswPortalArgs,
): Promise<LancarSswPortalResult> {
  const { supabase, env, card, codigoSsw, texto, imagens, todoId, permitirLocalizacaoBaixada } = args;
  // Captura, fora do callback, se o guard foi forçado (localização baixada)
  // pra registrar card_event auditável depois do submit bem-sucedido.
  let localizacaoForcada: { keyword?: string; localizacao: string } | null = null;

  if (!card.ctrc) {
    return {
      ok: false,
      error: `card ${card.id} sem ctrc — impossível validar tripé`,
      categoria: "db_erro",
    };
  }

  // ─── Step 1: idempotência via INSERT em acoes_executadas_ssw ───────────────
  //
  // INSERT direto. Se UNIQUE conflitar, checa o estado da linha existente:
  //   - sucesso=true  → idempotent_skip (já executado, retorna OK sem SSW)
  //   - sucesso=false → permite retry: deleta linha antiga e re-tenta INSERT
  //   - sucesso=null  → outro processo em voo. Aborta com erro defensivo.
  let acaoId: string | null = null;
  {
    const { data: inserted, error: insErr } = await supabase
      .from("acoes_executadas_ssw")
      .insert({
        card_id: card.id,
        codigo_oc: codigoSsw,
        ctrc: card.ctrc,
        todo_id: todoId ?? null,
      })
      .select("id")
      .maybeSingle();

    if (insErr) {
      // Verifica se é conflito UNIQUE (PG 23505). PostgREST retorna .code === '23505'
      // ou message contém "duplicate key value".
      const isUnique =
        insErr.code === "23505" ||
        /duplicate key|unique constraint/i.test(insErr.message ?? "");
      if (!isUnique) {
        return {
          ok: false,
          error: `db_erro INSERT acoes_executadas_ssw: ${insErr.message}`,
          categoria: "db_erro",
        };
      }
      // Conflito UNIQUE → buscar linha existente e decidir.
      // Caio 2026-06-15 (mig 202): a chave agora inclui `todo_id`, então o
      // conflito só acontece pro MESMO todo (PGMQ redelivery / duplo-clique).
      // O SELECT precisa filtrar por todo_id pra achar EXATAMENTE a linha
      // conflitante (senão `.maybeSingle()` quebra quando o card já tem
      // lançamentos da mesma oc/ctrc em ciclos anteriores, com todos distintos).
      let existenteQuery = supabase
        .from("acoes_executadas_ssw")
        .select("id, sucesso, finalizado_em")
        .eq("card_id", card.id)
        .eq("codigo_oc", codigoSsw)
        .eq("ctrc", card.ctrc);
      existenteQuery = todoId
        ? existenteQuery.eq("todo_id", todoId)
        : existenteQuery.is("todo_id", null);
      const { data: existente } = await existenteQuery.maybeSingle();

      if (!existente) {
        return {
          ok: false,
          error:
            "UNIQUE conflict mas SELECT subsequente não achou linha — race condition?",
          categoria: "db_erro",
        };
      }
      if (existente.sucesso === true) {
        return {
          ok: true,
          protocolo: `idempotent_skip (acao=${existente.id})`,
          idempotent_skip: true,
          acao_id: existente.id as string,
        };
      }
      if (existente.sucesso === null) {
        return {
          ok: false,
          error:
            `acao_id=${existente.id} em voo (sucesso=null). Outro processo lançando. ` +
            `Aborta defensivamente — PGMQ vai retentar se for o caso.`,
          categoria: "db_erro",
          acao_id: existente.id as string,
        };
      }
      // sucesso=false → permite retry. Apaga linha antiga e re-insere.
      await supabase
        .from("acoes_executadas_ssw")
        .delete()
        .eq("id", existente.id);

      const { data: retry, error: retryErr } = await supabase
        .from("acoes_executadas_ssw")
        .insert({
          card_id: card.id,
          codigo_oc: codigoSsw,
          ctrc: card.ctrc,
          todo_id: todoId ?? null,
        })
        .select("id")
        .maybeSingle();
      if (retryErr || !retry) {
        return {
          ok: false,
          error: `db_erro retry INSERT: ${retryErr?.message ?? "no row"}`,
          categoria: "db_erro",
        };
      }
      acaoId = retry.id as string;
    } else {
      acaoId = inserted!.id as string;
    }
  }

  // A partir daqui, acaoId está populado. TODO erro deve fazer UPDATE
  // finalizando a linha com sucesso=false.
  const finalizarComErro = async (
    categoria: LancarSswPortalResult extends { ok: false; categoria: infer C }
      ? C
      : never,
    motivo: string,
    excerpt?: string,
  ): Promise<LancarSswPortalResult> => {
    await supabase
      .from("acoes_executadas_ssw")
      .update({
        sucesso: false,
        finalizado_em: new Date().toISOString(),
        motivo_erro: motivo.slice(0, 1000),
        portal_response_excerpt: excerpt?.slice(0, 500) ?? null,
      })
      .eq("id", acaoId!);
    return {
      ok: false,
      error: motivo,
      categoria,
      acao_id: acaoId!,
    };
  };

  // ─── Step 2: resolver sessão SSW e detalhe da NF (com ctrc esperado) ──────
  let sessao;
  let sswEnv;
  try {
    sswEnv = await loadSswInternalEnvForCard(supabase, env, card.id);
    sessao = await obterSessao(sswEnv);
  } catch (err) {
    return await finalizarComErro(
      "sessao_invalida",
      `Falha ao abrir sessão SSW: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let detalhe;
  try {
    detalhe = await buscarNFInterno(sessao, card.nf, {
      ctrcEsperado: card.ctrc,
    });
  } catch (err) {
    return await finalizarComErro(
      "ssw_erro",
      `buscarNFInterno falhou: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ─── Step 3: chamar portal com guard injetado ─────────────────────────────
  const result = await lancarOcorrenciaPortal(sessao, detalhe, {
    codigoSsw,
    texto,
    imagens,
    validarAntesDoSubmit: async (htmlO: string) => {
      const v = validarTripeCtrcNfPagador({
        cardCtrc: card.ctrc,
        cardNf: card.nf,
        htmlAtoO: htmlO,
        permitirLocalizacaoBaixada,
      });
      if (v.ok) {
        if (v.localizacao_forcada) {
          localizacaoForcada = {
            keyword: v.localizacao_forcada_keyword,
            localizacao: v.localizacao,
          };
        }
        return { ok: true };
      }
      return {
        ok: false,
        motivo: v.motivo,
        detalhe: v.detalhe,
      };
    },
  });

  if (!result.ok) {
    if (result.bloqueado_por_guard) {
      return await finalizarComErro(
        "guard_tripe",
        `bloqueado_por_guard: ${result.bloqueado_por_guard.detalhe}`,
        result.raw_response_snippet,
      );
    }
    return await finalizarComErro(
      "ssw_erro",
      result.error,
      result.raw_response_snippet,
    );
  }

  // ─── Step 4: sucesso — finaliza linha com sucesso=true ────────────────────
  await supabase
    .from("acoes_executadas_ssw")
    .update({
      sucesso: true,
      finalizado_em: new Date().toISOString(),
      portal_response_excerpt: result.raw_response_snippet.slice(0, 500),
    })
    .eq("id", acaoId);

  // Caio 2026-06-11: lançamento forçado em CTRC baixado (checagem (c) do guard
  // dispensada pela operadora) — registra card_event auditável. CTRC/NF (a/b)
  // foram validados normalmente. Caso âncora NF 919611 BHZ399401-5.
  if (localizacaoForcada) {
    const forcada = localizacaoForcada as { keyword?: string; localizacao: string };
    await supabase.from("card_events").insert({
      card_id: card.id,
      event_type: "LancamentoForcadoCtrcBaixado",
      actor_type: "system",
      actor_id: "lancar-ssw-portal",
      payload: {
        todo_id: todoId ?? null,
        codigo_ssw: codigoSsw,
        ctrc: card.ctrc,
        nf: card.nf,
        localizacao_ssw: forcada.localizacao,
        keyword_dispensada: forcada.keyword ?? null,
        motivo: "operadora autorizou lançamento em CTRC baixado por devolução (ressarcimento em aberto)",
      },
    });
  }

  return {
    ok: true,
    protocolo: result.seq_oc,
    idempotent_skip: false,
    acao_id: acaoId,
  };
}
