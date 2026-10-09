import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComprovantePendente, OpRespostaComprovantes } from "@/lib/operacao/comprovantes";
import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { ComprovantesOperacao } from "./ComprovantesOperacao";

const AGORA = Date.parse("2026-10-08T15:00:00Z");
const diasAtras = (d: number) => new Date(Date.UTC(2026, 9, 8 - d)).toISOString().slice(0, 10);

let seq = 0;
function c(p: Partial<ComprovantePendente> = {}): ComprovantePendente {
  seq++;
  return {
    ctrc: `VGA${seq}-1`, nf: `${100 + seq}`, unidade: "VGA", base_nome: "VARGINHA", base_tipo: "filial", cliente_pagador: "CLIENTE A",
    placa: "AAA1B11", data_entrega: diasAtras(3), descricao_oc: "MERCADORIA ENTREGUE", valor_frete: 100, valor_mercadoria: 1000, origem: "fonte", ...p,
  };
}
function ok(linhas: ComprovantePendente[], p: Partial<Extract<OpRespostaComprovantes, { ok: true }>> = {}): OpRespostaComprovantes {
  return { ok: true, linhas, entregues: 96, ultimaAtualizacao: "2026-10-07", escopo: { todas: true, unidades: [] }, excluidas: 0, ...p };
}
function linhaFila(p: Partial<OpFilaLinha>): OpFilaLinha {
  return { op_item_id: "f1", ctrc: "X", nf: null, unidade: "POA", cod_ultima_ocorrencia: 12, descricao_oc: "COMPROVANTE RETIDO PARA CONFERENCIA", data_ultima_ocorrencia: "2026-10-01", ...p } as OpFilaLinha;
}
const base = { linhas: [] as OpFilaLinha[], agoraMs: AGORA, onAbrirNota: () => {}, demo: false };

afterEach(() => vi.restoreAllMocks());

describe("ComprovantesOperacao", () => {
  it("barra compacta: pendentes, % de pendência, frete, mercadoria e mediana; data sem deslocar fuso", () => {
    render(<ComprovantesOperacao {...base} resposta={ok([c(), c({ data_entrega: diasAtras(9) }), c(), c({ unidade: "POA", data_entrega: diasAtras(100) })])} />);
    expect(screen.getByText("Pendentes").nextSibling).toHaveTextContent("4");
    expect(screen.getByText("% de pendência").nextSibling).toHaveTextContent("4%");
    expect(screen.getByText("Mediana de idade").nextSibling).toHaveTextContent("6 dias");
    expect(screen.getByText(/último escaneamento 07\/10\/2026/)).toBeInTheDocument();
  });

  it("cartões por base, a pior primeiro; abre as notas por placa e 'Abrir na fila' para a oc 12", () => {
    const onAbrir = vi.fn();
    const real = c({ ctrc: "POA77-1", nf: "777", unidade: "POA", base_nome: "PORTO ALEGRE", data_entrega: diasAtras(200), placa: "ZZZ9Z99" });
    render(<ComprovantesOperacao {...base} onAbrirNota={onAbrir} linhas={[linhaFila({ op_item_id: "real-12", ctrc: "POA77-1" })]} resposta={ok([c(), c(), real])} />);
    const cartoes = screen.getByRole("list", { name: "Bases, da pior para a melhor" }).querySelectorAll(":scope > li");
    expect(cartoes[0]).toHaveTextContent("POA");
    expect(cartoes[1]).toHaveTextContent("VGA");
    fireEvent.click(within(cartoes[0] as HTMLElement).getByRole("button", { name: /Ver as notas de POA/ }));
    expect(within(cartoes[0] as HTMLElement).getByText("ZZZ9Z99")).toBeInTheDocument();
    expect(within(cartoes[0] as HTMLElement).getByText(/entregue 22\/03\/2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir NF 777 na fila" }));
    expect(onAbrir).toHaveBeenCalledWith("real-12");
  });

  it("Cobrar base: confirma, copia o texto e baixa o CSV da base; nada é enviado", async () => {
    const writeText = vi.fn((_texto: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ComprovantesOperacao {...base} resposta={ok([c({ ctrc: "VGA9-1", nf: "55", placa: "PLC1A23" }), c({ unidade: "POA" })])} />);
    fireEvent.click(screen.getByRole("button", { name: "Cobrar base VGA" }));
    expect(screen.getByTestId("texto-cobranca")).toHaveTextContent("VGA9-1 | 55 | CLIENTE A | 3 dias");
    expect(clique).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copiar texto e baixar CSV/ }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("base VGA (VARGINHA)");
    expect(writeText.mock.calls[0]![0]).toContain("Placas com mais pendências: PLC1A23 (1)");
    expect(clique).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^Base VGA cobrada às \d{2}:\d{2}/ })).toBeInTheDocument();
  });

  it("Exportar tudo baixa um CSV", () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const clique = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ComprovantesOperacao {...base} resposta={ok([c()])} />);
    fireEvent.click(screen.getByRole("button", { name: "Exportar tudo (CSV)" }));
    expect(clique).toHaveBeenCalledTimes(1);
  });

  it("filial escolhida na barra recorta a lista e esconde o %", () => {
    render(<ComprovantesOperacao {...base} filial="POA" resposta={ok([c(), c({ unidade: "POA" })])} />);
    expect(screen.getByText("Pendentes").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("% de pendência").nextSibling).toHaveTextContent("—");
    expect(screen.queryByRole("button", { name: "Cobrar base VGA" })).toBeNull();
  });

  it("sem credencial: estado explícito, sem dado fictício", () => {
    render(<ComprovantesOperacao {...base} resposta={{ ok: false, erro: "comprovantes_sem_credencial" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Comprovantes sem credencial");
    expect(screen.queryByText("Pendentes")).toBeNull();
  });

  it("fonte com erro: mostra o motivo e deixa tentar de novo", () => {
    const tentar = vi.fn();
    render(<ComprovantesOperacao {...base} onTentarDeNovo={tentar} resposta={{ ok: false, erro: "fonte_falhou", motivo: "fonte 500" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("A fonte respondeu: fonte 500");
    fireEvent.click(screen.getByRole("button", { name: "Tentar ler os comprovantes de novo" }));
    expect(tentar).toHaveBeenCalled();
  });

  it("carregando, vazio e cadastro sem unidade", () => {
    const { rerender } = render(<ComprovantesOperacao {...base} resposta={undefined} />);
    expect(screen.getByText("Lendo os comprovantes")).toBeInTheDocument();
    rerender(<ComprovantesOperacao {...base} resposta={ok([])} />);
    expect(screen.getByText("Nenhum comprovante pendente")).toBeInTheDocument();
    rerender(<ComprovantesOperacao {...base} resposta={ok([], { escopo: { todas: false, unidades: [] } })} />);
    expect(screen.getByText("Seu cadastro não tem unidade")).toBeInTheDocument();
  });
});
