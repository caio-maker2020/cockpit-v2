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

describe("sugestão VIGENTE endossa a aprovação (Caio 24/07, NF 158084 — popup falso)", () => {
  // Âncora literal: banner padrão destacou 59+email ANTES do cliente responder;
  // interpretador (camada mais recente) sugeriu oc33 solo; operador aprovou
  // oc33 solo e o popup disparou contra a sugestão velha.
  const card158084 = {
    analise_padrao_resultado: { proposta_destacada_acao: "lancar_oc_e_enviar_email:59" },
    ia_sugestao_oc_resposta: {
      oc_sugerida: 33,
      sugere_oc33_solo: true,
      sugerido_em: "2026-07-23T21:38:17.114Z",
    },
  };

  it("ÂNCORA NF 158084: aprovar oc33 solo endossada pelo interpretador NÃO diverge", () => {
    const r = detectarDivergencia(card158084, {
      tool: "lancar_oc33_solo_portal",
      args: { codigo_ssw: 33 },
      meta: { tipo_acao: "oc33_solo" },
    });
    expect(r.divergente).toBe(false);
  });

  it("todo carimbado recomendada=true pelo backend nunca diverge", () => {
    const r = detectarDivergencia(
      { analise_padrao_resultado: { proposta_destacada_acao: "lancar_oc_e_enviar_email:54" } },
      { acao_key: "lancar_ocorrencia:21", recomendada: true },
    );
    expect(r.divergente).toBe(false);
  });

  it("variante sem-email do MESMO código da destacada não diverge (regra das 4 opções)", () => {
    const r = detectarDivergencia(
      { analise_padrao_resultado: { proposta_destacada_acao: "lancar_oc_e_enviar_email:54" } },
      { acao_key: "lancar_ocorrencia:54", args: { codigo_ssw: 54 } },
    );
    expect(r.divergente).toBe(false);
  });

  it("divergência REAL continua detectada mesmo com interpretador presente", () => {
    // Interpretador sugere 33; banner sugere 59+email; operador aprova 21 —
    // nenhuma camada endossa → popup legítimo.
    const r = detectarDivergencia(card158084, { acao_key: "lancar_ocorrencia:21" });
    expect(r.divergente).toBe(true);
    expect(r.ocAprovada).toBe(21);
  });

  it("combo 44+59 endossado pelo interpretador não diverge", () => {
    const card = {
      analise_padrao_resultado: { proposta_destacada_acao: "lancar_oc_e_enviar_email:54" },
      ia_sugestao_oc_resposta: { sugere_combo_44_59: true },
    };
    const r = detectarDivergencia(card, {
      tool: "lancar_combo_44_59",
      meta: { tipo_acao: "combo_44_59" },
    });
    expect(r.divergente).toBe(false);
  });
});
