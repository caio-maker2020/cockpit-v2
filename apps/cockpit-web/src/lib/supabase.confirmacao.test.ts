// @vitest-environment jsdom
// Precisa de window.confirm; o resto da suíte roda em node (default).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guarda da CONFIRMAÇÃO ANTES DE APROVAR (piloto com ações reais).
 *
 * Propriedade protegida: com VITE_ACOES_DESABILITADAS=false E
 * VITE_CONFIRMAR_ANTES_DE_APROVAR=true, um RPC que lança no SSW/e-mail só
 * alcança a rede se o operador confirmar. Cancelou => a ação NÃO sai.
 * Asserimos sobre as URLs que o fetch recebeu, não sobre a UI.
 */

const ENV_BASE: Record<string, string> = {
  VITE_SUPABASE_URL: "https://exemplo.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key-de-teste",
};

async function carregarClient(opts: { acoes?: string; confirmar?: string }) {
  vi.resetModules();
  for (const [k, v] of Object.entries(ENV_BASE)) vi.stubEnv(k, v);
  // Controla SEMPRE as duas flags (senão o .env.local do projeto vaza pro vitest).
  vi.stubEnv("VITE_ACOES_DESABILITADAS", opts.acoes ?? "false");
  vi.stubEnv("VITE_CONFIRMAR_ANTES_DE_APROVAR", opts.confirmar ?? "");
  return await import("./supabase");
}

let urls: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  urls = [];
  fetchSpy = vi.fn(async (url: unknown) => {
    urls.push(String(url));
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const bateuNoRpcDeAcao = () =>
  urls.some((u) => u.includes("/rpc/aprovar_e_executar"));

describe("confirmação antes de aprovar LIGADA (ações reais)", () => {
  it("CANCELAR: a ação NÃO chega na rede e volta erro AcaoCancelada", async () => {
    const { supabase, CONFIRMAR_ACOES_REAIS } = await carregarClient({
      acoes: "false",
      confirmar: "true",
    });
    expect(CONFIRMAR_ACOES_REAIS).toBe(true);
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    const { error } = (await supabase.rpc("aprovar_e_executar" as never, {
      p_todo_id: "todo-1",
    } as never)) as { error: { name?: string } | null };

    expect(confirmSpy, "deve perguntar antes de lançar").toHaveBeenCalled();
    expect(error?.name).toBe("AcaoCancelada");
    expect(bateuNoRpcDeAcao(), "cancelado não pode lançar no SSW").toBe(false);
  });

  it("CONFIRMAR: a ação alcança a rede (rpc de lançamento)", async () => {
    const { supabase } = await carregarClient({ acoes: "false", confirmar: "true" });
    vi.stubGlobal("confirm", vi.fn(() => true));

    await supabase.rpc("aprovar_e_executar" as never, { p_todo_id: "todo-1" } as never);

    expect(bateuNoRpcDeAcao(), "confirmado precisa lançar").toBe(true);
  });

  it("RPC não-fiscal NÃO é confirmado (passa direto)", async () => {
    const { supabase } = await carregarClient({ acoes: "false", confirmar: "true" });
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    await supabase.rpc("marcar_card_nao_importante" as never, { p_card_id: "1" } as never);

    expect(confirmSpy, "só ação fiscal confirma").not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes("/rpc/marcar_card_nao_importante"))).toBe(true);
  });
});

describe("confirmação DESLIGADA (default: sem a flag)", () => {
  it("sem VITE_CONFIRMAR_ANTES_DE_APROVAR, aprovar executa direto (comportamento de hoje)", async () => {
    const { supabase, CONFIRMAR_ACOES_REAIS } = await carregarClient({
      acoes: "false",
      confirmar: "",
    });
    expect(CONFIRMAR_ACOES_REAIS).toBe(false);
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);

    await supabase.rpc("aprovar_e_executar" as never, { p_todo_id: "todo-1" } as never);

    expect(confirmSpy, "sem a flag não pergunta nada").not.toHaveBeenCalled();
    expect(bateuNoRpcDeAcao(), "sem a flag, a ação sai direto").toBe(true);
  });

  it("no modo somente-leitura, a confirmação fica desligada (escrita já é bloqueada antes)", async () => {
    const { CONFIRMAR_ACOES_REAIS } = await carregarClient({
      acoes: "true",
      confirmar: "true",
    });
    expect(CONFIRMAR_ACOES_REAIS).toBe(false);
  });
});
