// ============================================================================
// Guard B (INV-027 backend, P0) — Caio 2026-07-06, NF 28002 (operadora Larissa)
//
// Uma ação "54 + e-mail" NUNCA pode virar "54 sem e-mail" sem confirmação
// deliberada, explícita e auditável. Regressão real: o front (Lovable) resolveu
// o botão "54 + email" pelo NÚMERO 54 e submeteu o gêmeo "sem email"
// (garantirGemeosSemEmail) — cliente não notificado e card preso em
// AGUARDANDO_CLIENTE. Este guard fecha isso no BACKEND, independente do Lovable.
//
// Função PURA (testável). O executor (processOne) chama antes de lançar a 54.
// Fail-CLOSED: sem sinal deliberado, não lança.
//
// Dispara SOMENTE quando a oc 54 sairia SEM e-mail (enviarEmail=false), e:
//   (Prong 1) o próprio todo tinha intenção de e-mail (tool "lancar_oc_e_enviar_email")
//             mas o e-mail não vai sair (sem destinatário/template/conteúdo); OU
//   (Prong 2) a recomendação DESTACADA do card era "lancar_oc_e_enviar_email:54"
//             mas o todo executado é o gêmeo "sem email".
// Escape hatch deliberado:
// - no TODO "+email", `skipEmail` ou `confirmouSemEmailDeliberado`;
// - no TODO gêmeo "sem email" quando a recomendação era "+email", SOMENTE
//   `confirmouSemEmailDeliberado`. `skipEmail` sozinho é ambíguo nesse caminho,
//   porque fronts antigos podem marcar isso automaticamente pelo tipo do gêmeo.
// ============================================================================

export interface AvaliarGuard54Input {
  /** args.codigo_ssw resolvido (número). */
  codigoSsw: number;
  /** true se o executor VAI enviar e-mail nesta ação. */
  enviarEmail: boolean;
  /** true = ação "só notificar", não lança oc no SSW (extras.skip_oc). */
  skipOc: boolean;
  /** proposta_payload.tool. */
  tool: string | null | undefined;
  /** extras.skip_email===true || extras.enviar_email===false (checkbox desmarcado). */
  skipEmail: boolean;
  /** extras.confirmou_sem_email_deliberado — clique explícito na linha "🚫 SEM E-MAIL". */
  confirmouSemEmailDeliberado: boolean;
  /** cards.analise_padrao_resultado.proposta_destacada_acao (ou aviso_alteracao_oc). */
  propostaDestacadaAcao: string | null | undefined;
}

export type Guard54Prong =
  | "intencao_email_no_todo_sem_email_valido"
  | "gemeo_sem_email_vs_recomendacao_email";

export interface AvaliarGuard54Result {
  bloquear: boolean;
  prong: Guard54Prong | null;
  motivo: string | null;
}

export const ACAO_KEY_54_COM_EMAIL = "lancar_oc_e_enviar_email:54";

const MOTIVO_INTENCAO_EMAIL =
  'Ação "54 + e-mail" sem e-mail válido (sem destinatário/template/conteúdo) — ' +
  'não pode virar "54 sem e-mail". Informe o e-mail do cliente e reaprove. ' +
  "A oc 54 NÃO foi lançada.";

const MOTIVO_GEMEO =
  'A recomendação destacada do card era "54 + e-mail" ' +
  "(lancar_oc_e_enviar_email:54), mas esta ação lançaria a oc 54 SEM notificar o " +
  'cliente. Bloqueado para o cliente não ficar sem aviso. Se for intenção ' +
  'deliberada, use a linha "🚫 SEM E-MAIL". A oc 54 NÃO foi lançada.';

const NAO_APLICA: AvaliarGuard54Result = { bloquear: false, prong: null, motivo: null };

export function avaliarGuardOc54SemEmail(i: AvaliarGuard54Input): AvaliarGuard54Result {
  // Não aplica: ação que não lança oc, oc ≠ 54, ou e-mail que VAI sair.
  if (i.skipOc) return NAO_APLICA;
  if (i.codigoSsw !== 54) return NAO_APLICA;
  if (i.enviarEmail) return NAO_APLICA;

  const intencaoEmailNoProprioTodo = i.tool === "lancar_oc_e_enviar_email";
  const recomendacaoEraComEmail = i.propostaDestacadaAcao === ACAO_KEY_54_COM_EMAIL;

  if (intencaoEmailNoProprioTodo) {
    if (i.skipEmail === true || i.confirmouSemEmailDeliberado === true) return NAO_APLICA;
    return { bloquear: true, prong: "intencao_email_no_todo_sem_email_valido", motivo: MOTIVO_INTENCAO_EMAIL };
  }
  if (recomendacaoEraComEmail) {
    if (i.confirmouSemEmailDeliberado === true) return NAO_APLICA;
    return { bloquear: true, prong: "gemeo_sem_email_vs_recomendacao_email", motivo: MOTIVO_GEMEO };
  }
  return NAO_APLICA;
}
