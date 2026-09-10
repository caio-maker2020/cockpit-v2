import { describe, expect, it } from "vitest";
import { indexarFilaAgora, relogioDoCard, rotuloRelogio } from "./esperaNaFila";

// Números REAIS de produção medidos em 2026-09-10 (NF 350796, CTRC SPL915089-7,
// KAROLINE, oc 19 lançada 26/08 07:03 por `alejo`): o card estava na fila desde
// 26/08 11:00 UTC (364 h brutas / 109 h úteis) e o `HistoricoSswPuxado` de
// 09/09 20:21 UTC tinha resetado o `last_event_at`, fazendo o rodapé exibir
// "há 17h". Era o pior caso do sistema inteiro.
const NF350796 = {
  card_id: "95ba7bbc-e559-4c1c-a56e-9abb090c51b9",
  na_fila_desde: "2026-08-26T11:00:51.708179+00:00",
  horas_brutas: 364.3,
  horas_uteis: 108.8,
  parado_mais_1d_util: true,
};
const RUIDO_HISTORICO_SSW = "2026-09-09T20:21:26.702401+00:00";

describe("relogioDoCard", () => {
  it("NF 350796: mostra a espera na fila (26/08), NUNCA o ruído do HistoricoSswPuxado (09/09)", () => {
    const fila = indexarFilaAgora([NF350796]);
    const r = relogioDoCard(
      { id: NF350796.card_id, last_event_at: RUIDO_HISTORICO_SSW, updated_at: RUIDO_HISTORICO_SSW },
      fila,
    );
    expect(r.origem).toBe("fila");
    expect(r.iso).toBe(NF350796.na_fila_desde);
    // A trava: o relógio NÃO pode ser o campo contaminado.
    expect(r.iso).not.toBe(RUIDO_HISTORICO_SSW);
    // E tem de refletir espera de DIAS, não de horas.
    const dias = (Date.parse(RUIDO_HISTORICO_SSW) - Date.parse(r.iso!)) / 86_400_000;
    expect(dias).toBeGreaterThan(10);
  });

  it("propaga horas úteis e o selo de parado", () => {
    const r = relogioDoCard({ id: NF350796.card_id, last_event_at: RUIDO_HISTORICO_SSW }, indexarFilaAgora([NF350796]));
    expect(r.horasUteis).toBe(108.8);
    expect(r.paradoMais1dUtil).toBe(true);
  });

  it("card fora da view (outras colunas do kanban) mantém o comportamento de hoje", () => {
    const r = relogioDoCard({ id: "outro", last_event_at: RUIDO_HISTORICO_SSW, updated_at: "2026-01-01T00:00:00Z" }, indexarFilaAgora([NF350796]));
    expect(r.origem).toBe("atividade");
    expect(r.iso).toBe(RUIDO_HISTORICO_SSW);
    expect(r.paradoMais1dUtil).toBe(false);
  });

  it("query da view falhou (mapa nulo) → fail-open, renderiza como antes", () => {
    const r = relogioDoCard({ id: NF350796.card_id, last_event_at: RUIDO_HISTORICO_SSW }, null);
    expect(r.origem).toBe("atividade");
    expect(r.iso).toBe(RUIDO_HISTORICO_SSW);
  });

  it("fallback preserva a precedência antiga: last_event_at antes de updated_at", () => {
    expect(relogioDoCard({ id: "x", last_event_at: "2026-05-05T00:00:00Z", updated_at: "2026-06-06T00:00:00Z" }, null).iso)
      .toBe("2026-05-05T00:00:00Z");
    expect(relogioDoCard({ id: "x", last_event_at: null, updated_at: "2026-06-06T00:00:00Z" }, null).iso)
      .toBe("2026-06-06T00:00:00Z");
    expect(relogioDoCard({ id: "x", last_event_at: null, updated_at: null }, null).iso).toBeNull();
  });
});

describe("indexarFilaAgora", () => {
  it("ignora linha sem card_id ou sem na_fila_desde e aceita lista vazia/nula", () => {
    const m = indexarFilaAgora([
      NF350796,
      { card_id: "", na_fila_desde: "2026-09-01T00:00:00Z", horas_brutas: 1, horas_uteis: 1, parado_mais_1d_util: false },
      { card_id: "sem-data", na_fila_desde: "", horas_brutas: 1, horas_uteis: 1, parado_mais_1d_util: false },
    ]);
    expect(m.size).toBe(1);
    expect(indexarFilaAgora([]).size).toBe(0);
    expect(indexarFilaAgora(null).size).toBe(0);
  });
});

describe("rotuloRelogio", () => {
  it("explica QUAL relógio está na tela", () => {
    const naFila = rotuloRelogio(relogioDoCard({ id: NF350796.card_id }, indexarFilaAgora([NF350796])));
    expect(naFila).toContain("Na sua fila desde");
    expect(naFila).toContain("26/08"); // 11:00 UTC = 08:00 BRT do dia 26
    expect(naFila).toContain("108,8 h úteis parado");
    expect(rotuloRelogio(relogioDoCard({ id: "outro", last_event_at: RUIDO_HISTORICO_SSW }, null)))
      .toBe("Última atividade registrada no card");
    expect(rotuloRelogio(relogioDoCard({ id: "vazio" }, null))).toBe("Sem data de referência");
  });
});
