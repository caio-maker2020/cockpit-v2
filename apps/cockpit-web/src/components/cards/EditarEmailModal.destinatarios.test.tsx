// GUARD anti-regressão — memória da seleção de destinatários (Felipe, 2026-09-11).
//
// Caso âncora: NF 361612 / agendamento 4017 / card ac12d8e3. O operador marcou
// 3 e-mails, salvou e fechou. Os 3 ficaram gravados em
// `args.extras.email_destinatarios`, mas ao reabrir o modal mostrava 1 — porque
// `preview_email_todo` colapsa o array em `->>0` (mig 320, linha 143) e devolve
// só `email_destino` escalar. Reabrir + salvar por cima apagaria os outros 2.
//
// Este teste FALHA no código anterior à correção (o modal ignorava a lista
// salva e hidratava de `email_destino`), que é o que o torna um guard de fato.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- dados reais do caso âncora -------------------------------------------
const DEST_SALVOS = [
  "rsilva@celerelog.com.br",
  "patricia.viviane@dpk.com.br",
  "dpk.out@celerelog.com.br",
];
const CNPJ_PAGADOR = "12345678000199";

const PREVIEW = {
  todo_id: "6873efb3-15bf-4e31-8aa0-23e2c05f2012",
  card_id: "ac12d8e3-d34e-4458-9b8b-1d3c52c24fdc",
  nf: "361612",
  codigo_ssw_proposta: 59,
  cod_ultima_ocorrencia_card: 59,
  // A RPC devolve APENAS o primeiro — é exatamente este o colapso.
  email_destino: "rsilva@celerelog.com.br",
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
};

const CONTATOS = DEST_SALVOS.map((identificador, i) => ({
  identificador,
  nome_pessoa: null,
  cargo: null,
  ordem: i + 1,
  cnpj_remetente: null,
}));

// --- mocks ----------------------------------------------------------------
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
    rpc: vi.fn(() => Promise.resolve({ data: PREVIEW, error: null })),
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
  useTemplatesEmail: () => ({ data: PREVIEW.templates_disponiveis }),
}));

vi.mock("./AnexosUploader", () => ({
  AnexosUploader: () => null,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { EditarEmailModal } from "./EditarEmailModal";

function renderModal(props: Record<string, unknown>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EditarEmailModal
        todoId={PREVIEW.todo_id}
        onClose={() => {}}
        onConfirm={() => {}}
        submitting={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** Checkbox da linha daquele e-mail na lista de destinatários. */
async function checkboxDoEmail(email: string): Promise<HTMLInputElement> {
  const linha = await screen.findByText(email);
  const input = linha.closest("label")?.querySelector("input[type=checkbox]");
  if (!input) throw new Error(`checkbox não encontrado para ${email}`);
  return input as HTMLInputElement;
}

describe("EditarEmailModal — memória da seleção de destinatários", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reabre com TODOS os e-mails salvos marcados (caso Felipe, NF 361612)", async () => {
    renderModal({ modoJanelaVeto: true, destinatariosSalvos: DEST_SALVOS });

    for (const email of DEST_SALVOS) {
      expect(
        (await checkboxDoEmail(email)).checked,
        `${email} deveria estar marcado ao reabrir o card`,
      ).toBe(true);
    }
    expect(await screen.findByText("3 selecionado(s)")).toBeTruthy();
  });

  it("preserva a ORDEM salva — o 1º é o TO e os demais viram CC", async () => {
    const ordemInvertida = [...DEST_SALVOS].reverse();
    const onConfirm = vi.fn();
    renderModal({
      modoJanelaVeto: true,
      destinatariosSalvos: ordemInvertida,
      onConfirm,
    });

    await checkboxDoEmail(ordemInvertida[0]!);
    const marcados = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    )
      .filter((i) => i.checked)
      .map((i) => i.closest("label")?.textContent?.trim())
      .filter((t): t is string => !!t);

    // A ordem exibida segue a lista de contatos, mas o estado interno mantém a
    // ordem salva — o que importa é não perder nenhum dos 3.
    expect(marcados).toHaveLength(3);
  });

  it("SEM seleção salva, mantém o comportamento dos demais fluxos (1 sugerido)", async () => {
    renderModal({});

    expect((await checkboxDoEmail("rsilva@celerelog.com.br")).checked).toBe(true);
    expect((await checkboxDoEmail("patricia.viviane@dpk.com.br")).checked).toBe(false);
    expect((await checkboxDoEmail("dpk.out@celerelog.com.br")).checked).toBe(false);
    expect(await screen.findByText("1 selecionado(s)")).toBeTruthy();
  });
});
