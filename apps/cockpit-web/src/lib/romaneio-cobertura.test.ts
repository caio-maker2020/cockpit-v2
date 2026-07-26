import { describe, expect, it } from "vitest";
import { anexosCobremRomaneio, romaneioExigidoDoCard } from "./romaneio-cobertura";

const ROM = "Sal 17-07_260717_145833.pdf"; // romaneio REAL da NF 158084

describe("anexosCobremRomaneio (espelho do _shared — mudar nos dois)", () => {
  it("ÂNCORA NF 158084: páginas convertidas cobrem; assinatura não", () => {
    expect(anexosCobremRomaneio(["Sal_17-07_260717_145833_p1.jpg"], ROM)).toBe(true);
    expect(anexosCobremRomaneio(["image001.png"], ROM)).toBe(false);
    expect(anexosCobremRomaneio([], ROM)).toBe(false);
  });
});

describe("romaneioExigidoDoCard", () => {
  it("dossiê caso 1 com romaneio fonte=anexo → exige", () => {
    const r = romaneioExigidoDoCard({
      agent_state: { extravio_parcial: { caso: "1", dossie: { romaneio: { presente: true, fonte: "anexo", filename: ROM, mime_type: "application/pdf" } } } },
    });
    expect(r?.filename).toBe(ROM);
  });
  it("sem dossiê / fonte ssw / caso fora → não exige (modal não bloqueia)", () => {
    expect(romaneioExigidoDoCard({ agent_state: null })).toBe(null);
    expect(
      romaneioExigidoDoCard({
        agent_state: { extravio_parcial: { caso: "1", dossie: { romaneio: { presente: true, fonte: "ssw", filename: "x.jpg" } } } },
      }),
    ).toBe(null);
  });
});
