// =============================================================================
// oc13-template-email — escolha do template de e-mail do agente oc13 (PURA).
//
// Caio 2026-08-25 (NF 153826): o funil antigo mandava TUDO pro template
// PROBLEMAS_COM_ENDERECO (100% das 195 sugestões em 30d; 79 eram feriado/
// fechado/ausente) — o cliente recebia "problema com seu endereço" quando o
// motivo era feriado municipal. Regra nova, APENAS pro fluxo da oc 13
// (clientes validados em exceção): motivo de local fechado/feriado/ausência →
// template TENTATIVA_ENTREGA_LOCAL_FECHADO (termina com "Podemos reentregar?",
// texto aprovado pelo Caio). Fallback residual permanece o de endereço
// (decisão Caio 2026-05-23) — só o ramo novo foi autorizado.
// =============================================================================

export const TEMPLATE_LOCAL_FECHADO = "TENTATIVA_ENTREGA_LOCAL_FECHADO";

/** Motivos de insucesso que significam "estabelecimento fechado / sem quem
 *  receba" — nunca são problema de endereço. */
export function ehMotivoLocalFechado(motivo: string): boolean {
  return /feriado|fechad[oa]|ausente|hor[aá]rio|expediente|ponto\s*facultativo|almo[cç]o|encerrad[oa]/i
    .test(motivo);
}

/** Escolha do template do e-mail 54 do agente oc13. Ordem: motivo explícito
 *  (endereço/recusas/falta) → local fechado (novo) → fallback por foto. */
export function sugerirTemplateEmailOc13(motivo: string, fotoClass: string): string {
  const m = motivo.toLowerCase();
  if (/endere[cç]o|cep|n[uú]mero/i.test(m)) return "PROBLEMAS_COM_ENDERECO";
  if (/recusa\s*total|n[ãa]o\s*aceit/i.test(m)) return "RECUSA_TOTAL";
  if (/recusa\s*parcial|parcial/i.test(m)) return "RECUSA_PARCIAL";
  if (/falta|volume/i.test(m)) return "FALTA_DE_VOLUME";
  if (ehMotivoLocalFechado(m)) return TEMPLATE_LOCAL_FECHADO;
  // foto classificada como LOCAL FECHADO é literalmente o caso do template novo
  // (motivo genérico tipo "1 (SSWMOBILE)" + foto da loja fechada).
  if (fotoClass === "local_fechado") return TEMPLATE_LOCAL_FECHADO;
  if (fotoClass === "destinatario") return "PROBLEMAS_COM_ENDERECO";
  return "PROBLEMAS_COM_ENDERECO"; // fallback (Caio 2026-05-23: era RECUSA_TOTAL)
}
