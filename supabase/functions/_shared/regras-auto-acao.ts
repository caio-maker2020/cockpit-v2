// =============================================================================
// regras-auto-acao — catálogo de regras "oc atual → ação proposta" + função
// que cria todos automaticamente em um card. Reusado por:
//
//   - sync-bastao (Pass A): card vindo do Bastão
//   - vinculador (case ssw_tracking): card vindo do SSW Tracking (incompleto)
//
// Mover esse bloco pra _shared evita duplicação e garante que vinculador e
// sync-bastao apliquem exatamente as mesmas regras quando criarem cards.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface PropostaRegra {
  codigo_ssw_proposto: number;
  descricao_todo: string;
  descricao_acao: string;
  /** Se preenchido, executor dispara email com template_id após lançar a oc. */
  enviar_email_template?: string;
}

export interface RegraAutoAcao {
  /** 1+ propostas a serem criadas como todos pendentes. */
  propostas: PropostaRegra[];
  rationale: string;
  /**
   * Se true: NÃO move card pra AGUARDANDO_VALIDACAO_HUMANA + lock.
   * Card mantém state atual (ex: oc=54 fica em AGUARDANDO_CLIENTE com 2
   * todos pendentes — operadora pode aprovar a qualquer momento, mesmo
   * antes do cliente responder).
   */
  manter_state?: boolean;
}

export const REGRAS_AUTO_ACAO: Record<number, RegraAutoAcao> = {
  20: {
    propostas: [{
      codigo_ssw_proposto: 55,
      descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
      descricao_acao: "Autorização para seguir entrega — extravio localizado",
    }],
    rationale: "Padrão 2026-04-30: oc=20 (extravio localizado) → próximo passo é oc 55 (autorizar seguir entrega)",
  },
  10: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — recusa total",
        descricao_acao: "Aguardando retorno do cliente pagador",
        enviar_email_template: "RECUSA_TOTAL",
      },
      {
        codigo_ssw_proposto: 44,
        descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
        descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão 2026-05-04: oc=10 (recusa total) → 4 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 44 retorno carga (Devolução); (d) 56 falta info (Operação).",
  },
  11: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — tratativa endereço",
        descricao_acao: "Aguardando retorno do cliente pagador",
        enviar_email_template: "PROBLEMAS_COM_ENDERECO",
      },
      {
        codigo_ssw_proposto: 44,
        descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
        descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão 2026-05-04: oc=11 (problemas com endereço) → 4 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 44 retorno carga; (d) 56 falta info.",
  },
  35: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — tratativa recusa parcial",
        descricao_acao: "Aguardando retorno do cliente pagador",
        enviar_email_template: "RECUSA_PARCIAL",
      },
      {
        codigo_ssw_proposto: 44,
        descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
        descricao_acao: "Cliente autorizou devolução parcial — encaminha pro setor de Devolução",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão 2026-05-04: oc=35 (recusa parcial) → 4 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 44 retorno carga; (d) 56 falta info.",
  },
  49: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — tratativa relacionamento",
        descricao_acao: "Aguardando retorno do cliente pagador",
        enviar_email_template: "FALTA_DE_VOLUME",
      },
      {
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Autorização pra seguir entrega",
      },
      {
        codigo_ssw_proposto: 44,
        descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
        descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
      },
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Lançar oc 33 no SSW — reversão de perdas iniciada",
        descricao_acao: "Reversão de perdas iniciada — encaminha pra Perdas",
      },
      {
        codigo_ssw_proposto: 41,
        descricao_todo: "Lançar oc 41 no SSW — informação complementar (texto livre)",
        descricao_acao: "Informação complementar — Larissa preenche texto antes de aprovar",
      },
    ],
    rationale: "Padrão 2026-05-07: oc=49 (tratativa relacionamento) → 7 caminhos: (a) reentrega (21); (b) lançar 54 + email FALTA_DE_VOLUME; (c) 55 autorizar entrega; (d) 44 retorno carga; (e) 56 falta info; (f) 33 reversão de perdas; (g) 41 informação complementar com texto livre.",
  },
  54: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente",
      },
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Lançar oc 33 no SSW — reversão de perdas iniciada",
        descricao_acao: "Reversão de perdas iniciada",
      },
      {
        codigo_ssw_proposto: 44,
        descricao_todo: "Lançar oc 44 no SSW — retorno de carga (encaminhar p/ Devolução)",
        descricao_acao: "Cliente autorizou devolução — encaminha pro setor de Devolução",
      },
      {
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Autorização para seguir entrega",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão 2026-05-05: card em oc=54 (aguardando cliente) recebe 5 opções fixas — reentrega (21), reversão de perdas (33), retorno carga/devolução (44), autorizar entrega (55), falta info (56). Larissa aprova quando cliente decidir (por email automático, WhatsApp ou qualquer canal externo). manter_state=true — card continua em AGUARDANDO_CLIENTE até operadora agir.",
    manter_state: true,  // continua AGUARDANDO_CLIENTE sem lock
  },
  19: {
    propostas: [
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Lançar oc 33 no SSW — reversão de perdas iniciada (falta de volumes)",
        descricao_acao: "Reversão de perdas iniciada — encaminha pra Perdas",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — tratativa falta de volumes",
        descricao_acao: "Aguardando retorno do cliente pagador",
        enviar_email_template: "FALTA_DE_VOLUME",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Falta info operacional / evidência incompleta — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão Caio 2026-05-13: oc=19 (entrega realizada com falta de volumes) → 3 caminhos: (a) 33 reversão de perdas (caso de extravio confirmado dos volumes faltantes); (b) 54 + email FALTA_DE_VOLUME (consulta o cliente antes de decidir); (c) 56 falta info (devolve pra Operação se evidência da entrega parcial está incompleta). Padrão equivalente a oc=49 mas reduzido aos 3 caminhos aplicáveis ao caso 'cliente recebeu faltando volume'.",
  },
};

export interface ProporAutoAcaoArgs {
  cardId: string;
  cardNf: string | null;
  /** Caio 2026-05-11: CTRC original do card. Usado no lookup_chave_cte
   *  pra priorizar CT-e normal (ignora reentrega/complementar). */
  cardCtrc?: string | null;
  codUltimaOc: number | null;
  agentState: Record<string, unknown>;
  cardState: string;
  cardLock: boolean;
  /** quem está chamando — vai pro card_event.actor_id. Default: "sync-bastao". */
  actorId?: string;
}

/**
 * Cria todos automáticos quando a oc atual tem regra mapeada em REGRAS_AUTO_ACAO.
 * Move card pra AGUARDANDO_VALIDACAO_HUMANA + lock=true (exceto manter_state=true).
 * Idempotente — não cria 2º todo da mesma proposta.
 *
 * Falha graciosamente: se não acha chave_cte, registra evento e segue.
 */
export async function proporAutoAcaoSeAplicavel(
  supabase: SupabaseClient,
  args: ProporAutoAcaoArgs,
): Promise<void> {
  const { cardId, cardNf, cardCtrc, codUltimaOc, agentState, cardState, cardLock } = args;
  const actorId = args.actorId ?? "sync-bastao";

  if (codUltimaOc == null) return;
  const regra = REGRAS_AUTO_ACAO[codUltimaOc];
  if (!regra) return;
  if (!cardNf) return;

  // Caio 2026-05-13 (plano "hoje-usamos-o-bastao"): cooldown POR OC de 10min
  // após operadora clicar em RECUSAR AÇÕES SUGERIDAS em
  // voltar-para-to-do-com-rastreio. Defesa contra loop: Larissa recusa
  // propostas em oc=10, Bastão ainda mostra oc=10 por latência RPA, sync
  // chamava aqui e re-criava as 4 propostas → AVH+lock de volta. Com o par
  // (propostas_recusadas_em, propostas_recusadas_para_oc) setado no
  // agent_state, sync respeita a recusa por 10min — MAS só pra mesma oc.
  // Se a oc mudar (de 10 pra 49, p.ex.), o cooldown não dispara e propostas
  // novas aparecem normalmente. Janela cobre latência típica RPA Bastão.
  // Quando voltar-para-to-do-com-rastreio precisa LEGITIMAMENTE recriar
  // propostas pra oc nova (decidiu via SSW interno), ele remove ambos os
  // campos via stripCooldown antes de chamar esta função.
  const propostasRecusadasEm = agentState["propostas_recusadas_em"] as string | undefined;
  const propostasRecusadasParaOc = agentState["propostas_recusadas_para_oc"] as number | undefined;
  if (
    typeof propostasRecusadasEm === "string" &&
    typeof propostasRecusadasParaOc === "number" &&
    propostasRecusadasParaOc === codUltimaOc
  ) {
    const ageMs = Date.now() - new Date(propostasRecusadasEm).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10 * 60_000) {
      return;
    }
  }

  const isAdicaoIncremental = cardState === "AGUARDANDO_VALIDACAO_HUMANA";

  if (regra.manter_state) {
    if (cardState !== "AGUARDANDO_CLIENTE") return;
    if (cardLock) return;
  } else if (isAdicaoIncremental) {
    // OK
  } else {
    if (cardState !== "AGUARDANDO_AGENTE") return;
    if (cardLock) return;
  }

  // Idempotência: só bloqueia recriação se já existe todo ATIVO (pendente ou
  // aprovado aguardando executor pegar). Status terminais (executado,
  // executando, falhou, expirado, cancelado, rejeitado) viram histórico —
  // permitem recriação.
  //
  // Regra Caio 2026-05-06: oc=54 (entre outras) pode ser lançada várias vezes
  // sem problema. Quando card transita TRANSFERIDO → volta pra
  // AGUARDANDO_AGENTE (cliente recolocou), as 4 opções da regra devem
  // aparecer DE NOVO mesmo que tenham sido executadas no ciclo anterior.
  // Caso real: NF 2148226 ficou só com 21/44/56 porque o todo antigo de 54
  // estava em status `executando` — agora libera.
  const STATUS_ATIVOS = new Set(["pendente", "aprovado"]);
  const { data: existingTodos } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", cardId);

  const codigosJaPropostos = new Set<number>();
  for (const t of (existingTodos ?? []) as Array<Record<string, unknown>>) {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"];
    const status = t["status"] as string | undefined;
    if (typeof cod === "number" && status && STATUS_ATIVOS.has(status)) {
      codigosJaPropostos.add(cod);
    }
  }

  const propostasPendentes = regra.propostas.filter(
    (p) => !codigosJaPropostos.has(p.codigo_ssw_proposto),
  );
  if (propostasPendentes.length === 0) {
    // Caio 2026-05-07: card em AGUARDANDO_AGENTE com propostas ativas pré-
    // existentes deve estar em AGUARDANDO_VALIDACAO_HUMANA + lock pra Larissa
    // decidir. Caso real (NFs 422589, 62862, 1002836, 11233, 691367 etc):
    // após reverter_acao_falhou ou ciclo TRANSFERIDO→AGUARDANDO_AGENTE,
    // propostas continuam ativas mas state ficou AGUARDANDO_AGENTE
    // (= "PARA FAZER" no front), confundindo Larissa que esperaria ver na
    // aba "AGUARDANDO VOCÊ".
    if (
      !regra.manter_state &&
      cardState === "AGUARDANDO_AGENTE" &&
      !cardLock &&
      codigosJaPropostos.size > 0
    ) {
      const { error: updErr } = await supabase
        .from("cards")
        .update({
          state: "AGUARDANDO_VALIDACAO_HUMANA",
          lock_aguardando_validacao: true,
        })
        .eq("id", cardId);
      if (!updErr) {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "LockAjustadoPropostasExistentes",
          actor_type: "system",
          actor_id: actorId,
          payload: {
            regra: `oc=${codUltimaOc}`,
            propostas_existentes: [...codigosJaPropostos],
            motivo:
              "Card em AGUARDANDO_AGENTE com propostas ativas — força AGUARDANDO_VALIDACAO_HUMANA + lock pra Larissa decidir",
          },
        });
      }
    }
    return;
  }

  const cnpjPagador =
    (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador;
  let chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  if (!chaveCTe) {
    const { data: lookup } = await supabase.rpc("lookup_chave_cte", {
      p_nf: cardNf,
      p_cnpj_pagador: cnpjPagador,
    });
    const row = Array.isArray(lookup) ? lookup[0] : lookup;
    if (row && typeof row.chave_cte === "string") {
      chaveCTe = row.chave_cte;
      await supabase
        .from("cards")
        .update({ agent_state: { ...agentState, chave_cte: chaveCTe } })
        .eq("id", cardId);
    }
  }

  if (!chaveCTe) {
    // Marca flag visual no card pra Larissa investigar caso a caso
    // (RPA OPC 455 não importou, NF é RPS sem chave, etc).
    await supabase
      .from("cards")
      .update({ sem_chave_cte: true })
      .eq("id", cardId);

    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "AutoProposicaoAdiadaSemChaveCTe",
      actor_type: "system",
      actor_id: actorId,
      payload: {
        regra: `oc=${codUltimaOc}`,
        nf: cardNf,
        cnpj_pagador: cnpjPagador,
        motivo: "Chave CT-e não encontrada (agent_state vazio + lookup_chave_cte sem match)",
      },
    });
    return;
  }

  // Achou chave: limpa flag (caso já tivesse sido marcado antes)
  await supabase
    .from("cards")
    .update({ sem_chave_cte: false })
    .eq("id", cardId);

  const todosCriados: Array<{ todoId: string; codigo: number; modoEmail: 'completo' | 'sem_email' }> = [];

  for (const p of propostasPendentes) {
    let emailDestino: string | null = null;
    let templateDisponivel = false;
    let modoSemEmail = false;
    let motivoSemEmail: string | null = null;

    if (p.enviar_email_template) {
      const { data: tpl } = await supabase
        .from("templates_email")
        .select("id, ativo")
        .eq("id", p.enviar_email_template)
        .maybeSingle();

      templateDisponivel = !!tpl && (tpl as Record<string, unknown>)["ativo"] === true;

      if (templateDisponivel && cnpjPagador) {
        const { data: emailRpc } = await supabase.rpc("resolver_email_cobranca_cliente", {
          p_documento_cliente: cnpjPagador,
          p_tipo_uso: "logistico",
        });
        if (typeof emailRpc === "string") emailDestino = emailRpc;
      }

      if (!templateDisponivel) {
        modoSemEmail = true;
        motivoSemEmail = `Template '${p.enviar_email_template}' inativo/inexistente`;
      } else if (!emailDestino) {
        modoSemEmail = true;
        motivoSemEmail = `Cliente ${cnpjPagador ?? '(sem cnpj)'} sem email em contatos_cliente`;
      }

      if (modoSemEmail) {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "AutoProposicaoCriadaSemEmail",
          actor_type: "system",
          actor_id: actorId,
          payload: {
            regra: `oc=${codUltimaOc}→${p.codigo_ssw_proposto}`,
            template_id: p.enviar_email_template,
            documento_cliente: cnpjPagador,
            motivo: motivoSemEmail,
            obs: "Proposta criada sem email automático. Operadora pode aprovar só lançamento da oc.",
          },
        });
      }
    }

    const actionId = crypto.randomUUID();
    const propostaArgs: Record<string, unknown> = {
      codigo_ssw: p.codigo_ssw_proposto,
      nf: cardNf,
      chave_cte: chaveCTe,
      cnpj_remetente: cnpjRemetente,
      descricao: p.descricao_acao,
    };
    if (p.enviar_email_template && !modoSemEmail) {
      propostaArgs["template_id"] = p.enviar_email_template;
      propostaArgs["email_destino"] = emailDestino;
    }

    const propostaMeta: Record<string, unknown> = {
      tinha_intencao_email: !!p.enviar_email_template,
      modo: p.enviar_email_template && !modoSemEmail ? 'completo' : 'sem_email',
    };
    if (modoSemEmail) {
      propostaMeta["motivo_sem_email"] = motivoSemEmail;
    }

    const tool = (p.enviar_email_template && !modoSemEmail)
      ? "lancar_oc_e_enviar_email"
      : "lancar_ocorrencia";

    const { data: newTodo, error: todoErr } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: actionId,
        descricao: modoSemEmail
          ? `${p.descricao_todo} (sem email — template/contato indisponível)`
          : p.descricao_todo,
        status: "pendente",
        proposta_payload: {
          tool,
          args: propostaArgs,
          rationale: regra.rationale,
          texto: null,
          meta: propostaMeta,
        },
      })
      .select("id")
      .single();

    if (todoErr) {
      console.error(`auto-proposta INSERT todo (${p.codigo_ssw_proposto}): ${todoErr.message}`);
      continue;
    }

    todosCriados.push({
      todoId: newTodo.id as string,
      codigo: p.codigo_ssw_proposto,
      modoEmail: modoSemEmail ? 'sem_email' : 'completo',
    });
  }

  // Caio 2026-05-12 (PRATI): proposta EXTRA "Email + Lançar oc=33 via romaneio
  // interno" — pra cnpj_pagador configurado em cliente_config.usa_romaneio_interno
  // E oc atual ∈ {49, 10, 35}. Lança oc=33 SEM encadear oc=54.
  if ([49, 10, 35].includes(codUltimaOc) && cnpjPagador) {
    const cnpjPagadorNorm = cnpjPagador.replace(/\D/g, "");
    const jaTemRomaneioInterno = (existingTodos ?? []).some((t) => {
      const r = t as Record<string, unknown>;
      const payload = r["proposta_payload"] as Record<string, unknown> | null;
      const meta = payload?.["meta"] as Record<string, unknown> | undefined;
      return meta?.["tipo_acao"] === "extravio_total_romaneio_interno" &&
        STATUS_ATIVOS.has(r["status"] as string);
    });

    if (!jaTemRomaneioInterno) {
      const { data: cfg } = await supabase
        .from("cliente_config")
        .select("usa_romaneio_interno, template_email_extravio_total, nome_cliente")
        .eq("cnpj_pagador", cnpjPagadorNorm)
        .eq("ativo", true)
        .maybeSingle();

      const cfgRow = cfg as { usa_romaneio_interno?: boolean; template_email_extravio_total?: string; nome_cliente?: string } | null;
      if (cfgRow?.usa_romaneio_interno && cfgRow.template_email_extravio_total) {
        // Resolve destinatário default (operadora pode trocar no modal)
        let emailDestinoDefault: string | null = null;
        const { data: emailRpc } = await supabase.rpc("resolver_email_cobranca_cliente", {
          p_documento_cliente: cnpjPagadorNorm,
          p_tipo_uso: "logistico",
        });
        if (typeof emailRpc === "string") emailDestinoDefault = emailRpc;

        const propostaArgsR: Record<string, unknown> = {
          codigo_ssw: 33,
          nf: cardNf,
          chave_cte: chaveCTe,
          cnpj_remetente: cnpjRemetente,
          descricao: "Extravio total — email de notificação + lança oc=33 com romaneio buscado em plataforma interna",
          template_id: cfgRow.template_email_extravio_total,
        };
        if (emailDestinoDefault) propostaArgsR["email_destino"] = emailDestinoDefault;

        const { data: newTodo, error: todoErr } = await supabase
          .from("todos")
          .insert({
            card_id: cardId,
            action_id: crypto.randomUUID(),
            descricao: `Email + Lançar oc 33 — Extravio Total (${cfgRow.nome_cliente ?? "cliente"}, romaneio interno)`,
            status: "pendente",
            proposta_payload: {
              tool: "enviar_email_e_lancar_33_romaneio_interno",
              args: propostaArgsR,
              rationale: `Cliente ${cfgRow.nome_cliente ?? cnpjPagadorNorm} usa romaneio interno (cliente_config). Em ocs ${codUltimaOc}, não pedir romaneio por email — buscar na plataforma interna e lançar oc=33 direto.`,
              texto: null,
              meta: {
                tipo_acao: "extravio_total_romaneio_interno",
                tinha_intencao_email: true,
                modo: "completo",
                template_id: cfgRow.template_email_extravio_total,
                nome_cliente: cfgRow.nome_cliente,
              },
            },
          })
          .select("id")
          .single();

        if (todoErr) {
          console.error(`auto-proposta romaneio interno INSERT todo: ${todoErr.message}`);
        } else if (newTodo) {
          todosCriados.push({
            todoId: newTodo.id as string,
            codigo: 33,
            modoEmail: "completo",
          });
        }
      }
    }
  }

  if (todosCriados.length === 0) return;

  if (!regra.manter_state && !isAdicaoIncremental) {
    const { error: updErr } = await supabase
      .from("cards")
      .update({
        state: "AGUARDANDO_VALIDACAO_HUMANA",
        lock_aguardando_validacao: true,
      })
      .eq("id", cardId);
    if (updErr) {
      console.error(`auto-proposta UPDATE card: ${updErr.message}`);
      return;
    }
  }

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "TodoPropostoAutomaticamente",
    actor_type: "system",
    actor_id: actorId,
    payload: {
      regra: `oc=${codUltimaOc}`,
      todos_criados: todosCriados,
      manter_state: !!regra.manter_state,
      rationale: regra.rationale,
    },
  });
}

// =============================================================================
// Regra especial: oc=6/9/16 (extravio — Perdas trata) + cliente cobrou via
// email/whatsapp da notificação automática SSW. Caso específico Sal Express
// (medicamentos): cliente é notificado imediatamente e responde decidindo:
//   - autorizar entrega parcial → Larissa lança oc=55
//   - solicitar devolução       → Larissa lança oc=44
//   - aguardar localização      → Larissa só observa (5 dias até Perdas
//                                  lançar 49 e voltar pra fluxo normal)
//
// Card vai pra TRATATIVA_PENDENTE com 2 propostas (55, 44). Larissa decide
// baseada na leitura do email do cliente.
// =============================================================================

export const OCORRENCIAS_EXTRAVIO_PERDAS: ReadonlySet<number> = new Set([6, 9, 16]);

export interface AplicarExtravioArgs {
  cardId: string;
  cardNf: string | null;
  /** Caio 2026-05-11: CTRC original do card (lookup prioriza CT-e normal). */
  cardCtrc?: string | null;
  codUltimaOc: number | null;
  agentState: Record<string, unknown>;
  actorId?: string;
}

export async function aplicarRegraExtravioComCobrancaCliente(
  supabase: SupabaseClient,
  args: AplicarExtravioArgs,
): Promise<{ aplicou: boolean; criados: number }> {
  const { cardId, cardNf, cardCtrc, codUltimaOc, agentState } = args;
  const actorId = args.actorId ?? "vinculador";

  if (codUltimaOc == null || !OCORRENCIAS_EXTRAVIO_PERDAS.has(codUltimaOc)) {
    return { aplicou: false, criados: 0 };
  }
  if (!cardNf) return { aplicou: false, criados: 0 };

  // Caio 2026-05-12: state TRATATIVA_PENDENTE SUSPENSO. Antes esse combo de
  // extravio (oc=6/9/16) caía em TRATATIVA_PENDENTE com 2 propostas (55, 44).
  // Como o conceito do TRATATIVA_PENDENTE é o mesmo de "aguardando Larissa
  // decidir entre opções" (= AGUARDANDO_VALIDACAO_HUMANA com lock), e essa
  // regra JÁ cria propostas a seguir, basta usar AGUARDANDO_VALIDACAO_HUMANA
  // + lock=true. Visualmente cai na mesma aba "AGUARDANDO VOCÊ".
  await supabase
    .from("cards")
    .update({ state: "AGUARDANDO_VALIDACAO_HUMANA", lock_aguardando_validacao: true })
    .eq("id", cardId);

  // Resolve chave_cte (necessário pra executor lançar a oc no SSW)
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador;
  let chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  if (!chaveCTe) {
    const { data: lookup } = await supabase.rpc("lookup_chave_cte", {
      p_nf: cardNf,
      p_cnpj_pagador: cnpjPagador,
      p_ctrc: cardCtrc ?? null,
    });
    const row = Array.isArray(lookup) ? lookup[0] : lookup;
    if (row && typeof row.chave_cte === "string") {
      chaveCTe = row.chave_cte;
      await supabase
        .from("cards")
        .update({ agent_state: { ...agentState, chave_cte: chaveCTe } })
        .eq("id", cardId);
    }
  }

  if (!chaveCTe) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "ExtravioRegraAdiadaSemChaveCTe",
      actor_type: "system",
      actor_id: actorId,
      payload: { regra: `oc=${codUltimaOc}`, nf: cardNf, cnpj_pagador: cnpjPagador },
    });
    return { aplicou: true, criados: 0 };
  }

  // Idempotência: só bloqueia se todo ATIVO (pendente/aprovado). Mesma regra
  // aplicada em proporAutoAcaoSeAplicavel — permite recriação em ciclos de
  // re-entrada (Caio 2026-05-06).
  const STATUS_ATIVOS = new Set(["pendente", "aprovado"]);
  const { data: existing } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", cardId);
  const codigosJa = new Set<number>();
  for (const t of (existing ?? []) as Array<Record<string, unknown>>) {
    const p = t["proposta_payload"] as Record<string, unknown> | null;
    const a = p?.["args"] as Record<string, unknown> | undefined;
    const c = a?.["codigo_ssw"];
    const s = t["status"] as string | undefined;
    if (typeof c === "number" && s && STATUS_ATIVOS.has(s)) codigosJa.add(c);
  }

  const propostas = [
    {
      codigo: 55,
      descricao_todo: "Lançar oc 55 no SSW — autorizar entrega parcial",
      descricao_acao: "Cliente autorizou seguir entrega parcial",
    },
    {
      codigo: 44,
      descricao_todo: "Lançar oc 44 no SSW — retorno de carga (Devolução)",
      descricao_acao: "Cliente solicitou devolução — encaminha pro setor de Devolução",
    },
  ];

  let criados = 0;
  for (const p of propostas) {
    if (codigosJa.has(p.codigo)) continue;

    const { error } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        descricao: p.descricao_todo,
        status: "pendente",
        proposta_payload: {
          tool: "lancar_ocorrencia",
          args: {
            codigo_ssw: p.codigo,
            nf: cardNf,
            chave_cte: chaveCTe,
            cnpj_remetente: cnpjRemetente,
            descricao: p.descricao_acao,
          },
          rationale: `Extravio oc=${codUltimaOc} — cliente respondeu e Larissa decide entre 55 (autorizar parcial) ou 44 (devolver).`,
          texto: null,
          meta: {
            tinha_intencao_email: false,
            modo: "sem_email",
            origem: "vinculador_extravio_cobranca_cliente",
          },
        },
      });
    if (!error) criados++;
  }

  if (criados > 0) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "TodoPropostoAutomaticamente",
      actor_type: "system",
      actor_id: actorId,
      payload: {
        regra: `extravio-cobranca oc=${codUltimaOc}`,
        criados,
        rationale: "Cliente cobrou sobre NF em extravio (oc=6/9/16). 2 opções: 55 (autorizar entrega parcial) ou 44 (devolver).",
      },
    });
  }

  return { aplicou: true, criados };
}
