// GUARD DE COMPORTAMENTO — o cartão simples da 33 (Carlos 2026-10-09,
// NF 387252, CH-20261007-B8VZ).
//
// Fora de AGUARDANDO_VALIDACAO_HUMANA a tela usa o ProposalCard. Ele nascia sem
// a trava do carimbo (INV-152) e sem o pop-up (INV-155): o botão da 33 ficava
// aceso, a janela de anexos abria e a parede recusava no fim. Este teste CLICA
// no botão (o gateOc33Carimbo.test.ts só lê o código-fonte) e prova também o
// lado da não-regressão: 33 com dossiê completo e ocorrência que não é 33
// continuam exatamente como antes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardRow, TodoRow } from "@/lib/types";

vi.mock("@/lib/supabase", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-teste" }, operador: null, operadorCarregado: true }),
}));
// A chave do pop-up e o "card tem anexo" vêm do banco; aqui o teste decide.
const popup = vi.hoisted(() => ({
  flagConfirma33: true as boolean | undefined,
  temAnexoNoCard: true as boolean | undefined,
}));
vi.mock("@/hooks/usePopupConfirmaOc33", () => ({
  usePopupConfirmaOc33: () => popup,
}));

import { ProposalCard } from "./ProposedActions";

const DOSSIE_SEM_DESCRICAO = {
  caso: "1",
  fase: "coletando",
  dossie: {
    romaneio: { presente: true, fonte: "anexo", filename: "romaneio.pdf" },
    valor: { presente: true, fonte: "corpo", texto_bruto: "Custo:438,90" },
    descricao: { presente: false },
    completo: false,
  },
};

const DOSSIE_COMPLETO = {
  caso: "1",
  fase: "coletando",
  dossie: {
    romaneio: { presente: true, fonte: "anexo", filename: "romaneio.pdf" },
    valor: { presente: true, fonte: "corpo", texto_bruto: "Custo:438,90" },
    descricao: { presente: true, fonte: "corpo", texto_bruto: "ITEM EXEMPLO 50MG" },
    completo: true,
  },
};

function cardEm(state: string, extravio: unknown): CardRow {
  return {
    id: "card-teste",
    nf: "387252",
    ctrc: "APO608437-1",
    state,
    cod_ultima_ocorrencia: 59,
    empresa_cliente: "CLIENTE EXEMPLO",
    agent_state: { extravio_parcial: extravio },
  } as unknown as CardRow;
}

function todoCom(proposta_payload: Record<string, unknown>): TodoRow {
  return {
    id: "todo-teste",
    card_id: "card-teste",
    action_id: "acao-teste",
    descricao: "Lançar oc 33",
    proposta_payload,
    status: "pendente",
    created_at: "2026-10-07T18:33:58Z",
  } as unknown as TodoRow;
}

const GATE_BLOQUEADO = {
  bloqueada: true,
  natureza: "completude",
  faltando: ["descrição dos itens"],
};

const OC33_SOLO_BLOQUEADA = {
  tool: "lancar_oc33_solo_portal",
  args: { nf: "387252", codigo_ssw: 33 },
  meta: { tipo_acao: "oc33_solo", tinha_intencao_email: false, gate_oc33: GATE_BLOQUEADO },
};

function montar(card: CardRow, todo: TodoRow) {
  const onApprove = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ul>
        <ProposalCard
          todo={todo}
          card={card}
          onApprove={onApprove}
          approving={false}
          hideUniversalActions={card.state === "AGUARDANDO_CLIENTE"}
        />
      </ul>
    </QueryClientProvider>,
  );
  const botao = screen.getByRole("button", { name: /Aprovar e lançar/ }) as HTMLButtonElement;
  return { onApprove, botao };
}

const TITULO_JANELA_33 = "Lançar oc 33 — Reversão de Perdas (sem 44)";
const PERGUNTA_POPUP = /O cliente informou essa informacao/;

beforeEach(() => {
  popup.flagConfirma33 = true;
  popup.temAnexoNoCard = true;
});

describe("cartão simples — 33 que a parede vai recusar (o caso da NF 387252)", () => {
  it("card em AGUARDANDO_CLIENTE: o clique abre o POP-UP, não a janela de anexos", () => {
    const { botao, onApprove } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_SEM_DESCRICAO),
      todoCom(OC33_SOLO_BLOQUEADA),
    );
    expect(botao.disabled).toBe(false);
    // O aviso convida pelos DOIS caminhos (opção b do Carlos).
    expect(screen.getByText(/no e-mail ou em anexo/)).toBeTruthy();

    fireEvent.click(botao);

    expect(screen.getByText(PERGUNTA_POPUP)).toBeTruthy();
    expect(screen.queryByText(TITULO_JANELA_33)).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("vale também para TRANSFERIDO (todo estado fora da validação humana)", () => {
    const { botao } = montar(
      cardEm("TRANSFERIDO", DOSSIE_SEM_DESCRICAO),
      todoCom(OC33_SOLO_BLOQUEADA),
    );
    fireEvent.click(botao);
    expect(screen.getByText(PERGUNTA_POPUP)).toBeTruthy();
  });

  it("sem a chave do pop-up: botão nasce APAGADO e diz o motivo", () => {
    popup.flagConfirma33 = false;
    const { botao, onApprove } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_SEM_DESCRICAO),
      todoCom(OC33_SOLO_BLOQUEADA),
    );
    expect(botao.disabled).toBe(true);
    expect(screen.getByText(/Lançamento bloqueado/)).toBeTruthy();
    fireEvent.click(botao);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("card sem anexo do cliente: sem pop-up, botão apagado (regra de 16/09 mantida)", () => {
    popup.temAnexoNoCard = false;
    const { botao } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_SEM_DESCRICAO),
      todoCom(OC33_SOLO_BLOQUEADA),
    );
    expect(botao.disabled).toBe(true);
  });

  it("combo 33+44 bloqueado: apagado — fica fora do pop-up por decisão do Carlos", () => {
    const { botao } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_SEM_DESCRICAO),
      todoCom({
        tool: "lancar_combo_33_44",
        args: { nf: "387252", codigo_ssw: 33 },
        meta: { tipo_acao: "combo_33_44", tinha_intencao_email: false, gate_oc33: GATE_BLOQUEADO },
      }),
    );
    expect(botao.disabled).toBe(true);
  });
});

describe("cartão simples — NÃO-REGRESSÃO: o que já funcionava continua igual", () => {
  it("33 com dossiê completo (carimbo não bloqueado): botão aceso e abre a janela de anexos direto", () => {
    const { botao } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_COMPLETO),
      todoCom({
        ...OC33_SOLO_BLOQUEADA,
        meta: { tipo_acao: "oc33_solo", tinha_intencao_email: false, gate_oc33: { bloqueada: false } },
      }),
    );
    expect(botao.disabled).toBe(false);
    expect(screen.queryByText(/Lançamento bloqueado/)).toBeNull();
    fireEvent.click(botao);
    expect(screen.getByText(TITULO_JANELA_33)).toBeTruthy();
    expect(screen.queryByText(PERGUNTA_POPUP)).toBeNull();
  });

  it("33 sem carimbo nenhum: a parede deixa passar, então a tela também não apaga", () => {
    const { botao } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_COMPLETO),
      todoCom({ tool: "lancar_oc33_solo_portal", args: { codigo_ssw: 33 }, meta: { tipo_acao: "oc33_solo" } }),
    );
    expect(botao.disabled).toBe(false);
  });

  it("ocorrência que não é 33 (59 sem e-mail): aprova direto, sem aviso e sem pop-up", () => {
    const { botao, onApprove } = montar(
      cardEm("AGUARDANDO_CLIENTE", DOSSIE_SEM_DESCRICAO),
      todoCom({
        tool: "lancar_ocorrencia",
        args: { nf: "387252", codigo_ssw: 59 },
        meta: { tipo_acao: "relancamento_54", tinha_intencao_email: false },
      }),
    );
    expect(botao.disabled).toBe(false);
    expect(screen.queryByText(/no e-mail ou em anexo/)).toBeNull();
    fireEvent.click(botao);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PERGUNTA_POPUP)).toBeNull();
  });
});
