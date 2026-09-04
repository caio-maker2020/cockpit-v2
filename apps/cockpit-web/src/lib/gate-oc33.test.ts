import { describe, expect, it } from "vitest";
import {
  chavesFaltantes,
  ehErroDossieIncompleto,
  lerGateOc33,
  mensagemGateOc33,
  textoFaltando,
} from "./gate-oc33";

// Carimbo REAL do todo e0cd599e… do card NF 632603 (copiado do banco).
const CARIMBO_632603 = {
  tool: "lancar_oc33_solo_portal",
  args: { codigo_ssw: "33" },
  meta: {
    gate_oc33: {
      natureza: "completude",
      bloqueada: true,
      faltando: ["romaneio de coleta assinado"],
    },
  },
};

describe("lerGateOc33", () => {
  it("lê o carimbo real da NF 632603", () => {
    const g = lerGateOc33(CARIMBO_632603);
    expect(g.bloqueada).toBe(true);
    expect(g.natureza).toBe("completude");
    expect(g.faltando).toEqual(["romaneio de coleta assinado"]);
  });

  it("proposta sem gate (não é oc 33) nunca é bloqueada", () => {
    expect(lerGateOc33({ tool: "lancar_ocorrencia", args: { codigo_ssw: "54" } }).bloqueada).toBe(false);
    expect(lerGateOc33({ meta: {} }).bloqueada).toBe(false);
    expect(lerGateOc33(null).bloqueada).toBe(false);
    expect(lerGateOc33(undefined).bloqueada).toBe(false);
  });

  it("gate com bloqueada=false libera", () => {
    const g = lerGateOc33({ meta: { gate_oc33: { natureza: "completude", bloqueada: false, faltando: [] } } });
    expect(g.bloqueada).toBe(false);
    expect(g.faltando).toEqual([]);
  });

  it("aceita bloqueada como string 'true' (jsonb serializado)", () => {
    expect(lerGateOc33({ meta: { gate_oc33: { bloqueada: "true" } } }).bloqueada).toBe(true);
  });

  it("ignora faltando malformado sem quebrar", () => {
    const g = lerGateOc33({ meta: { gate_oc33: { bloqueada: true, faltando: [1, null, "valor dos itens"] } } });
    expect(g.faltando).toEqual(["valor dos itens"]);
  });
});

describe("textoFaltando / mensagemGateOc33", () => {
  it("um item", () => {
    expect(textoFaltando(["romaneio de coleta assinado"])).toBe("romaneio de coleta assinado");
    expect(mensagemGateOc33(["romaneio de coleta assinado"])).toBe(
      "Falta romaneio de coleta assinado para lançar a oc 33.",
    );
  });
  it("três itens", () => {
    expect(textoFaltando(["romaneio de coleta assinado", "descrição dos itens", "valor dos itens"])).toBe(
      "romaneio de coleta assinado, descrição dos itens e valor dos itens",
    );
  });
  it("lista vazia não inventa frase", () => {
    expect(textoFaltando([])).toBe("");
    expect(mensagemGateOc33([])).toBe("O dossiê da oc 33 está incompleto.");
  });
});

describe("chavesFaltantes", () => {
  it("mapeia os rótulos do backend para as chaves do dossiê", () => {
    expect(chavesFaltantes(["romaneio de coleta assinado"])).toEqual(["romaneio"]);
    expect(
      chavesFaltantes(["romaneio de coleta assinado", "descrição dos itens", "valor dos itens"]),
    ).toEqual(["romaneio", "descricao", "valor"]);
  });
  it("rótulo desconhecido não vira chave", () => {
    expect(chavesFaltantes(["algo que ninguém carimbou"])).toEqual([]);
  });
});

describe("ehErroDossieIncompleto", () => {
  it("reconhece a exceção crua da RPC (mensagem real de produção)", () => {
    const err = {
      message:
        'OC33_DOSSIE_INCOMPLETO: a oc 33 deste card so pode ser lancada COMPLETA — faltando: ["romaneio de coleta assinado"]. Complete o dossie (descricao, valor, romaneio) antes de aprovar.',
    };
    expect(ehErroDossieIncompleto(err)).toBe(true);
  });
  it("não confunde com outros erros", () => {
    expect(ehErroDossieIncompleto({ message: "FEEDBACK_OC49_OBRIGATORIO: ..." })).toBe(false);
    expect(ehErroDossieIncompleto(null)).toBe(false);
    expect(ehErroDossieIncompleto({})).toBe(false);
  });
});
