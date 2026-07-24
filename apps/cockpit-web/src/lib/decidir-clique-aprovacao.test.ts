/**
 * Guard — NF 556392 (FELIPE) / NF 51712 (ISABELY), 2026-07-22.
 * Propriedade protegida: ação com e-mail NUNCA aprova às cegas pelo botão
 * ⭐ RECOMENDADA — sempre abre a janela de edição (onde vivem o template, os
 * destinatários e o aval de evidência das ocs 10/11/35). 2ª regressão desse
 * aval na história do projeto (1ª foi na era Lovable) — por isso o teste.
 */
import { describe, expect, it } from "vitest";
import { decidirCliqueAprovacao } from "./decidir-clique-aprovacao";

describe("decidirCliqueAprovacao (botão ⭐ RECOMENDADA)", () => {
  it("54/59 + e-mail → abre a janela de edição (nunca às cegas)", () => {
    expect(
      decidirCliqueAprovacao({ tool: "lancar_oc_e_enviar_email", args: { codigo_ssw: 54 } }),
    ).toBe("modal-email");
    expect(
      decidirCliqueAprovacao({ tool: "lancar_oc_e_enviar_email", args: { codigo_ssw: 59 } }),
    ).toBe("modal-email");
  });

  it("combo 44+59 → modal do combo (volumes/motivo/filial)", () => {
    expect(decidirCliqueAprovacao({ tool: "lancar_combo_44_59" })).toBe("modal-combo-4459");
    expect(decidirCliqueAprovacao({ meta: { tipo_acao: "combo_44_59" } })).toBe("modal-combo-4459");
  });

  it("ação SEM e-mail (ex.: lancar_49) → aprova direto (comportamento preservado)", () => {
    expect(decidirCliqueAprovacao({ tool: "lancar_ocorrencia", args: { codigo_ssw: 49 } })).toBe(
      "aprovar-direto",
    );
  });

  it("romaneio-interno (PRATI) → janela de edição — Larissa 2026-07-22, NF 1025518", () => {
    // Regressão: item ⭐ RECOMENDADA "Email + Lançar oc 33 (romaneio interno)"
    // aprovava direto no confirm() nativo, sem opção de editar o e-mail.
    expect(decidirCliqueAprovacao({ tool: "enviar_email_e_lancar_33_romaneio_interno" })).toBe(
      "modal-email",
    );
  });

  it("e-mail livre + oc 33 → modal próprio (mesmo destino do item não-recomendado)", () => {
    expect(decidirCliqueAprovacao({ tool: "enviar_email_livre_e_lancar_oc33_portal" })).toBe(
      "modal-email-livre-oc33",
    );
  });

  it("payload nulo/vazio não explode", () => {
    expect(decidirCliqueAprovacao(null)).toBe("aprovar-direto");
    expect(decidirCliqueAprovacao({})).toBe("aprovar-direto");
  });
});

describe("abrir-input (Caio 23/07, NF 62566 — 56 lançada sem texto da operadora)", () => {
  it("ÂNCORA: 41/56/44/55 → ABRE painel de input (nunca lança sem texto/campos)", () => {
    for (const codigo of [41, 44, 55, 56]) {
      expect(decidirCliqueAprovacao({ tool: "lancar_ocorrencia", args: { codigo_ssw: codigo } })).toBe(
        "abrir-input",
      );
    }
  });

  it("gêmeos sem-email 54/59 seguem no fluxo próprio (confirm deliberado)", () => {
    expect(decidirCliqueAprovacao({ tool: "lancar_ocorrencia", args: { codigo_ssw: 54 } })).toBe(
      "aprovar-direto",
    );
    expect(decidirCliqueAprovacao({ tool: "lancar_ocorrencia", args: { codigo_ssw: 59 } })).toBe(
      "aprovar-direto",
    );
  });
});

describe("modal de anexos oc33 (Caio 24/07, NF 158084 — ⭐ aprovou oc33 solo às cegas)", () => {
  it("ÂNCORA NF 158084: oc33 solo (tool) → modal de anexos, nunca aprovar-direto", () => {
    // Regressão real: ⭐ RECOMENDADA "Lançar 33 (sem 44)" aprovou direto com
    // anexos_ids=[] → executor reverteu por completude (romaneio pendente).
    expect(
      decidirCliqueAprovacao({ tool: "lancar_oc33_solo_portal", args: { codigo_ssw: 33 } }),
    ).toBe("modal-oc33-solo");
  });

  it("oc33 solo (meta.tipo_acao) → modal de anexos", () => {
    expect(decidirCliqueAprovacao({ meta: { tipo_acao: "oc33_solo" } })).toBe("modal-oc33-solo");
  });

  it("combo 33+44 → modal do combo (mesma janela de anexos)", () => {
    expect(
      decidirCliqueAprovacao({ tool: "lancar_combo_33_44", args: { codigo_ssw: 33 } }),
    ).toBe("modal-combo-3344");
    expect(decidirCliqueAprovacao({ meta: { tipo_acao: "combo_33_44" } })).toBe(
      "modal-combo-3344",
    );
  });
});
