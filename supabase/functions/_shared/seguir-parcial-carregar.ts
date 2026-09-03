// =============================================================================
// seguir-parcial-carregar — o único ponto de I/O da regra da oc 55 automática
// (ADR 0025). Separado de `seguir-parcial-auto.ts` de propósito: aquele é puro e
// testável; este toca o banco.
//
// REGRA DESTE ARQUIVO: NUNCA lança e NUNCA propaga erro. Qualquer falha (rede,
// tabela ausente, migration não aplicada, RLS) devolve o estado INERTE
// — `{ flagOn: false, whitelist: Map vazio }` — e o Cockpit segue exatamente
// como hoje pra todo mundo. Uma exceção aqui não pode derrubar o sync, o
// interpretador nem o agente de sugestões, que rodam pra TODOS os clientes.
// =============================================================================

import type { ClienteSeguirParcial } from "./seguir-parcial-auto.ts";

/** feature_flags.key do kill-switch (mig 377, nasce OFF). */
export const FLAG_SEGUIR_PARCIAL = "seguir_parcial_auto_enabled";

/** feature_flags.key do modo sombra (mig 378): decide e registra, NÃO lança. */
export const FLAG_SEGUIR_PARCIAL_SOMBRA = "seguir_parcial_auto_sombra";

export interface ContextoSeguirParcial {
  flagOn: boolean;
  /** true = decide e grava evento, mas NÃO lança no SSW (F7). */
  sombra: boolean;
  whitelist: ReadonlyMap<string, ClienteSeguirParcial>;
}

/** Estado inerte: usado como default e como fallback de QUALQUER falha. */
export const CONTEXTO_INERTE: ContextoSeguirParcial = {
  flagOn: false,
  sombra: true,
  whitelist: new Map(),
};

// deno-lint-ignore no-explicit-any
type Db = any;

/**
 * Carrega flag + modo sombra + whitelist ATIVA. Chamar 1x por invocação e
 * propagar o resultado — a tabela tem punhado de linhas, mas N+1 em loop de
 * sync é como o Pass A já estourou timeout no passado.
 */
export async function carregarContextoSeguirParcial(
  supabase: Db,
): Promise<ContextoSeguirParcial> {
  try {
    const { data: flags, error: errFlags } = await supabase
      .from("feature_flags")
      .select("key, enabled")
      .in("key", [FLAG_SEGUIR_PARCIAL, FLAG_SEGUIR_PARCIAL_SOMBRA]);
    if (errFlags) {
      console.warn(`[seguir-parcial] flags: ${errFlags.message} — contexto inerte`);
      return CONTEXTO_INERTE;
    }
    const porKey = new Map(
      ((flags ?? []) as Array<{ key: string; enabled: boolean }>).map((f) => [f.key, f.enabled]),
    );
    const flagOn = porKey.get(FLAG_SEGUIR_PARCIAL) === true;
    // Sombra é FAIL-SAFE ao contrário das outras: ausente/erro => TRUE (não
    // lança). Só sai da sombra quando a linha existir e disser explicitamente
    // enabled=false.
    const sombra = porKey.get(FLAG_SEGUIR_PARCIAL_SOMBRA) !== false;

    // Flag off: nem consulta a whitelist (economiza query no caminho comum,
    // que é o de TODOS os clientes enquanto isto não estiver ligado).
    if (!flagOn) return { flagOn: false, sombra, whitelist: new Map() };

    const { data: linhas, error: errWl } = await supabase
      .from("cliente_config_seguir_parcial_auto")
      .select("cnpj_pagador, ativo, aplica_oc06, aplica_oc08")
      .eq("ativo", true);
    if (errWl) {
      console.warn(`[seguir-parcial] whitelist: ${errWl.message} — contexto inerte`);
      return CONTEXTO_INERTE;
    }

    const whitelist = new Map<string, ClienteSeguirParcial>();
    for (const l of (linhas ?? []) as Array<Record<string, unknown>>) {
      const cnpj = String(l["cnpj_pagador"] ?? "").replace(/\D/g, "");
      if (cnpj.length !== 14) continue;
      whitelist.set(cnpj, {
        cnpj_pagador: cnpj,
        ativo: l["ativo"] === true,
        // Default true casa com o DEFAULT da coluna (mig 377). Coluna ausente
        // (migration antiga) não pode virar "desligado silencioso".
        aplica_oc06: l["aplica_oc06"] !== false,
        aplica_oc08: l["aplica_oc08"] !== false,
      });
    }
    return { flagOn: true, sombra, whitelist };
  } catch (e) {
    console.warn(
      `[seguir-parcial] exceção ao carregar contexto: ${
        e instanceof Error ? e.message : String(e)
      } — contexto inerte`,
    );
    return CONTEXTO_INERTE;
  }
}

/**
 * Atalho para os callers que só precisam saber "este CNPJ tem autorização
 * permanente?" (os opt-ins D6/D7 do ADR 0025). Não faz I/O.
 */
export function cnpjTemAutorizacaoPermanente(
  ctx: ContextoSeguirParcial,
  ...cnpjs: Array<string | null | undefined>
): boolean {
  if (!ctx.flagOn) return false;
  for (const bruto of cnpjs) {
    if (bruto == null) continue;
    const d = String(bruto).replace(/\D/g, "");
    if (d.length === 14 && ctx.whitelist.get(d)?.ativo === true) return true;
  }
  return false;
}

// ── Atalho memoizado para os callers dos opt-ins D6/D7 ───────────────────────
// Esses callers (agente-sugere-ocs-padrao, interpretador-resposta-cliente) rodam
// por CARD e para TODOS os clientes. Uma query por card seria N+1 num caminho
// quente. Memo de 60s: no caminho comum (flag OFF) o custo é UMA query leve por
// minuto no processo inteiro, e a whitelist nem chega a ser consultada.

const TTL_MEMO_MS = 60_000;
let memo: { at: number; ctx: ContextoSeguirParcial } | null = null;
let clienteMemo: Db | null = null;

/** Contexto com cache curto. Nunca lança. */
export async function contextoSeguirParcialMemo(supabase: Db): Promise<ContextoSeguirParcial> {
  if (memo && Date.now() - memo.at < TTL_MEMO_MS) return memo.ctx;
  const ctx = await carregarContextoSeguirParcial(supabase);
  memo = { at: Date.now(), ctx };
  return ctx;
}

/**
 * "Este CNPJ tem autorização permanente de seguir parcial?" — versão de UMA
 * LINHA para os call sites, montando o client a partir do env.
 *
 * FAIL-CLOSED e à prova de exceção: qualquer problema devolve `false`, que é
 * exatamente o comportamento histórico. Um erro aqui não pode alterar a decisão
 * de nenhum card, muito menos derrubar o agente que roda pra todo mundo.
 */
export async function temAutorizacaoPermanenteSeguirParcial(
  env: Record<string, string>,
  ...cnpjs: Array<string | null | undefined>
): Promise<boolean> {
  try {
    if (cnpjs.every((c) => c == null || String(c).replace(/\D/g, "").length !== 14)) return false;
    if (!clienteMemo) {
      const url = env["SUPABASE_URL"];
      const key = env["SUPABASE_SERVICE_ROLE_KEY"];
      if (!url || !key) return false;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
      clienteMemo = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    const ctx = await contextoSeguirParcialMemo(clienteMemo);
    return cnpjTemAutorizacaoPermanente(ctx, ...cnpjs);
  } catch (e) {
    console.warn(
      `[seguir-parcial] temAutorizacaoPermanente falhou (${
        e instanceof Error ? e.message : String(e)
      }) — assume false (comportamento histórico)`,
    );
    return false;
  }
}
