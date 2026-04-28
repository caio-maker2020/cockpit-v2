/**
 * Adapter da Evolution API (WhatsApp).
 *
 * Responsabilidades:
 *   - Limpar JID (`@s.whatsapp.net`, `@g.us`).
 *   - Pular grupos (`@g.us`) — bot da Sal Express só fala com pessoa.
 *   - Aplicar fix do 9º dígito brasileiro.
 *   - POST `/message/sendText/<instance>` com header `apikey`.
 *
 * Tudo via env, instância configurável (padrão `sal-express` herdado do v1).
 * A lib não toca em retry/idempotência aqui — WhatsApp tem comportamento de
 * delivery próprio e o caller deve registrar `audit_log` com `external_id`
 * vindo do `data.key.id` retornado pela Evolution.
 */

import { fixBrazilianMobile, parseWhatsappJid } from "./extractors.js";

export interface EvolutionEnv {
  apiUrl: string;
  apiKey: string;
  /** Padrão: `sal-express` (instância única no v1). */
  instance: string;
}

export interface SendWhatsappInput {
  /** JID cru OU número já normalizado. A função tolera ambos. */
  number: string;
  text: string;
}

export type SendWhatsappResult =
  | { ok: true; skipped: false; data: unknown; messageId: string | null }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; status: number; error: string; raw: unknown };

export interface EvolutionClient {
  sendWhatsapp(input: SendWhatsappInput): Promise<SendWhatsappResult>;
}

export function readEvolutionEnvFromProcess(
  env: Record<string, string | undefined>
): EvolutionEnv {
  const apiUrl = env["EVOLUTION_API_URL"];
  const apiKey = env["EVOLUTION_API_KEY"];
  const instance = env["EVOLUTION_INSTANCE"] ?? "sal-express";

  if (!apiUrl) throw new Error("EVOLUTION_API_URL não configurado");
  if (!apiKey) throw new Error("EVOLUTION_API_KEY não configurado");

  return { apiUrl: apiUrl.replace(/\/+$/, ""), apiKey, instance };
}

export function createEvolutionClient(deps: {
  env: EvolutionEnv;
  fetch?: typeof fetch;
}): EvolutionClient {
  const f = deps.fetch ?? fetch;

  async function sendWhatsapp(
    input: SendWhatsappInput
  ): Promise<SendWhatsappResult> {
    const { number: cleaned, isGroup } = parseWhatsappJid(input.number);

    if (isGroup) {
      return { ok: true, skipped: true, reason: "grupo (@g.us)" };
    }

    // Extra guard: se ainda tiver `@` (JID exótico) ou ficou comprido demais,
    // não envia — Evolution falharia silenciosamente ou enviaria pra alvo errado.
    if (cleaned.includes("@") || cleaned.length > 15) {
      return {
        ok: true,
        skipped: true,
        reason: `JID não pessoal: ${input.number}`,
      };
    }

    const number = fixBrazilianMobile(cleaned);
    const url = `${deps.env.apiUrl}/message/sendText/${deps.env.instance}`;

    const res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: deps.env.apiKey,
      },
      body: JSON.stringify({ number, text: input.text }),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: extractErrorMessage(parsed) ?? text,
        raw: parsed,
      };
    }

    return {
      ok: true,
      skipped: false,
      data: parsed,
      messageId: extractMessageId(parsed),
    };
  }

  return { sendWhatsapp };
}

function extractErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const msg = obj["message"] ?? obj["error"];
  if (Array.isArray(msg)) return msg.map(String).join("; ");
  return typeof msg === "string" ? msg : null;
}

function extractMessageId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const key = obj["key"];
  if (key && typeof key === "object") {
    const id = (key as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return null;
}
