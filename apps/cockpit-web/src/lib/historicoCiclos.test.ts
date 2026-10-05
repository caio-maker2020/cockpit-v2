// Guard INV-168 (Caio 05/10): o chip "Ciclo N · etapa M" e o pop-up contam certo.
import { describe, expect, it } from "vitest";
import { montarHistoricoCiclos, type EventoCiclo } from "./historicoCiclos";

// Eventos REAIS da NF 10856904 (card_events, 29/09 → 05/10).
const NF_10856904: EventoCiclo[] = [
  { created_at: "2026-09-29T22:00:39Z", event_type: "BastaoCardImportado", cod: "10" },
  { created_at: "2026-09-29T22:09:56Z", event_type: "AgenteOcsPadraoDecisao", proposta: "54" },
  { created_at: "2026-09-30T14:02:49Z", event_type: "AprovacaoOperador" },
  { created_at: "2026-09-30T14:03:48Z", event_type: "AcaoExecutada", codigo_ssw: "54", sucesso: "true" },
  { created_at: "2026-10-01T23:31:44Z", event_type: "AguardandoClienteOcMudou", oc_atual: "49" },
  { created_at: "2026-10-02T19:17:59Z", event_type: "AprovacaoOperador" },
  { created_at: "2026-10-02T19:19:29Z", event_type: "AcaoExecutada", codigo_ssw: "54", sucesso: "true" },
  { created_at: "2026-10-03T13:00:14Z", event_type: "AguardandoClienteOcMudou", oc_atual: "49" },
  { created_at: "2026-10-03T13:04:06Z", event_type: "AgenteOcsPadraoDecisao" },
  { created_at: "2026-10-05T12:07:38Z", event_type: "AprovacaoOperador" },
  { created_at: "2026-10-05T12:13:18Z", event_type: "AcaoExecutada", codigo_ssw: "54", sucesso: "true" },
];

describe("montarHistoricoCiclos", () => {
  it("NF 10856904 (real): 10 → 54 → 49 → 54 → 49 → 54 é UM ciclo com 3 etapas", () => {
    const h = montarHistoricoCiclos(NF_10856904);
    expect(h.ciclos).toHaveLength(1);
    expect(h.cicloAtual).toBe(1);
    expect(h.etapaAtual).toBe(3);
    const [e1, e2, e3] = h.ciclos[0]!.etapas;
    expect(e1!.gatilho).toMatchObject({ tipo: "ocorrencia", oc: 10 });
    expect(e1!.sugestao?.oc).toBe(54);
    expect(e1!.lancado).toMatchObject({ oc: 54, automatico: false });
    // etapa 2: a 49 voltou e o operador aprovou SEM análise do agente (o bug)
    expect(e2!.gatilho).toMatchObject({ tipo: "ocorrencia", oc: 49 });
    expect(e2!.sugestao).toBeUndefined();
    // etapa 3: o agente rodou e não destacou nada (≠ não ter rodado)
    expect(e3!.sugestao).toEqual({ oc: null, em: new Date("2026-10-03T13:04:06Z").getTime() });
    expect(h.entradasSemSugestao).toBe(1);
  });

  it("etapa em aberto (card voltou, ninguém agiu ainda) conta como a próxima etapa", () => {
    const h = montarHistoricoCiclos(NF_10856904.slice(0, 5));
    expect(h.etapaAtual).toBe(2);
    expect(h.ciclos[0]!.etapas[1]!.lancado).toBeNull();
  });

  it("reabertura depois de ação = ciclo 2; etapa recomeça em 1", () => {
    const h = montarHistoricoCiclos([
      ...NF_10856904.slice(0, 4),
      { created_at: "2026-10-02T12:00:00Z", event_type: "CardReaberto", oc: "10", para_state: "AGUARDANDO_VALIDACAO_HUMANA" },
    ]);
    expect(h.cicloAtual).toBe(2);
    expect(h.etapaAtual).toBe(1);
    expect(h.ciclos[1]!.etapas[0]!.gatilho).toMatchObject({ tipo: "ocorrencia", oc: 10 });
  });

  it("resposta do cliente é etapa do MESMO ciclo e a leitura da IA não se perde no evento duplicado", () => {
    const h = montarHistoricoCiclos([
      ...NF_10856904.slice(0, 4),
      { created_at: "2026-10-01T10:00:00Z", event_type: "RetornoClienteEmAguardo" },
      { created_at: "2026-10-01T10:01:00Z", event_type: "InterpretadorRespostaClienteConcluido", oc_sugerida: "21" },
      { created_at: "2026-10-01T10:01:05Z", event_type: "RetornoClienteEmAguardo" },
    ]);
    expect(h.cicloAtual).toBe(1);
    const aberta = h.ciclos[0]!.etapas[1]!;
    expect(aberta.gatilho?.tipo).toBe("resposta_cliente");
    expect(aberta.sugestao?.oc).toBe(21);
  });

  it("extravio: 6/9/16 não abre; a 49 autônoma abre o ciclo 1 e é lançamento automático", () => {
    const h = montarHistoricoCiclos([
      { created_at: "2026-10-01T12:00:00Z", event_type: "AgenteExtravioLancou49" },
      { created_at: "2026-10-01T12:01:00Z", event_type: "AcaoExecutada", codigo_ssw: "49", sucesso: "true" },
      { created_at: "2026-10-01T12:30:00Z", event_type: "CardReaberto", oc: "49", para_state: "AGUARDANDO_VALIDACAO_HUMANA" },
    ]);
    expect(h.ciclos).toHaveLength(1);
    expect(h.ciclos[0]!.etapas[0]!.lancado).toMatchObject({ oc: 49, automatico: true });
    expect(h.etapaAtual).toBe(2);
  });

  it("card sem nenhum evento: ciclo 1 · etapa 1, sem quebrar", () => {
    const h = montarHistoricoCiclos([]);
    expect(h).toMatchObject({ cicloAtual: 1, etapaAtual: 1, entradasSemSugestao: 0 });
  });

  it("ação que FALHOU não fecha etapa", () => {
    const h = montarHistoricoCiclos([
      NF_10856904[0]!,
      { created_at: "2026-09-30T14:03:48Z", event_type: "AcaoExecutada", codigo_ssw: "54", sucesso: "false" },
    ]);
    expect(h.ciclos[0]!.etapas).toHaveLength(1);
    expect(h.ciclos[0]!.etapas[0]!.lancado).toBeNull();
  });
});
