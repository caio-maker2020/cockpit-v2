// =============================================================================
// escopo-relacionamento — invariante "card em escopo protegido nunca sai sozinho"
// (Caio 2026-06-22)
//
// Card em AGUARDANDO_VALIDACAO_HUMANA (AGUARDANDO VOCÊ, lockado) ou
// AGUARDANDO_CLIENTE (oc=54) NÃO pode ser movido pra TRANSFERIDO/RESOLVIDO por
// ação automática do sync. Quando a oc real (Bastão/SSW) sai do escopo de
// relacionamento, em vez de mover, o sync FLAGGA (mudanca_suspeita
// tipo="saiu_de_escopo") e o card aparece na aba ⚠️ CONFLITOS até o operador
// clicar FORÇAR ATUALIZAÇÃO.
//
// AGUARDANDO_AGENTE (PARA FAZER) NÃO entra no escopo protegido: sai naturalmente
// seguindo o Bastão, sem aprovação (decisão Caio 2026-06-22).
//
// REGRA Caio 2026-08-24 (NF 1611059): conflito APENAS interessa quando a oc
// conflitante é de RELACIONAMENTO ou de CLIENTE. Se o Cockpit já DESPACHOU o
// card (último lançamento bem-sucedido ≠54/59 → TRANSFERIDO) e o que veio
// depois no SSW é operacional (14/1/30/32...), NÃO é conflito — é a operação
// seguindo o fluxo após a nossa ação; oc de cliente/relacionamento voltaria
// pelo caminho normal de reabertura. Guard dentro do flagConflitoOcSemMover
// (ponto único — vale pra todos os callers).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { OCORRENCIAS_DE_RELACIONAMENTO, OCS_CLIENTE } from "./bastao-rules.ts";

type SupabaseClient = ReturnType<typeof createClient>;

/**
 * Estados cujo card NÃO pode ser solto automaticamente pelo sync (Pass B / Pass E).
 * Fonte única — usada nos guards dos branches found/!current dos dois Pass B.
 */
export const STATES_PROTEGIDOS_CONFLITO: ReadonlySet<string> = new Set([
  "AGUARDANDO_VALIDACAO_HUMANA",
  "AGUARDANDO_CLIENTE",
]);

export function cardEmEscopoProtegido(state: string | null | undefined): boolean {
  return state != null && STATES_PROTEGIDOS_CONFLITO.has(state);
}

/** Shape do jsonb cards.mudanca_suspeita (estende o caso extravio da mig 218). */
export type MudancaSuspeitaJson = {
  /** "saiu_de_escopo" (este módulo) | ausente => "virou_extravio" (legado). */
  tipo?: string;
  de_oc?: number | null;
  para_oc?: number;
  de_state?: string;
  requer_ok?: boolean;
  origem_pass?: string;
  detectada_em?: string;
  vista_em?: string | null;
  [k: string]: unknown;
};

/**
 * Grava o sinal de conflito (mudanca_suspeita tipo="saiu_de_escopo") SEM mover
 * state/lock/cod_ultima_ocorrencia do card. O card permanece onde está; aparece
 * na aba CONFLITOS até o operador FORÇAR ATUALIZAÇÃO.
 *
 * Idempotente: se já existe flag ATIVO (vista_em null) pra a MESMA para_oc, não
 * regrava nem reinsere evento (evita spam a cada sync de 5min). Regrava só se a
 * para_oc mudou OU se o flag anterior já foi visto/é de outro tipo.
 *
 * `mudancaAtual` deve vir do SELECT do Pass B (coluna mudanca_suspeita) pra
 * evitar uma query extra por card.
 */
export async function flagConflitoOcSemMover(
  supabase: SupabaseClient,
  args: {
    cardId: string;
    deState: string;
    deOc: number | null;
    paraOc: number;
    origemPass: "B_found" | "B_notfound" | "A_reconc";
    mudancaAtual?: MudancaSuspeitaJson | null;
    cardCtrc?: string | null;       // CT-e do card (a identidade do card)
    pendenciaCtrc?: string | null;  // CT-e da pendência que originou `paraOc`
  },
): Promise<"flagged" | "skipped_idempotente" | "skipped_cockpit_lancou" | "skipped_ctrc_diferente" | "skipped_pos_lancamento_cockpit"> {
  // ── GUARD CT-e INVIOLÁVEL (Caio 2026-06-24; NF 919069) ───────────────────────
  // NUNCA apontar conflito comparando DOIS CT-es DIFERENTES. A identidade do card é
  // o CTRC, não a NF. Quando a NF tem mais de um CT-e (ex.: um CT-e de DEVOLUÇÃO), o
  // lookup por NF traz a oc do OUTRO CT-e (caso âncora: oc=2 "Emissão CTRC
  // Subcontrato" do CT-e de devolução BHZ410378-5, enquanto o card é BHZ390535-7) e
  // flagga o card errado, recorrente a cada ciclo. Se a pendência que gerou `paraOc`
  // é de um CTRC diferente do card, NÃO é conflito desse card — não flagga.
  const normCtrc = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, "");
  if (args.cardCtrc && args.pendenciaCtrc &&
      normCtrc(args.cardCtrc) !== normCtrc(args.pendenciaCtrc)) {
    return "skipped_ctrc_diferente";
  }

  // ── REGRA Caio 2026-08-24 (NF 1611059): pós-despacho não é conflito ─────────
  // Conflito só interessa quando a oc conflitante é de RELACIONAMENTO ou de
  // CLIENTE ({54,59}). Se a `paraOc` é operacional (14/1/30/32/...) E o último
  // lançamento bem-sucedido do Cockpit foi ≠54/59 (= despachou o card pra
  // TRANSFERIDO), o que veio depois é a operação seguindo o fluxo da NOSSA
  // ação — não flagga. Card ainda sob nossa gestão (último lançamento 54/59,
  // ou nunca lançou nada) continua flaggando — senão vira zumbi invisível.
  if (!OCS_CLIENTE.has(args.paraOc) && !OCORRENCIAS_DE_RELACIONAMENTO.has(args.paraOc)) {
    try {
      const { data: ultimoLanc } = await supabase
        .from("acoes_executadas_ssw")
        .select("codigo_oc")
        .eq("card_id", args.cardId)
        .eq("sucesso", true)
        .order("iniciado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ocUltima = (ultimoLanc as { codigo_oc?: number } | null)?.codigo_oc;
      if (ocUltima != null && !OCS_CLIENTE.has(ocUltima)) {
        return "skipped_pos_lancamento_cockpit";
      }
    } catch (_e) {
      // checagem falhou → segue pro flag (conservador: visível > invisível)
    }
  }

  // ── INV-014 INVIOLÁVEL (Caio 2026-06-22; corrigido na raiz 2026-06-23) ──
  // Card cuja oc conflitante (`paraOc`) foi lançada PELO COCKPIT (por dentro)
  // NUNCA vira conflito. Os 2 sinais abaixo rodam SEMPRE — sem gate de ciclo.
  //
  // BUG que isto corrige (era retrabalho na aba CONFLITOS): a versão de 06-23
  // gateava os guards atrás de `acao_executada_em != null` ("ciclo ativo"). Mas
  // esse campo é ZERADO assim que o Bastão confirma o lançamento e o card volta a
  // descansar (AGUARDANDO_CLIENTE). Resultado: TODO card já confirmado perdia a
  // proteção e era re-flagado, mesmo a oc estando em acoes_executadas_ssw. O
  // estado de "descanso" é o normal da maioria dos cards → flag em massa.
  // Âncoras: NF 359849(44), 1017149(21), 3057294(56), 377696(21).
  //
  // Tradeoff aceito pelo Caio: se a operação reabrir o card e relançar a MESMA oc
  // por fora num ciclo novo, isso NÃO será flagado (suprimimos por número de oc).
  // Zero falso-positivo > pegar esse caso raro. (Pra distinguir no futuro: comparar
  // a data da ocorrência no SSW com `acoes_executadas_ssw.finalizado_em`.)
  //
  // Sinal 1 — acoes_executadas_ssw: registro autoritativo do envelope de lançamento.
  try {
    const { data: jaLancou } = await supabase
      .from("acoes_executadas_ssw")
      .select("id")
      .eq("card_id", args.cardId)
      .eq("codigo_oc", args.paraOc)
      .eq("sucesso", true)
      .limit(1)
      .maybeSingle();
    if (jaLancou) return "skipped_cockpit_lancou";
  } catch (_e) {
    // Falha na checagem não bloqueia — segue pro flag (conservador).
  }

  // Sinal 2 — PATH-INDEPENDENT (NF 376924): nem todo lançamento grava em
  // acoes_executadas_ssw. `AcaoExecutadaConfirmadaPeloSsw` é emitido por TODO
  // lançamento confirmado pelo SSW (executor-inline / Pass H), qualquer handler.
  try {
    const { data: confirmadoPeloSsw } = await supabase
      .from("card_events")
      .select("id")
      .eq("card_id", args.cardId)
      .eq("event_type", "AcaoExecutadaConfirmadaPeloSsw")
      .eq("payload->>oc_ssw", String(args.paraOc))
      .limit(1)
      .maybeSingle();
    if (confirmadoPeloSsw) return "skipped_cockpit_lancou";
  } catch (_e) {
    // idem: falha de checagem não bloqueia o flag (conservador).
  }

  const atual = args.mudancaAtual;
  const jaFlaggadoMesmaOc =
    atual != null &&
    atual.tipo === "saiu_de_escopo" &&
    (atual.vista_em === null || atual.vista_em === undefined) &&
    Number(atual.para_oc) === args.paraOc;
  if (jaFlaggadoMesmaOc) return "skipped_idempotente";

  const agora = new Date().toISOString();
  const mudanca: MudancaSuspeitaJson = {
    tipo: "saiu_de_escopo",
    de_oc: args.deOc,
    para_oc: args.paraOc,
    de_state: args.deState,
    requer_ok: true,
    origem_pass: args.origemPass,
    detectada_em: agora,
    vista_em: null,
  };

  const { error: updErr } = await supabase
    .from("cards")
    .update({ mudanca_suspeita: mudanca, bastao_synced_at: agora })
    .eq("id", args.cardId);
  if (updErr) throw new Error(`flagConflitoOcSemMover UPDATE: ${updErr.message}`);

  await supabase.from("card_events").insert({
    card_id: args.cardId,
    event_type: "MudancaSuspeitaDetectada",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      tipo: "saiu_de_escopo",
      de_oc: args.deOc,
      para_oc: args.paraOc,
      de_state: args.deState,
      origem_pass: args.origemPass,
      motivo:
        "Card em escopo protegido + oc real saiu de relacionamento. Sinalizado " +
        "pra aba CONFLITOS; NÃO movido (aguarda FORÇAR ATUALIZAÇÃO do operador).",
    },
  });

  return "flagged";
}
