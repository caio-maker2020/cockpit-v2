// =============================================================================
// sync-bastao — Edge Function (Deno runtime)
//
// 3 passes em ordem:
//   Pass A — discover: importa pendências do Bastão filtradas por
//            OCORRENCIAS_DE_RELACIONAMENTO + BASTAO_TEST_FILTER_OPERATOR.
//            Cria card OU atualiza dados sincronizados.
//   Pass B — release: cards ativos no Cockpit cuja pendência no Bastão
//            (lookup por NF) saiu do escopo do Relacionamento → fecha card
//            como RESOLVIDO + grava DevolvidoParaOperacao.
//   Pass C — verify: todos.status='executando' → checa se a ocorrência
//            esperada (proposta_payload.args.codigo) já apareceu no Bastão.
//
// IMPORTANTE — Bastão regenera os UUIDs de pendências.id a cada update
// (DELETE + INSERT no upstream a cada ~40min). Por isso o match Cockpit ↔ Bastão
// é feito por (nf, ctrc), não por bastao_pendencia_id. O campo
// bastao_pendencia_id em cards continua sendo populado pra debug e auditoria,
// mas não é chave estável.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";
import {
  OCORRENCIAS_DE_RELACIONAMENTO,
  VERIFICATION_TIMEOUT_MINUTES,
} from "../_shared/bastao-rules.ts";
import { proporAutoAcaoSeAplicavel } from "../_shared/regras-auto-acao.ts";
import {
  createSswTrackingClient,
  isTrackingSuccess,
  loadTrackingSenhasFromSupabase,
  readSswTrackingEnvFromProcess,
} from "../_shared/ssw-tracking-client.ts";
import {
  aplicarTransicaoAguardandoCliente,
  decidirTransicaoAguardandoCliente,
} from "../_shared/transicao-aguardando-cliente.ts";

interface PassASummary {
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
}

interface PassBSummary {
  checked: number;
  released: number;
  not_found_in_bastao: number;
}

interface PassCSummary {
  pending: number;
  confirmed: number;
  timed_out: number;
  still_waiting: number;
}

interface PassDSummary {
  checked: number;
  aviso_disparado: number;
  sem_pendencia_no_bastao: number;
}

interface PassESummary {
  checked: number;
  mantido_em_54: number;
  resolvido_finalizadora: number;
  movido_aguardando_voce: number;
  movido_tratativa_pendente: number;
  sem_info: number;
}

interface SyncSummary {
  pass_a: PassASummary;
  pass_b: PassBSummary;
  pass_c: PassCSummary;
  pass_d: PassDSummary;
  pass_e: PassESummary;
  errors: Array<{ pass: string; ref: string; message: string }>;
  duration_ms: number;
}

serve(async (req) => {
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    const errors: SyncSummary["errors"] = [];

    const tracking = await buildTrackingResolver(supabase, env);

    const passA = await runPassA(supabase, bastao, tracking, errors);
    const passB = await runPassB(supabase, bastao, tracking, errors);
    const passC = await runPassC(supabase, bastao, errors);
    const passD = await runPassD(supabase, bastao, errors);
    const passE = await runPassE(supabase, bastao, tracking, errors);

    const summary: SyncSummary = {
      pass_a: passA,
      pass_b: passB,
      pass_c: passC,
      pass_d: passD,
      pass_e: passE,
      errors,
      duration_ms: Date.now() - startedAt,
    };

    console.log("Sync done:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("sync-bastao fatal:", message);
    return new Response(
      JSON.stringify({ error: message, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// =============================================================================
// PASS A — discover
// =============================================================================

type SupabaseClient = ReturnType<typeof createClient>;
type BastaoClient = ReturnType<typeof createBastaoClient>;
type SswTrackingClient = ReturnType<typeof createSswTrackingClient>;

/**
 * Ocorrências finalizadoras do CT-e (regra Sal Express 2026-05-05). Quando
 * uma dessas oc é lançada, a NF some do Bastão pendência. Sync-bastao Pass B
 * consulta tracking pra confirmar; se última oc bate, fecha card RESOLVIDO.
 *  - 30: finaliza CT-e
 *  - 01: entrega normal (finaliza)
 *  - 32: finaliza CT-e
 */
const OCORRENCIAS_FINALIZADORAS: ReadonlySet<number> = new Set([1, 30, 32]);

/**
 * Resolver de oc real via SSW tracking. Quando Bastão pendência diverge do
 * que está no card (Bastão tem latência maior que tracking), confirma com
 * tracking SSW e segue a fonte mais real-time. Regra geral 2026-05-05.
 */
interface TrackingResolver {
  ssw: SswTrackingClient;
  senhaByCnpj: Record<string, string>;
}

async function buildTrackingResolver(
  supabase: SupabaseClient,
  env: Record<string, string>,
): Promise<TrackingResolver | null> {
  try {
    const senhaByCnpj = await loadTrackingSenhasFromSupabase(supabase);
    if (Object.keys(senhaByCnpj).length === 0) return null;
    const ssw = createSswTrackingClient({
      env: { ...readSswTrackingEnvFromProcess(env), senhaByCnpj },
    });
    return { ssw, senhaByCnpj };
  } catch (err) {
    console.error("[A] tracking resolver falhou ao carregar:", err);
    return null;
  }
}

/**
 * Pra um par (nf, cnpj_pagador), retorna a última oc do tracking SSW.
 * null se não tem credencial, falhou, ou não conseguiu extrair.
 */
async function fetchOcDoTracking(
  resolver: TrackingResolver,
  nf: string,
  cnpjPagador: string | null | undefined,
): Promise<number | null> {
  if (!cnpjPagador) return null;
  const documentoLimpo = cnpjPagador.replace(/\D/g, "");
  if (!resolver.senhaByCnpj[documentoLimpo]) return null;

  try {
    const resp = await resolver.ssw.fetchByNf(documentoLimpo, nf);
    if (!isTrackingSuccess(resp)) return null;
    const tracking = (resp["tracking"] ?? []) as Array<Record<string, unknown>>;
    const last = tracking[tracking.length - 1];
    const ocStr = (last?.["ocorrencia"] as string | undefined) ?? "";
    const match = ocStr.match(/\((\d+)\)\s*$/);
    if (!match) return null;
    return parseInt(match[1], 10);
  } catch (err) {
    console.error(`[A] tracking ${nf}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function runPassA(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  tracking: TrackingResolver | null,
  errors: SyncSummary["errors"],
): Promise<PassASummary> {
  const pendencias = await bastao.fetchPendenciasDoCockpit();
  console.log(`[A] Bastão retornou ${pendencias.length} pendências. Tracking ${tracking ? "ativo" : "indisponível"}.`);

  const summary: PassASummary = {
    pulled: pendencias.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const p of pendencias) {
    try {
      const result = await upsertCardFromPendencia(supabase, p, tracking);
      if (result === "created") summary.created++;
      else if (result === "updated") summary.updated++;
      else summary.unchanged++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ref = `${p.nf ?? "?"}/${p.ctrc ?? "?"}`;
      console.error(`[A] Erro pendência ${ref}: ${message}`);
      errors.push({ pass: "A", ref, message });
    }
  }

  return summary;
}

type UpsertResult = "created" | "updated" | "unchanged";

/**
 * Match Cockpit ↔ Bastão por NF (chave natural estável). Bastão regenera
 * UUIDs ao atualizar, então `bastao_pendencia_id` é só snapshot.
 */
async function upsertCardFromPendencia(
  supabase: SupabaseClient,
  pRaw: BastaoPendencia,
  tracking: TrackingResolver | null,
): Promise<UpsertResult> {
  // Normalização canônica: NF no Cockpit nunca tem zeros à esquerda.
  // Bastão API às vezes retorna com zeros, às vezes sem — manter o
  // banco sempre num formato único elimina cards-fantasma duplicados.
  const p: BastaoPendencia = { ...pRaw, nf: normalizeNf(pRaw.nf) };

  if (!p.nf) {
    // Sem NF não temos como matchar; pula.
    return "unchanged";
  }

  // Cards em TRANSFERIDO/RESOLVIDO/CANCELADO não são reabertos pelo Pass A.
  // Reabertura por mensagem do cliente é responsabilidade do vinculador
  // (que move pra TRATATIVA_PENDENTE).
  // Inclui TRANSFERIDO no select pra evitar duplicação infinita: card que
  // saiu pra outro setor permanece no Cockpit como TRANSFERIDO (filtrado do
  // Kanban). Quando Bastão continua tendo a pendência, queremos atualizar
  // o card existente, não criar duplicata. RESOLVIDO/CANCELADO continuam
  // excluídos (fim de fato — não deve ser ressuscitado pelo sync).
  const { data: existingRows, error: selectErr } = await supabase
    .from("cards")
    .select("id, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state, bastao_pendencia_id, lock_aguardando_validacao, aviso_alteracao_oc")
    .eq("nf", p.nf)
    .not("state", "in", "(RESOLVIDO,CANCELADO)")
    .order("created_at", { ascending: false })
    .limit(1);

  if (selectErr) {
    throw new Error(`SELECT cards by nf: ${selectErr.message}`);
  }

  const existing = existingRows?.[0] ?? null;

  // Crosscheck SSW tracking (regra geral 2026-05-05): Bastão pendência tem
  // latência maior que tracking. Quando Bastão diverge da oc do card, consulta
  // tracking; se tracking discordar do Bastão, segue o tracking (fonte
  // real-time). Sobrescreve p.cod_ultima_ocorrencia ANTES do resto do upsert
  // pra que o state e propostas sejam calculados na oc real.
  let ocVeioDoTracking = false;
  let ocBastaoOriginal: number | null = p.cod_ultima_ocorrencia;
  if (
    tracking &&
    existing &&
    p.cod_ultima_ocorrencia != null &&
    existing.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia
  ) {
    const ocReal = await fetchOcDoTracking(tracking, p.nf, p.cnpj_pagador);
    if (ocReal != null && ocReal !== p.cod_ultima_ocorrencia) {
      console.log(
        `[A] ${p.nf}: divergência Bastão=${p.cod_ultima_ocorrencia} vs tracking=${ocReal}. Seguindo tracking.`,
      );
      p.cod_ultima_ocorrencia = ocReal;
      ocVeioDoTracking = true;
    }
  }

  // Calcula o state baseado em (1) responsavel_atual do Bastão e
  // (2) responsabilidade do dicionário como fallback. Bastão é fonte
  // primária — quando ele diz que outro setor está cuidando, é outro setor.
  // Quando a oc veio do tracking (Bastão atrasado), responsavel_atual do
  // Bastão pode estar inconsistente — passa null pra usar só o dicionário.
  const stateProposto = await calcularStatePeloBastao(
    supabase,
    p.cod_ultima_ocorrencia,
    ocVeioDoTracking ? null : p.responsavel_atual,
  );

  if (existing) {
    const changedOcorrencia = existing.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia;
    const changedData = existing.bastao_data_ultima_ocorrencia !== p.data_ultima_ocorrencia;

    // Detecta caso especial: card lockado em AGUARDANDO_VALIDACAO_HUMANA
    // com todo pendente cuja oc proposta JÁ aparece no Bastão. Significa
    // que alguém lançou a oc por fora (manualmente no SSW). Aprovar
    // duplicaria. Auto-cancela o todo + destrava lock + segue fluxo normal.
    const lockOriginal = Boolean(
      (existing as Record<string, unknown>)["lock_aguardando_validacao"],
    );
    let lockEffective = lockOriginal;

    if (lockOriginal && p.cod_ultima_ocorrencia != null) {
      const cancelou = await cancelarTodoSeOcJaLancada(
        supabase,
        existing.id as string,
        p.cod_ultima_ocorrencia,
      );
      if (cancelou) lockEffective = false;
    }

    // Recalcula state APENAS se:
    //  (a) lock_aguardando_validacao=false (humano não travou)
    //  (b) state atual é "passivo" (não é estado ativo de execução nem de
    //      espera intencional)
    //  (c) state proposto é diferente do atual
    //
    // Estados ativos NÃO mexidos: EXECUTANDO_ACAO, AGUARDANDO_VALIDACAO_HUMANA,
    // TRATATIVA_PENDENTE, BLOQUEADO_POR_ERRO, ESCALADO_HUMANO.
    // AGUARDANDO_CLIENTE também NÃO é passivo: Sal já lançou oc=54 e está
    // intencionalmente esperando cliente responder. Bastão pendência segue
    // mostrando a oc original (10/11/35/49) até cliente responder de fato —
    // se Pass A recalcular esse card, vai relockar e criar propostas duplicadas.
    // Saída de AGUARDANDO_CLIENTE: vinculador detecta resposta cliente OU
    // marcar_retorno_inconclusivo OU cobrança D+4.
    // Pass B já filtra TRANSFERIDO/RESOLVIDO/CANCELADO no SELECT acima.
    const STATES_PASSIVOS = new Set([
      "AGUARDANDO_AGENTE",
      "AGUARDANDO_CONTEXTO",
      "AGUARDANDO_VINCULACAO",
      "EM_TRIAGEM",
      "RECEBIDO",
    ]);

    const podeRecalcular =
      !lockEffective &&
      STATES_PASSIVOS.has(existing.state as string) &&
      stateProposto != null &&
      stateProposto !== existing.state;

    // Regra geral 2026-05-04: cards em TRANSFERIDO ou TRATATIVA_PENDENTE
    // sobrevivem só enquanto a oc atual NÃO é de relacionamento. Quando
    // Bastão diz que oc voltou pra relacionamento (stateProposto =
    // AGUARDANDO_AGENTE), card volta automaticamente pra PARA FAZER, e a
    // regra REGRAS_AUTO_ACAO[oc] dispara nessa mesma sync (cria propostas).
    //
    // TRATATIVA_PENDENTE é setado pelo VINCULADOR quando cliente cobra/
    // responde sobre card que estava em TRANSFERIDO ou tem oc de extravio
    // (6/9/16). A premissa é "operadora acompanha decisão do cliente". Se
    // depois Perdas resolve com oc=49, cliente nem precisa mais decidir —
    // card volta pro fluxo normal.
    const voltouParaRelacionamento =
      (existing.state === "TRANSFERIDO" || existing.state === "TRATATIVA_PENDENTE") &&
      stateProposto === "AGUARDANDO_AGENTE";

    // Mantém variável legada com mesmo valor pra não quebrar referências
    // posteriores no arquivo.
    const transferidoVoltouRelacionamento = voltouParaRelacionamento;

    const updatePayload: Record<string, unknown> = {
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: p.responsavel_relacionamento,
      agent_state: snapshotFromPendencia(p),
    };
    if (podeRecalcular) {
      updatePayload["state"] = stateProposto;
    } else if (transferidoVoltouRelacionamento) {
      updatePayload["state"] = "AGUARDANDO_AGENTE";
    }
    // Senão (caso TRANSFERIDO mantém TRANSFERIDO): updatePayload sem state →
    // só atualiza cod/data/synced. Não cria duplicata.

    // Card lockado + oc mudou no Bastão = operação lançou oc por fora.
    // Sinaliza pra Larissa revisar antes de aprovar proposta antiga.
    // Limpado pelas RPCs aprovar_e_executar / voltar_para_to_do /
    // marcar_retorno_inconclusivo quando operadora age.
    if (lockOriginal && changedOcorrencia) {
      updatePayload["aviso_alteracao_oc"] = {
        oc_anterior: existing.cod_ultima_ocorrencia,
        oc_atual: p.cod_ultima_ocorrencia,
        alterada_em: new Date().toISOString(),
      };
    }

    const { error: updErr } = await supabase
      .from("cards")
      .update(updatePayload)
      .eq("id", existing.id);

    if (updErr) throw new Error(`UPDATE cards: ${updErr.message}`);

    if (ocVeioDoTracking) {
      await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: "DivergenciaBastaoVsTrackingResolvida",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_bastao: ocBastaoOriginal,
          oc_tracking_real: p.cod_ultima_ocorrencia,
          oc_anterior_card: existing.cod_ultima_ocorrencia,
          state_resultante: stateProposto,
          regra: "Bastão pendência tem latência maior que tracking SSW. Seguindo tracking como fonte mais real-time (regra geral 2026-05-05).",
        },
      });
    }

    if (changedOcorrencia || changedData || podeRecalcular) {
      const { error: evErr } = await supabase.from("card_events").insert({
        card_id: existing.id,
        event_type: podeRecalcular ? "StateRecalculadoPorOc" : "BastaoCardAtualizado",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          previous: {
            state: existing.state,
            cod_ultima_ocorrencia: existing.cod_ultima_ocorrencia,
            bastao_data_ultima_ocorrencia: existing.bastao_data_ultima_ocorrencia,
          },
          current: {
            state: podeRecalcular ? stateProposto : existing.state,
            ...snapshotFromPendencia(p),
          },
          fonte_oc: ocVeioDoTracking ? "ssw_tracking" : "bastao_pendencia",
        },
      });
      if (evErr) throw new Error(`INSERT card_events (atualizado): ${evErr.message}`);
    }

    // Auto-proposta sempre avaliada no Pass A (idempotente — não cria 2º
    // todo da mesma proposta). Garante que cards "unchanged" recebem regra
    // recém-deployada na próxima execução.
    //
    // Se card está lockado e tem aviso_alteracao_oc (oc mudou no SSW por
    // fora durante o lock), avalia regra usando a oc QUE ORIGINOU O LOCK
    // (oc_anterior do aviso) — não a oc atual. Senão, regra nova publicada
    // pra oc_anterior nunca dispararia (oc atual já é outra coisa, sem
    // regra) e propostas faltantes não seriam criadas.
    // effState reflete o state PÓS-update — usado pela auto-proposta abaixo.
    // Se card era TRANSFERIDO e voltou pra relacionamento, agora é
    // AGUARDANDO_AGENTE (e a regra REGRAS_AUTO_ACAO[oc] dispara já nessa sync).
    let effState = podeRecalcular ? (stateProposto as string) : existing.state;
    if (transferidoVoltouRelacionamento) {
      effState = "AGUARDANDO_AGENTE";
    }
    const avisoExisting = (existing as Record<string, unknown>)["aviso_alteracao_oc"] as
      | { oc_anterior?: number; oc_atual?: number }
      | null
      | undefined;
    const ocPraRegra = (lockOriginal && avisoExisting?.oc_anterior != null)
      ? avisoExisting.oc_anterior
      : p.cod_ultima_ocorrencia;
    await proporAutoAcaoSeAplicavel(supabase, {
      cardId: existing.id as string,
      cardNf: p.nf,
      codUltimaOc: ocPraRegra,
      agentState: snapshotFromPendencia(p) as Record<string, unknown>,
      cardState: effState as string,
      cardLock: lockEffective,
    });

    if (changedOcorrencia || changedData || podeRecalcular) return "updated";
    return "unchanged";
  }

  const newState = stateProposto ?? "AGUARDANDO_AGENTE";

  const { data: insertedCard, error: insErr } = await supabase
    .from("cards")
    .insert({
      nf: p.nf,
      ctrc: p.ctrc,
      canal_origem: "sistema",
      empresa_cliente: p.pagador,
      pagador: p.pagador,
      base_destino: p.base_destino,
      responsavel_relacionamento: p.responsavel_relacionamento,
      state: newState,
      tipo: null,
      risco: "baixo",
      assigned_agent: null,
      assigned_operator_id: null,
      bastao_pendencia_id: p.id,
      cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
      agent_state: snapshotFromPendencia(p),
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`INSERT cards: ${insErr.message}`);

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: insertedCard.id,
    event_type: "BastaoCardImportado",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: snapshotFromPendencia(p),
  });
  if (evErr) throw new Error(`INSERT card_events (importado): ${evErr.message}`);

  await proporAutoAcaoSeAplicavel(supabase, {
    cardId: insertedCard.id as string,
    cardNf: p.nf,
    codUltimaOc: p.cod_ultima_ocorrencia,
    agentState: snapshotFromPendencia(p) as Record<string, unknown>,
    cardState: newState,
    cardLock: false,
  });

  return "created";
}


// =============================================================================
// PASS B — release: cards que sairam do escopo do Relacionamento
// =============================================================================

async function runPassB(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  tracking: TrackingResolver | null,
  errors: SyncSummary["errors"],
): Promise<PassBSummary> {
  // 1. Cards ativos no Cockpit com bastao_pendencia_id (= importados do Bastão)
  //    e que TÊM nf (sem nf não dá pra fazer lookup).
  // Inclui lock_aguardando_validacao pra respeitar o lock no release.
  const { data: activeCards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, state, lock_aguardando_validacao, agent_state")
    .not("state", "in", "(RESOLVIDO,CANCELADO,TRANSFERIDO,TRATATIVA_PENDENTE)")
    .not("bastao_pendencia_id", "is", null)
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "B", ref: "select_active_cards", message: selErr.message });
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  const cards = activeCards ?? [];
  if (cards.length === 0) {
    return { checked: 0, released: 0, not_found_in_bastao: 0 };
  }

  // 2. Estado atual no Bastão por NF (1 query por card — Bastão não tem
  //    `nf=in.(...)` performático com 30+ valores; vamos sequencial)
  let released = 0;
  let notFound = 0;

  for (const card of cards) {
    const nf = normalizeNf(card.nf as string) ?? (card.nf as string);
    let current: BastaoPendencia | null;
    try {
      current = await bastao.fetchPendenciaByNf(nf);
    } catch (err) {
      errors.push({
        pass: "B",
        ref: `nf=${nf}`,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!current) {
      notFound++;
      // NF saiu do Bastão pendência. Regra Sal Express 2026-05-05: ocs
      // finalizadoras do CT-e (30, 01, 32) tiram a NF da fila do Bastão.
      // Confirma via SSW tracking — se última oc é finalizadora, fecha
      // card como RESOLVIDO. Se cliente cobrar de novo, o vinculador
      // reabre como TRATATIVA_PENDENTE (preserva histórico).
      if (tracking) {
        try {
          const cnpjPagador =
            ((card as Record<string, unknown>)["agent_state"] as Record<string, unknown> | null)?.[
              "cnpj_pagador"
            ] as string | undefined;
          const ocReal = await fetchOcDoTracking(tracking, nf, cnpjPagador ?? null);
          if (ocReal != null) {
            if (OCORRENCIAS_FINALIZADORAS.has(ocReal)) {
              await fecharCardComoResolvidoFimDePendencia(
                supabase,
                card.id as string,
                card.cod_ultima_ocorrencia as number | null,
                ocReal,
              );
              released++;
            } else if (!OCORRENCIAS_DE_RELACIONAMENTO.has(ocReal)) {
              // Tracking retornou oc fora de relacionamento e não-finalizadora
              // (ex: 14 saiu pra entrega = Operação). NF saiu do Bastão →
              // marca TRANSFERIDO com oc real do tracking. Padrão idêntico
              // ao releaseCard, mas com fonte=tracking_rt.
              await releaseCardViaTracking(
                supabase,
                card.id as string,
                card.cod_ultima_ocorrencia as number | null,
                ocReal,
              );
              released++;
            }
          }
        } catch (err) {
          errors.push({
            pass: "B",
            ref: `nf=${nf}/tracking`,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    const newCod = current.cod_ultima_ocorrencia;
    const stillInScope = newCod != null && OCORRENCIAS_DE_RELACIONAMENTO.has(newCod);
    if (stillInScope) continue;

    // Lock: card que o agente puxou pra validação humana não pode sair daqui
    // automaticamente. Mesmo que a oc no Bastão tenha mudado, esperamos o
    // operador clicar Aprovar ou Rejeitar pra destravar.
    if ((card as Record<string, unknown>)["lock_aguardando_validacao"] === true) {
      console.log(`[B] card ${card.id} lockado em AGUARDANDO_VALIDACAO_HUMANA — pulando release`);
      continue;
    }

    try {
      await releaseCard(supabase, card.id as string, card.cod_ultima_ocorrencia, current);
      released++;
    } catch (err) {
      errors.push({
        pass: "B",
        ref: card.id as string,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked: cards.length, released, not_found_in_bastao: notFound };
}

async function releaseCard(
  supabase: SupabaseClient,
  cardId: string,
  previousCod: number | null,
  current: BastaoPendencia,
): Promise<void> {
  // Busca setor responsável da nova ocorrência no dicionário pra registrar
  // pra qual setor o card foi (Operação, Devolução, Indenização, etc).
  // Se não achar, fica null e o evento ainda registra que houve transferência.
  let setorDestino: string | null = null;
  if (current.cod_ultima_ocorrencia != null) {
    const { data: dicRow } = await supabase
      .from("ocorrencias_dicionario")
      .select("responsabilidade")
      .eq("codigo", current.cod_ultima_ocorrencia)
      .maybeSingle();
    setorDestino = (dicRow?.responsabilidade as string | undefined) ?? null;
  }

  // Renomeado de DevolvidoParaOperacao → DevolvidoParaSetor (genérico).
  // Setor específico vai no payload.
  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "DevolvidoParaSetor",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      motivo: "cod_ultima_ocorrencia mudou pra fora do escopo do Relacionamento",
      setor_destino: setorDestino,
      previous_cod: previousCod,
      new_cod: current.cod_ultima_ocorrencia,
      new_descricao_instrucao: current.instrucao_ultima_ocorrencia,
      new_data_ocorrencia: current.data_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (released): ${evErr.message}`);

  // state='TRANSFERIDO' (não mais RESOLVIDO). RESOLVIDO fica reservado pra
  // "fim de fato" (operador marca como resolvido sem ação SSW). TRANSFERIDO
  // pode voltar pra TRATATIVA_PENDENTE se cliente cobrar.
  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "TRANSFERIDO",
      bastao_pendencia_id: current.id,
      cod_ultima_ocorrencia: current.cod_ultima_ocorrencia,
      bastao_data_ultima_ocorrencia: current.data_ultima_ocorrencia,
      bastao_synced_at: new Date().toISOString(),
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (released): ${updErr.message}`);
}

/**
 * Marca card como TRANSFERIDO quando NF sumiu do Bastão E tracking confirma
 * oc fora de escopo de relacionamento (não-finalizadora). Casos típicos:
 * card aprovado oc=44 que vira oc 88 no Bastão (devolução), ou oc=14 (saída
 * pra entrega = Operação). NF some da pendência mas tracking ainda mostra
 * histórico — usa essa info pra fechar o card como TRANSFERIDO sem ficar
 * preso em EXECUTANDO_ACAO/AGUARDANDO_CLIENTE/etc.
 */
async function releaseCardViaTracking(
  supabase: SupabaseClient,
  cardId: string,
  ocAnterior: number | null,
  ocTracking: number,
): Promise<void> {
  let setorDestino: string | null = null;
  const { data: dicRow } = await supabase
    .from("ocorrencias_dicionario")
    .select("responsabilidade")
    .eq("codigo", ocTracking)
    .maybeSingle();
  setorDestino = (dicRow?.responsabilidade as string | undefined) ?? null;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "DevolvidoParaSetor",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      motivo: "NF saiu do Bastão pendência + tracking confirma oc fora do escopo de Relacionamento",
      setor_destino: setorDestino,
      previous_cod: ocAnterior,
      new_cod: ocTracking,
      fonte_oc: "ssw_tracking",
    },
  });

  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "TRANSFERIDO",
      cod_ultima_ocorrencia: ocTracking,
      bastao_synced_at: new Date().toISOString(),
      lock_aguardando_validacao: false,
      aviso_alteracao_oc: null,
      acao_falhou_motivo: null,
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (transferido via tracking): ${updErr.message}`);
}

/**
 * Fecha card como RESOLVIDO quando NF sumiu do Bastão pendência E tracking
 * confirma oc finalizadora. Registra a oc final no card_event pra auditoria.
 * Se cliente cobrar essa NF depois, vinculador reabre o MESMO card em
 * TRATATIVA_PENDENTE (preserva histórico).
 */
async function fecharCardComoResolvidoFimDePendencia(
  supabase: SupabaseClient,
  cardId: string,
  ocAnterior: number | null,
  ocFinalTracking: number,
): Promise<void> {
  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "CardResolvidoBastaoFimDePendencia",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      oc_anterior: ocAnterior,
      oc_final_tracking: ocFinalTracking,
      regra: "NF saiu do Bastão pendência + tracking confirma oc finalizadora ∈ {1, 30, 32}. Card encerrado.",
      reabertura: "Se cliente cobrar essa NF depois, vinculador reabre este card em TRATATIVA_PENDENTE.",
    },
  });

  const { error: updErr } = await supabase
    .from("cards")
    .update({
      state: "RESOLVIDO",
      cod_ultima_ocorrencia: ocFinalTracking,
      bastao_synced_at: new Date().toISOString(),
      lock_aguardando_validacao: false,
      aviso_alteracao_oc: null,
      acao_falhou_motivo: null,
    })
    .eq("id", cardId);
  if (updErr) throw new Error(`UPDATE cards (resolvido fim de pendência): ${updErr.message}`);
}

// =============================================================================
// PASS C — verify: todos em "executando" → confirmar ou marcar timeout
// =============================================================================

async function runPassC(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassCSummary> {
  const { data: pendingTodos, error: selErr } = await supabase
    .from("todos")
    .select(`
      id, card_id, proposta_payload, approved_at,
      cards!inner(id, nf)
    `)
    .eq("status", "executando")
    .not("cards.nf", "is", null);

  if (selErr) {
    errors.push({ pass: "C", ref: "select_executando", message: selErr.message });
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  const todos = pendingTodos ?? [];
  if (todos.length === 0) {
    return { pending: 0, confirmed: 0, timed_out: 0, still_waiting: 0 };
  }

  let confirmed = 0;
  let timedOut = 0;
  let stillWaiting = 0;
  const now = Date.now();
  const timeoutMs = VERIFICATION_TIMEOUT_MINUTES * 60 * 1000;

  for (const t of todos) {
    try {
      const cardRef = (t as Record<string, unknown>)["cards"] as
        | { id: string; nf: string | null }
        | { id: string; nf: string | null }[]
        | null;
      const ref = Array.isArray(cardRef) ? cardRef[0] : cardRef;
      const nf = ref?.nf;
      if (!nf) {
        stillWaiting++;
        continue;
      }

      const current = await bastao.fetchPendenciaByNf(nf);
      if (!current) {
        stillWaiting++;
        continue;
      }

      const expected = parseExpectedCodigo(t.proposta_payload);
      if (!expected) {
        stillWaiting++;
        continue;
      }

      if (current.cod_ultima_ocorrencia === expected) {
        await markTodoExecutado(supabase, t, current, expected);
        confirmed++;
      } else {
        const approvedAt = t.approved_at ? new Date(t.approved_at).getTime() : now;
        const elapsed = now - approvedAt;
        if (elapsed > timeoutMs) {
          await markTodoFalhou(supabase, t, current, expected, elapsed);
          timedOut++;
        } else {
          stillWaiting++;
        }
      }
    } catch (err) {
      errors.push({
        pass: "C",
        ref: String(t.id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { pending: todos.length, confirmed, timed_out: timedOut, still_waiting: stillWaiting };
}

function parseExpectedCodigo(proposta: unknown): number | null {
  if (!proposta || typeof proposta !== "object") return null;
  const args = (proposta as Record<string, unknown>)["args"];
  if (!args || typeof args !== "object") return null;
  const codigo = (args as Record<string, unknown>)["codigo"];
  if (codigo == null) return null;
  const n = typeof codigo === "number" ? codigo : parseInt(String(codigo), 10);
  return Number.isFinite(n) ? n : null;
}

async function markTodoExecutado(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "OcorrenciaSSWConfirmada",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_confirmado: expected,
      data_ocorrencia: current.data_ultima_ocorrencia,
      instrucao: current.instrucao_ultima_ocorrencia,
    },
  });
  if (evErr) throw new Error(`INSERT card_events (confirmada): ${evErr.message}`);

  const { error: updErr } = await supabase
    .from("todos")
    .update({ status: "executado" })
    .eq("id", todoId);
  if (updErr) throw new Error(`UPDATE todos (executado): ${updErr.message}`);

  // Transição de state agora é feita pelo executor IMEDIATAMENTE pós-sucesso
  // SSW (regra 2026-05-05). Pass C aqui só confirma `status=executado` no todo
  // pra fins de auditoria/dashboard. NÃO mexe em cards.state.
}

async function markTodoFalhou(
  supabase: SupabaseClient,
  todo: Record<string, unknown>,
  current: BastaoPendencia,
  expected: number,
  elapsedMs: number,
): Promise<void> {
  const todoId = todo["id"] as string;
  const cardId = todo["card_id"] as string;

  const { error: evErr } = await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "AcaoExecutadaSemConfirmacao",
    actor_type: "system",
    actor_id: "sync-bastao",
    payload: {
      todo_id: todoId,
      codigo_esperado: expected,
      codigo_atual: current.cod_ultima_ocorrencia,
      minutos_decorridos: Math.round(elapsedMs / 60000),
      timeout_minutos: VERIFICATION_TIMEOUT_MINUTES,
      motivo: "Ocorrência esperada não apareceu no Bastão dentro do prazo",
    },
  });
  if (evErr) throw new Error(`INSERT card_events (falhou): ${evErr.message}`);

  const { error: updTodoErr } = await supabase
    .from("todos")
    .update({ status: "falhou" })
    .eq("id", todoId);
  if (updTodoErr) throw new Error(`UPDATE todos (falhou): ${updTodoErr.message}`);

  const { error: updCardErr } = await supabase
    .from("cards")
    .update({ state: "BLOQUEADO_POR_ERRO" })
    .eq("id", cardId);
  if (updCardErr) throw new Error(`UPDATE cards (BLOQUEADO_POR_ERRO): ${updCardErr.message}`);
}

// =============================================================================
// PASS D — crosscheck cards lockados
// =============================================================================
// Pass A só puxa pendências cuja oc atual está em OCORRENCIAS_DE_RELACIONAMENTO.
// Quando oc muda no Bastão pra um código fora dessa lista (ex: 41), o Pass A
// deixa de ver a pendência e o card lockado fica congelado com a oc antiga,
// sem o aviso visual pra Larissa.
//
// Pass D fecha esse buraco: pega TODOS cards lockados, busca pendências
// correspondentes no Bastão por bastao_pendencia_id (sem filtro de oc), e se
// a oc do Bastão divergir da oc do card, popula aviso_alteracao_oc.
//
// Importante: Pass D NÃO mexe em state, NÃO cria propostas, NÃO recalcula
// nada. Só dispara o aviso visual. Larissa continua dona da decisão.
// =============================================================================

async function runPassD(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  errors: SyncSummary["errors"],
): Promise<PassDSummary> {
  const summary: PassDSummary = {
    checked: 0,
    aviso_disparado: 0,
    sem_pendencia_no_bastao: 0,
  };

  const { data: lockados, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, bastao_pendencia_id, aviso_alteracao_oc")
    .eq("lock_aguardando_validacao", true)
    .not("nf", "is", null);

  if (selErr) {
    errors.push({ pass: "D", ref: "select", message: selErr.message });
    return summary;
  }

  const cards = (lockados ?? []) as Array<{
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    bastao_pendencia_id: string | null;
    aviso_alteracao_oc: Record<string, unknown> | null;
  }>;

  summary.checked = cards.length;
  if (cards.length === 0) return summary;

  // Bastão regenera UUIDs quando atualiza pendência, então o
  // bastao_pendencia_id no card pode estar obsoleto. Match por NF
  // (chave estável) — uma chamada por card.
  for (const card of cards) {
    try {
      if (!card.nf) continue;
      const p = await bastao.fetchPendenciaByNf(card.nf);
      if (!p) {
        // Pendência sumiu do Bastão (NF saiu da fila inteira). Pass B trata
        // isso quando confirma — aqui só conta.
        summary.sem_pendencia_no_bastao++;
        continue;
      }
      const ocBastao = p.cod_ultima_ocorrencia;
      if (ocBastao == null) continue;
      if (ocBastao === card.cod_ultima_ocorrencia) continue;

      // Se já tem aviso apontando pra essa mesma oc atual, não retoca
      // (idempotente — não faz UPDATE inútil nem novo card_event).
      const avisoExistente = card.aviso_alteracao_oc;
      if (
        avisoExistente &&
        Number(avisoExistente["oc_atual"]) === ocBastao &&
        Number(avisoExistente["oc_anterior"]) === card.cod_ultima_ocorrencia
      ) {
        continue;
      }

      const novoAviso = {
        oc_anterior: card.cod_ultima_ocorrencia,
        oc_atual: ocBastao,
        alterada_em: new Date().toISOString(),
      };

      const { error: updErr } = await supabase
        .from("cards")
        .update({ aviso_alteracao_oc: novoAviso })
        .eq("id", card.id);
      if (updErr) throw new Error(`UPDATE cards (aviso): ${updErr.message}`);

      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "AvisoAlteracaoOcDisparadoPassD",
        actor_type: "system",
        actor_id: "sync-bastao",
        payload: {
          oc_anterior: card.cod_ultima_ocorrencia,
          oc_atual: ocBastao,
          fonte: "bastao_pendencia",
          observacao: "Detectado pelo Pass D — oc do Bastão divergiu do card lockado, fora do filtro de relacionamento do Pass A.",
        },
      });

      summary.aviso_disparado++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ref = `${card.nf ?? "?"}/${card.id}`;
      console.error(`[D] Erro card ${ref}: ${message}`);
      errors.push({ pass: "D", ref, message });
    }
  }

  return summary;
}

// =============================================================================
// PASS E — verifica cards em AGUARDANDO_CLIENTE
// =============================================================================
// Regra Caio 2026-05-05: AGUARDANDO_CLIENTE só pode conter cards com oc=54.
// Lógica de decisão+aplicação extraída pra _shared/transicao-aguardando-cliente.ts
// (reusada pelo botão manual da Edge Function atualizar-card-via-tracking).
// =============================================================================

async function runPassE(
  supabase: SupabaseClient,
  bastao: BastaoClient,
  tracking: TrackingResolver | null,
  errors: SyncSummary["errors"],
): Promise<PassESummary> {
  const summary: PassESummary = {
    checked: 0,
    mantido_em_54: 0,
    resolvido_finalizadora: 0,
    movido_aguardando_voce: 0,
    movido_tratativa_pendente: 0,
    sem_info: 0,
  };

  const { data: cards, error: selErr } = await supabase
    .from("cards")
    .select("id, nf, cod_ultima_ocorrencia, agent_state")
    .eq("state", "AGUARDANDO_CLIENTE")
    .not("nf", "is", null);
  if (selErr) {
    errors.push({ pass: "E", ref: "select", message: selErr.message });
    return summary;
  }
  const lista = (cards ?? []) as Array<{
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    agent_state: Record<string, unknown> | null;
  }>;
  summary.checked = lista.length;

  for (const card of lista) {
    try {
      const nf = normalizeNf(card.nf as string) ?? (card.nf as string);
      const cnpjPagador = (card.agent_state ?? {})["cnpj_pagador"] as string | undefined;

      const pendBastao = await bastao.fetchPendenciaByNf(nf);
      const ocBastao = pendBastao?.cod_ultima_ocorrencia ?? null;
      const ocTracking = tracking
        ? await fetchOcDoTracking(tracking, nf, cnpjPagador ?? null)
        : null;

      const decisao = decidirTransicaoAguardandoCliente({ ocBastao, ocTracking });
      switch (decisao.tipo) {
        case "manter":
          summary.mantido_em_54++;
          break;
        case "resolvido":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.resolvido_finalizadora++;
          break;
        case "aguardando_voce":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.movido_aguardando_voce++;
          break;
        case "tratativa_pendente":
          await aplicarTransicaoAguardandoCliente(supabase, card.id, card.cod_ultima_ocorrencia, decisao);
          summary.movido_tratativa_pendente++;
          break;
        case "sem_info":
          summary.sem_info++;
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ pass: "E", ref: card.nf ?? card.id, message });
    }
  }

  return summary;
}

// =============================================================================
// helpers
// =============================================================================

/**
 * Normaliza NF removendo zeros à esquerda. Bastão API ora retorna
 * "000757683", ora "757683" pra mesma NF; o Cockpit padroniza sem zeros.
 * Mantém null/string vazia como null.
 */
function normalizeNf(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const trimmed = nf.trim().replace(/^0+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Card lockado em AGUARDANDO_VALIDACAO_HUMANA com todo pendente cuja oc
 * proposta JÁ apareceu no Bastão = alguém lançou a oc manualmente no SSW
 * por fora do Cockpit. Aprovar duplicaria. Auto-cancela o todo + destrava
 * o lock pra que o sync siga o fluxo normal (state segue responsavel_atual).
 *
 * Retorna true se cancelou algum todo (logo, o lock deve ser ignorado no
 * resto do upsert).
 */
async function cancelarTodoSeOcJaLancada(
  supabase: SupabaseClient,
  cardId: string,
  ocAtualNoBastao: number,
): Promise<boolean> {
  const { data: todosPendentes, error: selErr } = await supabase
    .from("todos")
    .select("id, action_id, proposta_payload")
    .eq("card_id", cardId)
    .eq("status", "pendente");

  if (selErr || !todosPendentes || todosPendentes.length === 0) return false;

  const alvos = todosPendentes.filter((t: Record<string, unknown>) => {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const args = payload?.["args"] as Record<string, unknown> | undefined;
    const codProposto = args?.["codigo_ssw"];
    return typeof codProposto === "number" && codProposto === ocAtualNoBastao;
  });

  if (alvos.length === 0) return false;

  for (const t of alvos) {
    const todoId = t["id"] as string;
    const actionId = (t["action_id"] as string | undefined) ?? null;

    const { error: updErr } = await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: "Auto-cancelado: oc já lançada por fora (Bastão registrou antes da aprovação)",
      })
      .eq("id", todoId);

    if (updErr) {
      console.error(`auto-cancel todo ${todoId}: ${updErr.message}`);
      continue;
    }

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "TodoAutoCanceladoOcLancadaPorFora",
      actor_type: "system",
      actor_id: "sync-bastao",
      payload: {
        todo_id: todoId,
        action_id: actionId,
        cod_atual_bastao: ocAtualNoBastao,
        motivo: "Bastão já mostra oc igual à proposta — evita duplicação no SSW",
      },
    });
  }

  // Destrava o lock (ainda não muda state — quem decide o state final é o
  // resto do upsert via stateProposto/podeRecalcular)
  await supabase
    .from("cards")
    .update({ lock_aguardando_validacao: false })
    .eq("id", cardId);

  return true;
}

/**
 * Calcula o state usando responsavel_atual do Bastão como fonte primária
 * e o dicionário ocorrencias_dicionario como fallback. Wraps a RPC
 * public.state_pelo_bastao(int, text) (migration 029).
 */
async function calcularStatePeloBastao(
  supabase: SupabaseClient,
  cod: number | null | undefined,
  responsavelAtual: string | null | undefined,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("state_pelo_bastao", {
    p_cod: cod ?? null,
    p_responsavel_atual: responsavelAtual ?? null,
  });
  if (error) {
    console.error(
      `state_pelo_bastao(${cod}, ${responsavelAtual}) erro: ${error.message}`,
    );
    return null;
  }
  return typeof data === "string" ? data : null;
}

function snapshotFromPendencia(p: BastaoPendencia) {
  return {
    bastao_pendencia_id: p.id,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    cnpj_remetente: p.cnpj_remetente,
    remetente: p.remetente,
    cnpj_pagador: p.cnpj_pagador,
    cnpj_destinatario: p.cnpj_destinatario,
    destinatario: p.destinatario,
    uf_destino: p.uf_destino,
    cidade_destino: p.cidade_destino,
    base_destino: p.base_destino,
    unidade_atual: p.unidade_atual,
    dias_atraso: p.atraso_original,
    previsao_entrega: p.previsao_entrega,
    responsabilidade_cliente: p.responsabilidade_cliente,
    responsavel_atual: p.responsavel_atual,
    responsavel_relacionamento: p.responsavel_relacionamento,
    segmento_cliente: p.segmento_cliente,
    importante_acompanhar: p.importante_acompanhar,
    bastao_synced_at: new Date().toISOString(),
  };
}
