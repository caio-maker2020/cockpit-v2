/**
 * Guard anti-regressão (INV-157): os dois botões do dashboard de clientes
 * abrem a URL certa em nova aba. Caso-âncora NF 2387303 (ASTRA):
 * card traz "ASTRA S/A. INDU A." (abreviado SSW) + cnpj_pagador
 * 50949528001232 → link deve levar `q` com o nome completo do cadastro
 * e `cnpj` com o pagador.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CNPJ = "50949528001232";
let nomeNoCadastro: string | null = "ASTRA S/A. INDUSTRIA E COMERCIO";

function builder(resultado: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit", "order"]) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve(resultado);
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => builder({ data: nomeNoCadastro ? { nome: nomeNoCadastro } : null, error: null })),
  },
}));

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import { BotaoVerNumerosCliente } from "./BotaoVerNumerosCliente";
import { BotaoVisaoGeralClientes } from "@/components/cockpit/BotaoVisaoGeralClientes";
import { DASHBOARD_CLIENTES_URL } from "@/lib/dashboard-clientes";
import type { CardRow } from "@/lib/types";

function cardAstra(over: Partial<CardRow> = {}): CardRow {
  return {
    id: "card-astra",
    nf: "2387303",
    ctrc: "TKS429932-9",
    empresa_cliente: "ASTRA S/A. INDU A.",
    nome_cliente: null,
    pagador: "ASTRA S/A. INDU A.",
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    agent_state: { cnpj_pagador: CNPJ },
    created_at: "2026-09-15T03:32:00Z",
    updated_at: "2026-09-18T12:00:00Z",
    ...over,
  } as unknown as CardRow;
}

function renderBotao(card: CardRow) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <BotaoVerNumerosCliente card={card} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockClear();
});
afterEach(() => {
  nomeNoCadastro = "ASTRA S/A. INDUSTRIA E COMERCIO";
});

/** Nova aba é nativa da âncora — NUNCA window.open (retorna null com noopener). */
function esperaNovaAbaNativa(a: HTMLAnchorElement) {
  expect(a.target).toBe("_blank");
  expect(a.rel).toContain("noopener");
}

describe("BotaoVerNumerosCliente (card)", () => {
  it("usa o nome completo do cadastro + cnpj pagador e abre em nova aba", async () => {
    renderBotao(cardAstra());
    const a = screen.getByTestId("botao-ver-numeros-cliente") as HTMLAnchorElement;
    expect(a.textContent).toMatch(/ver números do cliente/i);

    await waitFor(() => {
      const u = new URL(a.href);
      expect(u.searchParams.get("q")).toBe("ASTRA S/A. INDUSTRIA E COMERCIO");
    });
    const u = new URL(a.href);
    expect(u.origin + u.pathname).toBe(DASHBOARD_CLIENTES_URL);
    expect(u.searchParams.get("cnpj")).toBe(CNPJ);

    esperaNovaAbaNativa(a);
    fireEvent.click(a);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(String(toastMock.mock.calls[0]?.[0])).toContain("ASTRA S/A. INDUSTRIA E COMERCIO");
  });

  it("sem cliente visível no cadastro (RLS por carteira) cai pro nome do card sem ' A.'", async () => {
    nomeNoCadastro = null;
    renderBotao(cardAstra());
    const a = screen.getByTestId("botao-ver-numeros-cliente") as HTMLAnchorElement;
    await waitFor(() => expect(new URL(a.href).searchParams.get("q")).toBe("ASTRA S/A. INDU"));
    expect(new URL(a.href).searchParams.get("cnpj")).toBe(CNPJ);
  });

  it("card sem cnpj e sem nome ainda abre o dashboard (nunca quebra)", () => {
    nomeNoCadastro = null;
    renderBotao(cardAstra({ empresa_cliente: null, pagador: null, agent_state: null }));
    const a = screen.getByTestId("botao-ver-numeros-cliente") as HTMLAnchorElement;
    expect(a.href).toBe(DASHBOARD_CLIENTES_URL);
  });
});

describe("BotaoVisaoGeralClientes (Inbox)", () => {
  it("aponta pro dashboard e abre em nova aba ao clicar", () => {
    render(<BotaoVisaoGeralClientes />);
    const a = screen.getByTestId("botao-visao-geral-clientes") as HTMLAnchorElement;
    expect(a.textContent).toMatch(/visão geral dos clientes/i);
    expect(a.href).toBe(DASHBOARD_CLIENTES_URL);
    esperaNovaAbaNativa(a);
    fireEvent.click(a);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
