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
  via: "cnpj_excluido" | "carteira_cnpj" | "carteira_dormente" | "responsavel_nome" | "segmento" | "nenhum";
  /** Se houve match ambíguo (>1 operador candidato) num path */
  ambiguo?: boolean;
}

// Caio 2026-06-11: CNPJ em cnpjs_excluidos_cockpit NUNCA é atribuído a
// operador (ex: DENTAL SORRIA migrou pra operador ainda não cadastrado;
// AMPLA SLI TRANS / operador demitido). Antes só o sync-bastao consultava o
// blacklist (e pulava o card antes de tocá-lo). vinculador e
// sync-prioridades-ai-do-bastao também chamam o resolver e re-escreviam
// assigned_operator_id via segmento/nome → devolviam o card pro operador
// antigo na próxima resposta do cliente. Centralizar a checagem aqui fecha o
// furo pra TODOS os callers, presentes e futuros.
//
// Memoização em módulo (TTL curto) pra não adicionar 1 query por card no hot
// path do sync-bastao (que resolve operador pra cada pendência a cada run).
// Staleness máxima = EXCL_TTL_MS (admin adiciona/remove CNPJ → efeito em
// até ~30s). Erro de leitura = Set vazio (conservador: prefere atribuir a
// sumir o card indevidamente).
let _exclCache: { set: Set<string>; at: number } | null = null;
const EXCL_TTL_MS = 30_000;

async function carregarCnpjsExcluidos(supabase: SupabaseClient): Promise<Set<string>> {
  const agora = Date.now();
  if (_exclCache && agora - _exclCache.at < EXCL_TTL_MS) {
    return _exclCache.set;
  }
  const set = new Set<string>();
  try {
    const { data, error } = await supabase
      .from("cnpjs_excluidos_cockpit")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error) {
      console.warn(`[operador-resolver] carregarCnpjsExcluidos falhou: ${error.message} — Set vazio.`);
      return set;
    }
    for (const r of (data ?? []) as Array<{ cnpj_pagador: string }>) {
      if (r.cnpj_pagador) set.add(r.cnpj_pagador);
    }
    _exclCache = { set, at: agora };
    return set;
  } catch (e) {
    console.warn(`[operador-resolver] carregarCnpjsExcluidos throw: ${e instanceof Error ? e.message : String(e)} — Set vazio.`);
    return set;
  }
}

export async function resolveOperadorDoCard(
  supabase: SupabaseClient,
  hints: ResolveOperadorHints,
): Promise<ResolveOperadorResult> {
  // Path 0: CNPJ no blacklist (cnpjs_excluidos_cockpit) → desatribui sempre.
  // Roda ANTES de carteira/nome/segmento: blacklist tem prioridade absoluta.
  if (hints.cnpjPagador && hints.cnpjPagador.trim().length > 0) {
    const excluidos = await carregarCnpjsExcluidos(supabase);
    if (excluidos.has(hints.cnpjPagador.trim())) {
      return { operadorId: null, via: "cnpj_excluido" };
    }
  }

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

  // CNPJ pertence a operador dormente OU está no blacklist
  // (cnpjs_excluidos_cockpit) → desatribui completamente. NUNCA cair pros
  // paths nome/segmento, que devolveriam o card pro operador antigo.
  if (r.via === "carteira_dormente" || r.via === "cnpj_excluido") {
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
