// Guard INV-105 (Caio 26/08): "1 card = 1 decisão" — o painel escolhe
// EXATAMENTE um vencedor pela tabela de prioridade; oc_mudou vence tudo;
// countdown vence sugestão; estado final não alarma.
import { describe, expect, it } from "vitest";
import { escolherVencedor, outrosAvisos, sinaisAtivos } from "./painelDecisao";
import type { CardRow, HistoricoSswOcorrencia } from "./types";

const h = (codigo: number, data: string): HistoricoSswOcorrencia => ({
  codigo, descricao: "", instrucao: "", data, filial: null, usuario: null, tem_foto: false,
});

const base = (p: Partial<CardRow>): CardRow =>
  ({
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    cod_ultima_ocorrencia: 54,
    historico_ssw: [h(54, "26/08/26 10:00")],
    acao_autonoma: null,
    acao_falhou_motivo: null,
    ultimo_bounce_payload: null,
    ia_sugestao_oc_resposta: null,
    aviso_alteracao_oc: null,
    analise_padrao_resultado: null,
    analise_oc13_resultado: null,
    ...p,
  }) as unknown as CardRow;

const espelhoAtivo = {
  agendamento_id: 1, acao_key: "lancar_ocorrencia:21", executar_em: null,
  status: "pendente", hash_proposta: null, processed_at: null, cancelado_motivo: null,
};

describe("painel de decisão — prioridade fixa", () => {
  it("oc_mudou vence TUDO (inclusive countdown)", () => {
    const c = base({
      historico_ssw: [h(54, "26/08/26 10:00"), h(13, "26/08/26 12:00")],
      acao_autonoma: espelhoAtivo as never,
      ia_sugestao_oc_resposta: { oc_sugerida: 55 } as never,
    });
    expect(escolherVencedor(c)).toBe("oc_mudou");
    expect(outrosAvisos(c)).toBe(2); // countdown + sugestão viram "outros"
  });

  it("countdown vence sugestão; falha vence sugestão", () => {
    expect(escolherVencedor(base({
      acao_autonoma: espelhoAtivo as never,
      ia_sugestao_oc_resposta: { oc_sugerida: 55 } as never,
    }))).toBe("acao_autonoma");
    expect(escolherVencedor(base({
      acao_falhou_motivo: "SSW recusou",
      ia_sugestao_oc_resposta: { oc_sugerida: 55 } as never,
    }))).toBe("falha");
  });

  it("sugestão da resposta vence a de ocs-padrão (camada mais nova)", () => {
    expect(escolherVencedor(base({
      ia_sugestao_oc_resposta: { oc_sugerida: 44 } as never,
      analise_padrao_resultado: { proposta_destacada: 54 } as never,
    }))).toBe("sugestao_resposta");
  });

  it("card sem nada destacado → null (sem painel, sem ruído)", () => {
    expect(escolherVencedor(base({}))).toBeNull();
    expect(outrosAvisos(base({}))).toBe(0);
  });

  it("estado final não dispara oc_mudou (nada a decidir)", () => {
    const c = base({
      state: "TRANSFERIDO",
      historico_ssw: [h(54, "26/08/26 10:00"), h(13, "26/08/26 12:00")],
    });
    expect(sinaisAtivos(c).has("oc_mudou")).toBe(false);
  });
});
