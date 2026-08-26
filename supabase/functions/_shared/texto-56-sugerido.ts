// =============================================================================
// texto-56-sugerido.ts — enxerto do texto da oc 56 GERADO pelo interpretador
// na proposta 56 ativa (Etapa C do plano de veto, Caio 25/08 — onda 2).
//
// REGRA DO CAIO (25/08): "SE O AGENTE SUGERE A 56, ELE SABE O QUE ESTÁ
// FALTANDO. BASTA ELE ESCREVER ISSO." O interpretador agora devolve
// texto_56_sugerido (instrução pronta pra Operação); este módulo grava o
// texto no todo 56 ativo:
//   - args.descricao → vira a Instrução do SSW por QUALQUER caminho de
//     aprovação (inclusive o trilho autônomo do veto);
//   - args.extras.texto_descricao → prefill do painel do operador ("o que
//     ela VÊ é o que sobe" — mesmo canal da oc 55);
//   - meta → auditoria (origem + texto original da IA).
// Input humano continua vencendo: extras.texto_descricao digitado no painel
// substitui tudo (precedência por construção, igual instrucao-email-21).
//
// Chamado pelos DOIS lados da corrida (interpretador e propostas-pos-resposta).
// Best-effort + idempotente. NF âncora: 234381 (etapa 1 — 56 apurar).
// Rodar: deno test supabase/functions/_shared/texto-56-sugerido.test.ts
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { montarTextoSswEmail21 } from "./instrucao-email-21.ts";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** Marca de origem no meta do todo 56 — front mostra "texto sugerido pela IA". */
export const ORIGEM_TEXTO_56 = "interpretador_texto_56";

/**
 * Decide (puro) se há texto da 56 a enxertar: decisão final 56 com
 * texto_56_sugerido preenchido. Senão null.
 */
export function decidirTexto56(
  iaSugestao: Record<string, unknown> | null | undefined,
): string | null {
  if (iaSugestao?.["oc_sugerida"] !== 56) return null;
  const t = typeof iaSugestao?.["texto_56_sugerido"] === "string"
    ? (iaSugestao["texto_56_sugerido"] as string).trim()
    : "";
  return t !== "" ? t : null;
}

/**
 * Novo proposta_payload com o texto da 56 enxertado (puro, testável).
 * Normalização latin-1/CAIXA ALTA reusa a do e-mail→21 (mesmo submit SSW).
 */
export function enxertarTexto56(
  propostaPayload: Record<string, unknown> | null | undefined,
  texto: string,
): Record<string, unknown> {
  const pp = (propostaPayload ?? {}) as Record<string, unknown>;
  const argsAntigos = (pp["args"] as Record<string, unknown> | undefined) ?? {};
  const extrasAntigos = (argsAntigos["extras"] as Record<string, unknown> | undefined) ?? {};
  const metaAntiga = (pp["meta"] as Record<string, unknown> | undefined) ?? {};
  const textoSsw = montarTextoSswEmail21(texto);
  return {
    ...pp,
    args: {
      ...argsAntigos,
      descricao: textoSsw,
      extras: { ...extrasAntigos, texto_descricao: textoSsw },
    },
    meta: {
      ...metaAntiga,
      origem_instrucao: ORIGEM_TEXTO_56,
      texto_ssw_sugerido: textoSsw,
      texto_56_original_ia: texto,
    },
  };
}

/**
 * Aplica o texto nos todos 56 ATIVOS do card. Idempotente; nunca cria todo;
 * grava card_event Texto56SugeridoAplicado quando patcha. Best-effort.
 */
export async function aplicarTexto56NaProposta(
  supabase: SupabaseClient,
  cardId: string,
  actorId: string,
): Promise<boolean> {
  try {
    const { data: card } = await supabase
      .from("cards")
      .select("ia_sugestao_oc_resposta")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return false;

    const ia = (card.ia_sugestao_oc_resposta ?? null) as Record<string, unknown> | null;
    const texto = decidirTexto56(ia);
    if (!texto) return false;

    const { data: todos } = await supabase
      .from("todos")
      .select("id, status, proposta_payload")
      .eq("card_id", cardId);

    const alvos = ((todos ?? []) as Array<Record<string, unknown>>).filter((t) => {
      if (t["status"] !== "pendente") return false;
      const pp = t["proposta_payload"] as Record<string, unknown> | null;
      if (!pp || pp["tool"] !== "lancar_ocorrencia") return false;
      const a = pp["args"] as Record<string, unknown> | undefined;
      return a?.["codigo_ssw"] === 56;
    });
    if (alvos.length === 0) return false;

    const textoSsw = montarTextoSswEmail21(texto);
    const patchados: string[] = [];
    for (const alvo of alvos) {
      const pp = alvo["proposta_payload"] as Record<string, unknown>;
      const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
      const a = (pp["args"] ?? {}) as Record<string, unknown>;
      if (meta["origem_instrucao"] === ORIGEM_TEXTO_56 && a["descricao"] === textoSsw) {
        continue; // já enxertado com este mesmo texto
      }
      const { error } = await supabase
        .from("todos")
        .update({ proposta_payload: enxertarTexto56(pp, texto) })
        .eq("id", alvo["id"] as string);
      if (!error) patchados.push(alvo["id"] as string);
    }
    if (patchados.length === 0) return false;

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "Texto56SugeridoAplicado",
      actor_type: "system",
      actor_id: actorId,
      payload: { todos_patchados: patchados, texto_ssw: textoSsw, texto_original_ia: texto },
    });
    return true;
  } catch (e) {
    console.warn(
      `[texto-56-sugerido] falhou (card ${cardId}): ${e instanceof Error ? e.message : e} — operadora digita como hoje`,
    );
    return false;
  }
}
