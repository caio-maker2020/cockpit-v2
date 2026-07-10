import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client — Cockpit v2 / Sal Express
 *
 * URL e anon key são chaves publicáveis (seguras no client).
 * RLS no banco é o que protege os dados.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Falha clara em vez de erro obscuro em runtime. Rode: cp .env.example .env.local
  throw new Error(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não definidos. Rode: cp .env.example .env.local",
  );
}

export const isSupabaseConfigured = true;
export const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
export const SUPABASE_ANON_KEY_PUBLIC = SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * MODO SOMENTE-LEITURA (piloto de migração).
 *
 * Default `false`: sem a env var, o comportamento é EXATAMENTE o de hoje.
 * Nenhum deploy existente muda. Ligar só no preview do piloto.
 *
 * Quando ligado, bloqueia toda escrita (rpc + edge function) por ALLOWLIST.
 * Allowlist, e não denylist, de propósito: se eu esquecer uma LEITURA aqui,
 * uma tela quebra de forma visível e inofensiva. Se eu esquecesse uma ESCRITA
 * numa denylist, sairia ocorrência de verdade no SSW.
 *
 * `.from(...)` (SELECT) e `.auth` NÃO são tocados: a operadora navega e loga normal.
 */
export const ACOES_DESABILITADAS =
  String(import.meta.env.VITE_ACOES_DESABILITADAS ?? "false").toLowerCase() === "true";

/** RPCs que só leem. Tudo que não está aqui é bloqueado no modo leitura. */
const RPC_SOMENTE_LEITURA = new Set([
  "preview_email_todo",
  "status_ultimo_sync_bastao",
  "listar_tratativas_email_do_card",
]);

/** Edge functions liberadas: só o refresh de histórico, pra aba Histórico SSW carregar. */
const INVOKE_SOMENTE_LEITURA = new Set(["puxar-historico-ssw-card"]);

function respostaBloqueada(alvo: string): any {
  const message = `Modo somente-leitura (piloto de migração). Ação bloqueada: ${alvo}`;
  console.warn(`[cockpit-web] ${message}`);
  const error = { name: "AcaoBloqueadaModoLeitura", message };
  const resolved = Promise.resolve({ data: null, error });
  // Proxy que é ao mesmo tempo:
  //  - thenable: `await supabase.rpc(...)` e `await supabase.from().insert()`
  //    resolvem { data:null, error } sem tocar a rede;
  //  - encadeável: o front faz `.update({...}).eq("id", ...)`, então qualquer
  //    método pós-escrita (.eq/.select/.single/...) devolve o MESMO stub.
  const stub: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return resolved.then.bind(resolved);
        if (prop === "catch") return resolved.catch.bind(resolved);
        if (prop === "finally") return resolved.finally.bind(resolved);
        if (prop === "data") return null;
        if (prop === "error") return error;
        return () => stub;
      },
    },
  );
  return stub;
}

if (ACOES_DESABILITADAS) {
  // 1) rpc: só a allowlist de leitura passa.
  const rpcOriginal = supabase.rpc.bind(supabase);
  (supabase as any).rpc = (fn: string, args?: unknown, opts?: unknown) =>
    RPC_SOMENTE_LEITURA.has(fn)
      ? (rpcOriginal as any)(fn, args, opts)
      : respostaBloqueada(`rpc:${fn}`);

  // 2) edge functions: idem. `functions` é getter, então intercepta o invoke
  //    resolvido na hora, sem guardar referência que o getter recria.
  const functionsReal = supabase.functions;
  const invokeOriginal = functionsReal.invoke.bind(functionsReal);
  (functionsReal as any).invoke = (fn: string, opts?: unknown) =>
    INVOKE_SOMENTE_LEITURA.has(fn)
      ? (invokeOriginal as any)(fn, opts)
      : respostaBloqueada(`fn:${fn}`);
  Object.defineProperty(supabase, "functions", { value: functionsReal, configurable: true });

  // 3) `.from(tabela)`: SELECT passa; insert/update/upsert/delete são bloqueados.
  //    É aqui que estão as ~20 escritas diretas em tabela (update state,
  //    assigned_operator_id, insert card_events, delete...). Sem isto, elas
  //    escapariam do modo leitura.
  const fromOriginal = supabase.from.bind(supabase);
  (supabase as any).from = (tabela: string) => {
    const builder = fromOriginal(tabela) as any;
    for (const op of ["insert", "update", "upsert", "delete"] as const) {
      builder[op] = () => respostaBloqueada(`${op}:${tabela}`);
    }
    return builder;
  };
}
