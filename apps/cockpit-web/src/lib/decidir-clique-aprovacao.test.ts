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

  it("fluxos com modal/corpo próprios seguem diretos (romaneio-interno, email-oc33)", () => {
    expect(decidirCliqueAprovacao({ tool: "enviar_email_e_lancar_33_romaneio_interno" })).toBe(
      "aprovar-direto",
    );
    expect(decidirCliqueAprovacao({ tool: "enviar_email_livre_e_lancar_oc33_portal" })).toBe(
      "aprovar-direto",
    );
  });

  it("payload nulo/vazio não explode", () => {
    expect(decidirCliqueAprovacao(null)).toBe("aprovar-direto");
    expect(decidirCliqueAprovacao({})).toBe("aprovar-direto");
  });
});
