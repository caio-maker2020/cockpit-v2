import { describe, it, expect } from "vitest";
import {
  resolverDestinatariosIniciais,
  unirSelecaoComTodosOsContatos,
} from "./destinatariosIniciais";

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

describe("unirSelecaoComTodosOsContatos", () => {
  it("acrescenta os contatos que faltam sem mexer em quem já está marcado", () => {
    expect(
      unirSelecaoComTodosOsContatos(["a@x.com"], ["a@x.com", "b@x.com", "c@x.com"]),
    ).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("NUNCA troca o TO — a seleção atual fica na frente", () => {
    // 'c' é o destino que o backend escolheu; a lista de contatos vem noutra ordem.
    expect(
      unirSelecaoComTodosOsContatos(["c@x.com"], ["a@x.com", "b@x.com", "c@x.com"]),
    ).toEqual(["c@x.com", "a@x.com", "b@x.com"]);
  });

  it("sem destino sugerido, usa a ordem dos contatos", () => {
    expect(unirSelecaoComTodosOsContatos([], ["a@x.com", "b@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("não duplica quando o destino já está na lista de contatos", () => {
    expect(unirSelecaoComTodosOsContatos(["a@x.com"], ["a@x.com"])).toEqual(["a@x.com"]);
  });

  it("sem teto de quantidade — cliente de 11 contatos entra inteiro", () => {
    const muitos = Array.from({ length: 11 }, (_, i) => `c${i}@x.com`);
    expect(unirSelecaoComTodosOsContatos(["c0@x.com"], muitos)).toHaveLength(11);
  });

  it("higieniza vazios, duplicados e não-strings dos dois lados", () => {
    expect(
      unirSelecaoComTodosOsContatos([" a@x.com ", ""], ["a@x.com", null, "  ", "b@x.com"]),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("contatos ausentes não zeram a seleção atual", () => {
    expect(unirSelecaoComTodosOsContatos(["a@x.com"], null)).toEqual(["a@x.com"]);
  });
});
