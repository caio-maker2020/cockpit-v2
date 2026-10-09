// O hub com números falhando: o que falhou vira "—", o resto continua.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ operador: { nome: "Caio Teste", papel: "gestor" }, user: { email: "x@y" } }) }));
vi.mock("@/contexts/OperacaoContext", () => ({
  useAreas: () => ({ ehGestor: true, veRelacionamento: true, podeAbrirOperacao: true, carregando: false, carregandoOperacao: false }),
}));
const ok = (v: number) => ({ valor: v, carregando: false, erro: false });
const falhou = { valor: null, carregando: false, erro: true };
vi.mock("@/components/inicio/useNumerosHub", () => ({
  useNumerosRelacionamento: () => ({ aguardando: ok(7), clienteRespondeu: falhou, slaRisco: ok(2), escopo: "da equipe toda" }),
  useNumerosOperacao: () => ({
    precisaVoce: ok(30), comSugestao: ok(4), conselheiro: ok(1), total: ok(40),
    gargalo: { unidade: "VGA", paradas: 5, setor: "Entrega" }, carregando: false, erro: false,
  }),
}));

import Inicio from "./Inicio";

describe("hub do gestor", () => {
  it("mostra as duas áreas, destaca a mais urgente e não cai com um número quebrado", () => {
    render(<MemoryRouter><Inicio /></MemoryRouter>);
    const rel = screen.getByRole("link", { name: /^Relacionamento\./ });
    const op = screen.getByRole("link", { name: /^Operação\./ });
    expect(rel).toHaveAttribute("href", "/inbox");
    expect(op).toHaveAttribute("href", "/operacao");
    expect(rel.getAttribute("aria-label")).toContain("Cliente respondeu: indisponível");
    expect(op.textContent).toContain("Mais urgente agora");
    expect(op.textContent).toContain("VGA");
    expect(screen.getByRole("link", { name: /Gestão Agentes/ })).toHaveAttribute("href", "/gestao-agentes");
    expect(screen.getByRole("link", { name: /Torre/ })).toHaveAttribute("href", "/operacao");
  });
});
