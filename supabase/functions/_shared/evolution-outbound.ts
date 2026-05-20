// Caio 2026-05-19 / 2026-05-20:
// WhatsApp outbound via Evolution API, multi-instance (1 instance por operador).
//
// 2026-05-19 (v1): instance + apikey vinham de env vars `EVOLUTION_<NOME>_*`.
// 2026-05-20 (v2): instance agora vem da tabela `operadores.whatsapp_instance`.
//   Apikey é global (`EVOLUTION_GLOBAL_APIKEY`) — Evolution v2 expõe
//   AUTHENTICATION_API_KEY que opera todas as instances. Padrão antigo
//   permanece como fallback pra não quebrar `disparar-cobranca-escalonada`.
//
// Onboarding novo operador:
//   1. supabase secrets set EVOLUTION_BASE_URL / EVOLUTION_GLOBAL_APIKEY
//   2. POST /functions/v1/criar-instancia-whatsapp { operador_id }
//   3. Scanear QR retornado
//
// Endpoint Evolution `/message/sendText/<instance>` recebe { number, text }.

export interface EvolutionEnv {
  baseUrl: string;
  instance: string;
  apikey: string;
}

export interface EvolutionGlobal {
  baseUrl: string;
  apikey: string;
}

/**
 * Lê config global da Evolution (base URL + apikey). Lança erro se ausente.
 * Usado por endpoints que precisam falar com a Evolution sem instance específica
 * (ex.: criar instance nova, listar, deletar).
 */
export function readEvolutionGlobal(
  env: Record<string, string | undefined>,
): EvolutionGlobal {
  const baseUrl = env["EVOLUTION_BASE_URL"];
  const apikey = env["EVOLUTION_GLOBAL_APIKEY"] ?? env["EVOLUTION_APIKEY"];

  if (!baseUrl) throw new Error("EVOLUTION_BASE_URL não configurado");
  if (!apikey) throw new Error("EVOLUTION_GLOBAL_APIKEY não configurado");

  return { baseUrl: baseUrl.replace(/\/$/, ""), apikey };
}

/**
 * [Legado v1] Lê config do Evolution pro operador alvo via env vars
 * `EVOLUTION_<NOME>_INSTANCE` / `EVOLUTION_<NOME>_APIKEY`. Fallback genérico
 * `EVOLUTION_INSTANCE`/`EVOLUTION_APIKEY`.
 *
 * Mantido pra retrocompat com `disparar-cobranca-escalonada`. Novos callers
 * devem preferir `evolutionEnvFromInstance` lendo o nome do DB.
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
  const apikey =
    env[`${prefix}APIKEY`] ??
    env["EVOLUTION_GLOBAL_APIKEY"] ??
    env["EVOLUTION_APIKEY"];

  if (!instance || !apikey) {
    throw new Error(
      `Evolution env ausente pra operador=${operadorNome ?? "genérico"} ` +
        `(prefix=${prefix}, fallback=EVOLUTION_*). Setar via supabase secrets set.`,
    );
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), instance, apikey };
}

/**
 * Monta EvolutionEnv a partir do nome da instance vindo do DB.
 * Apikey é sempre a global (`EVOLUTION_GLOBAL_APIKEY`).
 */
export function evolutionEnvFromInstance(
  env: Record<string, string | undefined>,
  instance: string,
): EvolutionEnv {
  const global = readEvolutionGlobal(env);
  return { ...global, instance };
}

/**
 * Slug determinístico pro nome da instance Evolution. `LARISSA` → `op-larissa`.
 * Remove acentos, troca espaços/hífen por hífen único, prefixa `op-`.
 */
export function slugOperador(nome: string): string {
  const norm = nome
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!norm) throw new Error(`Nome de operador vazio após slug: ${nome}`);
  return `op-${norm}`;
}

/**
 * Normaliza telefone pro formato Evolution: 5535999990000 (sem +, sem mask).
 * Aceita "(35) 99999-0000", "+5535999990000", "35999990000", etc.
 * Adiciona '55' (Brasil) quando começa com DDD de 2 dígitos sem prefixo.
 */
export function normalizarTelefoneEvolution(input: string): string {
  const digits = input.replace(/\D+/g, "");
  if (!digits) throw new Error(`Telefone vazio: ${input}`);
  if (digits.startsWith("55") && digits.length >= 12) return digits;
  if (digits.length === 11 || digits.length === 10) return `55${digits}`;
  return digits;
}

export interface EnviarWhatsAppResult {
  messageId: string;
  rawResponse: unknown;
}

/**
 * Envia 1 mensagem texto pelo Evolution. Throws em falha HTTP/conexão.
 * Caller deve try/catch e tratar como envio falhado.
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
  const messageId =
    (json as { key?: { id?: string } })?.key?.id ??
    (json as { messageId?: string })?.messageId ??
    "";

  return { messageId, rawResponse: json };
}

// =============================================================================
// Instance management (Evolution API admin endpoints)
// =============================================================================

export interface CreateInstanceResult {
  instance: string;
  qrcodeBase64: string | null;
  pairingCode: string | null;
  state: string | null;
  raw: unknown;
}

/**
 * Cria instance nova OU devolve QR de instance existente.
 * Idempotente: se já existe instance com esse nome, chama /instance/connect.
 */
export async function criarInstanceEvolution(
  global: EvolutionGlobal,
  instance: string,
  webhookUrl?: string,
): Promise<CreateInstanceResult> {
  const body: Record<string, unknown> = {
    instanceName: instance,
    qrcode: true,
    integration: "WHATSAPP-BAILEYS",
  };
  if (webhookUrl) {
    body.webhook = { url: webhookUrl, byEvents: false };
  }

  const res = await fetch(`${global.baseUrl}/instance/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: global.apikey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  // Instance já existe → 403 ou 409 → chamar /instance/connect
  if (res.status === 403 || res.status === 409) {
    return await connectInstanceEvolution(global, instance);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Evolution /instance/create falhou (${res.status}): ${txt.slice(0, 300)}`,
    );
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const qr = (json.qrcode ?? {}) as Record<string, unknown>;
  return {
    instance,
    qrcodeBase64: (qr.base64 as string) ?? null,
    pairingCode: (qr.pairingCode as string) ?? null,
    state: ((json.instance as Record<string, unknown>)?.status as string) ?? null,
    raw: json,
  };
}

/**
 * Conecta (= solicita QR novo) de instance já criada.
 */
export async function connectInstanceEvolution(
  global: EvolutionGlobal,
  instance: string,
): Promise<CreateInstanceResult> {
  const res = await fetch(
    `${global.baseUrl}/instance/connect/${encodeURIComponent(instance)}`,
    {
      method: "GET",
      headers: { apikey: global.apikey },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Evolution /instance/connect falhou (${res.status}): ${txt.slice(0, 300)}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    instance,
    qrcodeBase64: (json.base64 as string) ?? null,
    pairingCode: (json.pairingCode as string) ?? null,
    state: (json.instance as string) ?? null,
    raw: json,
  };
}

export interface ConnectionStateResult {
  instance: string;
  /** open | connecting | close */
  state: string;
  raw: unknown;
}

/**
 * Lê estado atual do pareamento da instance.
 */
export async function connectionStateEvolution(
  global: EvolutionGlobal,
  instance: string,
): Promise<ConnectionStateResult> {
  const res = await fetch(
    `${global.baseUrl}/instance/connectionState/${encodeURIComponent(instance)}`,
    {
      method: "GET",
      headers: { apikey: global.apikey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Evolution /instance/connectionState falhou (${res.status}): ${txt.slice(0, 300)}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const inst = (json.instance ?? {}) as Record<string, unknown>;
  const state =
    (inst.state as string) ??
    (inst.status as string) ??
    (json.state as string) ??
    "unknown";
  return { instance, state, raw: json };
}
