// Guard do trilho autônomo no front (etapa E, 25/08): predicados das abas,
// countdown, formulário e — o mais crítico — PARIDADE do hashDaProposta com o
// _shared do backend (vetor fixo idêntico nos dois testes; divergir = edição
// do operador devolvida pro humano no vencimento).
import { describe, expect, it } from "vitest";
import {
  emJanelaDeVeto,
  executadaRecente,
  explicacaoDidatica,
  hashDaProposta,
  rotuloCountdown,
  urgenciaCountdown,
  validarFormularioCancelamento,
  type AcaoAutonomaEspelho,
  type RespostasCancelamento,
} from "./acaoAutonomaVeto";

const esp = (p: Partial<AcaoAutonomaEspelho>): AcaoAutonomaEspelho => ({
  agendamento_id: 1,
  acao_key: "lancar_ocorrencia:21",
  executar_em: null,
  status: null,
  hash_proposta: null,
  processed_at: null,
  cancelado_motivo: null,
  ...p,
});

describe("predicados das abas (visão, nenhum estado novo — risco 1)", () => {
  it("aba 1: pendente/executando; cancelado/expirado ficam fora", () => {
    expect(emJanelaDeVeto(esp({ status: "pendente" }))).toBe(true);
    expect(emJanelaDeVeto(esp({ status: "executando" }))).toBe(true);
    expect(emJanelaDeVeto(esp({ status: "cancelado" }))).toBe(false);
    expect(emJanelaDeVeto(esp({ status: "expirado" }))).toBe(false);
    expect(emJanelaDeVeto(null)).toBe(false);
  });

  it("aba 2: processado há <1h; depois o card segue a vida normal", () => {
    const agora = Date.parse("2026-08-25T14:00:00-03:00");
    const r30 = esp({ status: "processado", processed_at: "2026-08-25T13:30:00-03:00" });
    const r90 = esp({ status: "processado", processed_at: "2026-08-25T12:20:00-03:00" });
    expect(executadaRecente(r30, agora)).toBe(true);
    expect(executadaRecente(r90, agora)).toBe(false);
    expect(executadaRecente(esp({ status: "pendente" }), agora)).toBe(false);
  });
});

describe("countdown (alvo absoluto do backend — nunca recalcula a janela)", () => {
  const agora = Date.parse("2026-08-25T14:00:00-03:00");
  it("faltando <60min mostra minutos; vencido mostra executando", () => {
    expect(rotuloCountdown("2026-08-25T14:42:00-03:00", agora)).toBe("42 min");
    expect(rotuloCountdown("2026-08-25T13:59:00-03:00", agora)).toBe("executando…");
  });
  it("virada de dia mostra o dia (sexta 17:10 → vence seg 08:40)", () => {
    const sexta = Date.parse("2026-08-28T17:10:00-03:00");
    expect(rotuloCountdown("2026-08-31T08:40:00-03:00", sexta)).toBe("vence seg 08:40");
  });
  it("urgência: 15min=crítica, 30=alta, senão normal", () => {
    expect(urgenciaCountdown("2026-08-25T14:10:00-03:00", agora)).toBe("critica");
    expect(urgenciaCountdown("2026-08-25T14:25:00-03:00", agora)).toBe("alta");
    expect(urgenciaCountdown("2026-08-25T14:50:00-03:00", agora)).toBe("normal");
  });
});

describe("formulário de cancelamento (o servidor revalida — RPC)", () => {
  const base: RespostasCancelamento = {
    o_que_leu_errado: "Cliente só pediu pra aguardar, não confirmou endereço",
    onde_olhou: ["email_cliente"],
    info_existe_no_cockpit: "sim_interpretou_errado",
    excecao_cliente: false,
  };
  it("completo passa", () => {
    expect(validarFormularioCancelamento(base)).toBeNull();
  });
  it("cada campo obrigatório barra com mensagem própria", () => {
    expect(validarFormularioCancelamento({ ...base, o_que_leu_errado: "x" })).toMatch(/leu errado/);
    expect(validarFormularioCancelamento({ ...base, onde_olhou: [] })).toMatch(/onde você olhou/);
    expect(validarFormularioCancelamento({ ...base, info_existe_no_cockpit: "" })).toMatch(/dentro do Cockpit/);
    expect(
      validarFormularioCancelamento({ ...base, info_existe_no_cockpit: "nao_so_fora" }),
    ).toMatch(/onde \(fora do Cockpit\)/);
    expect(validarFormularioCancelamento({ ...base, excecao_cliente: null })).toMatch(/exceção/);
    expect(
      validarFormularioCancelamento({ ...base, excecao_cliente: true, excecao_qual: "" }),
    ).toMatch(/qual é a exceção/);
  });
});

describe("explicação didática", () => {
  it("cada ação da onda 1 tem texto próprio; desconhecida tem fallback honesto", () => {
    expect(explicacaoDidatica("lancar_ocorrencia:21")).toMatch(/entregar de novo/);
    expect(explicacaoDidatica("ignorar_e_aguardar:54")).toMatch(/aguardando/);
    expect(explicacaoDidatica("tool_estranha:99")).toMatch(/se ninguém cancelar/);
  });
});

describe("PARIDADE do hash com o backend (_shared/acao-autonoma-veto.ts)", () => {
  it("vetor fixo bate com o hash gerado pelo deno no backend", () => {
    // gerado por: deno eval hashDaProposta(...) em 25/08 — NÃO recalcular à mão
    expect(
      hashDaProposta({
        tool: "lancar_ocorrencia",
        args: { codigo_ssw: 21, nf: "1611059", extras: { cancelar_reentrega_24h: true } },
        meta: { origem: "teste" },
      }),
    ).toBe("076cb53b1c832d88");
    expect(hashDaProposta(null)).toBe("5b9bc4ba528108e4");
  });
  it("ordem de chaves não muda; conteúdo muda", () => {
    const a = { x: 1, y: { b: 2, a: 3 } };
    const b = { y: { a: 3, b: 2 }, x: 1 };
    expect(hashDaProposta(a)).toBe(hashDaProposta(b));
    expect(hashDaProposta({ x: 1 })).not.toBe(hashDaProposta({ x: 2 }));
  });
});
