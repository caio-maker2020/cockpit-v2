import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCanalPergunta,
  enviarPerguntaParaChat,
  ouvirPerguntasDoPlacar,
} from "./perguntaParaChat";

beforeEach(() => _resetCanalPergunta());

describe("canal placar → chat", () => {
  it("entrega a pergunta a quem está ouvindo", () => {
    const ouvinte = vi.fn();
    ouvirPerguntasDoPlacar(ouvinte);
    enviarPerguntaParaChat("por que sugere 54?");
    expect(ouvinte).toHaveBeenCalledWith("por que sugere 54?");
  });

  it("guarda a pendente se o chat ainda não montou (não perde o clique)", async () => {
    enviarPerguntaParaChat("pergunta antecipada");
    const ouvinte = vi.fn();
    ouvirPerguntasDoPlacar(ouvinte);
    await Promise.resolve(); // queueMicrotask
    expect(ouvinte).toHaveBeenCalledWith("pergunta antecipada");
  });

  it("a pendente é entregue UMA vez só", async () => {
    enviarPerguntaParaChat("uma vez");
    const a = vi.fn();
    ouvirPerguntasDoPlacar(a);
    await Promise.resolve();
    const b = vi.fn();
    ouvirPerguntasDoPlacar(b);
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("texto vazio não dispara nada", () => {
    const ouvinte = vi.fn();
    ouvirPerguntasDoPlacar(ouvinte);
    enviarPerguntaParaChat("   ");
    expect(ouvinte).not.toHaveBeenCalled();
  });

  it("cancelar a assinatura para de receber (sem vazar no unmount)", () => {
    const ouvinte = vi.fn();
    const cancelar = ouvirPerguntasDoPlacar(ouvinte);
    cancelar();
    enviarPerguntaParaChat("depois do unmount");
    expect(ouvinte).not.toHaveBeenCalled();
  });
});
