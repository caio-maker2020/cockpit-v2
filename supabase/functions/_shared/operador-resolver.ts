// Caio 2026-05-14 (multi-operador onboarding Duilio):
// Resolve qual operador deve receber um card baseado em hints disponíveis.
// Substitui o uso de DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS hardcoded "LARISSA"
// em bastao-rules.ts.
//
// Cascata de resolução (Caio 2026-05-19 — INVERTIDA pós bug NF 568107):
//   1. cnpjPagador        → CNPJ em operadores.carteira (REGRA "1 CNPJ = 1 operador")
//   2. responsavelNome    → match exato (case-insensitive) com operadores.nome
//                           (fallback quando CNPJ não está em nenhuma carteira)
//   3. segmentoCodigo     → código em operadores.segmentos
//   4. null               → card fica sem assigned_operator_id (gestor revisa)
//
// Mudança: antes era nome > carteira > segmento. Bug raiz: Bastão classificou
// NORTEL (CNPJ 46044053005417) como segmento 014 (FERRAMENTAS E CONSTRUCAO),
// mandou responsavel_relacionamento=DUILIO. Resolver pegou via nome direto.
// Mas NORTEL deveria estar na carteira de outro operador. Carteira > nome
// resolve: se cliente é de outro operador específico, esse outro ganha.
//
// Filtros aplicados em TODOS os caminhos:
//   - operadores.ativo = true
//   - operadores.cockpit_ativo = true (operador efetivamente no Cockpit)
//
// Match único é requerido em TODOS os paths agora (incluindo nome — se 2
// operadores têm mesmo nome, retorna ambíguo). Ambiguidade vira null pra
// gestor decidir — sem premissa de fairness.

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
  via: "carteira_cnpj" | "carteira_dormente" | "responsavel_nome" | "segmento" | "nenhum";
  /** Se houve match ambíguo (>1 operador candidato) num path */
  ambiguo?: boolean;
}

export async function resolveOperadorDoCard(
  supabase: SupabaseClient,
  hints: ResolveOperadorHints,
): Promise<ResolveOperadorResult> {
  // Path 1: CNPJ na carteira (prioridade absoluta — regra "1 CNPJ = 1 operador")
  if (hints.cnpjPagador && hints.cnpjPagador.trim().length > 0) {
    // 1a — operador ativo no Cockpit: atribui
    const { data: ativos } = await supabase
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("cockpit_ativo", true)
      .contains("carteira", [hints.cnpjPagador.trim()]);
    const rowsAtivos = (ativos ?? []) as Array<{ id: string }>;
    if (rowsAtivos.length === 1) {
      return { operadorId: rowsAtivos[0]!.id, via: "carteira_cnpj" };
    }
    if (rowsAtivos.length > 1) {
      return { operadorId: null, via: "nenhum", ambiguo: true };
    }

    // 1b — CNPJ pertence a operador DORMENTE (cockpit_ativo=false, ex: Ingrid
    // ainda não no Cockpit). Curto-circuita pra null — não cai pros paths
    // 2/3 (nome/segmento) pra evitar atribuir a OUTRO operador erroneamente.
    // Caio 2026-05-19 (NF 568107 NORTEL/Ingrid).
    const { data: dormentes } = await supabase
      .from("operadores")
      .select("id")
      .eq("ativo", true)
      .eq("cockpit_ativo", false)
      .contains("carteira", [hints.cnpjPagador.trim()]);
    if (((dormentes ?? []) as Array<{ id: string }>).length > 0) {
      return { operadorId: null, via: "carteira_dormente" };
    }
  }

  // Path 2: nome (fallback quando CNPJ não tem dono específico)
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

/**
 * Caio 2026-05-19 (bug NF 568107 NORTEL):
 * Helper que resolve o operador e devolve os 2 campos prontos pra UPDATE/INSERT
 * de cards: { responsavel_relacionamento, assigned_operator_id }.
 *
 * Regras:
 *  - via='carteira_cnpj' (operador ativo dono do CNPJ): retorna nome canônico
 *    do operador (não o cru do Bastão) + id.
 *  - via='carteira_dormente' (CNPJ pertence a operador inativo no Cockpit):
 *    retorna NULL/NULL — card fica desatribuído até dono entrar no Cockpit.
 *    Evita atribuir erroneamente via nome do Bastão (caso NORTEL→DUILIO).
 *  - via='responsavel_nome' ou 'segmento': retorna nome canônico + id.
 *  - via='nenhum' (sem match): mantém o nome cru do Bastão como fallback;
 *    assigned_operator_id=null (gestor revisa).
 */
export async function resolverCamposAtribuicaoDoCard(
  supabase: SupabaseClient,
  hints: ResolveOperadorHints,
): Promise<{
  responsavel_relacionamento: string | null;
  assigned_operator_id: string | null;
  via: ResolveOperadorResult["via"];
  ambiguo?: boolean;
}> {
  const r = await resolveOperadorDoCard(supabase, hints);

  // CNPJ pertence a operador dormente → desatribui completamente
  if (r.via === "carteira_dormente") {
    return {
      responsavel_relacionamento: null,
      assigned_operator_id: null,
      via: r.via,
    };
  }

  // Match encontrado: usa nome canônico do operador resolvido
  if (r.operadorId) {
    const { data: op } = await supabase
      .from("operadores")
      .select("nome")
      .eq("id", r.operadorId)
      .maybeSingle();
    return {
      responsavel_relacionamento: (op?.nome as string | undefined) ?? hints.responsavelNome ?? null,
      assigned_operator_id: r.operadorId,
      via: r.via,
    };
  }

  // Sem match e CNPJ não é de dormente: mantém nome cru pra audit/legibilidade
  return {
    responsavel_relacionamento: hints.responsavelNome ?? null,
    assigned_operator_id: null,
    via: r.via,
    ambiguo: r.ambiguo,
  };
}
