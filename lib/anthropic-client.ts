/**
 * Cliente Anthropic API minimalista.
 *
 * Usa fetch direto sobre /v1/messages — sem dependência do SDK
 * @anthropic-ai/sdk pra manter a lib leve, Bun-testável, e Deno-compatível
 * sem ginástica de imports.
 *
 * Roteamento de modelo (CLAUDE.md):
 *   - Haiku 4.5  → triagem/classificação simples
 *   - Sonnet 4.6 → agentes especialistas (raciocínio + tool use)
 *   - Opus 4.7   → auditoria periódica e casos especiais
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicModel =
  | "claude-haiku-4-5"
  | "claude-sonnet-4-6"
  | "claude-opus-4-7";

export interface AnthropicEnv {
  apiKey: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicCompletionInput {
  model: AnthropicModel;
  /** Prompt do sistema (vindo de prompts/*.md normalmente). */
  system?: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  /** 0 → determinístico; 1 → criativo. Default 0.2 (estável pra classificação). */
  temperature?: number;
  /** Metadados OPCIONAIS de telemetria de uso/custo (não vão pra API Anthropic). */
  meta?: AnthropicUsageMeta;
}

export interface AnthropicCompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  raw: unknown;
  /** Campos aditivos (telemetria) — opcionais p/ não quebrar callers existentes. */
  requestId?: string | null;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** Metadados de telemetria por chamada. NUNCA inclui prompt/conteúdo/PII. */
export interface AnthropicUsageMeta {
  functionName?: string;
  agentName?: string;
  cardId?: string;
  messageId?: string;
  imageCount?: number;
  /** Se passado, o wrapper empurra 1 registro por attempt aqui (p/ agent_runs etc). */
  usageSink?: AnthropicUsageRecord[];
}

/** Registro de uso de UMA chamada (attempt). Só metadados — sem conteúdo. */
export interface AnthropicUsageRecord {
  functionName?: string;
  agentName?: string;
  cardId?: string;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  imageCount: number;
  requestId: string | null;
  stopReason: string | null;
  status: "success" | "error";
  attempt: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * Resposta de erro do Anthropic API. Não tipo todos os campos —
 * repassamos `raw` pro caller decidir.
 */
export class AnthropicError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Anthropic API ${status}: ${body.slice(0, 300)}`);
  }
}

export interface AnthropicClient {
  complete(input: AnthropicCompletionInput): Promise<AnthropicCompletionResult>;
  /**
   * Helper que faz `complete` + extrai JSON da resposta.
   * Tolera ```json fences, prefixos/sufixos textuais leves, e re-tenta
   * 1x com tom mais firme se o JSON falhar.
   */
  completeJson<T>(input: AnthropicCompletionInput): Promise<T>;
}

export function readAnthropicEnvFromProcess(env: Record<string, string | undefined>): AnthropicEnv {
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY não configurado");
  return { apiKey };
}

export function createAnthropicClient(deps: {
  env: AnthropicEnv;
  fetch?: typeof fetch;
  /**
   * Hook BEST-EFFORT de telemetria. Chamado 1x por ATTEMPT (retry = attempt
   * separado, p/ não esconder custo dobrado). NUNCA deve quebrar a chamada —
   * o wrapper já engole erros. Opcional: sem ele, o client age como antes.
   */
  onUsage?: (rec: AnthropicUsageRecord) => void | Promise<void>;
}): AnthropicClient {
  const f = deps.fetch ?? fetch;

  async function complete(
    input: AnthropicCompletionInput,
    attempt = 1,
  ): Promise<AnthropicCompletionResult> {
    const startedAt = new Date().toISOString();
    const meta = input.meta;
    let requestId: string | null = null;
    let usageFired = false;

    // Emite 1 registro de telemetria (best-effort). NUNCA propaga erro.
    const fireUsage = async (o: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      stopReason: string | null;
      status: "success" | "error";
    }): Promise<void> => {
      if (!deps.onUsage && !meta?.usageSink) return;
      usageFired = true;
      const rec: AnthropicUsageRecord = {
        functionName: meta?.functionName,
        agentName: meta?.agentName,
        cardId: meta?.cardId,
        messageId: meta?.messageId,
        model: o.model,
        inputTokens: o.inputTokens,
        outputTokens: o.outputTokens,
        cacheCreationTokens: o.cacheCreationTokens,
        cacheReadTokens: o.cacheReadTokens,
        imageCount: meta?.imageCount ?? 0,
        requestId,
        stopReason: o.stopReason,
        status: o.status,
        attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      if (meta?.usageSink) meta.usageSink.push(rec);
      if (deps.onUsage) {
        try {
          await deps.onUsage(rec);
        } catch (usageErr) {
          const m = usageErr instanceof Error ? usageErr.message : String(usageErr);
          console.error("[anthropic-client] onUsage falhou (ignorado):", m);
        }
      }
    };

    // Registro de erro: tokens 0, modelo solicitado (resposta não parseada).
    const errZero = () => ({
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      stopReason: null,
      status: "error" as const,
    });

    try {
      const body: Record<string, unknown> = {
        model: input.model,
        max_tokens: input.maxTokens,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
      };
      if (input.system) body["system"] = input.system;

      const res = await f(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": deps.env.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      requestId = res.headers.get("request-id") ??
        res.headers.get("anthropic-request-id") ?? null;

      const raw = await res.text();
      if (!res.ok) {
        await fireUsage(errZero());
        throw new AnthropicError(res.status, raw);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await fireUsage(errZero());
        throw new AnthropicError(res.status, `Resposta não é JSON: ${raw.slice(0, 200)}`);
      }

      const content = (parsed["content"] as Array<Record<string, unknown>> | undefined) ?? [];
      const firstText = content.find((c) => c["type"] === "text");
      const text = firstText && typeof firstText["text"] === "string" ? firstText["text"] : "";

      const usage = (parsed["usage"] as Record<string, unknown> | undefined) ?? {};
      const inputTokens = (usage["input_tokens"] as number | undefined) ?? 0;
      const outputTokens = (usage["output_tokens"] as number | undefined) ?? 0;
      const cacheCreationTokens = (usage["cache_creation_input_tokens"] as number | undefined) ?? 0;
      const cacheReadTokens = (usage["cache_read_input_tokens"] as number | undefined) ?? 0;

      const model = (parsed["model"] as string | undefined) ?? input.model;
      const stopReason = (parsed["stop_reason"] as string | null | undefined) ?? null;

      await fireUsage({
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        stopReason,
        status: "success",
      });

      return {
        text,
        model,
        inputTokens,
        outputTokens,
        stopReason,
        raw: parsed,
        requestId,
        cacheCreationTokens,
        cacheReadTokens,
      };
    } catch (err) {
      // Falha antes de qualquer fireUsage (ex.: fetch rejeitou / timeout): loga
      // 1 linha de erro best-effort. Se já logamos acima, não duplica.
      if (!usageFired) {
        await fireUsage(errZero());
      }
      throw err;
    }
  }

  async function completeJson<T>(input: AnthropicCompletionInput): Promise<T> {
    const result = await complete(input, 1);
    const parsed = tryParseJson<T>(result.text);
    if (parsed.ok) return parsed.value;

    // Re-tenta uma vez sendo mais firme sobre formato (attempt=2 → log separado).
    const retry = await complete({
      ...input,
      messages: [
        ...input.messages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content:
            "Sua resposta anterior não pôde ser parseada como JSON. Devolva " +
            "EXCLUSIVAMENTE um único objeto JSON válido, sem nenhum texto " +
            "antes ou depois, sem ```. Garanta que parse com JSON.parse.",
        },
      ],
    }, 2);

    const reparsed = tryParseJson<T>(retry.text);
    if (reparsed.ok) return reparsed.value;

    throw new Error(
      `Anthropic retornou texto não-JSON em 2 tentativas. ` +
        `1ª: ${result.text.slice(0, 200)}; 2ª: ${retry.text.slice(0, 200)}`,
    );
  }

  return { complete, completeJson };
}

/**
 * Extrai e parseia JSON da resposta do Claude. Tolera:
 *  - JSON puro
 *  - JSON envolto em ```json ... ```
 *  - JSON envolto em ``` ... ```
 *  - Texto antes/depois (pega primeira ocorrência de { ... } ou [ ... ])
 */
function tryParseJson<T>(text: string): { ok: true; value: T } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };

  // Strip code fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;

  // Tenta parse direto
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch {
    // Tenta extrair primeiro objeto/array que parsea
    const start = candidate.search(/[\{\[]/);
    if (start === -1) return { ok: false };
    for (let end = candidate.length; end > start; end--) {
      const sub = candidate.slice(start, end);
      try {
        return { ok: true, value: JSON.parse(sub) as T };
      } catch {
        continue;
      }
    }
  }
  return { ok: false };
}
