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
  proximoDiaUtil,
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

describe("próximo dia útil", () => {
  it("sexta → segunda; quinta → sexta; véspera de feriado pula o feriado", () => {
    expect(proximoDiaUtil(diaSP("2026-10-16")!)).toBe(diaSP("2026-10-19")); // sex → seg
    expect(proximoDiaUtil(diaSP("2026-10-08")!)).toBe(diaSP("2026-10-09")); // qui → sex
    expect(proximoDiaUtil(diaSP("2026-10-09")!)).toBe(diaSP("2026-10-13")); // sex → ter (seg 12/10 feriado)
    expect(proximoDiaUtil(diaSP("2026-10-10")!)).toBe(diaSP("2026-10-13")); // sábado → ter
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
