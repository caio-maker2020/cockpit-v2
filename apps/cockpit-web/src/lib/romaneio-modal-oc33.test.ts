import { describe, expect, it } from "vitest";
import { anexosCobremRomaneio, romaneioExigidoDoCard } from "./romaneio-cobertura";
import {
  avisoRomaneioIndisponivel,
  decidirConfirmacaoRomaneio,
  rebuscaDoRomaneioJaFalhou,
  romaneioDoDossie,
  situacaoRomaneioNoModal,
  type FalhaDeRebusca,
  type RomaneioDoDossie,
} from "./romaneio-modal-oc33";

// Dados REAIS da NF 435297 (Karoline, 29/09): a 1ª 33 (03/09) levou o romaneio
// e ele foi apagado no mesmo minuto; a lista do modal só oferecia a NF-e.
const ROM_435297: RomaneioDoDossie = {
  filename: "WhatsApp Image 2026-09-02 at 17.54.29.jpeg",
  mime_type: "image/jpeg",
  visto_em: "2026-09-03T11:17:42.442Z",
};
const LISTA_435297 = ["NFE-436050.pdf"];
const SELECAO_435297 = ["NFE-436050_p1.jpg"]; // a NF-e convertida pelo modal

// Romaneio REAL da NF 158084 (PDF) — o caso que originou a trava em 25/07.
const ROM_PDF: RomaneioDoDossie = {
  filename: "Sal 17-07_260717_145833.pdf",
  mime_type: "application/pdf",
  visto_em: "2026-07-17T12:00:00Z",
};

const TEXTO_DE_SEMPRE =
  "A oc 33 de completude exige o romaneio anexado. Selecione-o na lista (PDF é convertido pra JPEG automaticamente) — sem ele o SSW reverte o lançamento.";

function situacao(
  romaneio: RomaneioDoDossie | null,
  nomesNaLista: string[],
  modal: "solo" | "combo",
  falhasDeRebusca: FalhaDeRebusca[] = [],
  carregado = true,
) {
  return situacaoRomaneioNoModal({ romaneio, nomesNaLista, modal, falhasDeRebusca, carregado });
}

describe("ÂNCORA NF 435297 — romaneio já enviado e apagado", () => {
  it("33 sozinha: deixa de pedir o impossível — segue e o executor busca no e-mail", () => {
    const s = situacao(ROM_435297, LISTA_435297, "solo");
    expect(s).toEqual({ tipo: "rebusca_no_email", filename: ROM_435297.filename });
    expect(decidirConfirmacaoRomaneio(s, SELECAO_435297)).toEqual({ tipo: "seguir" });
    // e o aviso conta à operadora o que vai acontecer ANTES do clique
    expect(avisoRomaneioIndisponivel(s)).toContain("busca esse arquivo de novo no e-mail do cliente");
  });

  it("a regra de antes de 29/09 barrava exatamente este caso (o que o fix muda)", () => {
    const regraAntiga = !anexosCobremRomaneio(SELECAO_435297, ROM_435297.filename);
    expect(regraAntiga).toBe(true);
  });

  it("33+44: continua barrando (o executor do combo não busca o romaneio)", () => {
    const s = situacao(ROM_435297, LISTA_435297, "combo");
    expect(s).toEqual({ tipo: "anexar_manual", filename: ROM_435297.filename, motivo: "combo" });
    const d = decidirConfirmacaoRomaneio(s, SELECAO_435297);
    expect(d.tipo).toBe("bloquear");
    // o texto novo não manda mais "selecionar na lista"
    if (d.tipo === "bloquear") {
      expect(d.descricao).not.toContain("Selecione-o na lista");
      expect(d.descricao).toContain("+ Adicionar arquivo");
    }
  });

  it("caminho manual: subir a MESMA imagem com o MESMO nome passa nos dois modais", () => {
    for (const modal of ["solo", "combo"] as const) {
      const s = situacao(ROM_435297, LISTA_435297, modal);
      expect(decidirConfirmacaoRomaneio(s, [...SELECAO_435297, ROM_435297.filename])).toEqual({ tipo: "seguir" });
    }
  });
});

describe("o que NÃO muda", () => {
  it("romaneio na lista e não marcado: barra com o texto de sempre (solo e combo)", () => {
    for (const modal of ["solo", "combo"] as const) {
      const s = situacao(ROM_435297, [...LISTA_435297, ROM_435297.filename], modal);
      expect(s.tipo).toBe("na_lista");
      expect(decidirConfirmacaoRomaneio(s, SELECAO_435297)).toEqual({
        tipo: "bloquear",
        titulo: `Anexe o romaneio do dossiê: "${ROM_435297.filename}"`,
        descricao: TEXTO_DE_SEMPRE,
      });
      expect(avisoRomaneioIndisponivel(s)).toBe(null);
    }
  });

  it("romaneio na lista e marcado: segue", () => {
    const s = situacao(ROM_435297, [ROM_435297.filename], "solo");
    expect(decidirConfirmacaoRomaneio(s, [ROM_435297.filename])).toEqual({ tipo: "seguir" });
  });

  it("romaneio PDF na lista: as páginas convertidas cobrem (NF 158084)", () => {
    const s = situacao(ROM_PDF, [ROM_PDF.filename], "solo");
    expect(s.tipo).toBe("na_lista");
    expect(decidirConfirmacaoRomaneio(s, ["Sal_17-07_260717_145833_p1.jpg"])).toEqual({ tipo: "seguir" });
    expect(decidirConfirmacaoRomaneio(s, ["image001.png"]).tipo).toBe("bloquear");
  });

  it("card sem romaneio exigido: segue sem aviso", () => {
    const s = situacao(null, LISTA_435297, "solo");
    expect(s).toEqual({ tipo: "nao_exigido" });
    expect(decidirConfirmacaoRomaneio(s, [])).toEqual({ tipo: "seguir" });
    expect(avisoRomaneioIndisponivel(s)).toBe(null);
  });

  it("lista ainda carregando (ou com erro): regra de antes — exige o romaneio", () => {
    const s = situacao(ROM_435297, [], "solo", [], /*carregado*/ false);
    expect(s.tipo).toBe("na_lista");
    expect(decidirConfirmacaoRomaneio(s, SELECAO_435297).tipo).toBe("bloquear");
  });

  it("MATRIZ: fora da busca no e-mail, bloqueia exatamente quando a regra antiga bloqueava", () => {
    const romaneios = [null, ROM_435297, ROM_PDF, { ...ROM_435297, mime_type: "image/png" }, { ...ROM_435297, mime_type: null }];
    const listas = [[], LISTA_435297, [ROM_435297.filename], [ROM_PDF.filename]];
    const selecoes = [[], SELECAO_435297, [ROM_435297.filename], ["Sal_17-07_260717_145833_p1.jpg"], ["image001.png"]];
    const falhas: FalhaDeRebusca[][] = [[], [{ created_at: "2026-09-10T00:00:00Z", payload: { faltando: ["romaneio"] } }]];
    let casos = 0;
    let novos = 0;
    for (const r of romaneios)
      for (const lista of listas)
        for (const sel of selecoes)
          for (const f of falhas)
            for (const modal of ["solo", "combo"] as const)
              for (const carregado of [true, false]) {
                const s = situacao(r, lista, modal, f, carregado);
                const d = decidirConfirmacaoRomaneio(s, sel);
                const antiga = !!r && !anexosCobremRomaneio(sel, r.filename);
                casos++;
                if (s.tipo === "rebusca_no_email") {
                  novos++;
                  // o único caso novo: só na 33 sozinha, só imagem, só com a lista carregada
                  expect(modal).toBe("solo");
                  expect(carregado).toBe(true);
                  expect(["image/jpeg", "image/png"]).toContain(r?.mime_type);
                  continue;
                }
                expect(d.tipo === "bloquear").toBe(antiga);
              }
    expect(casos).toBe(5 * 4 * 5 * 2 * 2 * 2);
    expect(novos).toBeGreaterThan(0);
  });
});

describe("quando a busca no e-mail não serve", () => {
  it("romaneio PDF apagado: continua barrando (o executor não converte PDF)", () => {
    const s = situacao(ROM_PDF, LISTA_435297, "solo");
    expect(s).toEqual({ tipo: "anexar_manual", filename: ROM_PDF.filename, motivo: "pdf" });
    expect(decidirConfirmacaoRomaneio(s, SELECAO_435297).tipo).toBe("bloquear");
  });

  it("tipo desconhecido (null) apagado: continua barrando", () => {
    const s = situacao({ ...ROM_435297, mime_type: null }, LISTA_435297, "solo");
    expect(s.tipo).toBe("anexar_manual");
  });

  it("busca já falhou neste card: volta o caminho manual (sem aprovar→reverter em loop)", () => {
    const falha = { created_at: "2026-09-29T18:00:00Z", payload: { faltando: ["romaneio"] } };
    const s = situacao(ROM_435297, LISTA_435297, "solo", [falha]);
    expect(s).toEqual({ tipo: "anexar_manual", filename: ROM_435297.filename, motivo: "rebusca_falhou" });
    expect(avisoRomaneioIndisponivel(s)).toContain("já tentou buscar de novo");
    expect(decidirConfirmacaoRomaneio(s, SELECAO_435297).tipo).toBe("bloquear");
    expect(decidirConfirmacaoRomaneio(s, [ROM_435297.filename])).toEqual({ tipo: "seguir" });
  });
});

describe("rebuscaDoRomaneioJaFalhou", () => {
  it("falha ANTERIOR ao romaneio atual não conta (era outro arquivo)", () => {
    expect(
      rebuscaDoRomaneioJaFalhou([{ created_at: "2026-09-01T00:00:00Z", payload: { faltando: ["romaneio"] } }], ROM_435297.visto_em),
    ).toBe(false);
  });
  it("falha só de descrição/valor não conta", () => {
    expect(
      rebuscaDoRomaneioJaFalhou([{ created_at: "2026-09-29T00:00:00Z", payload: { faltando: ["descrição (anexo)"] } }], ROM_435297.visto_em),
    ).toBe(false);
  });
  it("texto do executor para PDF também começa com 'romaneio'", () => {
    expect(
      rebuscaDoRomaneioJaFalhou(
        [{ created_at: "2026-09-29T00:00:00Z", payload: { faltando: ["romaneio (PDF — anexe pelo modal, que converte pra JPEG automaticamente)"] } }],
        null,
      ),
    ).toBe(true);
  });
  it("payload estranho não quebra", () => {
    expect(rebuscaDoRomaneioJaFalhou([{ created_at: "x", payload: null }], null)).toBe(false);
    expect(rebuscaDoRomaneioJaFalhou([{ created_at: "x", payload: { faltando: "romaneio" } }], null)).toBe(false);
  });
});

describe("romaneioDoDossie (mesmas condições do romaneioExigidoDoCard)", () => {
  it("lê o dossiê real da NF 435297, com a data em que o romaneio foi visto", () => {
    const r = romaneioDoDossie({
      agent_state: {
        extravio_parcial: {
          caso: "1",
          dossie: { romaneio: { presente: true, fonte: "anexo", filename: ROM_435297.filename, mime_type: "image/jpeg", visto_em: ROM_435297.visto_em } },
        },
      },
    });
    expect(r).toEqual(ROM_435297);
  });
  it("exige nos MESMOS casos que o romaneioExigidoDoCard (a regra de antes)", () => {
    const romaneios = [
      undefined,
      { presente: true, fonte: "anexo", filename: "a.jpg", mime_type: "image/jpeg" },
      { presente: true, fonte: "ssw", filename: "a.jpg" },
      { presente: false, fonte: "anexo", filename: "a.jpg" },
      { presente: true, fonte: "anexo", filename: null },
      { presente: true, fonte: "anexo", filename: "b.pdf" },
    ];
    for (const caso of [undefined, "1", "2", "3"])
      for (const romaneio of romaneios) {
        const card = { agent_state: { extravio_parcial: { caso, dossie: { romaneio } } } };
        const antigo = romaneioExigidoDoCard(card);
        const novo = romaneioDoDossie(card);
        expect(novo?.filename ?? null).toBe(antigo?.filename ?? null);
        expect(novo?.mime_type ?? null).toBe(antigo?.mime_type ?? null);
      }
  });

  it("sem dossiê / fonte ssw / caso fora / ausente → não exige", () => {
    expect(romaneioDoDossie({ agent_state: null })).toBe(null);
    const base = { presente: true, fonte: "anexo", filename: "x.jpg" };
    expect(romaneioDoDossie({ agent_state: { extravio_parcial: { caso: "1", dossie: { romaneio: { ...base, fonte: "ssw" } } } } })).toBe(null);
    expect(romaneioDoDossie({ agent_state: { extravio_parcial: { caso: "3", dossie: { romaneio: base } } } })).toBe(null);
    expect(romaneioDoDossie({ agent_state: { extravio_parcial: { caso: "1", dossie: { romaneio: { ...base, presente: false } } } } })).toBe(null);
  });
});
