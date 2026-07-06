// =============================================================================
// parse-bounce-ndr — parser PURO de NDR/bounce SMTP pra extrair destinatário +
// razão legível do bounce, robusto a formatos Microsoft Exchange/365.
//
// Caio 2026-07-01 (bug B, NF 575330 HDL LOGISTICA / Larissa): o banner "EMAIL
// BLOQUEADO PELO SERVIDOR DO CLIENTE" mostrava LIXO (`5503238344...:.NET 10.0.8`)
// no lugar da razão SMTP, e "destino" no lugar do destinatário. Causa raiz: o
// gmail-poll-inbox extraía a razão com `/(550[^\n]{0,200})/` sobre o PRIMEIRO
// text/plain, ignorando o part estruturado `message/delivery-status`. Em NDRs
// Microsoft esse text/plain carrega diagnóstico hex do Exchange → o regex casava
// um "550" DENTRO do blob e o destinatário não casava.
//
// Fix (raiz): ler o `message/delivery-status` PRIMEIRO (fonte canônica do DSN,
// RFC 3464): `Diagnostic-Code` → motivo, `Final-Recipient` → destinatário,
// `Status`/`Action` como enriquecimento. Fallback de texto humano é GUARDADO
// contra blobs hex (razão real sempre tem letra além de a-f; hex nunca) — melhor
// gravar null do que exibir garbage.
//
// PURO e testável: recebe as parts já decodificadas. O flatten+decode fica em
// gmail-reader.flattenPartsDecoded (onde vive o decodeBase64Url). Ver
// parse-bounce-ndr.test.ts (guard de não-regressão).
// =============================================================================

export interface DecodedPartInput {
  /** MIME type em minúsculas (ex.: "message/delivery-status", "text/plain"). */
  mimeType: string;
  /** Conteúdo já decodificado (base64url → texto). */
  text: string;
}

export interface BounceInfo {
  destinatario: string | null;
  /** Razão SMTP legível (ex.: "550 5.7.1 Message rejected as spam"). */
  motivo_smtp: string | null;
  /** Enhanced status code do DSN (ex.: "5.7.1"), quando disponível. */
  status_code: string | null;
  /** Diagnostic-Code cru do DSN (antes de limpar), pra auditoria. */
  diagnostic_raw: string | null;
  /** Action do DSN ("failed", "delayed", ...), quando disponível. */
  action: string | null;
  /** De onde veio a razão: DSN estruturado, texto humano, ou nada. */
  fonte: "delivery-status" | "texto" | "nenhuma";
}

const MOTIVO_MAX = 300;

/**
 * Extrai destinatário + razão do bounce a partir das parts decodificadas.
 * Prioriza o `message/delivery-status` (canônico); cai pro texto humano com
 * guard anti-hex.
 */
export function parseBounceNdr(parts: DecodedPartInput[]): BounceInfo {
  const ds = parts.find((p) => p.mimeType === "message/delivery-status");
  if (ds) {
    const info = parseDeliveryStatus(ds.text);
    if (info.destinatario || info.motivo_smtp) {
      return { ...info, fonte: "delivery-status" };
    }
  }

  // Fallback: texto humano (text/plain preferido, senão qualquer text/*).
  const humano =
    parts.find((p) => p.mimeType === "text/plain")?.text ??
    parts.find((p) => p.mimeType.startsWith("text/"))?.text ??
    "";
  const motivo = extrairMotivoSmtpHumano(humano);
  const dest = extrairDestinatarioHumano(humano);
  return {
    destinatario: dest,
    motivo_smtp: motivo,
    status_code: null,
    diagnostic_raw: null,
    action: null,
    fonte: motivo || dest ? "texto" : "nenhuma",
  };
}

/** Parseia o corpo de um part `message/delivery-status` (RFC 3464). */
function parseDeliveryStatus(text: string): Omit<BounceInfo, "fonte"> {
  // Desdobra continuation lines (começam com espaço/tab) antes de casar campos.
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");

  const finalRcpt =
    matchField(unfolded, "final-recipient") ??
    matchField(unfolded, "original-recipient");
  const statusRaw = matchField(unfolded, "status");
  const status = statusRaw ? (/(\d\.\d+\.\d+)/.exec(statusRaw)?.[1] ?? null) : null;
  const action = matchField(unfolded, "action");
  const diagRaw = matchField(unfolded, "diagnostic-code");

  const destinatario = finalRcpt ? limparRecipient(finalRcpt) : null;

  let motivo: string | null = null;
  if (diagRaw) motivo = limparDiagnostic(diagRaw);
  if (!motivo && status) {
    motivo = [status, action].filter(Boolean).join(" ").trim() || null;
  }

  return {
    destinatario,
    motivo_smtp: motivo,
    status_code: status,
    diagnostic_raw: diagRaw ?? null,
    action: action ?? null,
  };
}

/** Casa um campo `Nome: valor` (case-insensitive, linha única já desdobrada). */
function matchField(text: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "mi");
  const v = re.exec(text)?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

/** Limpa `Final-Recipient: rfc822; <email>` → email. */
function limparRecipient(v: string): string | null {
  const semTipo = v
    .replace(/^\s*(?:rfc822|x400|utf-8)\s*;?\s*/i, "")
    .replace(/[<>]/g, "")
    .trim();
  const email = semTipo.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return email?.[0] ?? (semTipo.length > 0 ? semTipo : null);
}

/** Limpa `Diagnostic-Code: smtp; 550 ...` → "550 ..." colapsando espaços. */
function limparDiagnostic(v: string): string | null {
  const limpo = v
    .replace(/^\s*(?:smtp|x-[\w-]+)\s*;?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (limpo.length === 0) return null;
  // Caio 2026-07-01 (validação Caio): o guard anti-hex também no caminho
  // ESTRUTURADO — um DSN pode trazer o blob de tracking do Exchange DENTRO do
  // Diagnostic-Code. Se for blob hex → null e o parser cai pro Status+Action
  // (limpo). Código terso legítimo ("550 5.7.1") não tem run de 16 hex → passa.
  if (contemBlobHex(limpo)) return null;
  return limpo.slice(0, MOTIVO_MAX);
}

/**
 * `true` se a string contém um run contínuo de ≥16 dígitos hex — assinatura do
 * diagnóstico/tracking do MS Exchange (`5503238344042323531393A...`), nunca uma
 * razão SMTP. Códigos terços ("550 5.7.1") têm runs curtos → não casam.
 */
function contemBlobHex(s: string): boolean {
  return /[0-9a-fA-F]{16,}/.test(s);
}

/**
 * Extrai razão SMTP de texto humano, GUARDADO contra blobs hex/binários.
 * Razão real (spam/blocked/rejeitado/entrega/...) sempre tem letra além de a-f;
 * diagnóstico hex do Exchange (`5503238344...`) nunca tem → é rejeitado (retorna
 * null em vez de exibir garbage). Anti-regressão do bug B (NF 575330 HDL).
 */
export function extrairMotivoSmtpHumano(texto: string): string | null {
  if (!texto) return null;
  const t = texto.replace(/\r/g, "");
  // Código SMTP 4xx/5xx + (opcional) enhanced status + o resto da linha.
  const re = /([45]\d\d(?:[ -]\d\.\d+\.\d+)?[^\n]{0,240})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const cand = m[1].replace(/\s+/g, " ").trim();
    if (pareceRazaoLegivel(cand)) return cand.slice(0, MOTIVO_MAX);
  }
  return null;
}

/**
 * `true` se a string parece uma razão humana (tem letra além de a-f), `false`
 * se parece hex/binário. Hex só usa [0-9a-fA-F]; toda razão real de bounce tem
 * ao menos uma consoante g-z (spaM, blocKed, rejeItado, deLivery...).
 */
function pareceRazaoLegivel(s: string): boolean {
  return /[g-zG-Z]/.test(s);
}

/** Fallback de destinatário no texto humano (mantém heurística "para/to <email>"). */
export function extrairDestinatarioHumano(texto: string): string | null {
  if (!texto) return null;
  // "para/to <email>" — brackets opcionais (Gmail/Google escrevem "to <x@y>").
  const m = texto.match(/(?:para|to)\s+<?([\w.+-]+@[\w.-]+\.\w+)>?/i);
  return m?.[1] ?? null;
}
