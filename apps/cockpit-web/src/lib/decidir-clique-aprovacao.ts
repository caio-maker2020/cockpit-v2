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
 * Larissa 2026-07-22 (PRATI NF 1025518): a exclusão original do romaneio-interno
 * ("corpo pronto") deixava o item ⭐ RECOMENDADA "Email + Lançar oc 33 (romaneio
 * interno)" aprovar direto no confirm() nativo — sem janela de edição, violando
 * a própria regra acima. O backend sempre foi desenhado pro modal
 * (regras-auto-acao.ts: "operadora pode trocar no modal"; executor honra
 * texto_email_customizado/assunto_override/template_id_override/
 * email_destinatarios). Agora: romaneio-interno → EditarEmailModal; e-mail
 * livre → modal próprio (mesmo destino do item não-recomendado).
 */
export type DestinoCliqueAprovacao =
  | "modal-email"
  | "modal-email-livre-oc33"
  | "modal-combo-4459"
  | "abrir-input"
  | "aprovar-direto";

// Caio 2026-07-23 (NF 62566 LARISSA): ações de lançamento direto que EXIGEM/
// OFERECEM input do operador antes de aprovar — 41/56 têm texto OBRIGATÓRIO
// que vai direto pro SSW; 44 exige volumes/motivo/filial; 55 tem texto
// opcional. O ⭐ RECOMENDADA aprovava às cegas (extras=null) e a 56 saiu SEM
// o texto da operadora. Mesma classe do bug de 22/07 (e-mail às cegas),
// espécie que ficou de fora: agora o clique ABRE o painel expandido (fluxo
// que já funciona), nunca lança direto.
export const OCS_COM_INPUT_OBRIGATORIO: ReadonlyArray<number> = [41, 44, 55, 56];

export function decidirCliqueAprovacao(
  propostaPayload: Record<string, unknown> | null | undefined,
): DestinoCliqueAprovacao {
  const pl = (propostaPayload ?? {}) as {
    tool?: string;
    meta?: { tipo_acao?: string };
    args?: { codigo_ssw?: unknown };
  };
  if (pl.tool === "lancar_combo_44_59" || pl.meta?.tipo_acao === "combo_44_59") {
    return "modal-combo-4459";
  }
  if (
    pl.tool === "lancar_oc_e_enviar_email" ||
    pl.tool === "enviar_email_e_lancar_33_romaneio_interno"
  ) {
    return "modal-email";
  }
  if (pl.tool === "enviar_email_livre_e_lancar_oc33_portal") {
    return "modal-email-livre-oc33";
  }
  const codigo = Number(pl.args?.codigo_ssw);
  if (pl.tool === "lancar_ocorrencia" && OCS_COM_INPUT_OBRIGATORIO.includes(codigo)) {
    return "abrir-input";
  }
  return "aprovar-direto";
}
