// =============================================================================
// devolucao-cte-acionar.ts — liga o detector ao resto do fluxo.
//
// Chamado logo depois de o anexo inbound ser SALVO (não na chegada da
// mensagem). Por quê: no caso Ícaro real — thread NOVA iniciada pelo cliente com
// 1 mensagem só — o anexo é persistido DEPOIS do gancho que criaria a proposta
// (`gmail-poll-inbox`: enqueue na linha ~1115 vs. INSERT do anexo na ~1218).
// Disparar por mensagem perderia o caso. É o risco R2 do plano.
//
// INV-131: mora em `_shared/` e NÃO olha `cards.state` de propósito. A oc 56
// (pedido de NFD pra unidade) manda o card pra TRANSFERIDO, a espera dura
// semanas, e o CT-e pode chegar nesse meio-tempo. Um acionamento que exigisse
// card ativo engoliria o documento em silêncio.
//
// CUSTO QUANDO A FEATURE ESTÁ DESLIGADA: uma leitura de `feature_flags` e sai.
// A ordem das checagens é essa de propósito — enquanto os degraus 3/4 não
// subirem, isto é praticamente de graça.
//
// NUNCA DERRUBA O CHAMADOR: o caminho crítico aqui é a captura de e-mail do
// cliente. Qualquer erro é engolido, registrado e devolvido como "nada".
// =============================================================================
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { detectarCteDevolucao } from "./devolucao-cte-detector.ts";
import {
  type AcaoProposta,
  decidirAcaoProposta,
  descricaoTodo44Cte,
  montarPropostaPayload44,
} from "./devolucao-cte-proposta.ts";
import { CODIGO_SSW_44, TOOL_44_DEVOLUCAO_CTE } from "./devolucao-cte-44.ts";

/** Quantas mensagens anteriores do card entram como contexto do nível B. */
const MAX_MENSAGENS_ANTERIORES = 40;

export interface AnexoSalvo {
  id: string;
  filename: string;
  mime: string;
}

export interface ResultadoAcionamento {
  acao: AcaoProposta;
  motivo: string;
  /** ID do ciclo, quando abriu. */
  cicloId?: string;
  /** ID do todo criado, quando propôs. */
  todoId?: string;
}

const NADA = (motivo: string): ResultadoAcionamento => ({ acao: "nada", motivo });

function ehPdf(a: AnexoSalvo): boolean {
  return (a.mime ?? "").toLowerCase() === "application/pdf" ||
    (a.filename ?? "").toLowerCase().endsWith(".pdf");
}

export async function acionarDeteccaoCteDevolucao(params: {
  supabase: SupabaseClient;
  cardId: string;
  remetente: string | null;
  assunto: string | null;
  corpo: string;
  anexosSalvos: AnexoSalvo[];
  /** ID da mensagem inbound recém-salva — excluída do contexto "anterior". */
  messageInboxId?: string | null;
}): Promise<ResultadoAcionamento> {
  const { supabase, cardId, remetente, assunto, corpo, anexosSalvos } = params;
  try {
    // (0) Sem PDF novo não há o que detectar. Saída mais barata possível.
    if (!(anexosSalvos ?? []).some(ehPdf)) return NADA("sem_pdf_novo");

    // (1) Flags ANTES de qualquer outra leitura — é o que mantém isto de graça
    // enquanto os degraus 3 e 4 não subirem.
    const { data: flags } = await supabase
      .from("feature_flags")
      .select("key, enabled")
      .in("key", ["devolucao_cte_shadow", "devolucao_cte_maria_enabled"]);
    const mapa = new Map(
      ((flags ?? []) as Array<{ key: string; enabled: boolean }>).map((f) => [f.key, f.enabled]),
    );
    const flagShadow = mapa.get("devolucao_cte_shadow") === true;
    const flagEnabled = mapa.get("devolucao_cte_maria_enabled") === true;
    if (!flagShadow && !flagEnabled) return NADA("flags_desligadas");

    // (2) Card. `state` NÃO é lido de propósito (INV-131).
    const { data: card } = await supabase
      .from("cards")
      .select("id, nf, ctrc, agent_state, qtde_volumes, assigned_operator_id")
      .eq("id", cardId)
      .maybeSingle();
    if (!card) return NADA("card_nao_encontrado");
    const nf = (card.nf as string | null) ?? null;
    const ctrc = (card.ctrc as string | null) ?? null;
    if (!nf || !ctrc) return NADA("card_sem_nf_ou_ctrc");

    const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
    const cnpjPagadorRaw = (agentState["cnpj_pagador"] as string | null) ?? null;

    // (3) Escopo pela carteira, avaliado NO BANCO (fonte única — mig 373).
    // Pagador nulo ⇒ false ⇒ nada acontece. É o R17.
    const { data: emEscopoRaw, error: escopoErr } = await supabase
      .rpc("devolucao_cte_em_escopo", { p_cnpj_pagador: cnpjPagadorRaw });
    if (escopoErr) return NADA(`escopo_indisponivel:${escopoErr.message.slice(0, 80)}`);
    if (emEscopoRaw !== true) return NADA("fora_do_escopo");

    // (4) Contexto da conversa pro nível B: mensagens ANTERIORES do card.
    const { data: anteriores } = await supabase
      .from("messages_inbox")
      .select("id, conteudo, recebido_em")
      .eq("card_id", cardId)
      .order("recebido_em", { ascending: true })
      .limit(MAX_MENSAGENS_ANTERIORES);
    const corposAnteriores = ((anteriores ?? []) as Array<{ id: string; conteudo: string | null }>)
      .filter((r) => r.id !== params.messageInboxId)
      .map((r) => r.conteudo ?? "")
      .filter((c) => c.trim().length > 0);

    // (5) O detector.
    const det = detectarCteDevolucao(
      {
        corpo,
        assunto,
        remetente,
        anexos: anexosSalvos.map((a) => ({ filename: a.filename, mimeType: a.mime })),
      },
      corposAnteriores,
    );

    // (6) Idempotência: proposta ativa e ciclo já com CT-e.
    const { data: todosAtivos } = await supabase
      .from("todos")
      .select("id, status, proposta_payload")
      .eq("card_id", cardId)
      .in("status", ["pendente", "aprovado"]);
    const jaExisteTodoAtivo = ((todosAtivos ?? []) as Array<{ proposta_payload: unknown }>)
      .some((t) =>
        (t.proposta_payload as { tool?: string } | null)?.tool === TOOL_44_DEVOLUCAO_CTE
      );

    const { data: ciclos } = await supabase
      .from("devolucoes_cte")
      .select("id, cte_anexo_id")
      .eq("nf", nf)
      .eq("ctrc_origem", ctrc)
      .is("encerrado_em", null)
      .limit(1);
    const cicloExistente = ((ciclos ?? []) as Array<{ id: string; cte_anexo_id: string | null }>)[0];
    const cicloJaTemCte = cicloExistente?.cte_anexo_id != null;

    // (7) A decisão (pura, testada em todas as combinações).
    const decisao = decidirAcaoProposta({
      nivel: det.nivel,
      emEscopo: true,
      flagShadow,
      flagEnabled,
      jaExisteTodoAtivo,
      cicloJaTemCte,
    });

    // (8) Registro SEMPRE — inclusive "nada". É o que permite conferir falsos
    // positivos no degrau 3 sem tocar em card nenhum.
    const idxAnexo = det.idxAnexo;
    const anexoEscolhido = idxAnexo != null ? anexosSalvos[idxAnexo] : undefined;
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "DevolucaoCteDetectada",
      actor_type: "agent",
      actor_id: "devolucao-cte-detector",
      payload: {
        acao: decisao.acao,
        motivo: decisao.motivo,
        nivel: det.nivel,
        motivos_detector: det.motivos,
        sinais_nome: det.sinaisNome,
        anexo_escolhido_id: anexoEscolhido?.id ?? null,
        anexo_escolhido_nome: anexoEscolhido?.filename ?? null,
        anexos_novos: anexosSalvos.map((a) => a.filename),
        flag_shadow: flagShadow,
        flag_enabled: flagEnabled,
      },
    });

    if (decisao.acao !== "propor") {
      return { acao: decisao.acao, motivo: decisao.motivo, cicloId: cicloExistente?.id };
    }

    // (9) Só aqui há efeito. Sem anexo escolhido não se propõe: ambíguo é a
    // operadora que resolve, nunca adivinhação (`escolherAnexoCte` devolve null
    // de propósito quando há mais de um candidato).
    if (!anexoEscolhido) {
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "DevolucaoCteAnexoAmbiguo",
        actor_type: "agent",
        actor_id: "devolucao-cte-detector",
        payload: { anexos: anexosSalvos.map((a) => a.filename), sinais: det.sinaisNome },
      });
      return NADA("anexo_ambiguo_operadora_decide");
    }

    const cnpjPagador = (cnpjPagadorRaw ?? "").replace(/\D/g, "").padStart(14, "0");
    const { data: ciclo, error: cicloErr } = await supabase
      .from("devolucoes_cte")
      .upsert(
        {
          nf,
          ctrc_origem: ctrc,
          cnpj_pagador: cnpjPagador,
          card_id: cardId,
          operador_id: (card.assigned_operator_id as string | null) ?? null,
          status: "pronto_para_44",
          cte_detectado_nivel: det.nivel,
          cte_recebido_em: new Date().toISOString(),
          cte_anexo_id: anexoEscolhido.id,
        },
        { onConflict: "nf,ctrc_origem" },
      )
      .select("id")
      .single();
    if (cicloErr || !ciclo) {
      return NADA(`ciclo_nao_criado:${cicloErr?.message.slice(0, 120) ?? "sem_retorno"}`);
    }
    const cicloId = (ciclo as { id: string }).id;

    const payload = montarPropostaPayload44({
      cicloId,
      nf,
      nomeArquivoCte: anexoEscolhido.filename,
      quantidadeVolumes: (card.qtde_volumes as number | null) ?? null,
      sinaisNome: det.sinaisNome,
    });

    const { data: todo, error: todoErr } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        descricao: descricaoTodo44Cte(anexoEscolhido.filename),
        status: "pendente",
        proposta_payload: payload,
      })
      .select("id")
      .single();
    if (todoErr || !todo) {
      // Ciclo criado e proposta não: registra pra não ficar silencioso. O ciclo
      // é idempotente pelo UNIQUE, então a próxima passada tenta de novo.
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "DevolucaoCtePropostaFalhou",
        actor_type: "agent",
        actor_id: "devolucao-cte-detector",
        payload: { devolucao_cte_id: cicloId, erro: todoErr?.message.slice(0, 200) ?? null },
      });
      return { acao: "nada", motivo: "proposta_nao_criada", cicloId };
    }

    const todoId = (todo as { id: string }).id;
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "DevolucaoCtePropostaCriada",
      actor_type: "agent",
      actor_id: "devolucao-cte-detector",
      payload: {
        devolucao_cte_id: cicloId,
        todo_id: todoId,
        codigo_ssw: CODIGO_SSW_44,
        cte_anexo_id: anexoEscolhido.id,
        cte_anexo_nome: anexoEscolhido.filename,
      },
    });

    return { acao: "propor", motivo: decisao.motivo, cicloId, todoId };
  } catch (e) {
    // O caminho crítico do chamador é a captura de e-mail do cliente. Um erro
    // aqui NUNCA pode derrubá-la.
    try {
      await params.supabase.from("card_events").insert({
        card_id: params.cardId,
        event_type: "DevolucaoCteAcionamentoFalhou",
        actor_type: "agent",
        actor_id: "devolucao-cte-detector",
        payload: { erro: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) },
      });
    } catch { /* nada a fazer */ }
    return NADA("erro_engolido");
  }
}
