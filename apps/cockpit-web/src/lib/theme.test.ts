// Guard INV-112 (Caio 26-27/08): o modo escuro é OPCIONAL e o padrão é o
// claro — valor ausente/corrompido NUNCA pode cair no escuro, e alternar é
// simétrico. Se normalizarTema mudar o default, operador abriria o Cockpit
// num tema que nunca escolheu.
// Stubs próprios de document/localStorage (jsdom 20 não sobe no vitest 3 —
// e a lib só toca classList + storage, então o stub cobre o contrato inteiro).
import { beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();
const classes = new Set<string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  clear: () => store.clear(),
};
(globalThis as Record<string, unknown>).document = {
  documentElement: {
    classList: {
      toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
      contains: (c: string) => classes.has(c),
      remove: (c: string) => void classes.delete(c),
    },
  },
};

const { alternarTema, aplicarTema, CHAVE_TEMA, lerTema, normalizarTema } = await import("./theme");

describe("modo escuro opcional — contrato (INV-112)", () => {
  beforeEach(() => {
    store.clear();
    classes.clear();
  });

  it("padrão é claro: storage vazio, nulo ou lixo → claro", () => {
    expect(normalizarTema(null)).toBe("claro");
    expect(normalizarTema(undefined)).toBe("claro");
    expect(normalizarTema("")).toBe("claro");
    expect(normalizarTema("dark")).toBe("claro"); // só o literal 'escuro' ativa
    expect(normalizarTema("qualquer-lixo")).toBe("claro");
    expect(lerTema()).toBe("claro");
  });

  it("aplicar escuro põe a classe no <html> e persiste; claro remove", () => {
    aplicarTema("escuro");
    expect(classes.has("dark")).toBe(true);
    expect(store.get(CHAVE_TEMA)).toBe("escuro");
    aplicarTema("claro");
    expect(classes.has("dark")).toBe(false);
    expect(store.get(CHAVE_TEMA)).toBe("claro");
  });

  it("alternar é simétrico e devolve o tema novo", () => {
    expect(alternarTema()).toBe("escuro");
    expect(alternarTema()).toBe("claro");
    expect(classes.has("dark")).toBe(false);
  });
});
