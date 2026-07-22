/**
 * Decide o destino do clique em "aprovar ação →" (item ⭐ RECOMENDADA da lista).
 *
 * Caio 2026-07-22 (NF 556392 FELIPE / NF 51712 ISABELY): o botão recomendado
 * aprovava DIRETO (extras = null) qualquer proposta — inclusive ações com
 * e-mail. Efeitos: (a) o operador nunca via a janela de edição (template,
 * destinatários); (b) pra ocs {10,11,35} o aval "enviar mesmo sem evidência"
 * (skip_evidencia) ficava INACESSÍVEL → executor bloqueava com "Evidencia
 * ausente" e o card revertia, sem saída pro operador. 2ª vez que esse aval
 * some (já sumiu na era Lovable — prompts lovable-restaurar-nao-validar-evidencia).
 *
 * REGRA: ação que envia e-mail NUNCA aprova às cegas — sempre passa pela
 * janela de edição (EditarEmailModal), que já contém template, destinatários,
 * "validar evidência" (ocs comuns) e "enviar sem evidência" (ocs 10/11/35).
 *
 * Fora do escopo (mantêm o fluxo próprio, deliberadamente):
 * - enviar_email_e_lancar_33_romaneio_interno (fluxo romaneio-interno, corpo pronto)
 * - enviar_email_livre_e_lancar_oc33_portal (modal próprio de e-mail livre)
 */
export type DestinoCliqueAprovacao =
  | "modal-email"
  | "modal-combo-4459"
  | "aprovar-direto";

export function decidirCliqueAprovacao(
  propostaPayload: Record<string, unknown> | null | undefined,
): DestinoCliqueAprovacao {
  const pl = (propostaPayload ?? {}) as {
    tool?: string;
    meta?: { tipo_acao?: string };
  };
  if (pl.tool === "lancar_combo_44_59" || pl.meta?.tipo_acao === "combo_44_59") {
    return "modal-combo-4459";
  }
  if (pl.tool === "lancar_oc_e_enviar_email") {
    return "modal-email";
  }
  return "aprovar-direto";
}
