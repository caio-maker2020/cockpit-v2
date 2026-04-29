// AUTO-MIRROR de /lib/anthropic-client.ts — não edite direto.

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
  system?: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface AnthropicCompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  raw: unknown;
}

export class AnthropicError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Anthropic API ${status}: ${body.slice(0, 300)}`);
  }
}

export interface AnthropicClient {
  complete(input: AnthropicCompletionInput): Promise<AnthropicCompletionResult>;
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
}): AnthropicClient {
  const f = deps.fetch ?? fetch;

  async function complete(input: AnthropicCompletionInput): Promise<AnthropicCompletionResult> {
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

    const raw = await res.text();
    if (!res.ok) throw new AnthropicError(res.status, raw);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AnthropicError(res.status, `Resposta não é JSON: ${raw.slice(0, 200)}`);
    }

    const content = (parsed["content"] as Array<Record<string, unknown>> | undefined) ?? [];
    const firstText = content.find((c) => c["type"] === "text");
    const text = firstText && typeof firstText["text"] === "string" ? firstText["text"] : "";

    const usage = (parsed["usage"] as Record<string, unknown> | undefined) ?? {};
    const inputTokens = (usage["input_tokens"] as number | undefined) ?? 0;
    const outputTokens = (usage["output_tokens"] as number | undefined) ?? 0;

    const model = (parsed["model"] as string | undefined) ?? input.model;
    const stopReason = (parsed["stop_reason"] as string | null | undefined) ?? null;

    return { text, model, inputTokens, outputTokens, stopReason, raw: parsed };
  }

  async function completeJson<T>(input: AnthropicCompletionInput): Promise<T> {
    const result = await complete(input);
    const parsed = tryParseJson<T>(result.text);
    if (parsed.ok) return parsed.value;

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
    });

    const reparsed = tryParseJson<T>(retry.text);
    if (reparsed.ok) return reparsed.value;

    throw new Error(
      `Anthropic retornou texto não-JSON em 2 tentativas. ` +
        `1ª: ${result.text.slice(0, 200)}; 2ª: ${retry.text.slice(0, 200)}`,
    );
  }

  return { complete, completeJson };
}

function tryParseJson<T>(text: string): { ok: true; value: T } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch {
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
