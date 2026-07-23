import { describe, expect, it } from "vitest";
import { detectarDivergencia } from "./divergencia";

const cardComDestacada = {
  analise_padrao_resultado: { proposta_destacada_acao: "lancar_oc_e_enviar_email:54" },
};

describe("detectarDivergencia", () => {
  it("aprovar a própria destacada NÃO é divergência", () => {
    const r = detectarDivergencia(cardComDestacada, {
      acao_key: "lancar_oc_e_enviar_email:54",
    });
    expect(r.divergente).toBe(false);
  });

  it("aprovar ação diferente da destacada É divergência", () => {
    const r = detectarDivergencia(cardComDestacada, {
      acao_key: "lancar_ocorrencia:21",
    });
    expect(r.divergente).toBe(true);
    expect(r.ocSugerida).toBe(54);
    expect(r.ocAprovada).toBe(21);
  });

  it("sem sugestão da IA no card → nunca incomoda", () => {
    const r = detectarDivergencia({}, { acao_key: "lancar_ocorrencia:21" });
    expect(r.divergente).toBe(false);
  });

  it("fallback por código: sugestão do interpretador (número) vs aprovada", () => {
    const card = { ia_sugestao_oc_resposta: { oc_sugerida: 54 } };
    const div = detectarDivergencia(card, {
      tool: "lancar_ocorrencia",
      args: { codigo_ssw: 21 },
    });
    expect(div.divergente).toBe(true);
    const igual = detectarDivergencia(card, {
      tool: "lancar_oc_e_enviar_email",
      args: { codigo_ssw: 54 },
    });
    expect(igual.divergente).toBe(false);
  });

  it("payload sem acao_key nem codigo → dados insuficientes, não incomoda", () => {
    const r = detectarDivergencia(cardComDestacada, { tool: "responder_cliente" });
    expect(r.divergente).toBe(false);
  });
});
