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

/**
 * Extras da linha "🚫 SEM E-MAIL" quando o cliente pode SEGREGAR (Carlos
 * 2026-10-06, Larissa/PRATI — ADR 0033 emendado): o painel substitui o
 * window.confirm e leva a marcação junto.
 *
 * Os 3 campos do clique deliberado vêm do helper acima, sem cópia — o guard
 * backend do gêmeo sem-email continua recebendo exatamente o que exige.
 *
 * `segregar_ctrc` vai SEMPRE como booleano, nunca omitido: `aprovar_e_executar`
 * grava os extras com `extras_existentes || p_extras`, e o `||` do jsonb mantém
 * chave ausente — omitir quando desmarcada deixaria um `true` de uma tentativa
 * anterior valendo na reaprovação (achado da auditoria de 21/09).
 */
export function extrasSemEmailComSegregacao(segregar: boolean): {
  confirmou_sem_email_deliberado: true;
  skip_email: true;
  enviar_email: false;
  segregar_ctrc: boolean;
} {
  return { ...extrasSemEmailDeliberado(), segregar_ctrc: segregar === true };
}
