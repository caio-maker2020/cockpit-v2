// =============================================================================
// parser-ssw-webhook — adapta payload do SSW2181 pro shape interno do Cockpit.
//
// Caio 2026-05-22: SSW Sistemas envia POST com JSON conforme doc:
//   https://ssw.inf.br/ajuda/webserviceOcorrencias.html
// Esse helper extrai/valida e produz estrutura compatível com upsertCardFromPendencia
// (mesmo path do Pass A do sync-bastao). Reuso máximo de lógica existente.
//
// Direção do payload (mantida da doc original SSW2181):
//   POST body = ARRAY de objetos OU objeto único (toleramos os 2).
//   Cada objeto = 1 ocorrência (ou batch).
// =============================================================================

export interface SswWebhookOcorrencia {
  dataHoraEvento?: string;        // "13-06-2019 16:59:39"
  codigo?: string | number;        // "1" ou 1
  descricao?: string;
  complemento?: string;
  nomeRecebedor?: string;
  docRecebedor?: string;
  latitude?: string;
  longitude?: string;
  dataHoraAgendamento?: string;
  linkComprovante?: string;
  imagemComprovante?: string;      // base64
}

export interface SswWebhookCte {
  // Documento externo (CTRC formato Cockpit: AMP190047-1). Quando preenchidos,
  // viram cards.ctrc direto. Doc SSW chama esses de "serieDocumento" /
  // "numeroDocumento" mas no payload real vimos sempre vazios.
  serieDocumento?: string;
  numeroDocumento?: string | number;
  // Identificadores internos SSW (vimos no payload real 2026-05-22):
  //   serieSSW: "012", numeroSSW: 2769502, chaveSSW: "31260486..."
  // NÃO bate com formato Cockpit. Usado só pra debug/auditoria por enquanto.
  // Pass F do sync-bastao resolve chave_cte real via lookup em nf_chave_cte.
  serieSSW?: string;
  numeroSSW?: string | number;
  chaveSSW?: string;
  // Campos da doc original (também podem vir vazios em produção)
  serieCTe?: string;
  numeroCTe?: string | number;
  chaveCTe?: string;
}

export interface SswWebhookNf {
  numeroNFe?: string | number;
  serieNFe?: string;
  chaveNFe?: string;
  pedido?: string;
}

export interface SswWebhookPayload {
  dataHoraEnvio?: string;
  cnpjTransportadora?: string;
  cnpjPagador?: string;
  cnpjRemetente?: string;          // não documentado mas pode vir
  nf?: SswWebhookNf;
  cte?: SswWebhookCte;
  ocorrencia?: SswWebhookOcorrencia;
}

/**
 * Resultado da extração — só com os campos que importam pro Cockpit.
 * Estrutura espelha BastaoPendencia (ver _shared/bastao-client.ts) pra
 * permitir reuso de upsertCardFromPendencia.
 */
export interface PayloadExtraido {
  ok: true;
  cnpjTransportadora: string;
  cnpjPagador: string | null;
  cnpjRemetente: string | null;
  nf: string;
  // CTRC no formato Cockpit (ex: "OVD397081-7"). Vazio quando SSW só manda
  // identificadores internos (serieSSW/numeroSSW) — Fase 2 resolve via Pass F.
  ctrc: string | null;
  // Chave fiscal NFe (44 dígitos), do payload nf.chaveNFe
  chaveNfe: string | null;
  // Chave SSW (interna, diferente de NFe). Útil pra Fase 2 lookup em nf_chave_cte.
  chaveSsw: string | null;
  numeroSsw: string | null;
  codigoOc: number;
  descricaoOc: string;
  dataEvento: Date;
  linkComprovante: string | null;
  imagemComprovanteBase64: string | null;
  raw: SswWebhookPayload;
}

export type ResultadoExtracao = PayloadExtraido | {
  ok: false;
  motivo: string;
  raw: unknown;
};

/**
 * Parse data SSW (formato "DD-MM-YYYY HH:MM:SS"). Retorna null se inválido.
 */
function parseSswData(s: string | undefined): Date | null {
  if (!s) return null;
  // DD-MM-YYYY HH:MM:SS
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dia, mes, ano, h, mi, se] = m;
  // SSW publica em fuso de Brasília (UTC-3); ISO sem offset = local.
  const iso = `${ano}-${mes}-${dia}T${h}:${mi}:${se}-03:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Normaliza NF (remove zeros à esquerda, mesma regra do Bastão).
 * Memory feedback_nf_format_bastao_vs_cockpit: Cockpit guarda sem padding.
 */
function normalizeNf(input: string | number | undefined): string | null {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const apenasDigitos = s.replace(/\D+/g, "");
  if (!apenasDigitos) return null;
  return apenasDigitos.replace(/^0+(?=\d)/, "");
}

/**
 * Normaliza CNPJ (só dígitos, 14 chars).
 */
function normalizeCnpj(input: string | undefined): string | null {
  if (!input) return null;
  const d = input.replace(/\D+/g, "");
  return d.length === 14 ? d : null;
}

/**
 * Monta CTRC no formato Cockpit (ex: "OVD397081-7" = <3 letras><6 dig>-<DV>).
 *
 * SSW payload real (vimos em 2026-05-22) NÃO vem com serieDocumento/numeroDocumento
 * preenchidos — vem só serieSSW/numeroSSW (identificadores internos numéricos,
 * formato diferente do Cockpit). Esses NÃO servem pra montar CTRC.
 *
 * Estratégia:
 *   - Se serieDocumento+numeroDocumento preenchidos → monta (caso ideal)
 *   - Senão → retorna null. Fase 2 (criação de card) chama Pass F do sync-bastao
 *     que resolve chave_cte/ctrc via lookup em nf_chave_cte (memory
 *     project_chave_cte_lookup_obrigatorio).
 */
function montarCtrc(cte: SswWebhookCte | undefined): string | null {
  if (!cte) return null;
  const serie = cte.serieDocumento?.trim() ?? "";
  const numero = String(cte.numeroDocumento ?? "").trim();
  if (!serie || !numero || numero === "0") return null;
  // Se número já começa com letras (serie embutida), retorna como veio
  if (/^[A-Z]/i.test(numero)) return numero;
  return `${serie}${numero}`;
}

/**
 * Valida + extrai. Retorna { ok: false, motivo } pra payloads malformados —
 * caller responde 400 e SSW pode reenviar.
 */
export function extrairPayloadSsw(input: unknown): ResultadoExtracao {
  if (!input || typeof input !== "object") {
    return { ok: false, motivo: "payload não é objeto", raw: input };
  }

  const p = input as SswWebhookPayload;

  const cnpjTransp = normalizeCnpj(p.cnpjTransportadora);
  if (!cnpjTransp) {
    return { ok: false, motivo: "cnpjTransportadora ausente/inválido", raw: input };
  }

  const nf = normalizeNf(p.nf?.numeroNFe);
  if (!nf) {
    return { ok: false, motivo: "nf.numeroNFe ausente/inválido", raw: input };
  }

  const codigoOc = Number(p.ocorrencia?.codigo);
  if (!Number.isFinite(codigoOc)) {
    return { ok: false, motivo: "ocorrencia.codigo ausente/inválido", raw: input };
  }

  const dataEvento = parseSswData(p.ocorrencia?.dataHoraEvento);
  if (!dataEvento) {
    return { ok: false, motivo: "ocorrencia.dataHoraEvento ausente/inválido", raw: input };
  }

  return {
    ok: true,
    cnpjTransportadora: cnpjTransp,
    cnpjPagador: normalizeCnpj(p.cnpjPagador),
    cnpjRemetente: normalizeCnpj(p.cnpjRemetente),
    nf,
    ctrc: montarCtrc(p.cte),
    chaveNfe: p.nf?.chaveNFe?.trim() || null,
    chaveSsw: p.cte?.chaveSSW?.trim() || null,
    numeroSsw: p.cte?.numeroSSW != null ? String(p.cte.numeroSSW).trim() : null,
    codigoOc,
    descricaoOc: p.ocorrencia?.descricao ?? "",
    dataEvento,
    linkComprovante: p.ocorrencia?.linkComprovante ?? null,
    imagemComprovanteBase64: p.ocorrencia?.imagemComprovante ?? null,
    raw: p,
  };
}

/**
 * Gera protocolo determinístico (idempotência). Mesma chamada (mesma NF +
 * mesmo evento + mesmo timestamp) → mesmo protocolo. Permite SSW reenviar
 * em timeout sem duplicar.
 */
export async function gerarProtocolo(p: PayloadExtraido): Promise<string> {
  const chave = `${p.cnpjTransportadora}|${p.nf}|${p.codigoOc}|${p.dataEvento.toISOString()}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chave));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ssw-${hex.slice(0, 24)}`;
}
