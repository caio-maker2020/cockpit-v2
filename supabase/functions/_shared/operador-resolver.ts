// Caio 2026-05-14 (multi-operador onboarding Duilio):
// Resolve qual operador deve receber um card baseado em hints disponíveis.
// Substitui o uso de DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS hardcoded "LARISSA"
// em bastao-rules.ts.
//
// Cascata de resolução:
//   1. responsavelNome    → match exato (case-insensitive) com operadores.nome
//   2. cnpjPagador        → CNPJ em operadores.carteira
//   3. segmentoCodigo     → código em operadores.segmentos
//   4. null               → card fica sem assigned_operator_id (gestor revisa)
//
// Filtros aplicados em TODOS os caminhos:
//   - operadores.ativo = true
//   - operadores.cockpit_ativo = true (operador efetivamente no Cockpit)
//
// Match único é requerido nos paths 2 e 3 (se 2 operadores cobrem o mesmo
// CNPJ/segmento, retorna null e deixa pro gestor decidir — não há premissa
// de fairness, ambiguidade é problema operacional a ser resolvido).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface ResolveOperadorHints {
  /** Nome do operador (geralmente vem de Bastão.responsavel_relacionamento) */
  responsavelNome?: string | null;
  /** CNPJ do pagador (busca em operadores.carteira) */
  cnpjPagador?: string | null;
  /** Código do segmento SSW (busca em operadores.segmentos) */
  segmentoCodigo?: string | null;
}

export interface ResolveOperadorResult {
  operadorId: string | null;
  /** Pra quê path o match aconteceu (audit) */
  via: "responsavel_nome" | "carteira_cnpj" | "segmento" | "nenhum";
  /** Se houve match ambíguo (>1 operador candidato) num path */
  ambiguo?: boolean;
}

export async function resolveOperadorDoCard(
  supabase: SupabaseClient,
  hints: ResolveOperadorHints,
): Promise<ResolveOperadorResult> {
  // Path 1: nome
  if (hints.responsavelNome && hints.responsavelNome.trim().length > 0) {
    const nomeUpper = hints.responsavelNome.trim().toUpperCase();
    const { data } = await supabase
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("cockpit_ativo", true)
      .ilike("nome", nomeUpper)
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      return { operadorId: data.id as string, via: "responsavel_nome" };
    }
  }

  // Path 2: CNPJ na carteira
  if (hints.cnpjPagador && hints.cnpjPagador.trim().length > 0) {
    const { data } = await supabase
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("cockpit_ativo", true)
      .contains("carteira", [hints.cnpjPagador.trim()]);
    const rows = (data ?? []) as Array<{ id: string }>;
    if (rows.length === 1) {
      return { operadorId: rows[0]!.id, via: "carteira_cnpj" };
    }
    if (rows.length > 1) {
      return { operadorId: null, via: "nenhum", ambiguo: true };
    }
  }

  // Path 3: segmento
  if (hints.segmentoCodigo && hints.segmentoCodigo.trim().length > 0) {
    const { data } = await supabase
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("cockpit_ativo", true)
      .contains("segmentos", [hints.segmentoCodigo.trim()]);
    const rows = (data ?? []) as Array<{ id: string }>;
    if (rows.length === 1) {
      return { operadorId: rows[0]!.id, via: "segmento" };
    }
    if (rows.length > 1) {
      return { operadorId: null, via: "nenhum", ambiguo: true };
    }
  }

  return { operadorId: null, via: "nenhum" };
}
