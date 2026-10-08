import { describe, expect, it } from "vitest";
import {
  atrasoPrevisaoDias,
  cargaCritica,
  diaSP,
  diasUteisDesde,
  entraAcima7,
  entraPreEntregaAcima2,
  faixaCargaParada,
  regionalDaUnidade,
  baseDaUnidade,
  regraCargaParada,
  MIN_DIAS_REGRA_AJUDA,
  MIN_DIAS_REGRA_CODIGO,
} from "./regua";

// Quinta, 08/10/2026, 12h em São Paulo.
const QUI = Date.parse("2026-10-08T15:00:00Z");
// Terça, 13/10/2026 (segunda 12/10 é feriado).
const TER = Date.parse("2026-10-13T15:00:00Z");

describe("dias úteis (calcularDiasDesdeUltimaOcorrencia do Pendências)", () => {
  it("hoje = 0; dia útil anterior = 1; data futura ou vazia = 0", () => {
    expect(diasUteisDesde("2026-10-08", QUI)).toBe(0);
    expect(diasUteisDesde("2026-10-07", QUI)).toBe(1);
    expect(diasUteisDesde("2026-10-09", QUI)).toBe(0);
    expect(diasUteisDesde(null, QUI)).toBe(0);
  });
  it("pula sábado, domingo e feriado nacional (12/10)", () => {
    // sex 09 → ter 13: sáb, dom, seg(feriado) não contam; ter conta.
    expect(diasUteisDesde("2026-10-09", TER)).toBe(1);
    // qui 08 → ter 13: sex + ter.
    expect(diasUteisDesde("2026-10-08", TER)).toBe(2);
  });
  it("Carnaval e Corpus Christi não são úteis", () => {
    expect(diasUteisDesde("2026-02-13", Date.parse("2026-02-18T15:00:00Z"))).toBe(1);
    expect(diasUteisDesde("2026-06-03", Date.parse("2026-06-05T15:00:00Z"))).toBe(1);
  });
  it("timestamp vira o dia de São Paulo (01h UTC ainda é o dia anterior)", () => {
    expect(diaSP("2026-10-08T01:00:00Z")).toBe(diaSP("2026-10-07"));
    expect(diasUteisDesde("2026-10-08T01:00:00Z", QUI)).toBe(1);
  });
});

describe("atraso na previsão (dias corridos)", () => {
  it("conta corrido, zero no prazo e sem previsão", () => {
    expect(atrasoPrevisaoDias("2026-10-03", QUI)).toBe(5);
    expect(atrasoPrevisaoDias("2026-10-08", QUI)).toBe(0);
    expect(atrasoPrevisaoDias("2026-10-20", QUI)).toBe(0);
    expect(atrasoPrevisaoDias(null, QUI)).toBe(0);
  });
});

describe("faixas e carga crítica", () => {
  it("0..7 e acima de 7; crítica é > 5", () => {
    expect(faixaCargaParada(0)).toBe("0");
    expect(faixaCargaParada(7)).toBe("7");
    expect(faixaCargaParada(8)).toBe("8+");
    expect(cargaCritica(5)).toBe(false);
    expect(cargaCritica(6)).toBe(true);
  });
});

describe("regra da carga parada (exportação da Gestão)", () => {
  const base = { previsao_entrega: "2026-10-01" };
  it("usa o mínimo do código (1), não o da ajuda (2)", () => {
    expect(MIN_DIAS_REGRA_CODIGO).toBe(1);
    expect(MIN_DIAS_REGRA_AJUDA).toBe(2);
    const r = regraCargaParada({ ...base, cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-07" }, QUI);
    expect(r).toMatchObject({ grupo: "Pré-entrega", minDias: 1, dias: 1, entra: true });
  });
  it("destroca 51/52/58 e 56 viram resolver rápido", () => {
    for (const c of [51, 52, 56, 58]) {
      expect(regraCargaParada({ ...base, cod_ultima_ocorrencia: c, data_ultima_ocorrencia: "2026-10-07" }, QUI).grupo).toBe(
        "Informação faltante – resolver rápido",
      );
    }
  });
  it("redespacho final 40 só com 3+ dias úteis", () => {
    expect(regraCargaParada({ ...base, cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-06" }, QUI).entra).toBe(false);
    expect(regraCargaParada({ ...base, cod_ultima_ocorrencia: 40, data_ultima_ocorrencia: "2026-10-05" }, QUI).entra).toBe(true);
  });
  it("só fora do prazo; sem previsão fica como dúvida", () => {
    const noPrazo = regraCargaParada({ previsao_entrega: "2026-10-10", cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-01" }, QUI);
    expect(noPrazo.entra).toBe(false);
    const semPrev = regraCargaParada({ previsao_entrega: null, cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-10-01" }, QUI);
    expect(semPrev).toMatchObject({ entra: false, semPrevisao: true });
  });
  it("oc fora dos grupos não entra", () => {
    expect(regraCargaParada({ ...base, cod_ultima_ocorrencia: 41, data_ultima_ocorrencia: "2026-09-01" }, QUI)).toMatchObject({ grupo: null, entra: false });
  });
});

describe("indicadores regra atual (estoque)", () => {
  it("acima de 7: dias >= 7, fora pré-entrega", () => {
    expect(entraAcima7({ cod_ultima_ocorrencia: 41, data_ultima_ocorrencia: "2026-09-29" }, QUI)).toBe(true); // 7 úteis
    expect(entraAcima7({ cod_ultima_ocorrencia: 41, data_ultima_ocorrencia: "2026-09-30" }, QUI)).toBe(false);
    expect(entraAcima7({ cod_ultima_ocorrencia: 36, data_ultima_ocorrencia: "2026-09-01" }, QUI)).toBe(false);
  });
  it("pré-entrega: dias >= 2", () => {
    expect(entraPreEntregaAcima2({ cod_ultima_ocorrencia: 7, data_ultima_ocorrencia: "2026-10-06" }, QUI)).toBe(true);
    expect(entraPreEntregaAcima2({ cod_ultima_ocorrencia: 7, data_ultima_ocorrencia: "2026-10-07" }, QUI)).toBe(false);
    expect(entraPreEntregaAcima2({ cod_ultima_ocorrencia: 41, data_ultima_ocorrencia: "2026-09-01" }, QUI)).toBe(false);
  });
});

describe("regionais por sigla", () => {
  it("sigla → base → regional; sigla desconhecida = null", () => {
    expect(baseDaUnidade("vga")).toEqual({ base: "VARGINHA", tipo: "FILIAL" });
    expect(regionalDaUnidade("VGA")).toBe("Bruno");
    expect(regionalDaUnidade("AJF")).toBe("Daiene");
    expect(regionalDaUnidade("ZZZ")).toBeNull();
    expect(regionalDaUnidade(null)).toBeNull();
  });
});

describe("SLA por setor (sla_setores)", () => {
  it("prazo/crítico estritos; agendamento cai no padrão 3/7", async () => {
    const { statusSla, slaDoSetor } = await import("./regua");
    expect(statusSla(3, "OPERACAO")).toBe("dentro");
    expect(statusSla(4, "OPERACAO")).toBe("fora");
    expect(statusSla(8, "OPERACAO")).toBe("critico");
    expect(statusSla(10, "PERDAS")).toBe("fora");
    expect(statusSla(11, "PERDAS")).toBe("critico");
    expect(slaDoSetor("AGENDAMENTO")).toEqual({ prazo: 3, critico: 7, padrao: true });
  });
});
