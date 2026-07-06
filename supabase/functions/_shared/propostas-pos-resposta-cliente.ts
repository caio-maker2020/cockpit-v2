// =============================================================================
// propostas-pos-resposta-cliente — fonte ÚNICA das propostas que o operador vê
// quando o cliente responde uma tratativa (oc=54 → CLIENTE RESPONDEU).
//
// Caio 2026-06-23 (NF 761583, INV-016): extraído do vinculador/index.ts pra
// virar módulo compartilhado. ANTES a criação de propostas vivia SÓ dentro do
// vinculador, que fica ATRÁS do triador (classificação via LLM). Quando a
// Anthropic estourou 529, o triador jogou a mensagem do cliente no dead_letter
// → vinculador nunca rodou → 0 propostas. O scan-email-pre-card já tinha setado
// `cliente_respondeu_em` + o cron `cron-ia-resposta-pendentes` já tinha gravado
// `ia_sugestao_oc_resposta` → card ficou "cliente respondeu, IA sugeriu oc 44,
// ZERO botões pra aprovar". Regra inviolável violada: cliente respondeu e o
// operador não viu a ação no Cockpit.
//
// Agora a criação de propostas é DETERMINÍSTICA (sem LLM) e chamada por:
//   - vinculador (caminho normal, pós-classificação)
//   - scan-email-pre-card (adoção de thread pré-existente — DIRETO, sem depender
//     do re-enqueue→triador)
//   - cron-ia-resposta-pendentes (rede de segurança: garante propostas pra
//     qualquer card com cliente_respondeu_em != null e 0 todos pendentes)
//
// Idempotente: rodar N vezes não duplica (whitelist por codigo_ssw + tipo_acao).
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  classificarOc33,
  decidirGateOc33,
  dossieVazio,
  lerExtravioParcial,
} from "./extravio-parcial-dossie.ts";

// Aceita qualquer instanciação de client (vinculador, scan-email-pre-card,
// cron-ia-resposta-pendentes passam clients com generics diferentes). <any> evita
// o erro "Type 'public' is not assignable to type 'never'" do schema tipado.
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export interface PropostasInfo {
  cancelados: number;
  criados: Array<{ codigo_ssw: number; tipo_acao?: string; todoId: string }>;
  ja_existentes: number[];
  /** Caio 2026-05-12: tipos especiais (relancamento_54, combo_33_44) que
   * idempotência detecta separado do codigo_ssw. Sem isso, combo_33_44 (que
   * tem codigo_ssw=33 igual ao 33-solo) duplica. */
  ja_existentes_tipos: string[];
}

/**
 * Quando cliente responde em card AGUARDANDO_CLIENTE, atualiza o conjunto
 * de propostas pendentes pra: [21, 44, 55, 56, 54-relançar, 33-combo, 33-solo].
 *
 * - Mantém 21 que já existe (regra oc=54 cria 21+55)
 * - Mantém 55 (Caio 2026-06-03 NF 66193 LARISSA INOVAMED: cliente respondeu
 *   autorizando entrega parcial; IA sugeriu 55 mas proposta não existia).
 *   Faz sentido pra TODO card pós-resposta cliente: cliente pode autorizar
 *   seguir parcial após notificação inicial via oc=54.
 * - Cria 44 (retorno carga → Devolução), 56 (falta info → Operação),
 *   54-relançar (re-aguardar cliente, sem email), combo 33+44, oc=33 solo
 *
 * Idempotente: se rodar 2x, não duplica.
 */
export async function atualizarPropostasAposRespostaCliente(
  supabase: SupabaseClient,
  cardId: string,
): Promise<PropostasInfo> {
  const info: PropostasInfo = { cancelados: 0, criados: [], ja_existentes: [], ja_existentes_tipos: [] };

  // 1. Carrega card (nf, ctrc, agent_state pra chave_cte/cnpj)
  // Caio 2026-05-11: ctrc preferencial pro lookup_chave_cte priorizar CT-e normal
  const { data: card } = await supabase
    .from("cards")
    .select("nf, ctrc, agent_state")
    .eq("id", cardId)
    .single();
  if (!card) return info;

  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  // Gate da oc 33 no extravio parcial (Caio 2026-07-01, NF 66193): anota cada
  // proposta de oc 33 com a natureza (operacional/completude) + se está
  // bloqueada pelo dossiê incompleto. NÃO remove a proposta (modo AVISADO — o
  // front desabilita e mostra "faltam X"). Card não-parcial → ehParcial=false →
  // nada muda (extravio total intacto). Enforce real fica no executor.
  const estadoParcial = lerExtravioParcial({ agent_state: agentState });
  const ehParcial = estadoParcial !== null;
  const casoParcial = estadoParcial?.caso ?? null;
  const dossieParcial = estadoParcial?.dossie ?? dossieVazio();
  const oc33Bloqueadas: Array<{ natureza: string; faltando: string[]; tipo_acao?: string }> = [];
  const nf = card.nf as string | null;
  const ctrcCard = (card.ctrc as string | null) ?? null;
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador ?? null;
  let chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  if (!chaveCTe && nf) {
    const { data: lookup } = await supabase.rpc("lookup_chave_cte", {
      p_nf: nf,
      p_cnpj_pagador: cnpjPagador,
      p_ctrc: ctrcCard,
    });
    const row = Array.isArray(lookup) ? lookup[0] : null;
    if (row && typeof row.chave_cte === "string") {
      chaveCTe = row.chave_cte;
    }
  }

  // 2. Carrega todos pendentes existentes
  const { data: pendentes } = await supabase
    .from("todos")
    .select("id, proposta_payload")
    .eq("card_id", cardId)
    .eq("status", "pendente");

  // Whitelist de propostas que devem permanecer (codigo_ssw, isRelancamento54)
  // 21 (reentrega), 44 (retorno carga), 56 (falta info), 54-relançar
  const idsObsoletos: string[] = [];
  for (const t of (pendentes ?? []) as Array<Record<string, unknown>>) {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"] as number | undefined;
    // Caio 2026-06-12 (NF 2043438): `tipo` vem de meta.tipo_acao, MAS geradores
    // diferentes (regras-auto-acao) criam 33-solo/combo SEM meta.tipo_acao.
    // Sem derivar do `tool`, a whitelist não reconhecia o 33-solo do
    // regras-auto-acao → cancelava como obsoleta → operador sem botão p/ oc=33
    // em extravio total. Fallback pelo tool fecha a dessincronia entre geradores.
    const toolDoTodo = payload?.["tool"] as string | undefined;
    const tipo = (meta?.["tipo_acao"] as string | undefined)
      ?? (toolDoTodo === "lancar_oc33_solo_portal" ? "oc33_solo"
        : toolDoTodo === "lancar_combo_33_44" ? "combo_33_44"
        : undefined);

    const ehDaListaNova =
      cod === 21 ||
      cod === 44 ||
      // Caio 2026-06-03 (NF 66193 LARISSA INOVAMED): 55 (autorizar entrega
      // parcial) é resposta legítima a oc=54 — cliente pode autorizar seguir
      // com o parcial após notificação. Antes era cancelada como "obsoleta".
      cod === 55 ||
      cod === 56 ||
      (cod === 54 && tipo === "relancamento_54") ||
      (cod === 33 && tipo === "combo_33_44") ||
      (cod === 33 && tipo === "oc33_solo");

    if (ehDaListaNova) {
      if (typeof cod === "number") info.ja_existentes.push(cod);
      if (tipo) info.ja_existentes_tipos.push(tipo);
    } else {
      idsObsoletos.push(t["id"] as string);
    }
  }

  // 3. Cancela obsoletos
  if (idsObsoletos.length > 0) {
    const { error } = await supabase
      .from("todos")
      .update({
        status: "cancelado",
        rejection_reason: "proposta obsoleta após resposta do cliente",
      })
      .in("id", idsObsoletos);
    if (!error) info.cancelados = idsObsoletos.length;
  }

  // 4. Cria os que faltam
  // Caio 2026-06-12 (NF 2043438): NÃO exigir chave_cte aqui. A migração
  // portal-101 (2026-06-09) eliminou chave_cte — o lançamento usa card.ctrc.
  // O guard antigo `!chaveCTe` fazia a função CANCELAR as obsoletas e retornar
  // sem recriar nada (chave_cte é null pra todo card agora) → propostas como
  // oc=33 solo sumiam e nunca voltavam. chave_cte segue indo nos args (null),
  // inofensivo — o executor portal-101 ignora.
  if (!nf) {
    return info;
  }

  type NovaProposta = {
    codigo_ssw: number;
    descricao_todo: string;
    descricao_acao: string;
    tipo_acao?: "relancamento_54" | "combo_33_44" | "oc33_solo";
    tool?: "lancar_ocorrencia" | "lancar_combo_33_44" | "lancar_oc33_solo_portal";
  };

  const novas: NovaProposta[] = [
    // Caio 2026-05-25 (NF 574248): cliente respondeu confirmando reentrega
    // (novo endereço). IA sugeriu oc_sugerida=21, mas a proposta original 21
    // tinha sido cancelada quando operador aprovou oc=54 pra perguntar.
    // Sem essa entrada, Larissa fica sem botão pra aprovar a reentrega que
    // o cliente acabou de autorizar.
    {
      codigo_ssw: 21,
      descricao_todo: "Lançar oc 21 no SSW — reentrega autorizada pelo cliente",
      descricao_acao: "Reentrega solicitada pelo cliente (resposta à tratativa)",
    },
    {
      codigo_ssw: 44,
      descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
      descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
    },
    // Caio 2026-06-03 (NF 66193 LARISSA INOVAMED): cliente respondeu
    // autorizando seguir entrega parcial; IA sugeriu oc=55 corretamente.
    // Sem esta entrada, proposta não era recriada se foi cancelada antes,
    // e operadora não tinha botão pra executar a autorização do cliente.
    {
      codigo_ssw: 55,
      descricao_todo: "Lançar oc 55 no SSW — autorizar entrega parcial (cliente liberou)",
      descricao_acao: "Cliente autorizou seguir com a entrega parcial dos volumes localizados",
    },
    {
      codigo_ssw: 56,
      descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
      descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
    },
    {
      codigo_ssw: 54,
      descricao_todo: "Re-lançar oc 54 no SSW — re-aguardar cliente (sem email)",
      descricao_acao: "Re-aguardar cliente — resposta inconclusiva ou nova solicitação",
      tipo_acao: "relancamento_54",
    },
    // Caio 2026-05-12: 6ª opção combo 33+44 (ressarcimento). Sempre criada
    // entre as propostas pós-resposta cliente; IA pode destacar quando
    // detecta padrão de ressarcimento (sugere_combo_33_44=true). Larissa
    // fornece via modal: texto_descricao + anexo_id pra oc=33, e
    // volumes/motivo/filial pra oc=44.
    {
      codigo_ssw: 33,
      descricao_todo: "Lançar oc 33 + oc 44 (Ressarcimento) — combo sequencial",
      descricao_acao: "Reversão de perdas (33) + Retorno de carga (44). Sinaliza tratativa de indenização pro time de Perdas com romaneio anexo, e em seguida autoriza devolução.",
      tipo_acao: "combo_33_44",
      tool: "lancar_combo_33_44",
    },
    // Caio 2026-05-12: 7ª opção — oc=33 SOLO (sem 44 em seguida). Quando o
    // cliente não autoriza devolução mas ainda assim cabe iniciar indenização
    // (ex: cliente vai retirar volume; mas Perdas precisa iniciar processo).
    // Mesma estrutura do combo (texto + N imagens via portal interno SSW),
    // só não encadeia oc=44.
    {
      codigo_ssw: 33,
      descricao_todo: "Lançar oc 33 no SSW — reversão de perdas (com romaneio, sem 44)",
      descricao_acao: "Reversão de perdas / início indenização. Anexa romaneio + texto. Não encadeia oc=44.",
      tipo_acao: "oc33_solo",
      tool: "lancar_oc33_solo_portal",
    },
  ];

  for (const p of novas) {
    // Idempotência: relancamento_54 e combo_33_44 são identificados pelo
    // tipo_acao (não pelo codigo_ssw — pode haver vários todos cod=33 ou 44
    // como ações solo). Outras propostas usam codigo_ssw + tipo_acao indef.
    const jaExisteSimples =
      p.tipo_acao == null && info.ja_existentes.includes(p.codigo_ssw);
    const jaExisteTipado =
      p.tipo_acao != null && info.ja_existentes_tipos.includes(p.tipo_acao);
    if (jaExisteSimples || jaExisteTipado) continue;

    const propostaArgs: Record<string, unknown> = {
      codigo_ssw: p.codigo_ssw,
      nf,
      chave_cte: chaveCTe,
      cnpj_remetente: cnpjRemetente,
      descricao: p.descricao_acao,
    };

    const propostaMeta: Record<string, unknown> = {
      tinha_intencao_email: false,
      modo: "sem_email",
      origem: "vinculador_pos_resposta_cliente",
    };
    if (p.tipo_acao) propostaMeta["tipo_acao"] = p.tipo_acao;

    // Gate da oc 33 (extravio parcial): anota natureza + bloqueio pro front. O
    // executor faz o enforce autoritativo lendo o dossiê vivo na hora de lançar.
    if (ehParcial) {
      const natureza = classificarOc33({ codigo_ssw: p.codigo_ssw, tipo_acao: p.tipo_acao, tool: p.tool }, casoParcial);
      if (natureza) {
        const g = decidirGateOc33(natureza, dossieParcial);
        propostaMeta["gate_oc33"] = { natureza, bloqueada: g.bloqueada, faltando: g.faltando };
        if (g.bloqueada) oc33Bloqueadas.push({ natureza, faltando: g.faltando, tipo_acao: p.tipo_acao });
      }
    }

    const { data: newTodo, error } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        descricao: p.descricao_todo,
        status: "pendente",
        proposta_payload: {
          tool: p.tool ?? "lancar_ocorrencia",
          args: propostaArgs,
          rationale: "Pós-resposta cliente em card AGUARDANDO_CLIENTE — opção operacional/encaminhamento.",
          texto: null,
          meta: propostaMeta,
        },
      })
      .select("id")
      .single();

    if (!error && newTodo) {
      const entry: { codigo_ssw: number; tipo_acao?: string; todoId: string } = {
        codigo_ssw: p.codigo_ssw,
        todoId: newTodo.id as string,
      };
      if (p.tipo_acao) entry.tipo_acao = p.tipo_acao;
      info.criados.push(entry);
    }
  }

  // Telemetria do gate (baseline p/ decidir ligar o enforce). Só quando há oc 33
  // bloqueada por dossiê incompleto num card de extravio parcial.
  if (oc33Bloqueadas.length > 0) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "Oc33BloqueadaDossieIncompleto",
      actor_type: "agent",
      actor_id: "propostas-pos-resposta-cliente",
      payload: { origem: "propostas_pos_resposta", bloqueadas: oc33Bloqueadas },
    });
  }

  return info;
}
