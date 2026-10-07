// Separação de ROTAS Relacionamento × Operação (ADR 0041 D2, INV-180).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Areas } from "@/lib/operacao/areas";

let areas: Areas;
vi.mock("@/contexts/OperacaoContext", () => ({ useAreas: () => areas }));

import { SoOperacao, SoRelacionamento } from "./AreaGuard";

function app(rota: string) {
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route element={<SoRelacionamento />}>
          <Route path="/inbox" element={<div>TELA INBOX</div>} />
          <Route path="/extravios" element={<div>TELA EXTRAVIOS</div>} />
        </Route>
        <Route element={<SoOperacao />}>
          <Route path="/operacao" element={<div>TELA OPERACAO</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const A = (p: Partial<Areas>): Areas => ({
  carregando: false,
  carregandoOperacao: false,
  ehGestor: false,
  ehMembroOp: false,
  veRelacionamento: false,
  podeAbrirOperacao: false,
  menuOperacao: false,
  telaLigada: true,
  ...p,
});

describe("separação de rotas", () => {
  it("membro só da Operação que abre o Inbox vai para /operacao", () => {
    areas = A({ ehMembroOp: true, podeAbrirOperacao: true, menuOperacao: true });
    app("/inbox");
    expect(screen.getByText("TELA OPERACAO")).toBeInTheDocument();
    expect(screen.queryByText("TELA INBOX")).not.toBeInTheDocument();
  });

  it("membro só da Operação também não abre extravios por URL", () => {
    areas = A({ ehMembroOp: true, podeAbrirOperacao: true });
    app("/extravios");
    expect(screen.getByText("TELA OPERACAO")).toBeInTheDocument();
  });

  it("operador do Relacionamento que abre /operacao volta para o Inbox", () => {
    areas = A({ veRelacionamento: true });
    app("/operacao");
    expect(screen.getByText("TELA INBOX")).toBeInTheDocument();
    expect(screen.queryByText("TELA OPERACAO")).not.toBeInTheDocument();
  });

  it("gestor abre os dois", () => {
    areas = A({ veRelacionamento: true, podeAbrirOperacao: true, ehGestor: true });
    const { unmount } = app("/inbox");
    expect(screen.getByText("TELA INBOX")).toBeInTheDocument();
    unmount();
    app("/operacao");
    expect(screen.getByText("TELA OPERACAO")).toBeInTheDocument();
  });

  it("enquanto o acesso carrega, não mostra a tela nem redireciona", () => {
    areas = A({ carregando: true, carregandoOperacao: true });
    app("/inbox");
    expect(screen.getByText(/Carregando seu acesso/)).toBeInTheDocument();
    expect(screen.queryByText("TELA INBOX")).not.toBeInTheDocument();
    expect(screen.queryByText("TELA OPERACAO")).not.toBeInTheDocument();
  });
});
