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
  // Seu Dashboard (21/08): agregados do próprio operador — leitura pura.
  "meu_dashboard_agentes",
  "meu_dashboard_operacao",
  // Gestão Operadores (24/08, mig 349): leitura pura com trava de gestor no
  // servidor — substitui o select paginado que estourava o timeout de 8s.
  "gestao_operadores_tratativas",
  // promover_fatia_autonoma fica FORA de propósito: promoção só em produção.
]);

/** Edge functions liberadas no modo somente-leitura:
 * - puxar-historico-ssw-card: refresh da aba Histórico SSW (leitura).
 * - agente-chefe-chat (Caio 08/08, validação Fase 1 no preview): NÃO é ação
 *   operacional — conversa da gestão com o agente-chefe. Seguro no preview
 *   aberto porque a PRÓPRIA function exige JWT de gestor no servidor
 *   (anônimo → 401) e só escreve nas tabelas de chat/learning_log; nunca
 *   SSW, nunca cards, nunca e-mail a cliente. */
const INVOKE_SOMENTE_LEITURA = new Set(["puxar-historico-ssw-card", "agente-chefe-chat"]);

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

/**
 * CONFIRMAÇÃO ANTES DE APROVAR (rede extra do piloto com AÇÕES REAIS).
 *
 * Só faz sentido quando as ações estão LIGADAS (senão a escrita já é bloqueada
 * acima). Default `false`, opt-in por env — mesma filosofia do modo leitura:
 * sem a var, o comportamento é o de hoje (aprovar executa direto, como no
 * Lovable). Ligar só no preview do piloto, com VITE_CONFIRMAR_ANTES_DE_APROVAR=true.
 *
 * Quando ligado, os RPCs que LANÇAM ocorrência no SSW / disparam e-mail passam
 * por um window.confirm enriquecido (OC · CTRC · NF) ANTES de sair. Cancelou =
 * nada vai pra rede. Interceptado no MESMO choke point do rpc do modo leitura,
 * então cobre os 7+ call-sites de aprovação (ProposedActions, BannerSugestaoIA,
 * SugestaoIATopBox, BannerInline54Composer, TratativaPendenteCard, emergencial)
 * de uma vez, sem depender de cada tela lembrar de confirmar.
 */
export const CONFIRMAR_ACOES_REAIS =
  !ACOES_DESABILITADAS &&
  String(import.meta.env.VITE_CONFIRMAR_ANTES_DE_APROVAR ?? "false").toLowerCase() === "true";

/** RPCs que lançam no SSW / mandam e-mail de verdade — exigem confirmação. */
const RPC_QUE_LANCAM_ACAO = new Set([
  "aprovar_e_executar",
  "lancar_oc_emergencial_acao_executada",
]);

/**
 * Monta "OC 54 · CTRC OVD… · NF 123" pra confirmação. Best-effort: se a leitura
 * falhar (RLS, coluna, rede), cai num rótulo genérico — o gate de confirmação
 * continua valendo, só perde o detalhe.
 */
async function contextoDaAcao(fn: string, args: any): Promise<string> {
  try {
    let cardId: string | undefined;
    let oc: unknown;
    if (fn === "aprovar_e_executar" && args?.p_todo_id) {
      const { data: todo } = await supabase
        .from("todos")
        .select("card_id, proposta_payload")
        .eq("id", args.p_todo_id)
        .maybeSingle();
      cardId = (todo as any)?.card_id;
      oc = (todo as any)?.proposta_payload?.args?.codigo_ssw;
    } else if (fn === "lancar_oc_emergencial_acao_executada") {
      cardId = args?.p_card_id;
      oc = args?.p_codigo_oc ?? args?.p_codigo_ssw;
    }
    let nf: unknown;
    let ctrc: unknown;
    if (cardId) {
      const { data: card } = await supabase
        .from("cards")
        .select("nf, ctrc")
        .eq("id", cardId)
        .maybeSingle();
      nf = (card as any)?.nf;
      ctrc = (card as any)?.ctrc;
    }
    const partes = [
      oc != null ? `OC ${oc}` : null,
      ctrc ? `CTRC ${ctrc}` : null,
      nf ? `NF ${nf}` : null,
    ].filter(Boolean);
    return partes.length ? partes.join(" · ") : "esta ação";
  } catch {
    return "esta ação";
  }
}

async function confirmarAcaoFiscal(fn: string, args: any): Promise<boolean> {
  // Sem window (SSR/teste em node) não há como perguntar: deixa passar.
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  const ctx = await contextoDaAcao(fn, args);
  const msg =
    `⚠ AÇÃO REAL NA PRODUÇÃO\n\n${ctx}\n\n` +
    `Isso vai lançar a ocorrência no SSW e pode notificar o cliente de verdade. ` +
    `Não dá pra desfazer.\n\nConfirmar e aprovar?`;
  return window.confirm(msg);
}

if (CONFIRMAR_ACOES_REAIS) {
  const rpcOriginal = supabase.rpc.bind(supabase);
  (supabase as any).rpc = (fn: string, args?: any, opts?: unknown) => {
    if (!RPC_QUE_LANCAM_ACAO.has(fn)) return (rpcOriginal as any)(fn, args, opts);
    // Retorna Promise<{data,error}> — os call-sites fazem `await ...rpc(...)`.
    return (async () => {
      const ok = await confirmarAcaoFiscal(fn, args);
      if (!ok) {
        return {
          data: null,
          error: {
            name: "AcaoCancelada",
            message: "Cancelado — nada foi lançado no SSW nem enviado ao cliente.",
          },
        };
      }
      return (rpcOriginal as any)(fn, args, opts);
    })();
  };
}
