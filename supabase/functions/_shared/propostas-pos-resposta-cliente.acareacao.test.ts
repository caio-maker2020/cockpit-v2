// Guard INV-192 (09/10, NF 1119123) — COMPORTAMENTO: roda a limpeza
// pós-resposta de verdade (`atualizarPropostasAposRespostaCliente`) sobre um
// banco falso e confere QUAIS opções ela cancela como "proposta obsoleta".
// Na master antiga a 41 da acareação era cancelada → estes testes falham lá.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { atualizarPropostasAposRespostaCliente } from "./propostas-pos-resposta-cliente.ts";
import { MARCA_41_ACAREACAO, ORIGEM_TEXTO_41_ACAREACAO } from "./acareacao-41.ts";

type Filtro = [string, string, unknown];
interface Estado { op: string; values: unknown; filtros: Filtro[]; unico: boolean }

/** Banco falso: responde o card e os pendentes; registra o que foi cancelado. */
function bancoFalso(card: Record<string, unknown>, pendentes: Array<{ id: string; proposta_payload: unknown }>) {
  const cancelados: string[] = [];

  function responder(tabela: string, st: Estado): { data: unknown; error: null } {
    if (tabela === "cards" && st.op === "select") return { data: card, error: null };
    if (tabela === "todos" && st.op === "select") {
      const soPendentes = st.filtros.some(([k, c, v]) => k === "eq" && c === "status" && v === "pendente");
      const porCodigo = st.filtros.some(([k, c]) => k === "eq" && c.startsWith("proposta_payload"));
      if (soPendentes && !porCodigo) return { data: pendentes, error: null };
      return { data: st.unico ? null : [], error: null };
    }
    if (tabela === "todos" && st.op === "update") {
      const v = st.values as Record<string, unknown>;
      const ids = st.filtros.find(([k, c]) => k === "in" && c === "id")?.[2];
      if (v?.["status"] === "cancelado" && Array.isArray(ids)) cancelados.push(...(ids as string[]));
      return { data: null, error: null };
    }
    return { data: st.unico ? null : [], error: null };
  }

  function construtor(tabela: string) {
    const st: Estado = { op: "select", values: undefined, filtros: [], unico: false };
    const proxy: unknown = new Proxy({}, {
      get(_alvo, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
            Promise.resolve(responder(tabela, st)).then(ok, erro);
        }
        return (...a: unknown[]) => {
          if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
            st.op = String(prop);
            st.values = a[0];
          } else if (prop === "single" || prop === "maybeSingle") {
            st.unico = true;
          } else if (prop !== "select" && typeof a[0] === "string") {
            st.filtros.push([String(prop), a[0], a[1]]);
          }
          return proxy;
        };
      },
    });
    return proxy;
  }

  const vazio = () => Promise.resolve({ data: null, error: null });
  const supabase = {
    from: (t: string) => construtor(t),
    rpc: vazio,
    functions: { invoke: vazio },
  };
  return { supabase, cancelados };
}

const todo = (id: string, codigo: number, extra: Record<string, unknown> = {}) => ({
  id,
  proposta_payload: {
    tool: "lancar_ocorrencia",
    acao_key: `lancar_ocorrencia:${codigo}`,
    args: { nf: "1119123", codigo_ssw: codigo, ...(extra["args"] as object ?? {}) },
    meta: { ...(extra["meta"] as object ?? {}) },
  },
});

const card = (oc: number) => ({
  nf: "1119123",
  ctrc: "PDV463236-2",
  cod_ultima_ocorrencia: oc,
  agent_state: { chave_cte: "3".repeat(44), cnpj_pagador: "11111111000111" },
});

async function rodarLimpeza(oc: number, pendentes: Array<{ id: string; proposta_payload: unknown }>) {
  const { supabase, cancelados } = bancoFalso(card(oc), pendentes);
  try {
    // deno-lint-ignore no-explicit-any
    await atualizarPropostasAposRespostaCliente(supabase as any, "card-teste");
  } catch {
    // o que vem DEPOIS do cancelamento (criar opções novas, destaque...) não
    // importa aqui; o cancelamento é a etapa 3 e já foi registrado.
  }
  return [...cancelados].sort();
}

const marcada = () => todo("41-marcada", 41, { meta: { [MARCA_41_ACAREACAO]: true } });
const legado = () =>
  todo("41-legado", 41, { args: { extras: { origem: ORIGEM_TEXTO_41_ACAREACAO, texto_descricao: "Realizar acareação" } } });

Deno.test("INV-192 comportamento: card na 49 — a 41 da acareação NÃO é cancelada; a 41 comum segue saindo", async () => {
  const cancelados = await rodarLimpeza(49, [
    marcada(),
    legado(),
    todo("41-comum", 41),
    todo("54-email", 54, { args: { template_id: "QUALQUER" } }),
    todo("21", 21),
  ]);
  assertEquals(cancelados, ["41-comum", "54-email"]);
});

Deno.test("INV-192 comportamento: trilho 59 (indenização) também preserva a 41 da acareação", async () => {
  const cancelados = await rodarLimpeza(59, [marcada(), todo("41-comum", 41), todo("21", 21)]);
  assertEquals(cancelados, ["21", "41-comum"]);
});

Deno.test("INV-192 não-regressão: sem 41 de acareação a limpeza cancela exatamente o mesmo de antes", async () => {
  const cancelados = await rodarLimpeza(49, [
    todo("41-comum", 41),
    todo("54-email", 54, { args: { template_id: "QUALQUER" } }),
    todo("21", 21),
    todo("44", 44),
    todo("55", 55),
    todo("56", 56),
  ]);
  assertEquals(cancelados, ["41-comum", "54-email"]);
});
