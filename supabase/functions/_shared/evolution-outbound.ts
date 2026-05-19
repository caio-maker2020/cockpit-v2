// Caio 2026-05-19 (PRIORIDADES AI):
// WhatsApp outbound via Evolution API, multi-instance (1 instance por operador).
// Mesmo padrão de SSW_INTERNAL_<NOME>_* (cada operador tem seu próprio número).
//
// Onboarding novo operador:
//   1. Criar instance no servidor Evolution + capturar API key
//   2. `supabase secrets set EVOLUTION_<NOME>_INSTANCE=... EVOLUTION_<NOME>_APIKEY=...`
//
// Endpoint Evolution `/message/sendText/<instance>` recebe { number, text }
// e envia uma mensagem de texto pura.

export interface EvolutionEnv {
  baseUrl: string;
  instance: string;
  apikey: string;
}

/**
 * Lê config do Evolution pro operador alvo. Fallback pra config genérica
 * (EVOLUTION_INSTANCE/EVOLUTION_APIKEY) se específica não existir.
 */
export function readEvolutionEnv(
  env: Record<string, string | undefined>,
  operadorNome?: string | null,
): EvolutionEnv {
  const baseUrl = env["EVOLUTION_BASE_URL"];
  if (!baseUrl) {
    throw new Error("EVOLUTION_BASE_URL não configurado");
  }

  const prefix = operadorNome
    ? `EVOLUTION_${operadorNome.trim().toUpperCase()}_`
    : "EVOLUTION_";

  const instance = env[`${prefix}INSTANCE`] ?? env["EVOLUTION_INSTANCE"];
  const apikey = env[`${prefix}APIKEY`] ?? env["EVOLUTION_APIKEY"];

  if (!instance || !apikey) {
    throw new Error(
      `Evolution env ausente pra operador=${operadorNome ?? "genérico"} ` +
      `(prefix=${prefix}, fallback=EVOLUTION_*). Setar via supabase secrets set.`,
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), instance, apikey };
}

/**
 * Normaliza telefone pro formato Evolution: 5535999990000 (sem +, sem mask).
 * Aceita formatos: "(35) 99999-0000", "+5535999990000", "35999990000", etc.
 * Adiciona '55' (Brasil) quando começa com DDD de 2 dígitos sem prefixo.
 */
export function normalizarTelefoneEvolution(input: string): string {
  const digits = input.replace(/\D+/g, "");
  if (!digits) throw new Error(`Telefone vazio: ${input}`);
  // Já tem 55 (Brasil)?
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  // DDD + 9 dígitos: prefixa 55
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  // Sem regra clara: retorna como veio
  return digits;
}

export interface EnviarWhatsAppResult {
  messageId: string;
  rawResponse: unknown;
}

/**
 * Envia 1 mensagem texto pelo Evolution. Throws em qualquer falha de
 * conexão/HTTP. Caller deve try/catch e tratar como envio falhado.
 */
export async function enviarWhatsApp(
  env: EvolutionEnv,
  telefone: string,
  texto: string,
): Promise<EnviarWhatsAppResult> {
  const number = normalizarTelefoneEvolution(telefone);
  const url = `${env.baseUrl}/message/sendText/${env.instance}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": env.apikey,
    },
    body: JSON.stringify({ number, text: texto }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Evolution sendText falhou (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = await res.json().catch(() => ({}));
  // Evolution retorna estrutura tipo { key: { id: "...", remoteJid: "..." }, ... }
  const messageId =
    (json as { key?: { id?: string } })?.key?.id ??
    (json as { messageId?: string })?.messageId ??
    "";

  return { messageId, rawResponse: json };
}
