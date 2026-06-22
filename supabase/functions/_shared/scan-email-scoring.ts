// =============================================================================
// scan-email-scoring — lógica PURA de match/scoring do scan de e-mail
// pré-existente (scan-email-pre-card). Sem I/O, testável com `deno test`.
//
// Caio 2026-06-22. Regra dura do Caio: um candidato só vira sugestão se
//   (I) a NF do card aparece no e-mail (assunto OU corpo — garantido pela query
//       Gmail que já casou a NF), E
//   (II) há vínculo ROBUSTO com o cliente do card (algum participante externo
//        tem domínio que pertence a uma das partes do card — remetente/
//        destinatário/pagador — por domínio cadastrado OU slug do nome).
// "Nunca subir um e-mail de uma NF que não seja comprovadamente do cliente."
// Na dúvida (sem vínculo), descarta. O score só ORDENA os que passaram a trava.
// =============================================================================

/** Candidato = uma thread Gmail única que casou a busca por NF. */
export interface CandidatoEmail {
  gmail_thread_id: string;
  assunto: string;
  /** domínios (lowercase) de From/To/Cc somados de TODAS as msgs da thread,
   *  já excluindo @salexpress.com.br (operador). */
  participantes_dominios: string[];
  /** ISO da 1ª mensagem da thread (pra detectar "iniciada antes do card"). */
  iniciada_em: string | null;
  qtd_mensagens: number;
  /** true se o operador já respondeu manualmente na thread (label SENT). */
  tem_sent_operador: boolean;
}

/** Identidade do cliente DESTE card (montada pelo edge a partir do agent_state
 *  + contatos_cliente). NÃO é global — é específica do card. */
export interface VinculoCliente {
  /** domínios exatos conhecidos do cliente (contatos_cliente p/ os CNPJs do card). */
  dominios: Set<string>;
  /** slugs dos nomes das partes do card (remetente/destinatário/pagador). */
  nomeSlugs: string[];
}

export interface ScoreResult {
  passou: boolean;
  score: number;
  nf_no_assunto: boolean;
  vinculo_ok: boolean;
  motivo_descartado?: string;
}

/** Só dígitos, sem zeros à esquerda. "0030459" → "30459". */
export function normalizarNf(nf: string | null | undefined): string {
  return (nf ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/** A NF (normalizada) aparece como token numérico no assunto? Compara
 *  normalizado (tolera zeros à esquerda e separadores). */
export function assuntoContemNf(assunto: string | null | undefined, nfNorm: string): boolean {
  if (!nfNorm) return false;
  const nums = (assunto ?? "").match(/\d{3,}/g) ?? [];
  return nums.some((n) => n.replace(/^0+/, "") === nfNorm);
}

/** Slug do NOME de uma empresa (remetente/destinatário/pagador) pra casar com
 *  domínio. Tira acento, sufixos societários e tudo que não é alfanumérico. */
export function slugNome(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(
      /\b(ltda|sa|s\/a|me|eireli|epp|com|ind|industria|distribuidora|distrib|distr|comercio|comercial|farma|farmaceutica|hospitalar|produtos|prod)\b/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "");
}

/** Slug do DOMÍNIO (tira sufixo público). "alfaparfdbdc.com.br" → "alfaparfdbdc". */
export function slugDominio(dom: string | null | undefined): string {
  if (!dom) return "";
  return dom
    .toLowerCase()
    .replace(/\.com\.br$|\.com$|\.org$|\.net$|\.br$/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** O domínio do participante vincula a alguma parte do card? Domínio exato
 *  cadastrado OU slug do domínio ⊇/⊆ slug de um nome do card (min 4 chars). */
export function dominioVincula(dom: string, vinc: VinculoCliente): boolean {
  if (!dom) return false;
  if (vinc.dominios.has(dom)) return true;
  const base = slugDominio(dom);
  if (base.length < 4) return false;
  for (const slug of vinc.nomeSlugs) {
    if (!slug || slug.length < 4) continue;
    if (base.includes(slug) || slug.includes(base)) return true;
  }
  return false;
}

/**
 * Pontua um candidato. passou = (NF presente) E (vínculo de cliente).
 * A NF é garantida pela query Gmail; o gate REAL é o vínculo. Score ordena.
 */
export function pontuarCandidato(
  cand: CandidatoEmail,
  nfNorm: string,
  vinc: VinculoCliente,
  cardCreatedAt: string,
): ScoreResult {
  const nf_no_assunto = assuntoContemNf(cand.assunto, nfNorm);

  const vinculo_ok = cand.participantes_dominios.some((d) => dominioVincula(d, vinc));
  if (!vinculo_ok) {
    return {
      passou: false,
      score: 0,
      nf_no_assunto,
      vinculo_ok: false,
      motivo_descartado: "sem_vinculo_cliente",
    };
  }

  // NF no assunto vale mais que só no corpo.
  let score = nf_no_assunto ? 50 : 25;

  // Thread iniciada ANTES do card = cenário-alvo (tratativa pré-card).
  const iniciada = cand.iniciada_em ? Date.parse(cand.iniciada_em) : NaN;
  const criada = Date.parse(cardCreatedAt);
  if (!Number.isNaN(iniciada) && !Number.isNaN(criada) && iniciada < criada) {
    score += 15;
  }

  // Vínculo por domínio EXATO cadastrado é mais forte que só por slug do nome.
  const exato = cand.participantes_dominios.some((d) => vinc.dominios.has(d));
  score += exato ? 10 : 5;

  // Operador já respondeu manual = tratativa de fato em andamento.
  if (cand.tem_sent_operador) score += 10;

  return { passou: true, score, nf_no_assunto, vinculo_ok: true };
}

/** Ordena os candidatos que passaram a trava por score desc e corta no topo. */
export function selecionarSugestoes(
  candidatos: Array<{ cand: CandidatoEmail; score: ScoreResult }>,
  max = 3,
): Array<{ cand: CandidatoEmail; score: ScoreResult }> {
  return candidatos
    .filter((c) => c.score.passou)
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, max);
}
