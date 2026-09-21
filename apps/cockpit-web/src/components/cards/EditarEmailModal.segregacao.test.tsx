// GUARD anti-regressão — caixa "Segregar CTRC" (campo f8 da tela 101 do SSW).
//
// Contexto (Caio, 2026-09-21): a operadora liga a segregação ao aprovar uma
// oc 54 ou 59 num card de EXTRAVIO de cliente habilitado (mig 407, hoje só
// PRATI). Segregar bloqueia a carga no SSW e a retirada é MANUAL (opção 091)
// — o Cockpit não desfaz.
//
// Por que este guard existe: a prop `podeSegregarCtrc` tem default `false`.
// Se alguém desfizer a fiação no componente pai, a caixa simplesmente SOME da
// tela — typecheck e vitest continuariam verdes e ninguém perceberia. Estes
// testes travam as duas pontas: quando a caixa aparece e o que ela entrega.
//
// Espelha o backend em supabase/functions/_shared/segregacao-ctrc.ts
// (OCS_COM_SEGREGACAO = {54, 59}).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const TEXTO_CAIXA = "Segregar o CT-e no SSW junto com esta ocorrencia";

// --- dados do preview (mutáveis por teste, via vi.hoisted) -----------------
const CNPJ_PAGADOR = "12345678000199";
const DEST_SALVOS = ["logistica@prati.com.br", "fiscal@prati.com.br"];

const mocks = vi.hoisted(() => ({
  preview: {
    todo_id: "11111111-1111-4111-8111-111111111111",
    card_id: "22222222-2222-4222-8222-222222222222",
    nf: "361612",
    codigo_ssw_proposta: 54,
    cod_ultima_ocorrencia_card: 9,
    email_destino: "logistica@prati.com.br",
    template_atual: {
      id: "EXTRAVIO_TOTAL",
      nome: "Extravio total",
      descricao: "",
      assunto_renderizado: "[Sal Express] NF 361612",
      corpo_renderizado: "corpo do e-mail",
      usa_link_evidencia: false,
    },
    templates_disponiveis: [
      { id: "EXTRAVIO_TOTAL", nome: "Extravio total", descricao: "" },
    ],
  } as Record<string, unknown>,
}));

const CONTATOS = DEST_SALVOS.map((identificador, i) => ({
  identificador,
  nome_pessoa: null,
  cargo: null,
  ordem: i + 1,
  cnpj_remetente: null,
}));

// --- mocks (mesma forma do molde EditarEmailModal.destinatarios.test.tsx) --
function builder(resultado: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "is", "or", "in", "not"]) {
    b[m] = () => b;
  }
  b.maybeSingle = () => Promise.resolve(resultado);
  b.single = () => Promise.resolve(resultado);
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resultado).then(res, rej);
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(() => Promise.resolve({ data: mocks.preview, error: null })),
    from: vi.fn((tabela: string) =>
      tabela === "cards"
        ? builder({
            data: { agent_state: { cnpj_pagador: CNPJ_PAGADOR } },
            error: null,
          })
        : builder({ data: CONTATOS, error: null }),
    ),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ operador: { pode_executar: true } }),
}));

vi.mock("@/hooks/useTemplatesEmail", () => ({
  useTemplatesEmail: () => ({
    data: [{ id: "EXTRAVIO_TOTAL", nome: "Extravio total", descricao: "" }],
  }),
}));

vi.mock("./AnexosUploader", () => ({
  AnexosUploader: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { EditarEmailModal } from "./EditarEmailModal";

function renderModal(
  oc: number,
  props: Record<string, unknown> = {},
): { onConfirm: ReturnType<typeof vi.fn> } {
  mocks.preview.codigo_ssw_proposta = oc;
  const onConfirm = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <EditarEmailModal
        todoId={mocks.preview.todo_id as string}
        onClose={() => {}}
        onConfirm={onConfirm}
        submitting={false}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onConfirm };
}

/** Espera o modal terminar de carregar (assunto renderizado na tela). */
async function esperarModalPronto(): Promise<void> {
  await screen.findByDisplayValue("[Sal Express] NF 361612");
}

function caixaSegregar(): HTMLInputElement | null {
  const titulo = screen.queryByText(TEXTO_CAIXA);
  if (!titulo) return null;
  const input = titulo.closest("label")?.querySelector("input[type=checkbox]");
  return (input as HTMLInputElement) ?? null;
}

function confirmar(): void {
  fireEvent.click(screen.getByRole("button", { name: /Confirmar/i }));
}

describe("EditarEmailModal — caixa Segregar CTRC (f8)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SEM a permissão (podeSegregarCtrc=false), oc 54 NÃO mostra a caixa", async () => {
    renderModal(54);
    await esperarModalPronto();
    expect(screen.queryByText(TEXTO_CAIXA)).toBeNull();
  });

  it("COM a permissão, oc 54 mostra a caixa", async () => {
    renderModal(54, { podeSegregarCtrc: true });
    await esperarModalPronto();
    expect(screen.queryByText(TEXTO_CAIXA)).not.toBeNull();
  });

  it("COM a permissão, oc 59 mostra a caixa", async () => {
    renderModal(59, { podeSegregarCtrc: true });
    await esperarModalPronto();
    expect(screen.queryByText(TEXTO_CAIXA)).not.toBeNull();
  });

  it("COM a permissão, oc 44 NÃO mostra a caixa (fora de 54/59)", async () => {
    renderModal(44, { podeSegregarCtrc: true });
    await esperarModalPronto();
    expect(screen.queryByText(TEXTO_CAIXA)).toBeNull();
  });

  it("marcando a caixa, o confirmar entrega segregar_ctrc = true", async () => {
    const { onConfirm } = renderModal(54, { podeSegregarCtrc: true });
    await esperarModalPronto();

    const caixa = caixaSegregar();
    expect(caixa, "a caixa deveria estar na tela").not.toBeNull();
    fireEvent.click(caixa!);
    expect(caixa!.checked).toBe(true);

    confirmar();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const extras = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect(extras.segregar_ctrc).toBe(true);
  });

  it("SEM marcar, sobe segregar_ctrc = FALSE — a chave TEM que ir junto", async () => {
    // Achado da auditoria pré-merge (21/09), gravidade bloqueia-merge.
    // A versão anterior deste teste exigia que a chave NÃO subisse, o que
    // parecia mais seguro e era o contrário: `aprovar_e_executar` grava os
    // extras dentro do to-do com `extras_existentes || p_extras`, e o `||` do
    // jsonb MANTÉM chave ausente. Omitir quando desmarcada deixava um
    // `segregar_ctrc: true` de uma tentativa que FALHOU gravado no to-do —
    // a reaprovação seguinte, com a caixa desmarcada, segregava o CT-e.
    // Mandar o false explícito é o que faz o merge sobrescrever.
    const { onConfirm } = renderModal(54, { podeSegregarCtrc: true });
    await esperarModalPronto();
    expect(caixaSegregar()!.checked).toBe(false);

    confirmar();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const extras = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect(extras.segregar_ctrc).toBe(false);
    expect("segregar_ctrc" in extras).toBe(true);
  });

  it("cliente sem permissão: a chave nao sobe (nem false)", async () => {
    // Quando a caixa nem aparece, nada deve ser dito sobre segregação — mandar
    // `false` aqui seria ruído num payload de cliente que nunca segrega.
    const { onConfirm } = renderModal(54, { podeSegregarCtrc: false });
    await esperarModalPronto();

    confirmar();
    const extras = onConfirm.mock.calls[0]![0] as Record<string, unknown>;
    expect("segregar_ctrc" in extras).toBe(false);
  });
});
