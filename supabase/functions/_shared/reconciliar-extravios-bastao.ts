// =============================================================================
// reconciliar-extravios-bastao — saída da aba EXTRAVIOS pela verdade do BASTÃO,
// consultado POR NF (não pelo filtro de ocorrência).
//
// Caio 2026-06-24 (desenho final, decisão do Caio): o Bastão é fotografia do
// relatório SSW de pendências e faz FULL-REFRESH a cada rodada do RPA. Provado
// empiricamente: uma NF que muda de oc CONTINUA no Bastão com a oc nova (33, 49,
// 14, 5, 53…); só SOME quando FINALIZA (entregue 1 / devol. 30 / cancel. 32).
// Logo, consultar o Bastão por NF é a fonte de verdade BARATA da aba:
//   - oc ∈ {6,9,16} → fica (atualiza a data → nova fotografia)
//   - oc ∉ {6,9,16} → sai roteado por responsabilidade (decidirDestinoExtravio)
//   - NF AUSENTE do Bastão → finalizou (1/30/32) → RESOLVIDO
//
// PRÉ-CONDIÇÃO INVIOLÁVEL (gate de frescor): o caller SÓ pode rodar isto se
// GARANTIU que o Bastão atualizou neste ciclo (max(updated_at) recente). Bastão
// velho/down → não roda NADA (senão "NF ausente" seria dado velho, não
// finalização). Sem isso, jamais inferir RESOLVIDO por ausência.
//
// SSW NÃO é usado aqui. Fica reservado pro conflito (oc lançada pelo Cockpit e o
// Bastão volta com outra — máquina existente) e pra pré-checagem do agente (PART 2).
// =============================================================================

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { type BastaoPendencia } from "./bastao-client.ts";
import { decidirDestinoExtravio, EXTRAVIO_OCS } from "./extravio-routing.ts";
import { proporAutoAcaoSeAplicavel, REGRAS_AUTO_ACAO } from "./regras-auto-acao.ts";
import { normalizeNf } from "./extravio-enrichment.ts";

export interface CardExtravioParaReconciliar {
  id: string;
  nf: string | null;
  ctrc: string | null;
  cod_ultima_ocorrencia: number | null;
  bastao_data_ultima_ocorrencia: string | null;
  agent_state: Record<string, unknown> | null;
}

export type DecisaoBastao =
  | "extravio" // continua na aba (oc ainda 6/9/16)
  | "aguardando_voce" // oc de relacionamento → AGUARDANDO VOCÊ / CLIENTE
  | "transferido" // oc de outro setor → TRANSFERIDO
  | "resolvido" // oc finalizadora presente no Bastão (raro)
  | "resolvido_sumiu" // NF sumiu do Bastão fresco → finalizou → RESOLVIDO
  | "sem_acao"; // pendência sem oc legível → não mexe

export interface LinhaRelatorioBastao {
  card_id: string;
  nf: string | null;
  oc_local: number | null;
  oc_bastao: number | null;
  decisao: DecisaoBastao;
  state_novo: string;
  motivo: string;
}

export interface ResultadoReconciliacaoBastao {
  processados: number;
  mantidos: number; // continuam extravio
  movidos: number; // saíram roteados (incl. resolvido_sumiu)
  sem_acao: number;
  erros: number;
  relatorio: LinhaRelatorioBastao[];
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Reconcilia uma lista de cards EXTRAVIO_MONITORADO contra o Bastão (já consultado
 * por NF pelo caller, mapa nf-normalizada → pendência). `bastaoConfirmadoFresco`
 * DEVE ser true (o caller validou o gate de frescor); só então "ausente" vira
 * RESOLVIDO.
 */
export async function reconciliarExtraviosViaBastao(
  supabase: SupabaseClient,
  cards: CardExtravioParaReconciliar[],
  pendenciaByNf: Map<string, BastaoPendencia>,
  opts: { bastaoConfirmadoFresco: boolean; actorId?: string },
): Promise<ResultadoReconciliacaoBastao> {
  const actorId = opts.actorId ?? "sync-extravios-bastao";
  const res: ResultadoReconciliacaoBastao = {
    processados: 0, mantidos: 0, movidos: 0, sem_acao: 0, erros: 0, relatorio: [],
  };

  for (const card of cards) {
    res.processados++;
    const nfNorm = normalizeNf(card.nf);
    const base = { card_id: card.id, nf: card.nf, oc_local: card.cod_ultima_ocorrencia ?? null };
    try {
      const pend = nfNorm ? pendenciaByNf.get(nfNorm) : undefined;

      // ── NF AUSENTE do Bastão ──────────────────────────────────────────────
      if (!pend) {
        if (!opts.bastaoConfirmadoFresco) {
          // Sem garantia de frescor não dá pra dizer que finalizou. Não mexe.
          res.sem_acao++;
          res.relatorio.push({ ...base, oc_bastao: null, decisao: "sem_acao", state_novo: "EXTRAVIO_MONITORADO", motivo: "ausente do Bastão MAS sem garantia de frescor — não move" });
          continue;
        }
        await cancelarPropostasExtravio(supabase, card.id, "Card finalizado (sumiu do Bastão atualizado) — propostas de extravio canceladas");
        await supabase.from("cards").update({
          state: "RESOLVIDO",
          lock_aguardando_validacao: false,
          aviso_alteracao_oc: null,
          acao_falhou_motivo: null,
          mudanca_suspeita: null,
          bastao_synced_at: new Date().toISOString(),
        }).eq("id", card.id);
        await supabase.from("card_events").insert({
          card_id: card.id,
          event_type: "ExtravioFinalizadoBastaoAusente",
          actor_type: "system",
          actor_id: actorId,
          payload: { oc_local: card.cod_ultima_ocorrencia, motivo: "NF não veio no relatório do Bastão atualizado → só sai do relatório quando finaliza (1/30/32) → RESOLVIDO" },
        });
        res.movidos++;
        res.relatorio.push({ ...base, oc_bastao: null, decisao: "resolvido_sumiu", state_novo: "RESOLVIDO", motivo: "sumiu do Bastão fresco → finalizada → RESOLVIDO" });
        continue;
      }

      const ocBastao = pend.cod_ultima_ocorrencia;
      if (ocBastao == null) {
        res.sem_acao++;
        res.relatorio.push({ ...base, oc_bastao: null, decisao: "sem_acao", state_novo: "EXTRAVIO_MONITORADO", motivo: "pendência do Bastão sem oc legível" });
        continue;
      }

      // ── CONTINUA EXTRAVIO (6/9/16) ────────────────────────────────────────
      if (EXTRAVIO_OCS.has(ocBastao)) {
        // Atualiza oc (pode ter ido 6→9) + data (nova fotografia) + synced. SEM
        // card_event: roda todo ciclo p/ todos, evita flood.
        await supabase.from("cards").update({
          cod_ultima_ocorrencia: ocBastao,
          bastao_data_ultima_ocorrencia: pend.data_ultima_ocorrencia,
          bastao_synced_at: new Date().toISOString(),
        }).eq("id", card.id);
        res.mantidos++;
        res.relatorio.push({ ...base, oc_bastao: ocBastao, decisao: "extravio", state_novo: "EXTRAVIO_MONITORADO", motivo: "ainda extravio no Bastão — mantido" });
        continue;
      }

      // ── SAIU DA ABA (oc mudou pra fora de 6/9/16) ─────────────────────────
      const temRegra = REGRAS_AUTO_ACAO[ocBastao] != null;
      const dest = decidirDestinoExtravio(ocBastao, temRegra);
      await cancelarPropostasExtravio(supabase, card.id, "Card saiu de Extravios (Bastão trouxe oc fora de 6/9/16) — propostas de extravio canceladas");
      const { error: upErr } = await supabase.from("cards").update({
        cod_ultima_ocorrencia: ocBastao,
        state: dest.state,
        lock_aguardando_validacao: dest.lock,
        bastao_data_ultima_ocorrencia: pend.data_ultima_ocorrencia,
        bastao_synced_at: new Date().toISOString(),
        mudanca_suspeita: null,
        aviso_alteracao_oc: null,
        acao_falhou_motivo: null,
      }).eq("id", card.id);
      if (upErr) {
        res.erros++;
        res.relatorio.push({ ...base, oc_bastao: ocBastao, decisao: dest.decisao, state_novo: card.cod_ultima_ocorrencia != null ? "EXTRAVIO_MONITORADO" : "?", motivo: `UPDATE falhou: ${upErr.message}` });
        continue;
      }

      let recriou = false;
      if (dest.decisao === "aguardando_voce" && temRegra) {
        try {
          await proporAutoAcaoSeAplicavel(supabase, {
            cardId: card.id,
            cardNf: card.nf,
            cardCtrc: card.ctrc,
            codUltimaOc: ocBastao,
            agentState: (card.agent_state ?? {}) as Record<string, unknown>,
            cardState: dest.state,
            cardLock: dest.lock,
            actorId,
          });
          recriou = true;
        } catch (e) {
          console.warn(`[reconciliar-extravios-bastao] proporAutoAcao falhou nf ${card.nf}: ${msg(e)}`);
        }
      }
      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "ExtravioReconciliadoViaBastao",
        actor_type: "system",
        actor_id: actorId,
        payload: { oc_anterior: card.cod_ultima_ocorrencia, oc_bastao: ocBastao, state_novo: dest.state, decisao: dest.decisao, propostas_recriadas: recriou },
      });
      res.movidos++;
      res.relatorio.push({ ...base, oc_bastao: ocBastao, decisao: dest.decisao, state_novo: dest.state, motivo: `oc ${ocBastao} → ${dest.state}${recriou ? " (+propostas)" : ""}` });
    } catch (e) {
      res.erros++;
      res.relatorio.push({ ...base, oc_bastao: null, decisao: "sem_acao", state_novo: "EXTRAVIO_MONITORADO", motivo: `erro: ${msg(e)}` });
    }
  }
  return res;
}

async function cancelarPropostasExtravio(
  supabase: SupabaseClient,
  cardId: string,
  motivo: string,
): Promise<void> {
  await supabase.from("todos").update({ status: "cancelado", rejection_reason: motivo })
    .eq("card_id", cardId).eq("status", "pendente");
}
