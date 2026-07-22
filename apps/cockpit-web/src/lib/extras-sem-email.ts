/**
 * Extras da linha "🚫 SEM E-MAIL" (gêmeo sem-email das ocs de cliente 54/59).
 *
 * Larissa 2026-07-22 (NF 1090092 UNIAO QUIMICA): o guard backend
 * `avaliarGuardOc54SemEmail` (prong gemeo_sem_email_vs_recomendacao_email) só
 * libera o gêmeo sem-email com `extras.confirmou_sem_email_deliberado===true`
 * — `skip_email` sozinho é ambíguo porque o builder genérico o auto-deriva
 * pelo tipo do gêmeo. O front próprio mostrava o window.confirm deliberado
 * mas aprovava SEM extras: operadora ficava presa num loop de bloqueio cuja
 * mensagem mandava usar a própria linha em que ela já estava clicando.
 *
 * Este helper é a ÚNICA fonte dos extras desse clique — se o guard backend
 * mudar o contrato, muda aqui e no teste.
 */
export function extrasSemEmailDeliberado(): {
  confirmou_sem_email_deliberado: true;
  skip_email: true;
  enviar_email: false;
} {
  return {
    confirmou_sem_email_deliberado: true,
    skip_email: true,
    enviar_email: false,
  };
}
