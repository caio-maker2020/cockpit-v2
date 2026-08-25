// Guard do placar da janela de veto (etapa F, 25/08): total = soma das
// partes; execução conta SÓ com actor veto-janela (outras AutoAprovacao —
// fatias, regra 13→21 — ficam FORA); edição no card marca a execução como
// "com edição"; tempo até o veto pareia programação→cancelamento.
import { describe, expect, it } from "vitest";
import {
  acaoKeyDoEvento,
  ehExecucaoDaJanela,
  pctSemToque,
  placarVeto,
  type EventoVetoCru,
} from "./auditoriaVeto";

let seq = 0;
const ev = (
  event_type: string,
  card_id: string,
  payload: Record<string, unknown> = {},
  actor_id: string | null = null,
  minuto = 0,
): EventoVetoCru => ({
  id: `e${seq++}`,
  card_id,
  event_type,
  actor_id,
  payload,
  created_at: new Date(Date.parse("2026-08-25T10:00:00Z") + minuto * 60000).toISOString(),
});

const K = { acao_key: "lancar_ocorrencia:21" };

describe("placarVeto", () => {
  it("execução da janela exige actor veto-janela — outras AutoAprovacao ficam fora", () => {
    const exec = ev("AutoAprovacaoPermitida", "c1", { regra: "veto_janela:agente-x:lancar_ocorrencia:21" }, "veto-janela");
    const fatia = ev("AutoAprovacaoPermitida", "c2", { regra: "fatia_autonoma:agente-x:oc13->21" }, "vinculador");
    expect(ehExecucaoDaJanela(exec)).toBe(true);
    expect(ehExecucaoDaJanela(fatia)).toBe(false);
    const linhas = placarVeto([exec, fatia]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.executadasSemToque).toBe(1);
  });

  it("acao_key sai do payload direto ou da regra veto_janela:<agente>:<tool>:<cod>", () => {
    expect(acaoKeyDoEvento(ev("AcaoAutonomaAgendada", "c1", K))).toBe("lancar_ocorrencia:21");
    expect(
      acaoKeyDoEvento(ev("AutoAprovacaoPermitida", "c1", { regra: "veto_janela:agente-sugere-ocs-padrao:lancar_oc_e_enviar_email:54" }, "veto-janela")),
    ).toBe("lancar_oc_e_enviar_email:54");
  });

  it("total = soma das partes; edição no card marca a execução como 'com edição'", () => {
    const eventos = [
      ev("AcaoAutonomaAgendada", "c1", K, null, 0),
      ev("AcaoAutonomaEditadaPeloOperador", "c1", K, null, 10),
      ev("AutoAprovacaoPermitida", "c1", { regra: "veto_janela:a:lancar_ocorrencia:21" }, "veto-janela", 60),
      ev("AcaoAutonomaAgendada", "c2", K, null, 0),
      ev("AutoAprovacaoPermitida", "c2", { regra: "veto_janela:a:lancar_ocorrencia:21" }, "veto-janela", 60),
      ev("AcaoAutonomaAgendada", "c3", K, null, 0),
      ev("AcaoAutonomaCanceladaPeloOperador", "c3", K, null, 25),
      ev("AcaoAutonomaAgendada", "c4", K, null, 0),
      ev("AcaoAutonomaDevolvidaProHumano", "c4", K, null, 61),
      ev("AcaoAutonomaExpirada", "c5", K, null, 95),
    ];
    const [l] = placarVeto(eventos);
    expect(l!.programadas).toBe(4);
    expect(l!.executadasSemToque).toBe(1);
    expect(l!.executadasComEdicao).toBe(1);
    expect(l!.canceladas).toBe(1);
    expect(l!.devolvidas).toBe(1);
    expect(l!.expiradas).toBe(1);
    expect(l!.tempoMedioAteVetoMin).toBe(25);
    expect(pctSemToque(l!)).toBe(33); // 1 de 3 desfechos decididos
  });

  it("sem desfechos decididos → pct null (nunca 0% enganoso)", () => {
    const [l] = placarVeto([ev("AcaoAutonomaAgendada", "c1", K)]);
    expect(pctSemToque(l!)).toBeNull();
  });
});
