// As rotas de verdade (App) não mudam para operador do Relacionamento nem para membro
// da Operação; o gestor cai no hub. Renderiza as guardas reais com a decisão real.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { decidirAreas, type EntradaAreas } from "@/lib/operacao/areas";

let entrada: EntradaAreas;
vi.mock("@/contexts/OperacaoContext", () => ({ useAreas: () => decidirAreas(entrada) }));

import { RotaInicial, SoGestor, SoOperacao, SoRelacionamento } from "./AreaGuard";

function montar(rota: string) {
  return render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes>
        <Route path="/" element={<RotaInicial />} />
        <Route element={<SoGestor />}>
          <Route path="/inicio" element={<p>HUB</p>} />
        </Route>
        <Route element={<SoRelacionamento />}>
          <Route path="/inbox" element={<p>INBOX</p>} />
          <Route path="/cards/:id" element={<p>CARD</p>} />
        </Route>
        <Route element={<SoOperacao />}>
          <Route path="/operacao" element={<p>OPERACAO</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const base = { operador: null, operadorCarregado: true, sessao: null, sessaoCarregada: true };
const membro = { membro: { nome: "Ana", papel_op: "operador_op", unidades: [] }, eh_gestor: false, eh_supervisor: false, flags: { operacao_tela: true } } as never;

describe("entrada no Cockpit", () => {
  beforeEach(() => {
    entrada = { ...base };
  });
  it("operador do Relacionamento: / → Inbox, e /inicio também o devolve ao Inbox", () => {
    entrada = { ...base, operador: { papel: "operador" } };
    montar("/");
    expect(screen.getByText("INBOX")).toBeInTheDocument();
  });
  it("operador do Relacionamento que digita /inicio vai ao Inbox", () => {
    entrada = { ...base, operador: { papel: "operador" } };
    montar("/inicio");
    expect(screen.getByText("INBOX")).toBeInTheDocument();
  });
  it("operador do Relacionamento ainda abre card direto", () => {
    entrada = { ...base, operador: { papel: "operador" } };
    montar("/cards/1");
    expect(screen.getByText("CARD")).toBeInTheDocument();
  });
  it("membro só da Operação: / → /operacao; /inicio → /operacao", () => {
    entrada = { ...base, sessao: membro };
    montar("/");
    expect(screen.getByText("OPERACAO")).toBeInTheDocument();
  });
  it("membro só da Operação que digita /inicio vai à Operação", () => {
    entrada = { ...base, sessao: membro };
    montar("/inicio");
    expect(screen.getByText("OPERACAO")).toBeInTheDocument();
  });
  it("gestor: / → hub, e ainda abre o Inbox e a Operação", () => {
    entrada = { ...base, operador: { papel: "gestor" } };
    montar("/");
    expect(screen.getByText("HUB")).toBeInTheDocument();
  });
  it("gestor membro da Operação: / → hub", () => {
    entrada = { ...base, operador: { papel: "gestor" }, sessao: membro };
    montar("/");
    expect(screen.getByText("HUB")).toBeInTheDocument();
  });
  it("membro carregando: não mostra Inbox nem hub antes de saber", () => {
    entrada = { ...base, sessaoCarregada: false };
    montar("/");
    expect(screen.getByText(/Carregando seu acesso/)).toBeInTheDocument();
  });
});
