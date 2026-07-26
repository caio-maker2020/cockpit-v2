// AUTO-MIRROR de /lib/anthropic-client.ts — não edite direto.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Teto do retry por truncamento — evita que o dobro vire cheque em branco. */
const TETO_MAX_TOKENS_RETRY = 4000;

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
  /** Metadados OPCIONAIS de telemetria de uso/custo (não vão pra API Anthropic). */
  meta?: AnthropicUsageMeta;
  /**
   * Avisa o caller que o JSON veio CORTADO e foi remendado (leitura parcial).
   * Quem recebe deve degradar confiança / marcar pro humano — nunca tratar
   * como leitura completa. Só usado por completeJson.
   */
  onJsonReparado?: (info: { attempt: number; stopReason: string | null }) => void;
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
    if (parsed.ok && !parsed.reparado) return parsed.value;

    // A 2ª tentativa TEM QUE REMOVER A CAUSA (incidente 26/07): quando a
    // resposta foi CORTADA por max_tokens, repetir com o mesmo teto corta de
    // novo — 268 falhas e 285 chamadas desperdiçadas num domingo. Truncou →
    // repete com teto MAIOR e pedido de concisão. Só o caso "veio lixo/texto"
    // usa o pedido antigo de "devolva JSON".
    const truncou = result.stopReason === "max_tokens";
    const retry = await complete({
      ...input,
      maxTokens: truncou
        ? Math.min(Math.round(input.maxTokens * 2), TETO_MAX_TOKENS_RETRY)
        : input.maxTokens,
      messages: [
        ...input.messages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content: truncou
            ? "Sua resposta anterior foi CORTADA no meio (estourou o limite). " +
              "Devolva o MESMO JSON de forma COMPLETA e mais enxuta: respeite " +
              "os limites de caracteres de cada campo, sem texto antes ou " +
              "depois, sem ```."
            : "Sua resposta anterior não pôde ser parseada como JSON. Devolva " +
              "EXCLUSIVAMENTE um único objeto JSON válido, sem nenhum texto " +
              "antes ou depois, sem ```. Garanta que parse com JSON.parse.",
        },
      ],
    }, 2);

    const reparsed = tryParseJson<T>(retry.text);
    if (reparsed.ok && !reparsed.reparado) return reparsed.value;

    // Nenhuma tentativa veio inteira. Antes de desistir (e deixar o card sem
    // NADA), aproveita a leitura PARCIAL — avisando o caller pra degradar.
    const salvavel = reparsed.ok ? reparsed : parsed.ok ? parsed : null;
    if (salvavel?.ok) {
      input.onJsonReparado?.({
        attempt: reparsed.ok ? 2 : 1,
        stopReason: reparsed.ok ? retry.stopReason : result.stopReason,
      });
      return salvavel.value;
    }

    throw new Error(
      `Anthropic retornou texto não-JSON em 2 tentativas. ` +
        `1ª: ${result.text.slice(0, 200)}; 2ª: ${retry.text.slice(0, 200)}`,
    );
  }

  return { complete, completeJson };
}

function tryParseJson<T>(
  text: string,
): { ok: true; value: T; reparado: boolean } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return { ok: true, value: JSON.parse(candidate) as T, reparado: false };
  } catch {
    const start = candidate.search(/[\{\[]/);
    if (start === -1) return { ok: false };
    for (let end = candidate.length; end > start; end--) {
      const sub = candidate.slice(start, end);
      try {
        return { ok: true, value: JSON.parse(sub) as T, reparado: false };
      } catch {
        continue;
      }
    }
  }
  // Último recurso: resposta CORTADA no meio (stop_reason=max_tokens). Os
  // campos de decisão vêm primeiro no schema, então o pedaço que chegou
  // costuma bastar — melhor entregar leitura parcial marcada do que
  // devolver nada e deixar o card órfão (incidente 26/07, NF 164346).
  const reparado = repararJsonTruncado(candidate);
  if (reparado !== null) {
    try {
      return { ok: true, value: JSON.parse(reparado) as T, reparado: true };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

/**
 * Fecha um JSON truncado no meio, preservando o maior prefixo VÁLIDO.
 *
 * Percorre da direita pra esquerda procurando um ponto de corte que, com os
 * delimitadores abertos fechados na ordem certa, parseia. Devolve `null`
 * quando não há nada aproveitável. Nunca inventa valor: só descarta o que
 * veio pela metade.
 */
export function repararJsonTruncado(texto: string): string | null {
  const inicio = texto.search(/[\{\[]/);
  if (inicio === -1) return null;
  const corpo = texto.slice(inicio);

  // Estado (dentro de string? pilha de fechamentos) posição a posição.
  const dentroString: boolean[] = new Array(corpo.length + 1);
  const pilhas: string[][] = new Array(corpo.length + 1);
  let emString = false;
  let escape = false;
  const pilha: string[] = [];
  dentroString[0] = false;
  pilhas[0] = [];
  for (let i = 0; i < corpo.length; i++) {
    const ch = corpo[i]!;
    if (emString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') emString = false;
    } else if (ch === '"') {
      emString = true;
    } else if (ch === "{" || ch === "[") {
      pilha.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      pilha.pop();
    }
    dentroString[i + 1] = emString;
    pilhas[i + 1] = [...pilha];
  }

  const MAX_TENTATIVAS = 4000;
  let tentativas = 0;
  for (let corte = corpo.length; corte > 0 && tentativas < MAX_TENTATIVAS; corte--) {
    if (dentroString[corte]) continue; // não corta dentro de string
    let prefixo = corpo.slice(0, corte).replace(/[,:\s]+$/, "");
    if (!prefixo) continue;
    // chave sem valor ("motivo": ) → descarta a chave inteira
    if (/"[^"]*"$/.test(prefixo) && /[,{]\s*"[^"]*"$/.test(prefixo)) {
      prefixo = prefixo.replace(/[,{]\s*"[^"]*"$/, (m) => (m.trimStart().startsWith("{") ? "{" : ""));
      if (!prefixo) continue;
    }
    const fechamento = [...(pilhas[corte] ?? [])].reverse().join("");
    const candidato = prefixo + fechamento;
    tentativas++;
    try {
      JSON.parse(candidato);
      return candidato;
    } catch {
      continue;
    }
  }
  return null;
}
