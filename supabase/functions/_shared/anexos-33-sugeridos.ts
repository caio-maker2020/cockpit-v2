// =============================================================================
// anexos-33-sugeridos.ts — o agente PRÉ-SELECIONA os anexos da oc 33
// (Etapa C do plano de veto, Caio 25/08 — onda 2).
//
// REGRA DO CAIO (25/08): a 33 "deve estar autônoma e deve aparecer o que será
// anexado". Hoje os modais pré-selecionam o PRIMEIRO anexo suportado (INV-045)
// — chute posicional. O agente SABE qual é o romaneio: o dossiê de extravio
// parcial guarda a evidência com filename/message_inbox_id. Este módulo:
//   1. escolhe os anexos certos (dossiê primeiro; heurística de nome depois);
//   2. grava meta.anexos_sugeridos nos todos 33 ativos (solo e combo 33+44);
//   3. o card MOSTRA o que será anexado; o modal pré-marca esses (fallback:
//      primeiro suportado, como hoje).
// Operador continua mandando: desmarcar/trocar no modal vence sempre.
//
// Best-effort + idempotente, chamado pelos dois lados da corrida.
// Rodar: deno test supabase/functions/_shared/anexos-33-sugeridos.test.ts
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { lerExtravioParcial } from "./extravio-parcial-dossie.ts";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export interface AnexoCardResumo {
  id: string;
  message_inbox_id?: string | null;
  filename?: string | null;
  mime_type?: string | null;
}

export interface AnexoSugerido {
  anexo_id: string;
  filename: string | null;
  motivo: "romaneio_do_dossie" | "romaneio_por_nome";
}

/** Suportado pelo SSW = imagem direta ou PDF (convertido no modal) — INV-045.
 *  Espelho de apps/cockpit-web/src/lib/anexos-ssw-elegiveis.ts (edge não
 *  importa do front; mudança tem que acontecer nos DOIS até unificar). */
export function ehAnexoSuportadoSsw(mime: string | null | undefined): boolean {
  return mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png" ||
    mime === "application/pdf";
}

const RE_NOME_ROMANEIO = /romaneio|coleta/i;

/**
 * PURO: escolhe os anexos que o agente sugere pra oc 33.
 * Prioridade: (1) o romaneio apontado pelo DOSSIÊ (filename+inbox quando
 * ambos existem); (2) heurística de nome entre os suportados. Máx. 3.
 */
export function escolherAnexosSugeridos33(
  romaneioDossie: { presente?: boolean; filename?: string | null; message_inbox_id?: string | null } | null | undefined,
  anexos: readonly AnexoCardResumo[],
): AnexoSugerido[] {
  const suportados = anexos.filter((a) => ehAnexoSuportadoSsw(a.mime_type));
  const out: AnexoSugerido[] = [];
  const visto = new Set<string>();
  const add = (a: AnexoCardResumo, motivo: AnexoSugerido["motivo"]) => {
    if (visto.has(a.id) || out.length >= 3) return;
    visto.add(a.id);
    out.push({ anexo_id: a.id, filename: a.filename ?? null, motivo });
  };

  if (romaneioDossie?.presente === true && romaneioDossie.filename) {
    const alvoNome = romaneioDossie.filename.trim().toLowerCase();
    const doDossie = suportados.find((a) => {
      if ((a.filename ?? "").trim().toLowerCase() !== alvoNome) return false;
      // quando o dossiê guarda o inbox de origem, ele também precisa bater
      if (romaneioDossie.message_inbox_id && a.message_inbox_id) {
        return a.message_inbox_id === romaneioDossie.message_inbox_id;
      }
      return true;
    });
    if (doDossie) add(doDossie, "romaneio_do_dossie");
  }

  if (out.length === 0) {
    for (const a of suportados) {
      if (RE_NOME_ROMANEIO.test(a.filename ?? "")) add(a, "romaneio_por_nome");
    }
  }
  return out;
}

const TOOLS_33 = new Set(["lancar_oc33_solo_portal", "lancar_combo_33_44"]);
const TIPOS_33 = new Set(["oc33_solo", "combo_33_44"]);

/**
 * Aplica meta.anexos_sugeridos nos todos 33 ativos do card.
 * Best-effort + idempotente; grava card_event Anexos33SugeridosAplicados.
 */
export async function aplicarAnexosSugeridos33(
  supabase: SupabaseClient,
  cardId: string,
  actorId: string,
): Promise<boolean> {
  try {
    const { data: card } = await supabase
      .from("cards")
      .select("agent_state")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return false;
    const romaneio = lerExtravioParcial(card as { agent_state?: Record<string, unknown> | null })
      ?.dossie?.romaneio ?? null;

    const { data: msgs } = await supabase
      .from("messages_inbox").select("id").eq("card_id", cardId);
    const inboxIds = ((msgs ?? []) as Array<{ id: string }>).map((m) => m.id);
    if (inboxIds.length === 0) return false;
    const { data: anexos } = await supabase
      .from("email_anexos")
      .select("id, message_inbox_id, filename, mime_type")
      .in("message_inbox_id", inboxIds)
      .eq("origem", "inbound")
      .is("deletado_em", null); // anexo enviado é apagado do bucket (auditoria 25/07)
    const sugeridos = escolherAnexosSugeridos33(romaneio, (anexos ?? []) as AnexoCardResumo[]);
    if (sugeridos.length === 0) return false;

    const { data: todos } = await supabase
      .from("todos")
      .select("id, status, proposta_payload")
      .eq("card_id", cardId)
      .eq("status", "pendente");
    const alvos = ((todos ?? []) as Array<Record<string, unknown>>).filter((t) => {
      const pp = t["proposta_payload"] as Record<string, unknown> | null;
      if (!pp) return false;
      const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
      return TOOLS_33.has(pp["tool"] as string) || TIPOS_33.has(meta["tipo_acao"] as string);
    });
    if (alvos.length === 0) return false;

    const idsNovos = JSON.stringify(sugeridos.map((s) => s.anexo_id));
    const patchados: string[] = [];
    for (const alvo of alvos) {
      const pp = alvo["proposta_payload"] as Record<string, unknown>;
      const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
      const atuais = Array.isArray(meta["anexos_sugeridos"])
        ? JSON.stringify((meta["anexos_sugeridos"] as Array<{ anexo_id?: string }>).map((s) => s.anexo_id))
        : null;
      if (atuais === idsNovos) continue; // idempotente
      const { error } = await supabase
        .from("todos")
        .update({ proposta_payload: { ...pp, meta: { ...meta, anexos_sugeridos: sugeridos } } })
        .eq("id", alvo["id"] as string);
      if (!error) patchados.push(alvo["id"] as string);
    }
    if (patchados.length === 0) return false;

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "Anexos33SugeridosAplicados",
      actor_type: "system",
      actor_id: actorId,
      payload: { todos_patchados: patchados, anexos_sugeridos: sugeridos },
    });
    return true;
  } catch (e) {
    console.warn(
      `[anexos-33-sugeridos] falhou (card ${cardId}): ${e instanceof Error ? e.message : e} — modal segue com pré-seleção padrão`,
    );
    return false;
  }
}
