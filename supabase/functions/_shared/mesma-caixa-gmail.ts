// =============================================================================
// mesma-caixa-gmail — decide se uma resposta manual do Cockpit pode REUSAR o
// gmail_thread_id da mensagem inbound original (mantendo a resposta na MESMA
// conversa do Gmail) ou se precisa sair como thread nova.
//
// A identidade da CAIXA é o e-mail Gmail conectado (`gmail_oauth_credentials.email`),
// NUNCA o `operador_id`. Uma mesma caixa física (ex: duilio.deus@) pode ser
// operada por MÚLTIPLAS personas/carteiras (ex: operador "DUILIO" e operador
// "DURAFA"). Comparar operador_id trata troca de persona na mesma caixa como se
// fosse caixa diferente → zera o threadId → Gmail cria thread NOVA.
//
// Caso âncora (INV-035): NF 17146 (AESTECH). Inbound do cliente capturado pela persona
// DURAFA (c322f605), resposta enviada pela persona DUILIO (01b205c1) — as duas
// com a MESMA caixa Gmail duilio.deus@. O guard antigo (operador_id) mandou como
// thread nova; o operador viu a resposta fora da conversa original.
//
// Também preserva a proteção Caio 2026-06-17 (NF 5558833 fortbras): quando a
// caixa que capturou é DE FATO diferente da que envia (reorg de operadores,
// CARLOS/DURAFA excluídos → ISA E KAROL/VICTOR), NÃO reusa o threadId — senão o
// Gmail rejeita ("thread inexistente nessa caixa") com 500. Se não der pra
// resolver a caixa do inbound, assume caixa diferente (lado seguro).
// =============================================================================

export function normalizarEmailCaixa(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * @returns true  → mesma caixa física: PODE reusar o gmail_thread_id do inbound.
 *          false → caixa diferente (ou indeterminada): enviar como thread nova.
 */
export function podeReusarThreadGmail(params: {
  /** operador_id gravado no raw_payload do inbound (persona que capturou). */
  inboundOperadorId: string | null | undefined;
  /** operador_id de quem está enviando a resposta agora. */
  sendingOperadorId: string;
  /** e-mail Gmail conectado da persona que capturou o inbound (resolvido pelo caller). */
  caixaInboundEmail: string | null | undefined;
  /** e-mail Gmail conectado de quem envia (creds.email). */
  caixaEnvioEmail: string | null | undefined;
}): boolean {
  const { inboundOperadorId, sendingOperadorId, caixaInboundEmail, caixaEnvioEmail } = params;

  // Inbound sem operador (ex: capturas legadas Postmark) → comportamento legado:
  // assume mesma caixa e reusa o threadId (era o default histórico).
  if (inboundOperadorId == null) return true;

  // Mesma persona → trivialmente a mesma caixa.
  if (inboundOperadorId === sendingOperadorId) return true;

  // Personas distintas: decide pela caixa Gmail física, não pelo operador_id.
  const inbound = normalizarEmailCaixa(caixaInboundEmail);
  const envio = normalizarEmailCaixa(caixaEnvioEmail);
  // Não resolveu alguma das caixas → não dá pra confirmar que é a mesma → lado
  // seguro (thread nova), preservando a proteção contra Gmail 500.
  if (!inbound || !envio) return false;
  return inbound === envio;
}
