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
  /**
   * Sobrescreve a heurística padrão de tool. Usado pra propostas que precisam
   * de handler específico no executor (ex: email texto livre + oc=33).
   * Sem isso, tool é derivado de codigo_ssw_proposto + enviar_email_template.
   * Caio 2026-05-20.
   */
  tool_override?: string;
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
  // Caio 2026-05-19: regra de EXCEÇÃO — só ativa pra CNPJs em cliente_config_oc13
  // (12 CNPJs: F E F, União Química, O.V.D., Ferramentas Gerais). Padrão geral:
  // oc=13 é responsabilidade do cliente final, operação trata sozinha, sem card
  // de relacionamento. Pra esses 6 grupos, o CTRC de reentrega NÃO é emitido
  // automaticamente — operador precisa intervir lançando oc=21 (que destrava
  // a emissão) ou outra opção. proporAutoAcaoSeAplicavel só aplica essa regra
  // quando cnpj_pagador ∈ excecoesOc13 (guard explícito na função).
  13: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega solicitada pelo cliente — destrava CTRC de reentrega",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — tratativa cliente exceção",
        descricao_acao: "Aguardando retorno do cliente pagador (cliente excepcional — operação não emite reentrega auto)",
        // Caio 2026-06-23 (NF 1090394): era FALTA_DE_VOLUME, cujo assunto é
        // "Extravio Parcial" — nada a ver com oc=13 (limitação cliente). Template
        // próprio LIMITACAO_CLIENTE (mig 248). Operadora ainda troca no modal.
        enviar_email_template: "LIMITACAO_CLIENTE",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Falta info / encaminha pra Operação corrigir",
      },
      {
        codigo_ssw_proposto: 41,
        descricao_todo: "Lançar oc 41 no SSW — informação complementar (texto livre)",
        descricao_acao: "Informação complementar — operador preenche texto antes de aprovar",
      },
    ],
    rationale: "Caio 2026-05-19: EXCEÇÃO restrita a CNPJs em cliente_config_oc13 (12 CNPJs em 4 grupos). Padrão geral oc=13 não cria card de relacionamento — esses clientes obrigam tratativa antes do CTRC de reentrega ser emitido. 4 propostas: (a) 21 reentrega (destrava CTRC); (b) 54 + email FALTA_DE_VOLUME; (c) 56 falta info; (d) 41 informação complementar. Proposta 21 herda checkbox de cancelamento agendado +24h (memory project_cancelamento_auto_reentrega).",
  },
  20: {
    propostas: [
      {
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Autorização para seguir entrega — extravio localizado",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — operadora escolhe template",
        descricao_acao: "Aguardando retorno do cliente pagador (template escolhido pela operadora no modal)",
        enviar_email_template: "FALTA_DE_VOLUME",
      },
    ],
    rationale: "Padrão 2026-04-30 (atualizado 2026-05-15): oc=20 (extravio localizado) → 2 caminhos: (a) oc 55 autorizar seguir entrega; (b) oc 54 + email pro cliente — Larissa escolhe template no modal (FALTA_DE_VOLUME, RECUSA_TOTAL, PROBLEMAS_COM_ENDERECO, RECUSA_PARCIAL) via extras.template_id_override; default FALTA_DE_VOLUME.",
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
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Cliente autorizou seguir entrega (parcial / mesmo com problema)",
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
    rationale: "Padrão 2026-05-04 (atualizado 2026-05-20): oc=10 (recusa total) → 5 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 55 autorizar seguir entrega (parcial sem reentrega); (d) 44 retorno carga (Devolução); (e) 56 falta info (Operação).",
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
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Cliente autorizou seguir entrega (parcial / mesmo com problema)",
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
    rationale: "Padrão 2026-05-04 (atualizado 2026-05-20): oc=11 (problemas com endereço) → 5 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 55 autorizar seguir entrega; (d) 44 retorno carga; (e) 56 falta info.",
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
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Cliente autorizou seguir entrega parcial (sem reentrega completa)",
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
    rationale: "Padrão 2026-05-04 (atualizado 2026-05-20): oc=35 (recusa parcial) → 5 caminhos: (a) reentrega (21); (b) lançar 54 + email cliente; (c) 55 autorizar seguir entrega parcial; (d) 44 retorno carga; (e) 56 falta info.",
  },
  // Caio 2026-05-26 (NF 713556): oc=26 (CONJUNTO DE COMPROVANTES INCOMPLETOS)
  // é caso administrativo onde os comprovantes da entrega não chegaram
  // completos pro SSW. Antes ficava em AGUARDANDO_AGENTE sem propostas e
  // operador precisava usar "Lançamento Emergencial" (caminho ad-hoc).
  // Replica as 8 opções de oc=49 — mesmas regras, fluxo padrão de aprovação.
  26: {
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
        descricao_acao: "Informação complementar — operador preenche texto antes de aprovar",
      },
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Email + oc 33 (notificação ao cliente + reversão de perdas)",
        descricao_acao: "Email texto livre pro cliente (apenas notificação, não aguarda resposta) + lança oc=33",
        tool_override: "enviar_email_livre_e_lancar_oc33_portal",
      },
    ],
    rationale: "Caio 2026-05-26 (NF 713556): oc=26 (comprovantes incompletos) replica as 8 opções de oc=49 — operador escolhe entre reentrega/aguardar cliente/autorizar entrega/devolução/falta info/reversão de perdas/texto livre/email+33.",
  },
  // Caio 2026-06-18 (NF 1119191, DUILIO): oc=23 (PROBLEMAS COM DOCUMENTACAO)
  // replica as 8 opções de oc=49. Caso âncora: a operação lançou oc=23 por
  // engano pra cobrar o relacionamento de retorno; como oc=23 não tinha regra
  // configurada, o card nasceu em AGUARDANDO_AGENTE ("PARA FAZER") sem nenhuma
  // proposta e nunca chegou na aba "AGUARDANDO VOCÊ" do operador. Mesma
  // estrutura do replic feito pra oc=26 e oc=43. Backfill: ~70 cards oc=23
  // presos em AGUARDANDO_AGENTE sem propostas (69 LARISSA + 1 DUILIO) passam a
  // receber as 8 opções no próximo ciclo de sync.
  23: {
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
        descricao_acao: "Informação complementar — operador preenche texto antes de aprovar",
      },
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Email + oc 33 (notificação ao cliente + reversão de perdas)",
        descricao_acao: "Email texto livre pro cliente (apenas notificação, não aguarda resposta) + lança oc=33",
        tool_override: "enviar_email_livre_e_lancar_oc33_portal",
      },
    ],
    rationale: "Caio 2026-06-18 (NF 1119191): oc=23 (problemas com documentação) replica as 8 opções de oc=49 — operador escolhe entre reentrega/aguardar cliente/autorizar entrega/devolução/falta info/reversão de perdas/texto livre/email+33. Operação lançou 23 por engano pra cobrar retorno do relacionamento e o card ficava preso em PARA FAZER sem propostas.",
  },
  // Caio 2026-05-26: oc=43 replica as 8 opções de oc=49 — operadora pediu
  // pra todas as propostas aparecerem de imediato no card. Mesma estrutura
  // do replic feito pra oc=26 mais cedo.
  43: {
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
        descricao_acao: "Informação complementar — operador preenche texto antes de aprovar",
      },
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Email + oc 33 (notificação ao cliente + reversão de perdas)",
        descricao_acao: "Email texto livre pro cliente (apenas notificação, não aguarda resposta) + lança oc=33",
        tool_override: "enviar_email_livre_e_lancar_oc33_portal",
      },
    ],
    rationale: "Caio 2026-05-26: oc=43 replica as 8 opções de oc=49 — operador escolhe entre reentrega/aguardar cliente/autorizar entrega/devolução/falta info/reversão de perdas/texto livre/email+33.",
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
      // Caio 2026-05-20: 8ª opção. Caso da NF 70080 (LARISSA). Operador precisa
      // notificar cliente (texto livre, sem aguardar retorno) E lançar oc=33.
      // Diferente de "54+email FALTA_DE_VOLUME" (esse aguarda resposta cliente).
      // Diferente de "33 sozinho" (esse não notifica cliente). Combina os dois
      // com email texto LIVRE (sem template) + opção de anexos no email e
      // imagens/texto na oc=33 (igual oc33_solo).
      {
        codigo_ssw_proposto: 33,
        descricao_todo: "Email + oc 33 (notificação ao cliente + reversão de perdas)",
        descricao_acao: "Email texto livre pro cliente (apenas notificação, não aguarda resposta) + lança oc=33",
        tool_override: "enviar_email_livre_e_lancar_oc33_portal",
      },
    ],
    rationale: "Padrão 2026-05-07 (atualizado 2026-05-20): oc=49 (tratativa relacionamento) → 8 caminhos: (a) reentrega (21); (b) 54+email FALTA_DE_VOLUME (aguarda cliente); (c) 55 autorizar entrega; (d) 44 retorno carga; (e) 56 falta info; (f) 33 reversão sozinha; (g) 41 informação complementar; (h) email texto livre + oc=33 (notificação sem aguardar resposta).",
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
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Relançar oc 54 + email pro cliente — recobrança",
        descricao_acao: "Recobrança do cliente — segundo envio do email FALTA_DE_VOLUME",
        enviar_email_template: "FALTA_DE_VOLUME",
      },
    ],
    rationale: "Padrão 2026-05-05 (atualizado 2026-05-15): card em oc=54 (aguardando cliente) recebe 6 opções — reentrega (21), reversão de perdas (33), retorno carga/devolução (44), autorizar entrega (55), falta info (56), recobrança via 54+email FALTA_DE_VOLUME. Larissa aprova quando cliente decidir OU pra recobrar quando cliente não responde. manter_state=true — card continua em AGUARDANDO_CLIENTE até operadora agir.",
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
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega",
        descricao_acao: "Cliente autorizou seguir entrega parcial (mesmo com falta de volumes)",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Falta info operacional / evidência incompleta — encaminha pra Operação corrigir",
      },
    ],
    rationale: "Padrão Caio 2026-05-13 (atualizado 2026-05-20): oc=19 (entrega realizada com falta de volumes) → 4 caminhos: (a) 33 reversão de perdas (caso de extravio confirmado dos volumes faltantes); (b) 54 + email FALTA_DE_VOLUME (consulta o cliente antes de decidir); (c) 55 autorizar seguir entrega parcial (cliente liberou ficar com o que recebeu); (d) 56 falta info (devolve pra Operação se evidência da entrega parcial está incompleta).",
  },
  // Caio 2026-05-20 (caso âncora NF 1494315): oc=8 AVARIA NA TRANSFERENCIA
  // aparece quando operação detecta avaria física durante transferência.
  // Decisão 100% manual do operador — analisa foto e julga. 4 propostas:
  //   (a) oc=21 reentrega (cliente pode ter autorizado por outro canal);
  //   (b) oc=54 + email — pergunta cliente se pode seguir mesmo com avaria;
  //   (c) oc=55 libera entrega — operador julgou avaria como não-impeditiva;
  //   (d) oc=56 — manda Operação revisar tecnicamente antes.
  8: {
    propostas: [
      {
        codigo_ssw_proposto: 21,
        descricao_todo: "Lançar oc 21 no SSW — reentrega solicitada pelo cliente",
        descricao_acao: "Reentrega autorizada pelo cliente — segue pra nova tentativa",
      },
      {
        codigo_ssw_proposto: 54,
        descricao_todo: "Lançar oc 54 + email pro cliente — informa avaria e pergunta se pode seguir",
        descricao_acao: "Avaria detectada na transferência — aguardando posicionamento do cliente",
        enviar_email_template: "FALTA_DE_VOLUME",
      },
      {
        codigo_ssw_proposto: 55,
        descricao_todo: "Lançar oc 55 no SSW — autorizar seguir entrega (avaria não impede)",
        descricao_acao: "Operador analisou avaria e liberou entrega",
      },
      {
        codigo_ssw_proposto: 56,
        descricao_todo: "Lançar oc 56 no SSW — falta info operacional (encaminhar p/ Operação)",
        descricao_acao: "Avaria precisa avaliação técnica da Operação antes de decidir",
      },
    ],
    rationale: "Padrão Caio 2026-05-20: oc=8 (avaria na transferência) → 4 caminhos manuais — operador analisa foto da avaria e decide caso a caso. (a) oc=21 reentrega se cliente já autorizou (caso âncora NF 1494315 — cliente respondeu por email fora da thread); (b) oc=54 consulta o cliente; (c) oc=55 libera entrega; (d) oc=56 manda Operação revisar. Sem decisão automática.",
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
  /**
   * Caio 2026-05-19: Set de CNPJs onde oc=13 vira caso de relacionamento.
   * Vem da tabela `cliente_config_oc13` (sync-bastao carrega 1x e propaga).
   * Sem isso, regra de oc=13 não dispara — comportamento legacy preservado.
   */
  excecoesOc13?: ReadonlySet<string>;
  /**
   * Caio 2026-06-29 (NF 705764): template de e-mail que o agente-sugere-ocs-padrao
   * decidiu pra a proposta "54 + e-mail" — sobrepõe o FALTA_DE_VOLUME genérico da
   * regra oc=49 quando o contexto é extravio (EXTRAVIO_TOTAL_PEDIR_ROMANEIO /
   * EXTRAVIO_PARCIAL). Sem isso, o todo da oc=54 saía com o template errado
   * (assunto "Extravio Parcial / falta de volume" em vez de pedir o romaneio) — a
   * decisão certa do agente ficava só no banner e nunca chegava na ação clicável.
   * Só aplica à proposta codigo_ssw_proposto === 54 que já tem e-mail.
   */
  templateEmail54Override?: string | null;
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

  // Caio 2026-05-19: regra oc=13 é EXCEÇÃO — só dispara pros 12 CNPJs em
  // cliente_config_oc13 (F E F, União Química, O.V.D., Ferramentas Gerais).
  // Sem `excecoesOc13` no args ou cnpj fora da lista: oc=13 não cria propostas
  // (comportamento legacy — oc=13 padrão é tratada pela operação, sem card).
  if (codUltimaOc === 13) {
    const cnpj = agentState["cnpj_pagador"] as string | undefined;
    if (!cnpj || !args.excecoesOc13?.has(cnpj)) return;
  }

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

  // Caio 2026-06-09 (mig 195): removido gate sem_chave_cte. Portal interno
  // não precisa de chave_cte 44 dígitos — usa card.ctrc + buscarNFInterno.
  // chaveCTe pode permanecer null/undefined sem bloquear criação de propostas.
  // Caio 2026-06-23: cnpj/chave/todosCriados resolvidos AQUI (antes do early-
  // return) pra que garantirGemeosSemEmail rode mesmo quando propostasPendentes
  // está vazio (card já tem todas as opções, incluindo "54 + email").
  const cnpjPagador =
    (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador;
  const chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  const todosCriados: Array<{ todoId: string; codigo: number; modoEmail: 'completo' | 'sem_email' }> = [];

  const propostasPendentes = regra.propostas.filter(
    (p) => !codigosJaPropostos.has(p.codigo_ssw_proposto),
  );
  if (propostasPendentes.length === 0) {
    // Caio 2026-06-23: mesmo sem propostas NOVAS, garante o gêmeo "lançar só a
    // oc, sem email" pros cards que já têm a opção "54 + email" ATIVA mas nunca
    // ganharam o gêmeo (a opção sumiu quando passamos a ter email de quase todo
    // cliente — antes vinha de graça via fallback modoSemEmail). É justamente
    // nesses cards que a dedup-por-código deixa propostasPendentes vazio (todas
    // as 5/8 opções já criadas). Âncoras: NF 352420 (oc=35), NF 775856 (oc=49).
    await garantirGemeosSemEmail(supabase, {
      cardId,
      cardNf,
      chaveCTe,
      cnpjRemetente,
      regra,
      codUltimaOc,
      existingTodos: (existingTodos ?? []) as Array<Record<string, unknown>>,
      todosCriados,
    });
    if (todosCriados.length > 0) {
      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "TodoPropostoAutomaticamente",
        actor_type: "system",
        actor_id: actorId,
        payload: {
          regra: `oc=${codUltimaOc}`,
          todos_criados: todosCriados,
          manter_state: !!regra.manter_state,
          motivo:
            "Gêmeo 'lançar só oc sem email' criado retroativamente (a opção 'com email' do mesmo código já estava ativa no card).",
        },
      });
    }
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

  // Caio 2026-06-22: cliente romaneio-interno (PRATI) resolvido UMA vez aqui
  // pra (a) marcar a proposta de romaneio como RECOMENDADA e (b) carimbar aviso
  // nas 33 GENÉRICAS — elas lançam a oc 33 SEM buscar/anexar o romaneio. Raiz do
  // furo: a opção de romaneio se perdia no meio de 4 caminhos genéricos de 33
  // ("Lançar oc 33 solo", "Email + oc 33", combo 33+44, oc 33 manual) e a
  // operadora escolhia o genérico. Retroativo: 9 lançamentos de 33 em cards
  // PRATI, 0 via romaneio (NFs 1002836, 1006605, 1007453, 1005069, 996860,
  // 1012717). O envelope continua deixando ela escolher — só deixa claro qual.
  type CfgRomaneio = { usa_romaneio_interno?: boolean; template_email_extravio_total?: string; nome_cliente?: string };
  const cnpjPagadorNorm = cnpjPagador ? cnpjPagador.replace(/\D/g, "") : null;
  let cfgRomaneio: CfgRomaneio | null = null;
  if ([49, 10, 35].includes(codUltimaOc) && cnpjPagadorNorm) {
    const { data: cfg } = await supabase
      .from("cliente_config")
      .select("usa_romaneio_interno, template_email_extravio_total, nome_cliente")
      .eq("cnpj_pagador", cnpjPagadorNorm)
      .eq("ativo", true)
      .maybeSingle();
    cfgRomaneio = cfg as CfgRomaneio | null;
  }
  const romaneioInternoAtivo = !!(
    cfgRomaneio?.usa_romaneio_interno && cfgRomaneio.template_email_extravio_total
  );

  for (const p of propostasPendentes) {
    let emailDestino: string | null = null;
    let templateDisponivel = false;
    let modoSemEmail = false;          // template inativo/inexistente → não dá pra mandar email
    let precisaEmailDestino = false;   // template OK, mas cliente sem contato → operadora preenche no modal
    let motivoSemEmail: string | null = null;

    // Caio 2026-06-29 (NF 705764): template efetivo da proposta. Só a "54 + e-mail"
    // aceita o override do agente (EXTRAVIO_TOTAL_PEDIR_ROMANEIO / EXTRAVIO_PARCIAL),
    // e só quando a proposta já tem e-mail (não cria e-mail onde a regra não previa).
    // Sem override → idêntico a `p.enviar_email_template` (zero regressão).
    const templateEfetivo: string | undefined =
      p.codigo_ssw_proposto === 54 && p.enviar_email_template && args.templateEmail54Override
        ? args.templateEmail54Override
        : p.enviar_email_template;

    if (templateEfetivo) {
      const { data: tpl } = await supabase
        .from("templates_email")
        .select("id, ativo")
        .eq("id", templateEfetivo)
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
        // Sem template ativo: realmente não dá pra mandar email → fallback sem-email.
        modoSemEmail = true;
        motivoSemEmail = `Template '${templateEfetivo}' inativo/inexistente`;
      } else if (!emailDestino) {
        // Caio 2026-06-23 (NF 59354, MEDH 18917657000183): template existe, só
        // falta o CONTATO do cliente. NÃO rebaixar pra "sem email" — mantém a
        // opção "54 + email" de verdade (lancar_oc_e_enviar_email) com destino
        // em branco pra operadora preencher no modal. O executor já aceita
        // extras.email_destinatarios e auto-cadastra o email em contatos_cliente
        // pros próximos cards. Antes, ~62 clientes sem contato perdiam a opção
        // de email e o card só mostrava "54 sem email".
        precisaEmailDestino = true;
      }

      if (modoSemEmail) {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "AutoProposicaoCriadaSemEmail",
          actor_type: "system",
          actor_id: actorId,
          payload: {
            regra: `oc=${codUltimaOc}→${p.codigo_ssw_proposto}`,
            template_id: templateEfetivo,
            documento_cliente: cnpjPagador,
            motivo: motivoSemEmail,
            obs: "Proposta criada sem email automático (template indisponível). Operadora pode aprovar só lançamento da oc.",
          },
        });
      } else if (precisaEmailDestino) {
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "AutoProposicaoPedeEmailDestino",
          actor_type: "system",
          actor_id: actorId,
          payload: {
            regra: `oc=${codUltimaOc}→${p.codigo_ssw_proposto}`,
            template_id: templateEfetivo,
            documento_cliente: cnpjPagador,
            obs: "Cliente sem contato logístico — proposta '+ email' criada com destino em branco; operadora informa no modal e o email é cadastrado pros próximos.",
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
    // enviaEmail = intenção de email E template disponível (com contato resolvido
    // OU a preencher pela operadora). modoSemEmail (template inativo) é o único
    // caminho que vira lancar_ocorrencia puro.
    const enviaEmail = !!templateEfetivo && !modoSemEmail;
    if (enviaEmail) {
      propostaArgs["template_id"] = templateEfetivo;
      // Só carimba destino quando resolvido. Em precisaEmailDestino fica ausente
      // — a operadora informa no modal (extras.email_destinatarios no executor).
      if (emailDestino) propostaArgs["email_destino"] = emailDestino;
    }

    const propostaMeta: Record<string, unknown> = {
      tinha_intencao_email: !!templateEfetivo,
      modo: enviaEmail ? 'completo' : 'sem_email',
    };
    if (modoSemEmail) {
      propostaMeta["motivo_sem_email"] = motivoSemEmail;
    }
    if (precisaEmailDestino) {
      // Front: abrir o composer e EXIGIR o destinatário antes de aprovar.
      propostaMeta["precisa_email_destino"] = true;
    }

    // Caio 2026-05-19: oc=33 sempre usa portal interno (opção 101) pra
    // permitir anexo de imagens (romaneio assinado, evidência). Backend
    // `processarOc33SoloPortal` aceita extras.anexos_ids[] e faz upload
    // multipart de N JPEGs. Sem essa tool, o operador não tinha como
    // anexar imagem no oc=33 vinda como proposta de oc=49/54/19/13.
    // Gate sem_chave_cte na RPC aprovar_e_executar não se aplica a portal
    // tools (portal busca NF direto, dispensa chave_cte). Comportamento
    // já validado no path do vinculador (combo 33+44 e oc33 solo pós-cliente).
    // Caio 2026-05-20: proposta pode definir tool_override (ex: nova opção
    // "Email + oc 33" da regra oc=49 usa enviar_email_livre_e_lancar_oc33_portal).
    // Sem override, cai na heurística padrão.
    const tool = p.tool_override
      ?? (p.codigo_ssw_proposto === 33
        ? "lancar_oc33_solo_portal"
        : enviaEmail
          ? "lancar_oc_e_enviar_email"
          : "lancar_ocorrencia");

    // Caio 2026-06-22: cliente romaneio-interno + opção que lança oc 33 (solo,
    // email+33, combo 33+44 ou 33 manual) → carimba aviso pra operadora não
    // escolher a 33 GENÉRICA sem querer (ela pula a busca/anexo de romaneio).
    // Não bloqueia — só deixa explícito que existe a ação certa.
    const lancaOc33 = p.codigo_ssw_proposto === 33 || /33/.test(tool);

    const { data: newTodo, error: todoErr } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: actionId,
        descricao: modoSemEmail
          ? `${p.descricao_todo} (sem email — template indisponível)`
          : precisaEmailDestino
            ? `${p.descricao_todo} (informe o e-mail do cliente no envio)`
            : p.descricao_todo,
        status: "pendente",
        proposta_payload: {
          tool,
          args: propostaArgs,
          rationale: regra.rationale,
          texto: null,
          meta: propostaMeta,
          ...(romaneioInternoAtivo && lancaOc33
            ? {
              aviso_romaneio_interno:
                `⚠️ ${cfgRomaneio?.nome_cliente ?? "Este cliente"} usa romaneio interno: esta opção lança a oc 33 SEM buscar/anexar o romaneio do portal. Para anexar o romaneio, use a ação recomendada "Email + Lançar oc 33 — Extravio Total (romaneio interno)".`,
            }
            : {}),
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
  // Caio 2026-06-22: reaproveita o lookup do topo (cfgRomaneio / cnpjPagadorNorm
  // / romaneioInternoAtivo) em vez de re-query cliente_config.
  if (romaneioInternoAtivo && cnpjPagadorNorm) {
    const jaTemRomaneioInterno = (existingTodos ?? []).some((t: unknown) => {
      const r = t as Record<string, unknown>;
      const payload = r["proposta_payload"] as Record<string, unknown> | null;
      const meta = payload?.["meta"] as Record<string, unknown> | undefined;
      return meta?.["tipo_acao"] === "extravio_total_romaneio_interno" &&
        STATUS_ATIVOS.has(r["status"] as string);
    });

    if (!jaTemRomaneioInterno) {
      const cfgRow = cfgRomaneio!;
      if (cfgRow.usa_romaneio_interno && cfgRow.template_email_extravio_total) {
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
              // Caio 2026-06-22: marca como AÇÃO RECOMENDADA pro front destacar
              // (selo + topo da lista). É a única que busca/anexa o romaneio do
              // portal interno; as 33 genéricas ganham aviso_romaneio_interno.
              recomendada: true,
              motivo_recomendacao:
                `${cfgRow.nome_cliente ?? "Este cliente"} usa romaneio interno: esta ação busca o romaneio no portal e anexa na oc 33 automaticamente. Use esta — não as opções genéricas de oc 33.`,
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

  // Caio 2026-06-23: gêmeo "lançar só a oc, sem email" pra cada opção "54 +
  // email" criada/ativa neste card. Roda no fluxo normal (cards novos e adição
  // incremental). A versão dentro do early-return cobre os cards já 100%
  // propostos. Idempotente via meta.sem_email_explicito.
  await garantirGemeosSemEmail(supabase, {
    cardId,
    cardNf,
    chaveCTe,
    cnpjRemetente,
    regra,
    codUltimaOc,
    existingTodos: (existingTodos ?? []) as Array<Record<string, unknown>>,
    todosCriados,
  });

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
// garantirGemeosSemEmail — Caio 2026-06-23
//
// Pra cada proposta da regra que tem `enviar_email_template` (hoje só as
// variações de oc=54 "+ email"), cria um TODO GÊMEO que lança SÓ a oc no SSW,
// SEM disparar email — restaurando a opção "lançar só oc 54 sem email" que
// existia "de graça" enquanto faltava template/contato (modoSemEmail) e sumiu
// quando passamos a ter email de quase todo cliente. Casos pontuais: a
// operadora avisa a IA que ela errou e segue pra outra oc, OU o email já existe
// (thread pré-card). A 54+email recomendada pela IA continua intocada — esta é
// uma opção ADICIONAL, lado a lado.
//
// Independente da dedup-por-código do fluxo principal: o gêmeo compartilha o
// codigo_ssw (54) com a "54 + email", então a dedup-por-código sozinha nunca
// criaria os dois em cards já propostos. Por isso a função é chamada também no
// early-return (cards 100% propostos) e roda direto no `existingTodos` já
// carregado (sem nova query).
//
// Regras:
//   - Só cria o gêmeo quando a opção "com email" do MESMO código está ATIVA
//     (todo pré-existente OU recém-criado em modo completo). Se a 54 só existe
//     em modo sem_email (fallback por falta de template/contato), NÃO duplica.
//   - Idempotente: não recria se já há gêmeo ativo (meta.sem_email_explicito).
//   - Pula codigo 33 (a 33 "+ email" usa tool_override próprio, não este path).
//   - args.descricao = descricao_acao limpa (texto que vai pro SSW é igual ao
//     da 54+email; o "sem email" é distinção interna do Cockpit, não vai pro
//     SSW). A flag fica em proposta_payload.meta.sem_email_explicito.
// =============================================================================
async function garantirGemeosSemEmail(
  supabase: SupabaseClient,
  ctx: {
    cardId: string;
    cardNf: string | null;
    chaveCTe: string | null;
    cnpjRemetente: string | null;
    regra: RegraAutoAcao;
    codUltimaOc: number;
    existingTodos: Array<Record<string, unknown>>;
    todosCriados: Array<{ todoId: string; codigo: number; modoEmail: 'completo' | 'sem_email' }>;
  },
): Promise<void> {
  const { cardId, cardNf, chaveCTe, cnpjRemetente, regra, codUltimaOc, existingTodos, todosCriados } = ctx;
  if (!cardNf) return;

  const STATUS_ATIVOS = new Set(["pendente", "aprovado"]);

  // Códigos com opção "com email" ATIVA e códigos que já têm gêmeo ativo —
  // derivados dos todos pré-existentes.
  const comEmailAtivo = new Set<number>();
  const jaTemTwin = new Set<number>();
  for (const t of existingTodos) {
    const status = t["status"] as string | undefined;
    if (!status || !STATUS_ATIVOS.has(status)) continue;
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"];
    if (typeof cod !== "number") continue;
    if (meta?.["sem_email_explicito"] === true) {
      jaTemTwin.add(cod);
    } else if (
      payload?.["tool"] === "lancar_oc_e_enviar_email" ||
      meta?.["modo"] === "completo" ||
      typeof tArgs?.["template_id"] === "string"
    ) {
      comEmailAtivo.add(cod);
    }
  }
  // Recém-criados neste run (a 54+email criada agora também habilita o gêmeo).
  for (const t of todosCriados) {
    if (t.modoEmail === "completo") comEmailAtivo.add(t.codigo);
  }

  for (const p of regra.propostas) {
    if (!p.enviar_email_template) continue;
    const cod = p.codigo_ssw_proposto;
    if (cod === 33) continue;
    if (!comEmailAtivo.has(cod)) continue;
    if (jaTemTwin.has(cod)) continue;

    const { data: twin, error: twinErr } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        descricao: `Lançar SÓ oc ${cod} (sem email) — re-aguardar cliente sem notificar`,
        status: "pendente",
        proposta_payload: {
          tool: "lancar_ocorrencia",
          args: {
            codigo_ssw: cod,
            nf: cardNf,
            chave_cte: chaveCTe,
            cnpj_remetente: cnpjRemetente,
            descricao: p.descricao_acao,
          },
          rationale: regra.rationale,
          texto: null,
          meta: {
            tinha_intencao_email: false,
            modo: "sem_email",
            // Front: renderizar como LANÇAR direto (NUNCA ABRIR EDITOR), mesmo
            // sendo oc 54. Diferencia do fallback modoSemEmail (que carrega
            // motivo_sem_email) — aqui é opção deliberada, lado a lado da 54+email.
            sem_email_explicito: true,
            gemeo_de_codigo_email: cod,
          },
        },
      })
      .select("id")
      .single();

    if (twinErr) {
      console.error(`auto-proposta gêmeo sem-email oc=${codUltimaOc}→${cod}: ${twinErr.message}`);
      continue;
    }
    jaTemTwin.add(cod);
    if (twin) {
      todosCriados.push({ todoId: twin.id as string, codigo: cod, modoEmail: "sem_email" });
    }
  }
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

  // Caio 2026-06-09 (mig 195): removido gate sem_chave_cte. Portal interno
  // não precisa de chave_cte 44 dígitos. Mantém apenas resolução de cnpj
  // pagador/remetente que ainda alimenta o payload do todo (informativo).
  const cnpjPagador = (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador;
  const chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

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
