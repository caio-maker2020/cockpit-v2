/**
 * Dashboard de clientes (Vercel externo) — link "Visão geral dos clientes"
 * e "Ver números do cliente" (Caio 2026-09-18).
 *
 * O Cockpit NÃO renderiza os números: só abre o dashboard em nova aba.
 * Pra abrir já no cliente do card, mandamos `q` (nome pra busca) e `cnpj`
 * (CNPJ pagador, 14 dígitos). O dashboard lê esses parâmetros e faz
 * busca → seleção → "Analisar" sozinho (ver docs/DASHBOARD_CLIENTES_DEEPLINK.md).
 *
 * Regras verificadas em 2026-09-18 contra a API real do dashboard
 * (`/api/clientes?q=`): a busca é por NOME (CNPJ não retorna nada) e o
 * nome abreviado do SSW ("ASTRA S/A. INDU A.") NÃO encontra o grupo —
 * "ASTRA S/A. INDU" encontra. Por isso: nome completo da tabela
 * `clientes` quando disponível; senão nome do card sem a abreviação SSW.
 */

export const DASHBOARD_CLIENTES_URL =
  "https://sal-express-dashboard.vercel.app/performance";

/** Mínimo de caracteres que a busca do dashboard exige. */
export const DASHBOARD_BUSCA_MIN_CHARS = 3;

/**
 * SSW abrevia razão social longa como 15 primeiros caracteres + " A."
 * (ex.: "ASTRA S/A. INDU A.", "ICARO EXPRESS L A."). O sufixo quebra a
 * busca do dashboard; o prefixo de 15 chars encontra o grupo certo.
 */
export function limparNomeSsw(nome: string | null | undefined): string {
  if (!nome) return "";
  const n = nome.trim().replace(/\s+/g, " ");
  if (n.length === 18 && n.endsWith(" A.")) return n.slice(0, 15).trim();
  return n;
}

/** Só dígitos; válido apenas com 14 (CNPJ). CPF/vazio → null. */
export function normalizarCnpj(valor: unknown): string | null {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const d = String(valor).replace(/\D/g, "");
  return d.length === 14 ? d : null;
}

/** CNPJ pagador gravado pelo pipeline em `cards.agent_state.cnpj_pagador`. */
export function cnpjPagadorDoCard(
  agentState: Record<string, unknown> | null | undefined,
): string | null {
  if (!agentState) return null;
  return normalizarCnpj(agentState["cnpj_pagador"]);
}

export interface EntradaNumerosCliente {
  /** Nome completo (tabela `clientes`, mesmo cadastro do dashboard). */
  nomeCompleto?: string | null;
  /** Nome como está no card (pode vir abreviado do SSW). */
  nomeCard?: string | null;
  cnpj?: string | null;
}

/** Termo que o dashboard vai buscar: nome completo > nome do card limpo. */
export function termoBuscaCliente(e: EntradaNumerosCliente): string {
  const completo = (e.nomeCompleto ?? "").trim().replace(/\s+/g, " ");
  if (completo.length >= DASHBOARD_BUSCA_MIN_CHARS) return completo;
  const doCard = limparNomeSsw(e.nomeCard);
  return doCard.length >= DASHBOARD_BUSCA_MIN_CHARS ? doCard : "";
}

/** URL do dashboard já apontando pro cliente (q + cnpj quando existirem). */
export function montarUrlNumerosCliente(e: EntradaNumerosCliente): string {
  const url = new URL(DASHBOARD_CLIENTES_URL);
  const q = termoBuscaCliente(e);
  if (q) url.searchParams.set("q", q);
  const cnpj = normalizarCnpj(e.cnpj);
  if (cnpj) url.searchParams.set("cnpj", cnpj);
  return url.toString();
}

/** Senha única do dashboard, injetada por env (nunca commitada). */
export function senhaDashboardClientes(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): string | null {
  const s = env["VITE_DASHBOARD_CLIENTES_SENHA"];
  return typeof s === "string" && s.trim() ? s.trim() : null;
}
