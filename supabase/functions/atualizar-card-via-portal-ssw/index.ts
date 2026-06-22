// =============================================================================
// atualizar-card-via-portal-ssw — botão "↻ atualizar agora" do card.
//
// Caio 2026-05-20: RENOMEADO de `atualizar-card-via-tracking` pra refletir
// fonte real (portal SSW interno, opção 101). O nome antigo causava confusão
// porque sugeria tracking público — que NÃO é a fonte desde 2026-05-12.
// Edge antiga `atualizar-card-via-tracking` virou wrapper proxy pra manter
// compat com Lovable enquanto front migra. Memory project_tracking_publico_deprecated.
//
// Caio 2026-05-12: REESCRITO. Antes consultava Bastão+tracking SSW (público).
// Agora consulta DIRETO o portal SSW interno (opção 101) — mesma cadeia que
// puxar-historico-ssw-card usa. Motivos:
//   - Tracking público oculta 31 ocs (49/56/44/...) — Larissa lança 56 manual
//     fora do Cockpit e o card fica preso em AGUARDANDO_VALIDACAO_HUMANA+lock
//     pq sync não enxerga a 56.
//   - Portal interno mostra TUDO em tempo real (não tem latência RPA Bastão).
//   - Ignora proteção 30min pós AcaoExecutada (essa proteção é pra RPA Bastão,
//     não pra portal real-time).
//
// Regra:
//   - States permitidos: AGUARDANDO_CLIENTE, AGUARDANDO_VALIDACAO_HUMANA,
//     AGUARDANDO_AGENTE, ACAO_EXECUTADA. Outros retornam no_action.
//   - Última oc do portal == cod_ultima_ocorrencia atual → ja_atualizado.
//   - Última oc finalizadora (1/30/32) → RESOLVIDO + unlock + cancela propostas.
//   - Última oc de relacionamento (≠ atual) → AGUARDANDO_VALIDACAO_HUMANA + lock
//     (preserva propostas existentes).
//   - Última oc fora de relacionamento → TRANSFERIDO + unlock + cancela propostas.
//
// Input:  { card_id }
// Output: { ok, decisao, oc_portal, state_anterior, state_novo, ja_atualizado? }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buscarNFInterno,
  listarOcorrenciasNF,
  obterSessao,
  readSswInternalEnv,
} from "../_shared/ssw-internal-client.ts";
import { OCORRENCIAS_DE_RELACIONAMENTO } from "../_shared/bastao-rules.ts";
import { OCORRENCIAS_FINALIZADORAS_AC } from "../_shared/transicao-aguardando-cliente.ts";
import { REGRAS_AUTO_ACAO, proporAutoAcaoSeAplicavel } from "../_shared/regras-auto-acao.ts";
import {
  analisarExtravio,
  resolverEmailDestino,
  upsertPropostas as upsertPropostasExtravio,
  normalizeNf as normalizeNfExtravio,
} from "../_shared/extravio-enrichment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STATES_PERMITIDOS = new Set([
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_VALIDACAO_HUMANA",
  "AGUARDANDO_AGENTE",
  "ACAO_EXECUTADA",
  // Caio 2026-06-18: aba EXTRAVIOS. Card de extravio (oc 6/9/16) pode receber
  // oc nova no SSW antes do Bastão refletir (delay do RPA). Quando o operador
  // clica ATUALIZAR/FORÇAR e a última oc já não é mais de extravio, o card deve
  // seguir o fluxo normal: relacionamento → Relacionamento; outro setor →
  // TRANSFERIDO. Se ainda é extravio, mantém EXTRAVIO_MONITORADO (kanban).
  "EXTRAVIO_MONITORADO",
  // Caio 2026-06-18 (ADR 0005): permite re-puxar um card TRANSFERIDO. Se o SSW
  // mostrar que a oc voltou a ser do Cockpit (relacionamento/extravio), o card
  // retorna pro fluxo certo (regra inviolável). Se seguir fora, fica TRANSFERIDO.
  "TRANSFERIDO",
]);

// Ocorrências de extravio (responsabilidade Perdas) — enquanto a última oc for
// uma destas, o card fica na aba EXTRAVIOS (state EXTRAVIO_MONITORADO).
const EXTRAVIO_OCS = new Set([6, 9, 16]);

type Decisao =
  | "ja_atualizado"
  | "resolvido"
  | "aguardando_voce"
  | "transferido"
  | "extravio_mantido"
  | "extravio";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const body = await req.json().catch(() => ({}));
    const cardId: string | undefined = body.card_id;
    if (!cardId) return json({ ok: false, error: "card_id obrigatório" }, 400);

    // Caio 2026-05-20 (NF 1008312): SELECT precisa incluir agent_state. Antes
    // não trazia → proporAutoAcaoSeAplicavel recebia {} → lookup_chave_cte
    // sobrescrevia agent_state com `{ chave_cte: ... }` perdendo cnpj_pagador
    // / cnpj_remetente. Sintoma: modal "enviar email" não acha contatos.
    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, ctrc, state, cod_ultima_ocorrencia, agent_state")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return json({ ok: false, error: "card não encontrado" }, 404);
    if (!card.nf) return json({ ok: false, error: "card sem NF" }, 400);

    const stateAnterior = card.state as string;
    if (!STATES_PERMITIDOS.has(stateAnterior)) {
      return json({
        ok: true,
        no_action: true,
        motivo: `card em state '${stateAnterior}' — ATUALIZAR AGORA só atua em AGUARDANDO_CLIENTE, AGUARDANDO_VALIDACAO_HUMANA, AGUARDANDO_AGENTE, ACAO_EXECUTADA`,
        state_atual: stateAnterior,
      }, 200);
    }

    // 1. Login + busca NF + lista ocs via portal SSW interno (opção 101)
    const sswEnv = readSswInternalEnv(env);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, card.nf as string, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
    });
    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    // Filtra entradas sem código (anotações manuais "INFORMAR QUAL..." que a
    // Larissa digita direto na tela ssw0122 — aparecem como linha no histórico
    // sem código numérico em f5). Pega a primeira oc REAL.
    const primeiraOcReal = ocs.find((o) => o.codigo != null);
    const ultimaOc = primeiraOcReal?.codigo ?? null;

    if (ultimaOc == null) {
      return json({
        ok: false,
        error: `SSW retornou ${ocs.length} entradas mas nenhuma com código de ocorrência válido`,
      }, 502);
    }

    const ocAnterior = (card.cod_ultima_ocorrencia as number | null) ?? null;

    // Caio 2026-05-20 (NF 1008312): respeita regra.manter_state. oc=54 (e
    // outras ocs com manter_state=true) NUNCA forçam AVH+lock — state alvo
    // é AGUARDANDO_CLIENTE sem lock. Bug raiz: Larissa lançou oc=54 com
    // sucesso (state=AGUARDANDO_CLIENTE), Bastão atrasou sync mostrando ainda
    // oc=10, BastaoDivergiuSswReconciliado disparou esta função que via
    // ultimaOc=54 ∈ RELACIONAMENTO e movia pra AVH+lock — destruía o state
    // correto pós-execução. INV-008: oc=54 ⟺ AGUARDANDO_CLIENTE (memory
    // project_aguardando_cliente_state).
    const regraOc = REGRAS_AUTO_ACAO[ultimaOc];
    const isManterState = regraOc?.manter_state === true;

    // Caio 2026-06-18: card de extravio (aba EXTRAVIOS). Se a última oc do
    // portal AINDA é de extravio (6/9/16), mantém EXTRAVIO_MONITORADO — só
    // atualiza a oc/sync (o kanban continua mostrando o card). Só sai da aba
    // quando a oc vira de relacionamento (→ Relacionamento, abaixo) ou de outro
    // setor (→ TRANSFERIDO). Sem isso, o ramo "else" mandaria oc=6/9/16 pra
    // TRANSFERIDO indevidamente.
    const eraExtravio = stateAnterior === "EXTRAVIO_MONITORADO";

    // Caio 2026-06-22: modo PREVIEW (dry-run) pro modal de FORÇAR ATUALIZAÇÃO.
    // Lê o SSW e CLASSIFICA o destino SEM aplicar nada (nenhum UPDATE/transição),
    // pra o front mostrar a mensagem certa antes do operador confirmar:
    //   - finalizadora (1/30/32)        → "trata-se de ocorrência finalizadora…"
    //   - fora de relacionamento        → "a última ocorrência não é de relacionamento…"
    //   - relacionamento / extravio     → segue no Cockpit (não sai da visão).
    // Front: 1º chama com {card_id, preview:true} → modal; no "sim" chama de novo
    // sem preview (aplica) + liberar_card_suspeito_lockado pra limpar o flag.
    if (body.preview === true) {
      let pvDecisao: Decisao;
      let pvStateAlvo: string;
      if (OCORRENCIAS_FINALIZADORAS_AC.has(ultimaOc)) {
        pvDecisao = "resolvido";
        pvStateAlvo = "RESOLVIDO";
      } else if (OCORRENCIAS_DE_RELACIONAMENTO.has(ultimaOc)) {
        pvDecisao = "aguardando_voce";
        pvStateAlvo = isManterState
          ? "AGUARDANDO_CLIENTE"
          : (regraOc != null ? "AGUARDANDO_VALIDACAO_HUMANA" : "AGUARDANDO_AGENTE");
      } else if (EXTRAVIO_OCS.has(ultimaOc)) {
        pvDecisao = eraExtravio ? "extravio_mantido" : "extravio";
        pvStateAlvo = "EXTRAVIO_MONITORADO";
      } else {
        pvDecisao = "transferido";
        pvStateAlvo = "TRANSFERIDO";
      }
      const saiDaVisao = pvStateAlvo === "RESOLVIDO" || pvStateAlvo === "TRANSFERIDO";
      return json({
        ok: true,
        preview: true,
        oc_portal: ultimaOc,
        oc_anterior: ocAnterior,
        decisao: pvDecisao,
        state_alvo: pvStateAlvo,
        finalizadora: OCORRENCIAS_FINALIZADORAS_AC.has(ultimaOc),
        sai_da_visao: saiDaVisao,
        ja_atualizado: ultimaOc === ocAnterior && stateAnterior === pvStateAlvo,
      }, 200);
    }

    if (eraExtravio && EXTRAVIO_OCS.has(ultimaOc)) {
      await supabase
        .from("cards")
        .update({
          cod_ultima_ocorrencia: ultimaOc,
          bastao_synced_at: new Date().toISOString(),
        })
        .eq("id", cardId);
      // Caio 2026-06-18: self-heal de propostas. O sync no steady-state (caso b)
      // é barato e não recria propostas; aqui (Atualizar manual) garantimos que
      // o card de extravio tem suas propostas (idempotente).
      try {
        const ag = (card.agent_state ?? {}) as Record<string, unknown>;
        const pend = {
          id: null, nf: card.nf, ctrc: (card.ctrc as string | null) ?? null,
          cnpj_pagador: (ag["cnpj_pagador"] as string | null) ?? null,
          cnpj_remetente: (ag["cnpj_remetente"] as string | null) ?? null,
          instrucao_ultima_ocorrencia: (ag["instrucao_ultima_ocorrencia"] as string | null) ?? null,
          qtd_volumes: ((ag["qtde_volumes"] ?? ag["qtd_volumes"]) as number | null) ?? null,
          // deno-lint-ignore no-explicit-any
        } as any;
        const extM = analisarExtravio(pend);
        const emailM = await resolverEmailDestino(supabase, pend.cnpj_pagador);
        await upsertPropostasExtravio(
          supabase, cardId, pend,
          normalizeNfExtravio(card.nf as string) ?? (card.nf as string), emailM, extM.template,
        );
      } catch (e) {
        console.warn(`self-heal propostas extravio falhou: ${e instanceof Error ? e.message : String(e)}`);
      }
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AtualizadoViaPortalSsw",
        actor_type: "system",
        actor_id: "atualizar-card-via-portal-ssw",
        payload: {
          oc_anterior: ocAnterior,
          oc_atual: ultimaOc,
          state_anterior: stateAnterior,
          state_novo: stateAnterior,
          decisao: "extravio_mantido",
        },
      });
      return json({
        ok: true,
        ja_atualizado: ultimaOc === ocAnterior,
        decisao: "extravio_mantido",
        oc_portal: ultimaOc,
        state_anterior: stateAnterior,
        state_novo: stateAnterior,
        motivo: "última oc ainda é de extravio (6/9/16) — card mantido na aba Extravios",
      }, 200);
    }

    // 2. Decide state alvo pela última oc do portal
    let decisao: Decisao;
    let stateAlvo: string;
    if (OCORRENCIAS_FINALIZADORAS_AC.has(ultimaOc)) {
      decisao = "resolvido";
      stateAlvo = "RESOLVIDO";
    } else if (OCORRENCIAS_DE_RELACIONAMENTO.has(ultimaOc)) {
      decisao = "aguardando_voce";
      // Regra manter_state (ex: oc=54) → state alvo é AGUARDANDO_CLIENTE
      // sem lock. Outras ocs de relacionamento → AVH+lock (padrão).
      stateAlvo = isManterState ? "AGUARDANDO_CLIENTE" : "AGUARDANDO_VALIDACAO_HUMANA";
    } else if (EXTRAVIO_OCS.has(ultimaOc)) {
      // Caio 2026-06-18 (ADR 0005): última oc real é de extravio → card vai pra
      // EXTRAVIO_MONITORADO (aba Extravios), não TRANSFERIDO. Cobre o OK do
      // operador num card suspeito lockado e o "Atualizar" manual. O
      // enriquecimento (propostas/agent_state extravio) vem do próximo
      // sync-bastao (handleExtravioPendencia caso b).
      decisao = "extravio";
      stateAlvo = "EXTRAVIO_MONITORADO";
    } else {
      decisao = "transferido";
      stateAlvo = "TRANSFERIDO";
    }

    // 3. "Já atualizado": state atual coerente com oc do portal.
    // Caio 2026-05-20 (NF 1008312): pra ocs com manter_state, se card já está
    // em AGUARDANDO_CLIENTE, é "ja_atualizado" mesmo se ocAnterior diferir
    // (Bastão atrasado mostra outra oc — não importa, state já está correto).
    const stateCoerente = stateAnterior === stateAlvo;
    const isManterStateEstavel = isManterState && stateAnterior === "AGUARDANDO_CLIENTE";
    if ((ultimaOc === ocAnterior && stateCoerente) || isManterStateEstavel) {
      // Caio 2026-06-19 (Fix A — ATUALIZAR vira RESGATE): "já atualizado" NÃO pode
      // ser no-op cego. Se a oc tem regra de propostas mas o card está SEM nenhuma
      // proposta ativa, o card está PRESO (estado certo, ações faltando — bug da
      // transição Extravios→relacionamento, ex. oc=20; também cobre qualquer card
      // que perca as propostas por outro caminho). Antes, a operadora clicava
      // ATUALIZAR e nada acontecia (NF 30159/427148). Agora recria as propostas via
      // proporAutoAcao. Resolve a CLASSE inteira: card "estado certo, ações
      // faltando" se auto-cura no próximo ATUALIZAR, independente de como travou.
      let propostasRecriadas = 0;
      if (REGRAS_AUTO_ACAO[ultimaOc] != null) {
        const { count: ativosAntes } = await supabase
          .from("todos")
          .select("id", { count: "exact", head: true })
          .eq("card_id", cardId)
          .in("status", ["pendente", "aprovado"]);
        if ((ativosAntes ?? 0) === 0) {
          try {
            const cardRec = card as Record<string, unknown>;
            await proporAutoAcaoSeAplicavel(supabase, {
              cardId,
              cardNf: (cardRec["nf"] as string | null) ?? null,
              cardCtrc: (cardRec["ctrc"] as string | null) ?? null,
              codUltimaOc: ultimaOc,
              agentState: (cardRec["agent_state"] ?? {}) as Record<string, unknown>,
              cardState: stateAnterior,
              // AVH ⟺ lock (convenção do state machine); pra AVH o gate de
              // proporAutoAcao (isAdicaoIncremental) ignora o lock de qualquer forma.
              cardLock: stateAnterior === "AGUARDANDO_VALIDACAO_HUMANA",
              actorId: "atualizar-card-via-portal-ssw/self-heal",
            });
            const { count: ativosDepois } = await supabase
              .from("todos")
              .select("id", { count: "exact", head: true })
              .eq("card_id", cardId)
              .in("status", ["pendente", "aprovado"]);
            propostasRecriadas = ativosDepois ?? 0;
          } catch (e) {
            console.warn(`[Fix A] self-heal proporAutoAcao falhou (não bloqueia): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AtualizadoViaPortalSsw",
        actor_type: "system",
        actor_id: "atualizar-card-via-portal-ssw",
        payload: {
          oc_anterior: ocAnterior,
          oc_atual: ultimaOc,
          state_anterior: stateAnterior,
          state_novo: stateAnterior,
          decisao: propostasRecriadas > 0 ? "ja_atualizado_self_heal" : "ja_atualizado",
          propostas_recriadas: propostasRecriadas,
        },
      });
      return json({
        ok: true,
        ja_atualizado: true,
        oc_portal: ultimaOc,
        state_anterior: stateAnterior,
        state_novo: stateAnterior,
        propostas_recriadas: propostasRecriadas,
        motivo: propostasRecriadas > 0
          ? `card estava preso sem ações — ${propostasRecriadas} proposta(s) recriada(s) via self-heal`
          : "última ocorrência e state do card já coerentes com SSW",
      }, 200);
    }

    // 4. Aplica transição
    let stateNovo = stateAlvo;
    const update: Record<string, unknown> = {
      cod_ultima_ocorrencia: ultimaOc,
      bastao_synced_at: new Date().toISOString(),
      state: stateNovo,
    };

    if (decisao === "resolvido") {
      update.lock_aguardando_validacao = false;
      update.aviso_alteracao_oc = null;
      update.acao_falhou_motivo = null;
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Card RESOLVIDO via ATUALIZAR AGORA (portal SSW)",
        })
        .eq("card_id", cardId)
        .eq("status", "pendente");
    } else if (decisao === "aguardando_voce") {
      // Caio 2026-05-20 (NF 1494315): se a oc nova é de relacionamento MAS
      // não tem regra em REGRAS_AUTO_ACAO, NÃO trava — card vai pra "PARA FAZER"
      // (AGUARDANDO_AGENTE) sem lock, operador escolhe lançamento manual.
      // Antes: ficava lockado em AGUARDANDO_VALIDACAO_HUMANA sem propostas
      // (caso âncora oc=8 avaria).
      const temRegra = regraOc != null;
      if (isManterState) {
        // Caio 2026-05-20 (NF 1008312): oc=54 com manter_state=true → mantém
        // AGUARDANDO_CLIENTE sem lock. Larissa lançou oc=54 e precisa do card
        // disponível pra cobrar de novo / escolher outra opção.
        update.lock_aguardando_validacao = false;
        update.aviso_alteracao_oc = null;
      } else if (temRegra) {
        update.lock_aguardando_validacao = true;
        update.aviso_alteracao_oc = null;
      } else {
        // Oc de relacionamento sem regra → PARA FAZER sem lock
        stateNovo = "AGUARDANDO_AGENTE";
        update.state = "AGUARDANDO_AGENTE";
        update.lock_aguardando_validacao = false;
        update.aviso_alteracao_oc = {
          tipo: "alteracao_oc_durante_lock",
          oc_anterior: ocAnterior,
          oc_atual: ultimaOc,
          alterada_em: new Date().toISOString(),
          sem_regra: true,
          observacao: "Última oc é de relacionamento mas não tem regra de propostas automáticas. Operador decide ação manual via 'lançamento emergencial'.",
        };
      }
    } else if (decisao === "extravio") {
      // Caio 2026-06-18 (ADR 0005): card vai pra Extravios. Destrava + cancela
      // propostas de relacionamento pendentes (o sync-bastao recria as de
      // extravio). agent_state/aviso são re-enriquecidos no próximo sync.
      update.lock_aguardando_validacao = false;
      update.acao_falhou_motivo = null;
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Card virou extravio via ATUALIZAR (última oc 6/9/16)",
        })
        .eq("card_id", cardId)
        .eq("status", "pendente");
    } else {
      update.lock_aguardando_validacao = false;
      update.aviso_alteracao_oc = null;
      update.acao_falhou_motivo = null;
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Card TRANSFERIDO via ATUALIZAR AGORA (portal SSW — oc fora do relacionamento)",
        })
        .eq("card_id", cardId)
        .eq("status", "pendente");
    }

    // Caio 2026-06-18: card SAINDO da aba Extravios (oc deixou de ser 6/9/16).
    // Cancela as propostas de extravio (origem=extravio_cockpit) pra não
    // sobrarem botões obsoletos (lançar 49/55, e-mail) no card de relacionamento.
    // As ocs de relacionamento (aguardando_voce) recriam propostas próprias via
    // proporAutoAcao; TRANSFERIDO/RESOLVIDO já cancelam tudo abaixo.
    if (eraExtravio) {
      await supabase
        .from("todos")
        .update({
          status: "cancelado",
          rejection_reason: "Card saiu de Extravios (oc mudou via ATUALIZAR) — propostas de extravio canceladas",
        })
        .eq("card_id", cardId)
        .eq("status", "pendente")
        .eq("proposta_payload->meta->>origem", "extravio_cockpit");
    }

    const { error: upErr } = await supabase
      .from("cards")
      .update(update)
      .eq("id", cardId);
    if (upErr) return json({ ok: false, error: `UPDATE card: ${upErr.message}` }, 500);

    // Caio 2026-06-18 (ADR 0005): card ENTROU em Extravios via ATUALIZAR →
    // enriquece (cria as propostas de extravio). É um ponto de ENTRADA: o sync
    // no steady-state (caso b) é barato e NÃO recria propostas, então a criação
    // tem que acontecer aqui. Monta a pendência a partir do agent_state do card.
    if (decisao === "extravio") {
      try {
        const ag = (card.agent_state ?? {}) as Record<string, unknown>;
        const pend = {
          id: null, nf: card.nf, ctrc: (card.ctrc as string | null) ?? null,
          cnpj_pagador: (ag["cnpj_pagador"] as string | null) ?? null,
          cnpj_remetente: (ag["cnpj_remetente"] as string | null) ?? null,
          instrucao_ultima_ocorrencia: (ag["instrucao_ultima_ocorrencia"] as string | null) ?? null,
          qtd_volumes: (ag["qtde_volumes"] ?? ag["qtd_volumes"]) as number | null ?? null,
          // deno-lint-ignore no-explicit-any
        } as any;
        const extA = analisarExtravio(pend);
        const emailA = await resolverEmailDestino(supabase, pend.cnpj_pagador);
        await upsertPropostasExtravio(
          supabase, cardId, pend, normalizeNfExtravio(card.nf as string) ?? (card.nf as string),
          emailA, extA.template,
        );
      } catch (e) {
        console.warn(`enriquecimento extravio falhou (não bloqueia): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Caio 2026-05-20 (NF 1494315): pra decisão=aguardando_voce com oc que TEM
    // regra, dispara proporAutoAcaoSeAplicavel pra criar propostas novas.
    // Antes só fazia o UPDATE — propostas tinham que vir do próximo Pass A
    // (latência). Agora cria inline.
    let propostasCriadas = 0;
    if (decisao === "aguardando_voce" && REGRAS_AUTO_ACAO[ultimaOc] != null) {
      try {
        const cardAtual = card as Record<string, unknown>;
        const agentStateAtual = (cardAtual["agent_state"] ?? {}) as Record<string, unknown>;
        propostasCriadas = await proporAutoAcaoSeAplicavel(supabase, {
          cardId,
          cardNf: (cardAtual["nf"] as string | null) ?? null,
          cardCtrc: (cardAtual["ctrc"] as string | null) ?? null,
          codUltimaOc: ultimaOc,
          agentState: agentStateAtual,
          cardState: stateNovo,
          cardLock: update.lock_aguardando_validacao === true,
          actorId: "atualizar-card-via-portal-ssw",
        }) ?? 0;
      } catch (e) {
        console.warn(`proporAutoAcao falhou (não bloqueia ATUALIZAR AGORA): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AtualizadoViaPortalSsw",
      actor_type: "system",
      actor_id: "atualizar-card-via-portal-ssw",
      payload: {
        oc_anterior: ocAnterior,
        oc_atual: ultimaOc,
        state_anterior: stateAnterior,
        state_novo: stateNovo,
        decisao,
        propostas_criadas: propostasCriadas,
        sem_regra: (update.aviso_alteracao_oc as Record<string, unknown> | null)?.["sem_regra"] === true,
      },
    });

    return json({
      ok: true,
      decisao,
      oc_portal: ultimaOc,
      state_anterior: stateAnterior,
      state_novo: stateNovo,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("atualizar-card-via-portal-ssw fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
