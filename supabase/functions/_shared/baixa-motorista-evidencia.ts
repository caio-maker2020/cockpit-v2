// =============================================================================
// baixa-motorista-evidencia — baixa os bytes da foto/PDF da baixa no Roteirizador
// e confere que são EXATAMENTE os que o motorista mandou (ADR 0040).
//
//   GET {RI_PONTE_BASE_URL}/v3/ponte/evidencias/:id   Bearer ROTEIRIZADOR_PONTE_TOKEN
//
// O token é o da direção Cockpit → Roteirizador (o mesmo da ponte v1); o
// PONTE_OPERACAO_TOKEN é só da direção contrária. Base: RI_PONTE_BASE_URL, com
// ROTEIRIZADOR_API_URL (a mesma API da v1) como reserva.
//
// Conferência (pura, `conferirEvidencia`): sha256 dos bytes == o declarado na
// baixa; mime do cabeçalho == o declarado; assinatura dos bytes == o mime
// (JPEG FF D8 FF, PDF %PDF-). Qualquer divergência = a evidência não vai ao SSW.
//
// Nunca lança: erro de rede/5xx = `transitorio` (tenta na próxima rodada, até o
// TTL); 4xx = `definitivo`.
// =============================================================================

export const TIMEOUT_EVIDENCIA_MS = 20_000;
/** O SSW recusa anexo grande; 8 MB cobre foto de celular com folga. */
export const MAX_BYTES_EVIDENCIA = 8 * 1024 * 1024;

export interface EnvEvidencia {
  baseUrl: string;
  token: string;
}

export function lerEnvEvidencia(env: Record<string, string | undefined>): EnvEvidencia | null {
  const baseUrl = (env["RI_PONTE_BASE_URL"] ?? env["ROTEIRIZADOR_API_URL"] ?? "").trim().replace(/\/+$/, "");
  const token = (env["ROTEIRIZADOR_PONTE_TOKEN"] ?? "").trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

export type ResultadoDownload =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; tipo: "transitorio" | "definitivo"; motivo: string };

export async function baixarEvidencia(
  id: string,
  env: EnvEvidencia | null,
  f: typeof fetch = fetch,
): Promise<ResultadoDownload> {
  if (!env) return { ok: false, tipo: "transitorio", motivo: "RI_PONTE_BASE_URL/ROTEIRIZADOR_PONTE_TOKEN ausentes no Cockpit" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_EVIDENCIA_MS);
  try {
    const res = await f(`${env.baseUrl}/v3/ponte/evidencias/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return res.status >= 500 || res.status === 429
        ? { ok: false, tipo: "transitorio", motivo: `Roteirizador respondeu ${res.status} na evidência ${id}` }
        : { ok: false, tipo: "definitivo", motivo: `Roteirizador respondeu ${res.status} na evidência ${id}` };
    }
    const declarado = Number(res.headers.get("content-length") ?? "0");
    if (declarado > MAX_BYTES_EVIDENCIA) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, tipo: "definitivo", motivo: `evidência ${id} tem ${declarado} bytes (máx. ${MAX_BYTES_EVIDENCIA})` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES_EVIDENCIA) {
      return { ok: false, tipo: "definitivo", motivo: `evidência ${id} tem ${bytes.length} bytes (máx. ${MAX_BYTES_EVIDENCIA})` };
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return { ok: true, bytes, contentType };
  } catch (e) {
    return { ok: false, tipo: "transitorio", motivo: `evidência ${id}: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(dig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function assinaturaBate(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "application/pdf") {
    return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  return false;
}

/** Pura (fora o hash): os bytes baixados são os que a baixa declarou? */
export async function conferirEvidencia(
  baixado: { bytes: Uint8Array; contentType: string },
  esperado: { sha256: string; mime: string },
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const sha = await sha256Hex(baixado.bytes);
  if (sha !== esperado.sha256.toLowerCase()) {
    return { ok: false, motivo: `sha256 da evidência não confere (baixado ${sha.slice(0, 12)}…, declarado ${esperado.sha256.slice(0, 12)}…)` };
  }
  if (baixado.contentType !== esperado.mime) {
    return { ok: false, motivo: `mime da evidência não confere (servido ${baixado.contentType || "vazio"}, declarado ${esperado.mime})` };
  }
  if (!assinaturaBate(baixado.bytes, esperado.mime)) {
    return { ok: false, motivo: `os bytes da evidência não são ${esperado.mime}` };
  }
  return { ok: true };
}
