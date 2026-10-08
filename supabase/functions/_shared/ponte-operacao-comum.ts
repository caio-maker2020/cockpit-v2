// =============================================================================
// ponte-operacao-comum — peças comuns da ponte v2 (Painel da Operação, ADR 0039).
//
// A v1 (ADR 0038) só tinha o Cockpit chamando o Roteirizador. A v2 inverte a
// direção em dois endpoints: o Roteirizador chama o Cockpit para LER o estado da
// tratativa (`ponte-tratativas`) e para PEDIR uma ação (`ponte-pedido-operacao`).
//
// Regras que valem para os dois endpoints (contrato v2):
//   - auth: `Authorization: Bearer <token>` com um segredo PRÓPRIO desta direção
//     (emenda 5 do contrato, 25/09): `PONTE_OPERACAO_TOKEN` no Cockpit
//     (`RI_COCKPIT_TOKEN` no Roteirizador). O `ROTEIRIZADOR_PONTE_TOKEN` da v1
//     serve só para o Cockpit chamar o Roteirizador e NÃO autentica aqui. Sem o
//     segredo configurado → 503, nunca fail-open (padrão do `aprendizado-pr-callback`);
//   - CTRC sempre trim + maiúsculas (`AMB642904-1`), igual a `cards.ctrc`;
//   - flag OFF → 503 e NADA acontece (nem SELECT de negócio).
//
// Este arquivo é PURO (sem I/O): deno test.
// =============================================================================

import { normalizarCtrc } from "./roteirizador-eventos-rotear.ts";

export { normalizarCtrc };

// ── flags (mig 418, todas nascem OFF) ────────────────────────────────────────
export const FLAG_PONTE_OPERACAO_LEITURA = "ponte_operacao_leitura" as const;
export const FLAG_PONTE_OPERACAO_PEDIDOS = "ponte_operacao_pedidos" as const;
export const FLAG_PONTE_OPERACAO_LANCAR_SSW = "ponte_operacao_lancar_ssw" as const;

export type FlagPonteOperacao =
  | typeof FLAG_PONTE_OPERACAO_LEITURA
  | typeof FLAG_PONTE_OPERACAO_PEDIDOS
  | typeof FLAG_PONTE_OPERACAO_LANCAR_SSW;

/** Estados em que o card saiu do Relacionamento (fora do uniq_cards_nf_active). */
export const STATES_TERMINAIS = ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"] as const;

export function ehTerminal(state: string | null | undefined): boolean {
  return (STATES_TERMINAIS as readonly string[]).includes(String(state ?? ""));
}

/** CTRC plausível: letras, dígitos e hífen, 3–20 caracteres (depois de normalizar). */
export function ctrcValido(ctrc: string | null): ctrc is string {
  return ctrc !== null && /^[A-Z0-9][A-Z0-9-]{2,19}$/.test(ctrc);
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** Nome do segredo que autentica o Roteirizador chamando o Cockpit (ponte v2). */
export const ENV_TOKEN_PONTE_OPERACAO = "PONTE_OPERACAO_TOKEN" as const;

/**
 * null = ponte v2 desligada (segredo ausente ou vazio). Lê SÓ o
 * PONTE_OPERACAO_TOKEN: o token da v1 (Cockpit → Roteirizador) vazar não abre esta porta.
 */
export function tokenDaPonte(env: Record<string, string | undefined>): string | null {
  const t = (env[ENV_TOKEN_PONTE_OPERACAO] ?? "").trim();
  return t ? t : null;
}

/** Comparação em tempo constante (não vaza o prefixo certo pelo tempo de resposta). */
export function iguaisTempoConstante(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export type ResultadoAuth = "ok" | "ponte_desligada" | "nao_autorizado";

export function autenticarPonte(req: Request, token: string | null): ResultadoAuth {
  if (!token) return "ponte_desligada";
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return "nao_autorizado";
  return iguaisTempoConstante(m[1]!.trim(), token) ? "ok" : "nao_autorizado";
}

// ── respostas ────────────────────────────────────────────────────────────────

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Resposta padrão de auth/flag. Nunca diz qual flag está desligada a quem não autenticou. */
export function respostaAuth(r: Exclude<ResultadoAuth, "ok">): Response {
  if (r === "ponte_desligada") {
    return json({ erro: "ponte_desligada", mensagem: `${ENV_TOKEN_PONTE_OPERACAO} não configurado no Cockpit` }, 503);
  }
  return json({ erro: "nao_autorizado" }, 401);
}

export function respostaFlagOff(flag: FlagPonteOperacao): Response {
  return json({ erro: "desligado", flag, mensagem: `flag ${flag} desligada — nada foi feito` }, 503);
}

// ── datas (America/Sao_Paulo = UTC-3 fixo desde 2019, sem horário de verão) ──

const OFFSET_SP_MS = 3 * 60 * 60 * 1000;

/** "2026-09-26T08:10:00-03:00". Entrada inválida → null. */
export function isoSaoPaulo(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined || d === "") return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  if (!Number.isFinite(t)) return null;
  const local = new Date(t - OFFSET_SP_MS).toISOString(); // "…Z" deslocado
  return `${local.slice(0, 19)}-03:00`;
}

/** "25/09/2026" no fuso de São Paulo. Entrada inválida → null. */
export function dataBrSaoPaulo(d: Date | string | null | undefined): string | null {
  const iso = isoSaoPaulo(d);
  if (!iso) return null;
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** Mesma regra de `normalizeNf` (extravio-enrichment.ts): sem zeros à esquerda. */
export function normalizarNf(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const t = String(nf).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}
