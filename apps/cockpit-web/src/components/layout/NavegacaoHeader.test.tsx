// Render: os itens aparecem com o rótulo e o contador; o menu "Gestão" abre com os itens de gestão.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NavegacaoHeader } from "./NavegacaoHeader";
import { itensNavegacao } from "./navegacao";

const nav = itensNavegacao({ rel: true, isGestor: true, temOperador: true, isAdmin: false, vePdi: false, menuOperacao: true, hub: true });

describe("NavegacaoHeader", () => {
  it("pílulas de trabalho com contador e aria-current na ativa", () => {
    render(
      <MemoryRouter initialEntries={["/conflitos"]}>
        <NavegacaoHeader nav={nav} contagens={{ inbox: 6, conflitos: 31, reentregas: 0 }} />
      </MemoryRouter>,
    );
    const principal = screen.getByRole("navigation", { name: "Principal" });
    expect(principal.querySelector('a[href="/inbox"]')?.getAttribute("aria-label")).toBe("Inbox, 6");
    expect(principal.querySelector('a[href="/conflitos"]')?.getAttribute("aria-current")).toBe("page");
    expect(principal.querySelector('a[href="/cancelamentos-reentrega"]')?.textContent).toBe("Reentregas");
    expect(screen.getByRole("button", { name: /Gestão/ })).toBeInTheDocument();
  });
  it("o menu Gestão traz Gestão Agentes, Gestão Operadores, Aprendizado e o antigo Mais", () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <NavegacaoHeader nav={nav} contagens={{ inbox: 0, conflitos: 0, reentregas: 0 }} />
      </MemoryRouter>,
    );
    const botao = screen.getByRole("button", { name: /Gestão/ });
    fireEvent.pointerDown(botao, { button: 0, ctrlKey: false });
    fireEvent.keyDown(botao, { key: "Enter" });
    for (const r of ["Gestão Agentes", "Gestão Operadores", "Aprendizado", "Auditoria", "Cadastros", "Configurações"]) {
      expect(screen.getByRole("menuitem", { name: r })).toBeInTheDocument();
    }
  });
});
