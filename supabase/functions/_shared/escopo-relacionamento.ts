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
// seguindo o Bastão, sem aprovação (decisão Caio 2026-06-22). Finalizadoras
// (1/30/32) nunca vêm pelo Bastão — operador descobre via histórico e força;
// por isso o sync NÃO flagga finalizadora (tratado no call-site do Pass B).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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
  },
): Promise<"flagged" | "skipped_idempotente" | "skipped_cockpit_lancou"> {
  // ── Escopo de CICLO da supressão (Caio 2026-06-23, refinamento INV-014) ──
  // A regra "oc lançada pelo Cockpit não é conflito" vale SÓ pra o ciclo DAQUELE
  // lançamento — não "essa oc nunca mais é conflito nesse card". Conflito é
  // descasamento POR ATUALIZAÇÃO/ciclo (Caio): se a operação reabre o card num
  // ciclo novo e relança a MESMA oc por fora/errado, ISSO é conflito.
  //   Caso 1 (49→54→cliente→33): o 33 é meu, ciclo ativo → NÃO flagga.
  //   Caso 2 (…33 meu → operação reabre 49 → operação relança 33 errado): ciclo
  //           NOVO → DEVE flaggar, mesmo a oc sendo a mesma de antes.
  //
  // Discriminador de ciclo = `acao_executada_em`: setado quando o Cockpit lança
  // (card vai pra ACAO_EXECUTADA) e SEMPRE zerado na liberação/confirmação
  // (confirmar-acao-executada-ssw). Não-nulo ⟺ o card ainda está no ciclo ATIVO
  // do lançamento; nulo ⟺ já foi liberado/reaberto (qualquer descasamento daqui
  // é ciclo novo → flagga). Prevenção primária do Caso 1 é o guard
  // forcaAguardandoClienteOc54 (mantém o card em TRANSFERIDO, fora do escopo
  // protegido, então nem chega aqui); este gate garante que a supressão por
  // número-de-oc NÃO vaze pro Caso 2.
  let emCicloAtivoDoLancamento = false;
  try {
    const { data: cardAtivo } = await supabase
      .from("cards")
      .select("acao_executada_em")
      .eq("id", args.cardId)
      .maybeSingle();
    emCicloAtivoDoLancamento =
      (cardAtivo as { acao_executada_em?: string | null } | null)?.acao_executada_em != null;
  } catch (_e) {
    // Na dúvida (falha de leitura), NÃO suprime — flagga (conservador).
  }

  if (emCicloAtivoDoLancamento) {
    // Guard 1 (Caio 2026-06-22): acoes_executadas_ssw = registro autoritativo do
    // que o Cockpit lança via envelope. Conflito real (oc por fora) não tem aqui.
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

    // Guard 2 — sinal PATH-INDEPENDENT (Caio 2026-06-22, NF 376924): nem todo
    // lançamento grava em acoes_executadas_ssw (os 5 callers oc=33/44 migraram
    // pro envelope, mas este sinal cobre qualquer caminho). `AcaoExecutadaConfir-
    // madaPeloSsw` é emitido por TODO lançamento confirmado pelo SSW (executor-
    // inline / Pass H), qualquer que seja o handler.
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
