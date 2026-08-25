// =============================================================================
// destaque-resposta-cliente — a ação destacada EXATA do interpretador
// (Etapa B do plano de veto, Caio 25/08).
//
// PROBLEMA: o interpretador gravava só oc_sugerida/flags em
// cards.ia_sugestao_oc_resposta e o FRONT adivinhava qual todo é "o destacado"
// com heurística de 3 níveis em tempo de clique (SugestaoIATopBox). Pro trilho
// autônomo isso é inseguro: o agendamento precisa apontar UM todo exato
// (acao_key + todo_id), decidido UMA vez no backend e persistido.
//
// SOLUÇÃO: este módulo resolve a ação destacada com a MESMA preferência que o
// front usava (acao_tool → modo completo → não-sem_email → primeiro) e grava
// em ia_sugestao_oc_resposta.proposta_destacada_acao (+todo_id/tipo). O front
// passa a LER o campo; a heurística vira fallback pra cards antigos.
//
// Chamado pelos DOIS lados da corrida (mesmo padrão do enxerto e-mail→21):
//   - interpretador-resposta-cliente (decisão depois dos todos)
//   - propostas-pos-resposta-cliente (todos depois da decisão)
// Idempotente: re-resolver grava o mesmo resultado.
//
// Casos-âncora: NF 1502332 (sugerir aguardar — regra 24/08), NF 306070 (oc 21
// pós-resposta), NF 234381 (trilhos de combo).
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export interface TodoPendenteResumo {
  id: string;
  proposta_payload: {
    tool?: string;
    acao_key?: string;
    args?: { codigo_ssw?: number | string };
    meta?: { modo?: string; sem_email_explicito?: boolean; tipo_acao?: string };
  } | null;
}

export interface IaSugestaoLoose {
  oc_sugerida?: number | null;
  contexto?: string | null;
  acao_tool?: string | null;
  acao_codigo_ssw?: number | null;
  sugere_combo_33_44?: boolean;
  sugere_oc33_solo?: boolean;
  sugere_combo_44_59?: boolean;
}

export interface DestaqueResolvido {
  /** 'aguardar' = executa ignorar_pendencias (não há todo); 'todo' = aprova o todo apontado. */
  tipo: "aguardar" | "todo" | null;
  acao_key: string | null;
  todo_id: string | null;
  /** Como foi resolvido — auditável ('acao_exata' | 'tool_codigo' | 'por_codigo' | 'aguardar' | null). */
  nivel: string | null;
}

const NENHUM: DestaqueResolvido = { tipo: null, acao_key: null, todo_id: null, nivel: null };

function acaoKeyDoTodo(t: TodoPendenteResumo): string | null {
  const pl = t.proposta_payload;
  if (!pl) return null;
  if (typeof pl.acao_key === "string" && pl.acao_key) return pl.acao_key;
  const cod = pl.args?.codigo_ssw;
  if (typeof pl.tool === "string" && (typeof cod === "number" || typeof cod === "string")) {
    return `${pl.tool}:${cod}`;
  }
  return null;
}

function preferido(candidatos: TodoPendenteResumo[]): TodoPendenteResumo | undefined {
  // MESMA preferência do front (SugestaoIATopBox, auditoria 25/07):
  // em empate NUNCA preferir sem_email_explicito — preferir quem NOTIFICA.
  return (
    candidatos.find((t) => t.proposta_payload?.meta?.modo === "completo") ??
    candidatos.find((t) => t.proposta_payload?.meta?.sem_email_explicito !== true) ??
    candidatos[0]
  );
}

/**
 * PURO: resolve a ação destacada exata da sugestão do interpretador.
 * @param ia conteúdo de cards.ia_sugestao_oc_resposta
 * @param codUltimaOcorrencia oc-âncora do card (decide "aguardar")
 * @param pendentes todos com status='pendente' do card
 */
export function resolverAcaoDestacada(
  ia: IaSugestaoLoose,
  codUltimaOcorrencia: number | null,
  pendentes: readonly TodoPendenteResumo[],
): DestaqueResolvido {
  const ocSugerida = typeof ia.oc_sugerida === "number" ? ia.oc_sugerida : null;

  // 1) SUGERIR AGUARDAR (regra Caio 24/08, NF 1502332): interpretador sugeriu a
  // MESMA oc em que o card está (54/59) sem combo e sem contexto cobrou_antes —
  // a ação destacada é "ignorar e continuar aguardando", nunca relançar por cima.
  const ehAguardar =
    ia.contexto !== "cobrou_antes_notificacao" &&
    ia.sugere_combo_33_44 !== true &&
    ia.sugere_oc33_solo !== true &&
    ocSugerida != null &&
    codUltimaOcorrencia != null &&
    ocSugerida === codUltimaOcorrencia &&
    (ocSugerida === 54 || ocSugerida === 59);
  if (ehAguardar) {
    return {
      tipo: "aguardar",
      acao_key: `ignorar_e_aguardar:${ocSugerida}`,
      todo_id: null,
      nivel: "aguardar",
    };
  }

  // 2) COMBOS (exclusão mútua garantida em _shared/exclusao-combos.ts):
  // o destacado é o todo do combo, identificado por tool OU meta.tipo_acao.
  const porCombo = (tool: string, tipoAcao: string) =>
    pendentes.find((t) =>
      t.proposta_payload?.tool === tool ||
      t.proposta_payload?.meta?.tipo_acao === tipoAcao
    );
  const combo =
    (ia.sugere_oc33_solo === true ? porCombo("lancar_oc33_solo_portal", "oc33_solo") : undefined) ??
    (ia.sugere_combo_33_44 === true ? porCombo("lancar_combo_33_44", "combo_33_44") : undefined) ??
    (ia.sugere_combo_44_59 === true ? porCombo("lancar_combo_44_59", "combo_44_59") : undefined);
  if (combo) {
    return { tipo: "todo", acao_key: acaoKeyDoTodo(combo), todo_id: combo.id, nivel: "acao_exata" };
  }

  if (ocSugerida == null && ia.acao_codigo_ssw == null) return NENHUM;
  const codigoAlvo = ia.acao_codigo_ssw ?? ocSugerida;

  // 3) tool preferido + código (nível 2 do front)
  const toolAlvo = ia.acao_tool ?? "lancar_oc_e_enviar_email";
  const porToolCodigo = pendentes.filter((t) => {
    const pl = t.proposta_payload;
    return pl?.tool === toolAlvo && Number(pl?.args?.codigo_ssw) === Number(codigoAlvo);
  });
  const nivel2 = preferido(porToolCodigo);
  if (nivel2) {
    return { tipo: "todo", acao_key: acaoKeyDoTodo(nivel2), todo_id: nivel2.id, nivel: "tool_codigo" };
  }

  // 4) qualquer tool com o código (nível 3 do front — auditoria 25/07: sem isso
  // o botão ficava morto em 14 de 15 cards)
  const porCodigo = pendentes.filter(
    (t) => Number(t.proposta_payload?.args?.codigo_ssw) === Number(codigoAlvo),
  );
  const nivel3 = preferido(porCodigo);
  if (nivel3) {
    return { tipo: "todo", acao_key: acaoKeyDoTodo(nivel3), todo_id: nivel3.id, nivel: "por_codigo" };
  }

  return NENHUM;
}

/**
 * Resolve E grava o destaque exato no card (merge em ia_sugestao_oc_resposta).
 * Best-effort e idempotente — NUNCA lança (segue o padrão dos enxertos:
 * o outro call site cobre a ordem inversa).
 */
export async function gravarDestaqueRespostaCliente(
  supabase: SupabaseClient,
  cardId: string,
  origem: string,
): Promise<DestaqueResolvido | null> {
  try {
    const { data: card } = await supabase
      .from("cards")
      .select("ia_sugestao_oc_resposta, cod_ultima_ocorrencia")
      .eq("id", cardId)
      .single();
    const ia = (card?.ia_sugestao_oc_resposta ?? null) as Record<string, unknown> | null;
    if (!ia) return null; // sem decisão do interpretador ainda — o outro lado grava

    const { data: todos } = await supabase
      .from("todos")
      .select("id, proposta_payload")
      .eq("card_id", cardId)
      .eq("status", "pendente")
      .order("created_at", { ascending: false })
      .limit(50);

    const destaque = resolverAcaoDestacada(
      ia as IaSugestaoLoose,
      (card?.cod_ultima_ocorrencia as number | null) ?? null,
      (todos ?? []) as TodoPendenteResumo[],
    );

    // Idempotência: só grava se mudou (evita update/realtime inútil).
    if (
      ia["proposta_destacada_acao"] === destaque.acao_key &&
      ia["proposta_destacada_todo_id"] === destaque.todo_id &&
      ia["proposta_destacada_tipo"] === destaque.tipo
    ) {
      return destaque;
    }

    await supabase
      .from("cards")
      .update({
        ia_sugestao_oc_resposta: {
          ...ia,
          proposta_destacada_acao: destaque.acao_key,
          proposta_destacada_todo_id: destaque.todo_id,
          proposta_destacada_tipo: destaque.tipo,
          proposta_destacada_nivel: destaque.nivel,
          destaque_resolvido_em: new Date().toISOString(),
          destaque_resolvido_por: origem,
        },
      })
      .eq("id", cardId);
    return destaque;
  } catch (e) {
    console.warn(
      `[destaque-resposta-cliente] falhou (card ${cardId}, ${origem}): ${e instanceof Error ? e.message : e} — front usa fallback heurístico`,
    );
    return null;
  }
}
