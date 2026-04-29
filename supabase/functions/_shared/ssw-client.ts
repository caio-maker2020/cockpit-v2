/**
 * Adapter HTTP do TMS SSW.
 *
 * Responsabilidades:
 *   - Cache de token em memória (TTL 50min — folga sobre o token real, que é 1h).
 *   - Idempotency key por (cardId, codigoOcorrencia, nf) via SHA-256.
 *   - Retry com backoff exponencial em 5xx (3 tentativas).
 *   - Normalização de erros do SSW para nossas categorias.
 *
 * Tudo via env. Sem segredos hardcoded. Edge Function injeta o env, lib pura
 * lê via factory. Token e idempotência ficam por instância — uma instância
 * por processo é o esperado.
 *
 * Origem das URLs e payloads: edge-functions/ssw-ocorrencia (v1).
 */

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50min
const RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 500;

const SSW_GENERATE_TOKEN_URL = "https://ssw.inf.br/api/generateToken";
const SSW_OCORRENCIA_URL = "https://ssw.inf.br/api/ocorrenciaParceiro";

export interface SswEnv {
  domain: string;
  username: string;
  password: string;
  cnpjEdi: string;
}

export interface LancarOcorrenciaInput {
  cardId: string;
  cnpjRemetente: string;
  numeroNFe: string;
  serieNFe?: string;
  codigo: string;
  descricao: string;
  /** ISO 8601. Padrão: agora. */
  dataHoraEvento?: string;
}

export type LancarOcorrenciaResult =
  | {
      ok: true;
      protocolo: string;
      idempotencyKey: string;
      raw: unknown;
    }
  | {
      ok: false;
      idempotencyKey: string;
      status: number;
      error: string;
      raw: unknown;
    };

export interface SswClient {
  /** Para teste / observability. Recalcula o cache antes do TTL se forçado. */
  getToken(force?: boolean): Promise<string>;
  lancarOcorrencia(
    input: LancarOcorrenciaInput
  ): Promise<LancarOcorrenciaResult>;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Lê o env do SSW de `Deno.env`-like / `process.env`. Falha rápido se faltar
 * algum valor obrigatório — mascarar com defaults aqui esconde erro de config.
 *
 * Os defaults do v1 (`SEP`/`salexpre`/`21280493000130`) ficam só no
 * `.env.example` para documentação; a lib exige presença explícita.
 */
export function readSswEnvFromProcess(env: Record<string, string | undefined>): SswEnv {
  const domain = env["SSW_DOMAIN"];
  const username = env["SSW_USERNAME"];
  const password = env["SSW_PASSWORD"];
  const cnpjEdi = env["SSW_CNPJ_EDI"];

  if (!domain) throw new Error("SSW_DOMAIN não configurado");
  if (!username) throw new Error("SSW_USERNAME não configurado");
  if (!password) throw new Error("SSW_PASSWORD não configurado");
  if (!cnpjEdi) throw new Error("SSW_CNPJ_EDI não configurado");

  return { domain, username, password, cnpjEdi };
}

/**
 * Deriva idempotency key estável para uma operação SSW.
 * Mesmo cardId+codigo+nf sempre produz a mesma chave; o banco
 * (audit_log.idempotency_key UNIQUE) impede execução dupla.
 */
export async function buildIdempotencyKey(
  cardId: string,
  codigo: string,
  nf: string
): Promise<string> {
  const data = new TextEncoder().encode(`${cardId}:${codigo}:${nf}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Factory do client. Injeção de env e (opcionalmente) `fetch`/`now` —
 * facilita teste sem precisar mockar global.
 */
export function createSswClient(deps: {
  env: SswEnv;
  fetch?: typeof fetch;
  now?: () => number;
}): SswClient {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());

  let cached: CachedToken | null = null;

  async function getToken(force = false): Promise<string> {
    if (!force && cached && cached.expiresAt > now()) {
      return cached.token;
    }

    const res = await f(SSW_GENERATE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: deps.env.domain,
        username: deps.env.username,
        password: deps.env.password,
        cnpj_edi: deps.env.cnpjEdi,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SSW token error [${res.status}]: ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const token = (data["token"] ?? data["access_token"] ?? null) as
      | string
      | null;
    if (!token || typeof token !== "string") {
      throw new Error(
        `SSW token response sem campo token reconhecido: ${JSON.stringify(data)}`
      );
    }

    cached = { token, expiresAt: now() + TOKEN_TTL_MS };
    return token;
  }

  async function lancarOcorrencia(
    input: LancarOcorrenciaInput
  ): Promise<LancarOcorrenciaResult> {
    const idempotencyKey = await buildIdempotencyKey(
      input.cardId,
      input.codigo,
      input.numeroNFe
    );

    // Schema oficial (https://ssw.inf.br/ajuda/webapiOcorParceiro.html):
    // body é aninhado em { cnpjRemetente, nf:{...}, ocorrencia:{...} }
    const body = {
      cnpjRemetente: input.cnpjRemetente,
      nf: {
        serieNFe: input.serieNFe ?? "1",
        numeroNFe: parseNumeroNFe(input.numeroNFe),
      },
      ocorrencia: {
        dataHoraEvento: input.dataHoraEvento ?? formatSswDateTime(new Date()),
        codigo: input.codigo,
        descricao: input.descricao,
        complemento: "",
        dataHoraAgendamento: "",
        unidade: "",
      },
    };

    let lastError: { status: number; raw: unknown; message: string } = {
      status: 0,
      raw: null,
      message: "no attempt",
    };

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      const token = await getToken(attempt > 0);
      // Header oficial é `authorization: <token>` SEM prefix "Bearer".
      // Confirmado empiricamente: "Bearer x" → 401 "CHAVE TOKEN EXPIRADA";
      // só `<token>` cru funciona. Doc: https://ssw.inf.br/ajuda/webapiOcorParceiro.html
      const res = await f(SSW_OCORRENCIA_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: token,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }

      if (res.ok || res.status === 201) {
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const protocolo =
          (obj["protocolo"] as string | undefined) ??
          (obj["id"] as string | undefined) ??
          (obj["numero"] as string | undefined) ??
          "";
        return {
          ok: true,
          protocolo: protocolo || "N/A",
          idempotencyKey,
          raw: parsed,
        };
      }

      // 4xx: erro do nosso lado, não adianta retry.
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          idempotencyKey,
          status: res.status,
          error: extractErrorMessage(parsed) ?? text,
          raw: parsed,
        };
      }

      // 5xx: backoff exponencial e tenta de novo.
      lastError = {
        status: res.status,
        raw: parsed,
        message: extractErrorMessage(parsed) ?? text,
      };
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }

    return {
      ok: false,
      idempotencyKey,
      status: lastError.status,
      error: `5xx após ${RETRY_COUNT} tentativas: ${lastError.message}`,
      raw: lastError.raw,
    };
  }

  return { getToken, lancarOcorrencia };
}

function extractErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const msg = obj["message"] ?? obj["erro"] ?? obj["error"];
  return typeof msg === "string" ? msg : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SSW espera numeroNFe como integer (ex.: 154848). Pode chegar como string
 * com zeros à esquerda; convertemos pra number.
 */
function parseNumeroNFe(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const trimmed = raw.replace(/\D/g, "");
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`numeroNFe inválido: "${raw}"`);
  }
  return n;
}

/**
 * Formato esperado por dataHoraEvento na API (visto no exemplo da doc):
 *   "2019-11-07T00:18:24:000-03:00"
 * Diferente do ISO 8601 padrão (usa `:` ao invés de `.` antes dos millis).
 * Aceitamos uma `Date` e formatamos pro horário de São Paulo (UTC-3).
 */
function formatSswDateTime(d: Date): string {
  // Aplica offset -3h (BRT, sem horário de verão — Sal Express opera assim)
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brt.getUTCFullYear();
  const mm = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(brt.getUTCDate()).padStart(2, "0");
  const HH = String(brt.getUTCHours()).padStart(2, "0");
  const MM = String(brt.getUTCMinutes()).padStart(2, "0");
  const SS = String(brt.getUTCSeconds()).padStart(2, "0");
  const ms = String(brt.getUTCMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}:${ms}-03:00`;
}
