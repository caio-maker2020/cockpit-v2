import { describe, expect, it } from "vitest";
import { acaoDaSugestao, fonteDaSugestao, lerConfianca, rotuloSugestao, sugereEncaminhar, sugestaoLancavel, textoConfianca, textoFonte, motivoSugestaoSoRegistro } from "./sugestao";

describe("sugestão com confiança (regras do histórico real)", () => {
  it("regra aprendida em palavras, sem porcentagem", () => {
    expect(rotuloSugestao({ codigo: 36, confianca: 0.82, casos: { n: 41, m: 50 } })).toBe(
      "Sugestão: oc 36 — certeza média · aprendida com o histórico da Sal",
    );
    // contrato v2: casos é inteiro
    expect(rotuloSugestao({ versao_contrato: 2, fonte: "regra_aprendida", codigo: 36, confianca: 0.83, casos: 41 })).toBe(
      "Sugestão: oc 36 — certeza média · aprendida com o histórico da Sal",
    );
  });

  it("agente: 'analisada pelo agente · certeza média — justificativa', inclusive inferido", () => {
    const s = { versao_contrato: 2 as const, acao: "lancar_ocorrencia" as const, fonte: "agente_ia" as const, codigo: 22, confianca: 0.72, justificativa: "parecido com 3 notas" };
    expect(rotuloSugestao(s)).toBe("Sugestão: oc 22 — analisada pelo agente · certeza média — parecido com 3 notas");
    expect(fonteDaSugestao({ codigo: 22, base_regra: "agente_ia" })).toBe("agente_ia");
    expect(fonteDaSugestao({ codigo: 22, regra_id: "r" })).toBe("regra_fixa");
    expect(textoFonte({ codigo: 22, regra_id: "r" })).toBe("regra fixa da Sal");
  });

  it("encaminhar: rótulo próprio, nunca 'lançável', acao inferida", () => {
    const s = { versao_contrato: 2 as const, acao: "encaminhar_relacionamento" as const, fonte: "agente_ia" as const, codigo: null, confianca: 0.9, lancavel: false };
    expect(rotuloSugestao(s)).toBe("Sugestão: encaminhar ao Relacionamento — analisada pelo agente · certeza alta");
    expect(sugereEncaminhar(s)).toBe(true);
    expect(sugestaoLancavel(s, new Set([15]))).toBe(false);
    expect(acaoDaSugestao({ codigo: 15 })).toBe("lancar_ocorrencia");
    expect(acaoDaSugestao({ codigo: null })).toBeNull();
  });
  it("aceita confiança 0–1 ou 0–100, e casos como número + casos_total", () => {
    expect(lerConfianca({ codigo: 1, confianca: 82 }).pct).toBe(82);
    expect(lerConfianca({ codigo: 1, casos: 41, casos_total: 50 })).toEqual({ pct: 82, n: 41, m: 50 });
  });
  it("sem confiança nem casos: só o código (regra pura antiga)", () => {
    expect(textoConfianca({ codigo: 15, regra_id: "r", motivo: "m", lancavel: true })).toBeNull();
    expect(rotuloSugestao({ codigo: 15 })).toBe("Sugestão: oc 15 — regra fixa da Sal");
  });
  it("vira botão só com o código liberado; lancavel:false explícito manda", () => {
    const lib = new Set([36, 15]);
    expect(sugestaoLancavel({ codigo: 15 }, lib)).toBe(true);
    expect(sugestaoLancavel({ codigo: 21 }, lib)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15, lancavel: false }, lib)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15 }, null)).toBe(false);
    expect(sugestaoLancavel({ codigo: 15, lancavel: true }, null)).toBe(true);
  });

  it("sugerir a própria oc atual nunca vira botão (contrato proíbe; o servidor recusaria)", () => {
    const lib = new Set([15]);
    expect(sugestaoLancavel({ codigo: 15 }, lib, 15)).toBe(false);
    expect(motivoSugestaoSoRegistro({ codigo: 15 }, lib, 15)).toBe("Só registro: o código sugerido já é a oc atual.");
    expect(motivoSugestaoSoRegistro({ codigo: 21 }, lib, 13)).toBe("Só registro: código ainda não liberado.");
    expect(motivoSugestaoSoRegistro({ codigo: 15 }, lib, 13)).toBeNull();
  });
});

describe("sugestão aguardar (mig 439)", () => {
  const ag = {
    versao_contrato: 2 as const,
    acao: "aguardar" as const,
    fonte: "agente_ia" as const,
    codigo: null,
    texto: "comprovante segue no malote",
    reavaliar_em_horas: 24,
    reavaliar_em: "2026-10-08T17:30:00.000Z",
    lancavel: false,
  };
  it("é aguardar, nunca lançável nem encaminhar, e não tem 'só registro'", async () => {
    const m = await import("./sugestao");
    expect(m.acaoDaSugestao(ag)).toBe("aguardar");
    expect(m.sugereAguardar(ag)).toBe(true);
    expect(m.sugereEncaminhar(ag)).toBe(false);
    expect(m.sugestaoLancavel(ag, new Set([1, 2, 3]))).toBe(false);
    expect(m.motivoSugestaoSoRegistro(ag, null)).toBeNull();
  });
  it("mostra 'Aguardar: motivo · reavaliar em HH:MM' no fuso de São Paulo", async () => {
    const m = await import("./sugestao");
    expect(m.textoAguardar(ag, new Date("2026-10-08T12:00:00Z"))).toBe("Aguardar: comprovante segue no malote · reavaliar em 14:30");
    expect(m.textoAguardar(ag, new Date("2026-10-07T12:00:00Z"))).toBe("Aguardar: comprovante segue no malote · reavaliar em 08/10 14:30");
    expect(m.textoAguardar({ ...ag, reavaliar_em: null })).toBe("Aguardar: comprovante segue no malote · reavaliar em 24 h");
    expect(m.rotuloSugestao(ag).startsWith("Aguardar: comprovante segue no malote")).toBe(true);
  });
});

describe("certeza em palavras e o porquê para o operador", () => {
  it("níveis: alta ≥ 85, média ≥ 65, baixa abaixo; regra fixa = alta", async () => {
    const m = await import("./sugestao");
    expect(m.nivelCerteza({ codigo: 1, fonte: "regra_aprendida", confianca: 0.98 })).toBe("alta");
    expect(m.nivelCerteza({ codigo: 1, fonte: "regra_aprendida", confianca: 0.667 })).toBe("media");
    expect(m.nivelCerteza({ codigo: 1, fonte: "regra_aprendida", confianca: 0.4 })).toBe("baixa");
    expect(m.nivelCerteza({ codigo: 1 })).toBe("alta");
    expect(m.nivelCerteza(null)).toBeNull();
  });
  it("firme: só regra da Sal com certeza alta; agente nunca é firme", async () => {
    const m = await import("./sugestao");
    expect(m.sugestaoFirme({ codigo: 1, fonte: "regra_aprendida", confianca: 0.9 })).toBe(true);
    expect(m.sugestaoFirme({ codigo: 1, fonte: "regra_aprendida", confianca: 0.7 })).toBe(false);
    expect(m.sugestaoFirme({ codigo: 1, fonte: "agente_ia", confianca: 0.99 })).toBe(false);
  });
  it("o porquê nunca mostra o nome técnico da regra", async () => {
    const m = await import("./sugestao");
    expect(m.porQueSugestao({ codigo: null, motivo: "histórico: 22413 casos com a oc 41 (98%)", base_regra: "arvore:p=0.2" })).toBe(
      "A Sal já viu 22.413 casos parecidos com a ocorrência 41.",
    );
    expect(m.porQueSugestao({ codigo: 1, base_regra: "historico_ssw:oc:aguardar:p_agir=0.004" })).toBe("Regra combinada com a Sal.");
  });
  it("aguardar com texto do histórico em caixa alta vira frase", async () => {
    const m = await import("./sugestao");
    const s = { codigo: null, acao: "aguardar" as const, texto: "AGUARDAR: SEGUE SOZINHA, EM GERAL VEM 01 ENTREGA REALIZADA NORMALMENTE" };
    expect(m.textoAguardar(s)).toBe("Aguardar: segue sozinha, em geral vem a ocorrência 1 (entrega realizada normalmente)");
  });
});
