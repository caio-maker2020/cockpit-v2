import { describe, it, expect } from "vitest";
import { resolverDestinatariosIniciais } from "./destinatariosIniciais";

describe("resolverDestinatariosIniciais", () => {
  it("a escolha salva vence a sugestão escalar do preview", () => {
    expect(
      resolverDestinatariosIniciais(["a@x.com", "b@x.com"], "a@x.com"),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("preserva a ordem salva — o 1º vira TO e os demais CC", () => {
    expect(
      resolverDestinatariosIniciais(["b@x.com", "a@x.com"], "a@x.com"),
    ).toEqual(["b@x.com", "a@x.com"]);
  });

  it("sem lista salva, cai no destino do preview (fluxos que não passam a prop)", () => {
    expect(resolverDestinatariosIniciais(null, "a@x.com")).toEqual(["a@x.com"]);
    expect(resolverDestinatariosIniciais(undefined, "a@x.com")).toEqual(["a@x.com"]);
    expect(resolverDestinatariosIniciais([], "a@x.com")).toEqual(["a@x.com"]);
  });

  it("sem lista e sem destino, ninguém marcado (obriga o operador a informar)", () => {
    expect(resolverDestinatariosIniciais(null, null)).toEqual([]);
    expect(resolverDestinatariosIniciais([], "   ")).toEqual([]);
  });

  it("descarta vazios e não-strings — o executor também filtra por trim()", () => {
    expect(
      resolverDestinatariosIniciais(["a@x.com", "", "   ", 42, null], null),
    ).toEqual(["a@x.com"]);
  });

  it("lista só de lixo cai no fallback do preview em vez de zerar", () => {
    expect(resolverDestinatariosIniciais(["", "  "], "a@x.com")).toEqual(["a@x.com"]);
  });

  it("remove duplicados mantendo a primeira ocorrência (não troca o TO)", () => {
    expect(
      resolverDestinatariosIniciais(["b@x.com", "a@x.com", "b@x.com"], null),
    ).toEqual(["b@x.com", "a@x.com"]);
  });

  it("aplica trim sem reordenar", () => {
    expect(resolverDestinatariosIniciais([" b@x.com ", "a@x.com"], null)).toEqual([
      "b@x.com",
      "a@x.com",
    ]);
  });

  it("ignora payload que não é array (defensivo contra JSON corrompido)", () => {
    expect(resolverDestinatariosIniciais("a@x.com", "b@x.com")).toEqual(["b@x.com"]);
    expect(resolverDestinatariosIniciais({ 0: "a@x.com" }, "b@x.com")).toEqual(["b@x.com"]);
  });
});
