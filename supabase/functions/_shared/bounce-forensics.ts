// =============================================================================
// bounce-forensics — parser PURO forense de NDR/bounce a partir do RAW RFC822
// completo (Gmail `format=raw` base64url-decodificado, ou um .eml colado).
//
// Caio 2026-07-01 (investigação A, casos NF 575330 HDL / NF 5620 MIX MOTO):
// extrai TUDO que precisamos pra cravar (ou NÃO cravar) a causa do bloqueio:
//   1. headers do BOUNCE (From, Return-Path, Authentication-Results, Received,
//      Subject, Message-ID);
//   2. part `message/delivery-status` (Reporting-MTA, Remote-MTA, Final-Recipient,
//      Action, Status, Diagnostic-Code);
//   3. headers do e-mail ORIGINAL anexado (`message/rfc822` ou
//      `text/rfc822-headers`): From, To, DKIM-Signature, Authentication-Results
//      original, Subject, Message-ID;
//   4. corpo humano "Diagnostic information for administrators" (NDR MS/Exchange).
//
// CUIDADO METODOLÓGICO (Caio): o `Authentication-Results` do BOUNCE se refere ao
// hop mailer-daemon→nossa caixa — NÃO prova nada sobre o nosso envio. Só cravar
// causa A (SPF/DKIM/DMARC) se o DSN/diagnóstico REMOTO ou os headers do ORIGINAL
// mostrarem a falha. Por isso `sinais` separa bounce_ar de original_ar e só olha
// original + diagnóstico remoto pro veredito assistido (que NÃO crava sozinho).
//
// PURO e testável (bounce-forensics.test.ts). Sem dependência de Gmail aqui — a
// Edge Function bounce-forensics/index.ts busca o raw e chama este parser.
// =============================================================================

export interface HeaderKV {
  name: string;
  value: string;
}

export interface MimePart {
  headers: HeaderKV[];
  /** Content-Type principal, minúsculo (ex.: "message/delivery-status"). */
  mimeType: string;
  /** Corpo decodificado (só em leaf; "" em multipart/message). */
  body: string;
  parts: MimePart[];
}

export interface BounceForensics {
  bounce_headers: {
    from: string | null;
    return_path: string | null;
    authentication_results: string[];
    received: string[];
    subject: string | null;
    message_id: string | null;
  };
  delivery_status: {
    reporting_mta: string | null;
    remote_mta: string | null;
    final_recipient: string | null;
    action: string | null;
    status: string | null;
    diagnostic_code: string | null;
  } | null;
  original: {
    from: string | null;
    to: string | null;
    dkim_signature: string | null;
    authentication_results: string[];
    subject: string | null;
    message_id: string | null;
  } | null;
  /** Corpo humano do NDR (inclui "Diagnostic information for administrators"). */
  diagnostic_admin_texto: string | null;
  /**
   * Veredito ASSISTIDO — NÃO crava causa. Só olha o que é confiável (original +
   * diagnóstico remoto), nunca o AR do próprio bounce.
   */
  sinais: {
    dkim_no_original: boolean;
    spf_no_original: string | null;
    original_authentication_results: string[];
    diagnostic_menciona_auth: boolean;
    palavras_auth_encontradas: string[];
    aviso: string;
  };
}

const AVISO_METODOLOGICO =
  "NÃO cravar SPF/DKIM/DMARC pelo Authentication-Results do BOUNCE (refere-se ao " +
  "hop mailer-daemon→nossa caixa). Só cravar causa A se diagnostic_code/original " +
  "mostrarem a falha explicitamente.";

const PALAVRAS_AUTH = [
  "spf", "dkim", "dmarc", "spoof", "unauthenticated", "not authenticated",
  "sender id", "senderid", "arc", "fail", "softfail", "reject",
];

export function parseBounceForensics(raw: string): BounceForensics {
  const root = parseMime(raw);
  const todas = flatten(root);

  // 1. Headers do bounce (raiz).
  const bounce_headers = {
    from: getHeader(root.headers, "from"),
    return_path: getHeader(root.headers, "return-path"),
    authentication_results: getHeaders(root.headers, "authentication-results"),
    received: getHeaders(root.headers, "received"),
    subject: getHeader(root.headers, "subject"),
    message_id: getHeader(root.headers, "message-id"),
  };

  // 2. message/delivery-status.
  const ds = todas.find((p) => p.mimeType === "message/delivery-status");
  const delivery_status = ds ? parseDeliveryStatus(ds.body) : null;

  // 3. Original anexado: message/rfc822 (usa headers do filho) OU
  //    text/rfc822-headers (corpo = headers crus).
  const original = extrairOriginal(root);

  // 4. Corpo humano (admin diagnostic) — text/plain do report, fora do original.
  const diagnostic_admin_texto = extrairTextoAdmin(root);

  // Sinais (assistido, não crava).
  const origAR = original?.authentication_results ?? [];
  const diagBlob = [
    delivery_status?.diagnostic_code ?? "",
    diagnostic_admin_texto ?? "",
  ].join(" ").toLowerCase();
  const palavras = PALAVRAS_AUTH.filter((w) => diagBlob.includes(w));
  const spfNoOriginal = origAR
    .map((ar) => /spf=(\w+)/i.exec(ar)?.[0] ?? null)
    .find((x) => x !== null) ?? null;

  return {
    bounce_headers,
    delivery_status,
    original,
    diagnostic_admin_texto,
    sinais: {
      dkim_no_original: original?.dkim_signature != null,
      spf_no_original: spfNoOriginal,
      original_authentication_results: origAR,
      diagnostic_menciona_auth: palavras.length > 0,
      palavras_auth_encontradas: palavras,
      aviso: AVISO_METODOLOGICO,
    },
  };
}

// ─── MIME parser ─────────────────────────────────────────────────────────────

export function parseMime(raw: string): MimePart {
  const { headerText, body } = splitHeadersBody(raw);
  const headers = parseHeaders(headerText);
  const ct = getHeader(headers, "content-type") ?? "text/plain";
  const mimeType = ct.split(";")[0]!.trim().toLowerCase();
  const boundary = matchParam(ct, "boundary");
  const cte = getHeader(headers, "content-transfer-encoding") ?? "7bit";
  const charset = matchParam(ct, "charset") ?? "utf-8";

  const part: MimePart = { headers, mimeType, body: "", parts: [] };

  if (mimeType.startsWith("multipart/") && boundary) {
    for (const seg of splitMultipart(body, boundary)) {
      part.parts.push(parseMime(seg));
    }
  } else if (mimeType === "message/rfc822") {
    part.parts.push(parseMime(body));
  } else {
    part.body = decodeBody(body, cte, charset);
  }
  return part;
}

function splitHeadersBody(raw: string): { headerText: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { headerText: raw, body: "" };
  return { headerText: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function parseHeaders(headerText: string): HeaderKV[] {
  // Desdobra continuation lines (começam com espaço/tab).
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const out: HeaderKV[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return out;
}

function splitMultipart(body: string, boundary: string): string[] {
  const delim = "--" + boundary;
  const chunks = body.split(delim);
  const parts: string[] = [];
  for (let i = 1; i < chunks.length; i++) {
    let chunk = chunks[i]!;
    if (chunk.startsWith("--")) break; // fechamento --boundary--
    chunk = chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    parts.push(chunk);
  }
  return parts;
}

function decodeBody(raw: string, cte: string, charset: string): string {
  let bytes = raw;
  const c = cte.toLowerCase();
  if (c === "base64") {
    try { bytes = atob(raw.replace(/\s+/g, "")); } catch { /* keep raw */ }
  } else if (c === "quoted-printable") {
    bytes = raw
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  const cs = charset.toLowerCase();
  if (cs.includes("utf-8") || cs.includes("utf8")) {
    try { return decodeURIComponent(escape(bytes)); } catch { return bytes; }
  }
  return bytes; // latin-1/windows-1252: bytes já mapeiam 1:1 pra chars
}

// ─── extração ────────────────────────────────────────────────────────────────

function flatten(part: MimePart): MimePart[] {
  const out: MimePart[] = [part];
  for (const c of part.parts) out.push(...flatten(c));
  return out;
}

function parseDeliveryStatus(text: string): BounceForensics["delivery_status"] {
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  return {
    reporting_mta: field(unfolded, "reporting-mta"),
    remote_mta: field(unfolded, "remote-mta"),
    final_recipient: cleanRecipient(field(unfolded, "final-recipient")),
    action: field(unfolded, "action"),
    status: field(unfolded, "status"),
    diagnostic_code: field(unfolded, "diagnostic-code"),
  };
}

function extrairOriginal(root: MimePart): BounceForensics["original"] {
  // message/rfc822 → o filho é a mensagem original com headers próprios.
  const rfc822 = flatten(root).find((p) => p.mimeType === "message/rfc822");
  let headers: HeaderKV[] | null = rfc822?.parts[0]?.headers ?? null;

  // text/rfc822-headers → corpo é o bloco de headers crus do original.
  if (!headers) {
    const hp = flatten(root).find((p) => p.mimeType === "text/rfc822-headers");
    if (hp) headers = parseHeaders(hp.body);
  }
  if (!headers) return null;

  return {
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    dkim_signature: getHeader(headers, "dkim-signature"),
    authentication_results: getHeaders(headers, "authentication-results"),
    subject: getHeader(headers, "subject"),
    message_id: getHeader(headers, "message-id"),
  };
}

function extrairTextoAdmin(root: MimePart): string | null {
  // Texto humano do report: text/plain que NÃO está dentro do original anexado.
  // Percorre os filhos diretos do report (e de multipart/alternative), ignora
  // message/rfc822.
  const textos: string[] = [];
  function walk(p: MimePart, dentroOriginal: boolean) {
    if (p.mimeType === "message/rfc822") return; // pula o original
    if (p.mimeType === "text/plain" && !dentroOriginal && p.body.trim()) {
      textos.push(p.body.trim());
    }
    for (const c of p.parts) walk(c, dentroOriginal);
  }
  for (const c of root.parts) walk(c, false);
  const joined = textos.join("\n\n---\n\n").trim();
  return joined.length > 0 ? joined : null;
}

// ─── helpers de header/campo ─────────────────────────────────────────────────

function getHeader(headers: HeaderKV[], name: string): string | null {
  const lower = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === lower) return h.value;
  return null;
}

function getHeaders(headers: HeaderKV[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

function field(text: string, name: string): string | null {
  const v = new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(text)?.[1]?.trim();
  return v && v.length > 0 ? v : null;
}

function cleanRecipient(v: string | null): string | null {
  if (!v) return null;
  const email = v.replace(/^\s*(?:rfc822|x400|utf-8)\s*;?\s*/i, "").match(/[\w.+-]+@[\w.-]+\.\w+/);
  return email?.[0] ?? v;
}

function matchParam(ct: string, param: string): string | null {
  const m = new RegExp(`;\\s*${param}\\s*=\\s*"?([^";]+)"?`, "i").exec(ct);
  return m?.[1]?.trim() ?? null;
}
