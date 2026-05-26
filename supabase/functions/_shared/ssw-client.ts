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

/**
 * Remapeamento de código semântico (Cockpit) → código wire (SSW API).
 *
 * Caio 2026-05-26: SSW fez mudança sistêmica. Agora a API
 * `/api/ocorrenciaParceiro` exige que se envie o código 71 pra que oc=33
 * apareça no portal SSW. O resto do Cockpit (state machine, regras,
 * propostas, eventos, histórico) continua trabalhando com 33 semântico —
 * só o wire da API é remapeado aqui. Caso âncora: NF 713556 falhou em
 * 26/05 com "CODIGO SSW NAO CADASTRADO" tentando codigo=33 direto.
 *
 * Aplica APENAS na API JSON. Portal interno (opção 101 via lancarOcorrenciaPortal)
 * é fluxo separado — não usa este mapeamento.
 */
const OC_REMAP_API_SSW: Record<string, string> = {
  "33": "71",
};

export interface SswEnv {
  domain: string;
  username: string;
  password: string;
  cnpjEdi: string;
}

export interface LancarOcorrenciaInput {
  cardId: string;
  /**
   * UUID do todo aprovado. Inclui no hash de idempotency_key pra que cada
   * todo aprovado seja um lançamento independente. Sem isso, o operador
   * não conseguiria aprovar uma 2ª reentrega na mesma NF (cliente cobrar de
   * novo após oc 21 anterior).
   */
  todoId: string;
  cnpjRemetente: string;
  /**
   * Chave fiscal do CT-e — 44 dígitos numéricos. É o identificador que o SSW
   * resolve confiável (numeroNFe+serieNFe falhou em todos os testes; só chave
   * CT-e ou chave NFe funcionam).
   */
  chaveCTe: string;
  codigo: string;
  descricao: string;
  /** Formato SSW: "yyyy-mm-ddThh:mm:ss:mmm-03:00". Padrão: agora BRT. */
  dataHoraEvento?: string;
  /**
   * Texto adicional (opcional). Vai pra `ocorrencia.complemento` no body SSW.
   * Diferente de `descricao` — descricao é o texto principal/oficial da oc;
   * complemento é info extra que aparece junto no SSW.
   */
  complemento?: string;
  /**
   * Imagem opcional em base64 (JPEG ou PDF). Vai pra `ocorrencia.imagem` no
   * body SSW. Setor responsável vê direto no SSW sem precisar abrir Cockpit.
   * Doc: https://ssw.inf.br/ajuda/webapiOcorParceiro.html (Caio 2026-05-08)
   */
  imagem?: string;
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
 * Deriva idempotency key estável pra uma operação SSW.
 *
 * Inclui `todoId` no hash pra permitir múltiplos lançamentos da MESMA oc na
 * MESMA NF — cada to-do aprovado é um lançamento independente. Sem isso, o
 * operador não conseguiria aprovar uma 2ª reentrega no mesmo card depois que
 * o cliente cobra novamente (cenário comum da Sal Express).
 *
 * O banco (`audit_log.idempotency_key UNIQUE`) ainda impede que o MESMO todo
 * seja executado 2x (ex.: retry de network) — porque mesmo todoId → mesma
 * chave SHA256.
 */
export async function buildIdempotencyKey(
  cardId: string,
  todoId: string,
  codigo: string,
  chaveCTe: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${cardId}:${todoId}:${codigo}:${chaveCTe}`);
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
      input.todoId,
      input.codigo,
      input.chaveCTe,
    );

    // Schema validado empiricamente em 2026-04-29 com NF 1235323:
    // body aninhado { cnpjRemetente, cte:{chaveCTe}, ocorrencia:{...} }
    // chaveCTe (44 dígitos fiscais) é o ID confiável; numeroNFe+serieNFe
    // não funcionou no SSW da Sal Express (sempre "DOCUMENTO NAO ENCONTRADO").
    //
    // Caio 2026-05-26: codigo wire pode diferir do semântico — ver OC_REMAP_API_SSW.
    const codigoWire = OC_REMAP_API_SSW[input.codigo] ?? input.codigo;
    const body = {
      cnpjRemetente: input.cnpjRemetente,
      cte: {
        chaveCTe: input.chaveCTe,
      },
      ocorrencia: {
        dataHoraEvento: input.dataHoraEvento ?? formatSswDateTime(new Date()),
        codigo: codigoWire,
        descricao: input.descricao,
        complemento: input.complemento ?? "",
        dataHoraAgendamento: "",
        unidade: "",
        // Caio 2026-05-08: imagem é opcional. SSW aceita "" ou ausência.
        // Mantém o campo sempre presente pra payload ser estável.
        imagem: input.imagem ?? "",
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
