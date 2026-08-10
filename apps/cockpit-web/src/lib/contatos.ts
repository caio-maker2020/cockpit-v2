// Contatos de cliente com a dimensão do REMETENTE (mig 320 — caso AGV/Maria).
// Regra: linhas gerais (cnpj_remetente NULL) valem sempre; linhas específicas
// só aparecem quando o card é DAQUELE remetente — a operadora nunca vê o
// contato interno de outro remetente por engano.

/** CNPJ do remetente CRU do agent_state (sem o colapso null→pagador). */
export function remetenteCruDoAgentState(agentState: unknown): string | null {
  const v = (agentState as Record<string, unknown> | null)?.cnpj_remetente;
  const dig = typeof v === "string" ? v.replace(/\D/g, "") : "";
  return dig || null;
}

/**
 * Aplica o filtro de remetente numa query de contatos_cliente do supabase-js.
 * Sem remetente no card → só contatos gerais (comportamento clássico).
 */
// deno-lint-ignore no-explicit-any
export function filtrarContatosPorRemetente<T>(query: T, remetenteCru: string | null): T {
  const q = query as unknown as {
    or: (f: string) => T;
    is: (c: string, v: null) => T;
  };
  return remetenteCru
    ? q.or(`cnpj_remetente.is.null,cnpj_remetente.eq.${remetenteCru}`)
    : q.is("cnpj_remetente", null);
}

export interface ContatoClienteRow {
  identificador: string;
  nome_pessoa: string | null;
  cargo: string | null;
  ordem: number | null;
  cnpj_remetente?: string | null;
}

/** true = contato específico do remetente deste card (ganha o badge 📌). */
export function ehContatoDoRemetente(c: ContatoClienteRow): boolean {
  return typeof c.cnpj_remetente === "string" && c.cnpj_remetente.length > 0;
}
