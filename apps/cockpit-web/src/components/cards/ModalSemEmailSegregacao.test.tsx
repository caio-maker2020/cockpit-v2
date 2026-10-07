// GUARD — painel do gêmeo "SEM e-mail" com a caixa "Segregar CTRC" (Carlos
// 2026-10-06, Larissa/PRATI — ADR 0033 (a) emendado).
//
// O que este painel NÃO pode perder, porque substitui um window.confirm numa
// ação que barra carga e o Cockpit não desfaz (retirada manual, opção 091):
//   - o aviso do confirm ("o cliente NÃO será notificado");
//   - o CT-e do card À VISTA (o motivo de o ADR exigir painel, não confirm);
//   - a caixa nascendo DESMARCADA e o valor indo SEMPRE como booleano;
//   - cancelar não aprova nada.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalSemEmailSegregacao, TEXTO_CAIXA_SEGREGAR } from "./ModalSemEmailSegregacao";

function renderModal(over: Partial<Parameters<typeof ModalSemEmailSegregacao>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ModalSemEmailSegregacao
      codigo={54}
      nf="1046448"
      ctrc="ABC123456-7"
      submitting={false}
      onClose={onClose}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onClose };
}

describe("ModalSemEmailSegregacao", () => {
  it("repete o aviso do confirm: lança a oc e o cliente NÃO será notificado", () => {
    renderModal({ codigo: 59 });
    expect(screen.getByText(/lança a oc 59 no SSW mas NÃO envia e-mail/)).toBeTruthy();
    expect(screen.getByText(/O cliente NÃO será notificado/)).toBeTruthy();
  });

  it("mostra o CT-e do card (decisão de barrar carga nunca às cegas)", () => {
    renderModal();
    expect(screen.getByTestId("ctrc-do-card").textContent).toBe("ABC123456-7");
  });

  it("a caixa de segregar nasce DESMARCADA e avisa que o Cockpit não desfaz (091)", () => {
    renderModal();
    const caixa = screen.getByRole("checkbox") as HTMLInputElement;
    expect(caixa.checked).toBe(false);
    expect(screen.getByText(TEXTO_CAIXA_SEGREGAR)).toBeTruthy();
    expect(screen.getByText(/opcao 091/)).toBeTruthy();
  });

  it("confirmar SEM marcar envia false (booleano, nunca omitido)", () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByText("Confirmar lançamento sem e-mail"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("confirmar MARCADA envia true", () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Confirmar lançamento sem e-mail"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("cancelar fecha e NÃO aprova", () => {
    const { onConfirm, onClose } = renderModal();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Cancelar"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("enquanto lança, não deixa clicar de novo", () => {
    renderModal({ submitting: true });
    expect((screen.getByText("Lançando…") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});
