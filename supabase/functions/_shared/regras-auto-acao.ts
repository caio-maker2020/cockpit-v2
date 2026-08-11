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

import type { SupabaseClient as SupabaseClientType } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  classificarOc33,
  decidirGateOc33,
  dossieVazio,
  lerExtravioParcial,
} from "./extravio-parcial-dossie.ts";

type SupabaseClient = SupabaseClientType<any, "public", any>;

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

// =============================================================================
// acaoKey — IDENTIDADE ÚNICA de uma ação proposta dentro do card.
//
// Caio 2026-06-26 (NF 463457): "lançar 54 + e-mail" e "lançar 54 SEM e-mail" são
// DUAS ações OPOSTAS, tão diferentes quanto "lançar 54" e "lançar 33". O bug:
// a recomendação da IA trafegava só como NÚMERO (proposta_destacada: 54) e o
// front destacava o banner casando por número — mas existem dois todos com
// codigo_ssw=54 (com e sem e-mail). Resultado: o banner mostrava "54 + e-mail
// (com template)" e o clique acionava "54 SEM e-mail" (cliente nunca notificado).
//
// Fix de raiz: TODA ação carrega `acao_key = "<tool>:<codigo_ssw>"`, identidade
// estável e SEM colisão (com-email e sem-email diferem pelo tool). O front
// destaca/vincula pela acao_key, nunca pelo número. Banner = exatamente a ação
// que executa. NÃO existe mais "gêmeo": são duas opções independentes lado a lado.
// =============================================================================
export function acaoKey(tool: string, codigoSsw: number): string {
  return `${tool}:${codigoSsw}`;
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
        // Caio 2026-07-23 (NF 1100040): a 59 SEMPRE disponível como opção
        // completa — a operadora decide mesmo quando o agente destacar outra.
        // Antes só existia o gêmeo sem-email da 59; faltava a versão que pede
        // os documentos por e-mail (romaneio + descrição/valor). Espelho da
        // entrada da regra oc=19 (separação 54/59: indenização → 59).
        codigo_ssw_proposto: 59,
        descricao_todo: "Lançar oc 59 + email pro cliente — indenização (pedir romaneio + descrição/valor)",
        descricao_acao: "Aguardando cliente enviar romaneio de coleta assinado + descrição/valor dos itens",
        enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
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
        // Caio 2026-07-23 (NF 1100040): a 59 SEMPRE disponível como opção
        // completa — a operadora decide mesmo quando o agente destacar outra.
        // Antes só existia o gêmeo sem-email da 59; faltava a versão que pede
        // os documentos por e-mail (romaneio + descrição/valor). Espelho da
        // entrada da regra oc=19 (separação 54/59: indenização → 59).
        codigo_ssw_proposto: 59,
        descricao_todo: "Lançar oc 59 + email pro cliente — indenização (pedir romaneio + descrição/valor)",
        descricao_acao: "Aguardando cliente enviar romaneio de coleta assinado + descrição/valor dos itens",
        enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
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
        // Caio 2026-07-23 (NF 1100040): a 59 SEMPRE disponível como opção
        // completa — a operadora decide mesmo quando o agente destacar outra.
        // Antes só existia o gêmeo sem-email da 59; faltava a versão que pede
        // os documentos por e-mail (romaneio + descrição/valor). Espelho da
        // entrada da regra oc=19 (separação 54/59: indenização → 59).
        codigo_ssw_proposto: 59,
        descricao_todo: "Lançar oc 59 + email pro cliente — indenização (pedir romaneio + descrição/valor)",
        descricao_acao: "Aguardando cliente enviar romaneio de coleta assinado + descrição/valor dos itens",
        enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
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
        // Caio 2026-07-23 (NF 1100040): a 59 SEMPRE disponível como opção
        // completa — a operadora decide mesmo quando o agente destacar outra.
        // Antes só existia o gêmeo sem-email da 59; faltava a versão que pede
        // os documentos por e-mail (romaneio + descrição/valor). Espelho da
        // entrada da regra oc=19 (separação 54/59: indenização → 59).
        codigo_ssw_proposto: 59,
        descricao_todo: "Lançar oc 59 + email pro cliente — indenização (pedir romaneio + descrição/valor)",
        descricao_acao: "Aguardando cliente enviar romaneio de coleta assinado + descrição/valor dos itens",
        enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
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
        // Caio 2026-07-13 (separação 54/59): oc=19 (entregue com falta) é INDENIZAÇÃO
        // (pede romaneio, nada físico a decidir) → RETORNO INDENIZAÇÃO (59), não 54.
        codigo_ssw_proposto: 59,
        descricao_todo: "Lançar oc 59 + email pro cliente — entregue com falta (pedir romaneio + descrição/valor)",
        descricao_acao: "Aguardando cliente enviar romaneio de coleta assinado + descrição/valor dos itens faltantes",
        // Codex 2026-07-02 (NF 609867): oc=19 é ENTREGA REALIZADA COM FALTA (pós-entrega).
        // O default era FALTA_DE_VOLUME ("seguir parcial ou devolução?" — template PRÉ-entrega,
        // não pede nada p/ o ressarcimento). Correto = ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (pede
        // romaneio + descrição + valor). Coerente com a oc 49 do Ressarcimento e com o dossiê.
        enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
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
    rationale: "Padrão Caio 2026-05-13 (atualizado Codex 2026-07-02): oc=19 (entrega realizada com falta de volumes = pós-entrega) → 4 caminhos: (a) 33 reversão de perdas (caso de extravio confirmado dos volumes faltantes); (b) 54 + email ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (pede romaneio + descrição/valor p/ abrir o ressarcimento — NÃO parcial×devolução, que é pré-entrega); (c) 55 autorizar seguir entrega parcial (cliente liberou ficar com o que recebeu); (d) 56 falta info (devolve pra Operação se evidência da entrega parcial está incompleta).",
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
  /**
   * Caio 2026-07-13 (Fase 4 — separação 54/59): CÓDIGO da oc que o agente destacou
   * pra a proposta "54 + e-mail" quando é INDENIZAÇÃO (59, RETORNO INDENIZAÇÃO) em vez
   * de TRATATIVA (54). Espelho do templateEmail54Override, mas pro número: sem isso, o
   * banner do oc49-total dizia 59 e o todo clicável saía 54 (mismatch de acao_key).
   * Aplicado na ORIGEM (regra.propostas) ANTES do dedup, pra idempotência (INV-030),
   * acao_key e código do todo ficarem consistentes. Só remapeia a proposta 54+email.
   */
  codigoSswClienteOverride?: number | null;
  /**
   * Caio 2026-07-08: instrução operacional que o agente pré-preencheu pra a
   * proposta de oc=56 (o que falta pra Operação). Semeada em
   * `meta.texto_ssw_sugerido` do todo cujo `codigo_ssw_proposto === 56` — o
   * front usa como prefill do textarea que vai pro campo Instrução do SSW
   * (editável). Só aplica quando a 56 é a proposta destacada pelo agente.
   */
  textoSsw56Override?: string | null;
  /**
   * OC 11 fora do raio (Isadora 07/08 + Caio 07/08): semeia NO PRÓPRIO TODO da
   * oc 21 o texto que a Operação precisa ler no SSW e a marcação de
   * cancelamento da reentrega. Vai em `args.extras` (não só em meta) de
   * propósito: assim a garantia não depende do front prefilar nem da operadora
   * digitar — aprovação em 1 clique já leva a informação.
   */
  oc21ForaDoRaioOverride?: {
    textoSsw: string;
    motivoCancelamento: string;
  } | null;
}

/**
 * Repatch IDEMPOTENTE do template do todo "54 + e-mail" ATIVO já existente
 * (Codex 2026-07-02, NF 609867 / classe NF 705764). Quando o agente decide um
 * `templateEmail54Override` mas o todo 54+email JÁ existe (criado antes pelo default
 * da regra), o override nunca o alcançava — ele só valia pro INSERT de proposta
 * PENDENTE, e o 54 já ativo é filtrado de `propostasPendentes` (dedup por código).
 * Aqui: acha o todo ATIVO tool=lancar_oc_e_enviar_email / codigo_ssw=54 e, se o
 * template diferir, ATUALIZA o PRÓPRIO todo (nunca cria gêmeo — INV-027/030,
 * uniq_todos_card_tool_cod_ativo), preservando email_destino/acao_key/meta/demais args.
 * No-op (retorna false) se já está com o override (idempotente) ou não há 54+email ativo.
 */
export async function repatcharTemplateEmail54Existente(
  supabase: SupabaseClient,
  params: {
    cardId: string;
    existingTodos: ReadonlyArray<Record<string, unknown>>;
    override: string;
    actorId: string;
    /** Caio 2026-07-13: código do todo a repatchar — 54 (tratativa) ou 59 (indenização). */
    codigoAlvo?: number;
  },
): Promise<boolean> {
  const ATIVOS = new Set(["pendente", "aprovado"]);
  // Caio 2026-07-13 (separação 54/59): casa o ÚNICO todo de e-mail de CLIENTE do card,
  // seja 54 (tratativa) ou 59 (indenização) — são mutuamente exclusivos por card. Antes
  // casava só `=== codigoAlvo (default 54)`: num card cuja regra já nasce 59 (oc=19) e sem
  // codigoSswClienteOverride, codigoAlvo=54 ≠ todo 59 → o repatch errava o alvo e o override
  // de template não aplicava. `params.codigoAlvo` fica só como documentação do caller.
  // Caio 2026-07-23 (REGRA 4 OPÇÕES, NF 1100040): 54+email e 59+email agora
  // COEXISTEM ('único todo de cliente' morreu). O repatch mira o todo do
  // TRILHO DESTACADO (codigoAlvo) e troca SÓ o template dele. NUNCA converte
  // 54↔59 (a conversão de 23/07-manhã comeu o 54+email da 1100040); se o todo
  // do trilho destacado não existe, no-op — proporAutoAcao (com o par nativo
  // nas regras) o cria na sequência.
  const codigoDesejado = params.codigoAlvo ?? 54;
  const alvo = params.existingTodos.find((t) => {
    const status = t["status"] as string | undefined;
    if (!status || !ATIVOS.has(status)) return false;
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    if (!pp || pp["tool"] !== "lancar_oc_e_enviar_email") return false;
    const a = pp["args"] as Record<string, unknown> | undefined;
    return a?.["codigo_ssw"] === codigoDesejado;
  });
  if (!alvo) return false;

  const pp = alvo["proposta_payload"] as Record<string, unknown>;
  const a = (pp["args"] ?? {}) as Record<string, unknown>;
  const atual = a["template_id"] as string | undefined;
  if (atual === params.override) return false; // idempotente — sem UPDATE, sem evento

  // Troca SÓ o template do todo do trilho destacado (codigo/acao_key intactos —
  // regra das 4 opções: nunca converter uma opção na outra).
  const novoPayload = { ...pp, args: { ...a, template_id: params.override } };
  const { error } = await supabase
    .from("todos")
    .update({ proposta_payload: novoPayload })
    .eq("id", alvo["id"] as string);
  if (error) return false;

  await supabase.from("card_events").insert({
    card_id: params.cardId,
    event_type: "TemplateEmail54OverrideAplicado",
    actor_type: "system",
    actor_id: params.actorId,
    payload: {
      todo_id: alvo["id"] ?? null,
      de: atual ?? null,
      para: params.override,
      codigo_trilho: codigoDesejado,
    },
  });
  return true;
}

/**
 * Repatch IDEMPOTENTE do todo "lancar oc 21" ATIVO já existente — espelho do
 * repatcharTemplateEmail54Existente pra oc 11 fora do raio (07/08, deploy da
 * padronização da Isadora). O override oc21ForaDoRaioOverride só valia pro
 * INSERT; cards cujo todo de 21 nasceu ANTES (sob a regra velha) ficavam sem
 * texto pro SSW e sem a marcação de cancelamento — os 4 primeiros re-analisados
 * em produção (NFs 1357857/139908/29250/63467) saíram exatamente assim.
 * Aqui: acha o todo ATIVO tool=lancar_ocorrencia / codigo_ssw=21 e, se ainda
 * não carrega o pacote, ATUALIZA o próprio todo (nunca cria gêmeo) semeando
 * args.extras (texto_descricao + cancelar_reentrega_24h + motivo) e o espelho
 * em meta. No-op se já está com o pacote ou não há todo de 21 ativo.
 */
export async function repatcharOc21ForaDoRaioExistente(
  supabase: SupabaseClient,
  params: {
    cardId: string;
    existingTodos: ReadonlyArray<Record<string, unknown>>;
    override: { textoSsw: string; motivoCancelamento: string };
    actorId: string;
  },
): Promise<boolean> {
  const ATIVOS = new Set(["pendente", "aprovado"]);
  const alvo = params.existingTodos.find((t) => {
    const status = t["status"] as string | undefined;
    if (!status || !ATIVOS.has(status)) return false;
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    if (!pp || pp["tool"] !== "lancar_ocorrencia") return false;
    const a = pp["args"] as Record<string, unknown> | undefined;
    return a?.["codigo_ssw"] === 21;
  });
  if (!alvo) return false;

  const pp = alvo["proposta_payload"] as Record<string, unknown>;
  const a = (pp["args"] ?? {}) as Record<string, unknown>;
  const extrasAtuais = (a["extras"] ?? {}) as Record<string, unknown>;
  if (
    extrasAtuais["cancelar_reentrega_24h"] === true &&
    extrasAtuais["texto_descricao"] === params.override.textoSsw
  ) {
    return false; // idempotente — sem UPDATE, sem evento
  }

  const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
  const novoPayload = {
    ...pp,
    args: {
      ...a,
      extras: {
        ...extrasAtuais,
        texto_descricao: params.override.textoSsw,
        cancelar_reentrega_24h: true,
        motivo_cancelamento: params.override.motivoCancelamento,
        origem: "agente-ocs-padrao-oc11-fora-do-raio",
      },
    },
    meta: {
      ...meta,
      texto_ssw_sugerido: params.override.textoSsw,
      cancelar_reentrega_sugerido: true,
    },
  };
  const { error } = await supabase
    .from("todos")
    .update({ proposta_payload: novoPayload })
    .eq("id", alvo["id"] as string);
  if (error) return false;

  await supabase.from("card_events").insert({
    card_id: params.cardId,
    event_type: "Oc21ForaDoRaioRepatchAplicado",
    actor_type: "system",
    actor_id: params.actorId,
    payload: {
      todo_id: alvo["id"] ?? null,
      texto_ssw: params.override.textoSsw,
      motivo_cancelamento: params.override.motivoCancelamento,
    },
  });
  return true;
}

/**
 * Cria todos automáticos quando a oc atual tem regra mapeada em REGRAS_AUTO_ACAO.
 * Move card pra AGUARDANDO_VALIDACAO_HUMANA + lock=true (exceto manter_state=true).
 * Idempotente — não cria 2º todo da mesma proposta.
 *
 * Falha graciosamente: se não acha chave_cte, registra evento e segue.
 */
/**
 * APOSENTADA (Caio 2026-07-23, regra das 4 OPÇÕES — NF 1100040): virou IDENTIDADE.
 *
 * História: nascida na Fase 4 da separação 54/59 (13/07), convertia a proposta
 * "54 + e-mail" pra 59 quando o agente destacava indenização. Com o par
 * 59+email NATIVO nas regras (23/07), a conversão passou a (a) gerar candidato
 * 59 duplicado e (b) COMER a opção 54+email de todo card que destacasse 59 —
 * violando a regra de produto: card com oc 49 tem SEMPRE as 4 opções
 * (54±email, 59±email); o agente sugere, a operadora decide, e a escolha
 * alimenta o loop de aprendizado. NUNCA converter opção — sempre garantir
 * ambas. Assinatura mantida pros 10 consumidores; comportamento = identidade.
 */
export function aplicarOverrideCodigoCliente(
  propostas: ReadonlyArray<PropostaRegra>,
  _codigoOverride: number | null | undefined,
): PropostaRegra[] {
  return [...propostas];
}

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

  // Codex 2026-07-03 (NF 156761): o repatch do template do todo "54 + e-mail" roda
  // ANTES dos state-gates abaixo — assim corrige o todo JÁ existente MESMO quando o
  // card está em AGUARDANDO_CLIENTE (antes ficava depois do gate, que dá `return`
  // p/ AGUARDANDO_CLIENTE não-manter_state → o agente re-invocado não repatchava
  // esses; precisou de backfill). NÃO cria proposta nem muda state/lock; só ATUALIZA
  // o template do todo ATIVO se houver override EXPLÍCITO do agente. Idempotente
  // (no-op se já está no override ou não há 54+email ativo). Query própria porque
  // `existingTodos` (abaixo) só é resolvido depois dos gates. Guarded por override →
  // no-op pros ~9 callers que não passam override (só o agente-sugere passa).
  // 07/08 (padronização oc 11): mesmo racional do repatch de template acima —
  // corrige o todo de 21 JÁ existente (nascido sob a regra velha, sem o pacote
  // fora-do-raio) ANTES dos state-gates. Guarded pelo override → no-op pros
  // 12 callers que não o passam (só o agente-sugere passa).
  if (args.oc21ForaDoRaioOverride) {
    const { data: todosParaRepatch21 } = await supabase
      .from("todos")
      .select("id, status, proposta_payload")
      .eq("card_id", cardId);
    await repatcharOc21ForaDoRaioExistente(supabase, {
      cardId,
      existingTodos: (todosParaRepatch21 ?? []) as Array<Record<string, unknown>>,
      override: args.oc21ForaDoRaioOverride,
      actorId,
    });
  }

  if (args.templateEmail54Override) {
    const { data: todosParaRepatch } = await supabase
      .from("todos")
      .select("id, status, proposta_payload")
      .eq("card_id", cardId);
    await repatcharTemplateEmail54Existente(supabase, {
      cardId,
      existingTodos: (todosParaRepatch ?? []) as Array<Record<string, unknown>>,
      override: args.templateEmail54Override,
      actorId,
      // Caio 2026-07-13: quando o destaque é 59 (indenização), repatcha o todo 59+email.
      codigoAlvo: args.codigoSswClienteOverride ?? 54,
    });
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

  // Caio 2026-06-25 (NF 1090036) / 2026-06-26 (NF 463457): "54 + e-mail" e
  // "lançar 54 SEM e-mail" são DUAS ações OPOSTAS que SEMPRE coexistem — NÃO são
  // variantes uma da outra (acabou o conceito de "gêmeo"). A dedup-por-código
  // sozinha tratava a "54 sem e-mail" (meta.sem_email_explicito) como se já
  // cobrisse o código 54 e SUPRIMIA pra sempre a "54 + e-mail" (a IA recomendada).
  // Caso real: card teve a opção sem-e-mail criada ANTES da re-análise da oc 49 →
  // toda createTodos seguinte filtrava a "54 + e-mail" pra fora. Fix: a ação
  // DELIBERADA sem_email_explicito NÃO ocupa o código pra efeito de dedup das
  // propostas da regra. A recriação dela continua idempotente
  // (garantirOpcaoLancarSemEmail via jaTemSemEmail), e a "54 + e-mail" já ativa
  // continua bloqueando a própria recriação (modo completo NÃO é sem_email_explicito).
  const codigosJaPropostos = new Set<number>();
  for (const t of (existingTodos ?? []) as Array<Record<string, unknown>>) {
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"];
    const status = t["status"] as string | undefined;
    if (typeof cod !== "number" || !status || !STATUS_ATIVOS.has(status)) continue;
    // Caio 2026-07-23 (NFs 7090/5606002, drenagem): gêmeos-LEGADO carregam só
    // meta.modo='sem_email' (sem a flag sem_email_explicito) — mesma semântica,
    // formato antigo. A exceção que só olhava a flag deixava o legado OCUPAR o
    // código e suprimir o par '+ e-mail' pra sempre (INV-047g pegou por dados).
    if (meta?.["sem_email_explicito"] === true || meta?.["modo"] === "sem_email") continue; // ação "sem e-mail" não suprime a "+ e-mail"
    codigosJaPropostos.add(cod);
  }

  // Caio 2026-06-09 (mig 195): removido gate sem_chave_cte. Portal interno
  // não precisa de chave_cte 44 dígitos — usa card.ctrc + buscarNFInterno.
  // chaveCTe pode permanecer null/undefined sem bloquear criação de propostas.
  // Caio 2026-06-23: cnpj/chave/todosCriados resolvidos AQUI (antes do early-
  // return) pra que garantirOpcaoLancarSemEmail rode mesmo quando propostasPendentes
  // está vazio (card já tem todas as opções, incluindo "54 + email").
  const cnpjPagador =
    (agentState["cnpj_pagador"] as string | undefined) ?? null;
  const cnpjRemetente =
    (agentState["cnpj_remetente"] as string | undefined) ?? cnpjPagador;
  // mig 320 (caso AGV): o resolver de e-mail recebe o remetente CRU — o
  // colapso null->pagador acima é pro CT-e, não pra escolha de contato.
  const cnpjRemetenteCru =
    (agentState["cnpj_remetente"] as string | undefined) ?? null;
  const chaveCTe = (agentState["chave_cte"] as string | undefined) ?? null;

  const todosCriados: Array<{ todoId: string; codigo: number; modoEmail: 'completo' | 'sem_email' }> = [];

  // Caio 2026-07-13 (separação 54/59): quando o agente destaca 59 (indenização),
  // a proposta "54 + e-mail" da regra vira "59 + e-mail" na ORIGEM — antes do dedup e
  // de toda a montagem do todo — pra idempotência (INV-030), acao_key e código do todo
  // casarem com o banner. Mesmo template; só o código muda. Só remapeia a 54 QUE TEM
  // e-mail (a proposta destacada; cada regra tem no máximo uma). Sem override → no-op.
  const propostasDaRegra = aplicarOverrideCodigoCliente(
    regra.propostas,
    args.codigoSswClienteOverride,
  );

  const propostasPendentes = propostasDaRegra.filter(
    (p) => !codigosJaPropostos.has(p.codigo_ssw_proposto),
  );

  // (o repatch de template 54+email agora roda ANTES dos state-gates — ver bloco
  //  `if (args.templateEmail54Override)` no topo da função. Codex 2026-07-03.)

  if (propostasPendentes.length === 0) {
    // Caio 2026-06-23: mesmo sem propostas NOVAS, garante a ação "lançar só a
    // oc, SEM e-mail" pros cards que já têm a opção "54 + e-mail" ATIVA mas nunca
    // ganharam a alternativa sem-e-mail (a opção sumiu quando passamos a ter
    // e-mail de quase todo cliente — antes vinha de graça via fallback
    // modoSemEmail). É justamente nesses cards que a dedup-por-código deixa
    // propostasPendentes vazio (todas as 5/8 opções já criadas). Âncoras:
    // NF 352420 (oc=35), NF 775856 (oc=49).
    await garantirOpcaoLancarSemEmail(supabase, {
      cardId,
      cardNf,
      chaveCTe,
      cnpjRemetente,
      // Caio 2026-07-13 (separação 54/59): passa a regra com as propostas REMAPEADAS
      // (propostasDaRegra) — senão garantirOpcaoLancarSemEmail itera cod=54 e nunca cria
      // o gêmeo "59 SEM e-mail" quando o override virou 59 (comEmailAtivo só tem 59).
      regra: { ...regra, propostas: propostasDaRegra },
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
            "Ação 'lançar só oc SEM e-mail' criada retroativamente (a opção 'com e-mail' do mesmo código já estava ativa no card). São ações independentes, não variantes.",
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
  type CfgRomaneio = {
    usa_romaneio_interno?: boolean;
    template_email_extravio_total?: string;
    nome_cliente?: string;
    romaneio_escopo?: string;
    romaneio_busca_chave?: string;
  };
  const cnpjPagadorNorm = cnpjPagador ? cnpjPagador.replace(/\D/g, "") : null;
  let cfgRomaneio: CfgRomaneio | null = null;
  if ([49, 10, 35].includes(codUltimaOc) && cnpjPagadorNorm) {
    const { data: cfg } = await supabase
      .from("cliente_config")
      .select("usa_romaneio_interno, template_email_extravio_total, nome_cliente, romaneio_escopo, romaneio_busca_chave")
      .eq("cnpj_pagador", cnpjPagadorNorm)
      .eq("ativo", true)
      .maybeSingle();
    cfgRomaneio = cfg as CfgRomaneio | null;
  }
  // Escopo por cliente (Caio 2026-08-11, SBD/Ingrid): 'sempre' (PRATI, default)
  // liga o trilho em qualquer extravio; 'so_parcial' (SBD) só quando o card é
  // extravio PARCIAL — no total a SBD PODE pedir romaneio por e-mail (padrão
  // 59+email), então o trilho interno não deve competir. A checagem do parcial
  // acontece adiante (ehParcialCard é computado depois deste bloco).
  const romaneioInternoConfigurado = !!(
    cfgRomaneio?.usa_romaneio_interno && cfgRomaneio.template_email_extravio_total
  );

  // Gate da oc 33 no extravio parcial (Caio 2026-07-01, NF 66193): anota cada
  // proposta de oc 33 com natureza + bloqueio (modo AVISADO — não remove a
  // proposta). Card não-parcial → ehParcialCard=false → zero mudança (extravio
  // total e demais fluxos intactos). Enforce autoritativo fica no executor.
  const estadoParcialCard = lerExtravioParcial({ agent_state: agentState });
  const ehParcialCard = estadoParcialCard !== null;
  // Trilho romaneio-interno EFETIVO = configurado + escopo satisfeito
  // ('so_parcial' exige card parcial — SBD/Ingrid, Caio 2026-08-11).
  const romaneioInternoAtivo = romaneioInternoConfigurado &&
    ((cfgRomaneio?.romaneio_escopo ?? "sempre") !== "so_parcial" || ehParcialCard);
  const casoParcialCard = estadoParcialCard?.caso ?? null;
  const dossieParcialCard = estadoParcialCard?.dossie ?? dossieVazio();
  const oc33BloqueadasRegra: Array<{ codigo: number; natureza: string; faltando: string[] }> = [];

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
      // Caio 2026-07-13: 54 e 59 (Cliente) aceitam o override de template do agente.
      // No oc49-total a proposta já veio remapeada p/ 59 (origem), então precisa do 59 aqui.
      (p.codigo_ssw_proposto === 54 || p.codigo_ssw_proposto === 59) &&
        p.enviar_email_template && args.templateEmail54Override
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
          p_cnpj_remetente: cnpjRemetenteCru,
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
    // Caio 2026-07-08: instrução operacional da 56 pré-preenchida pelo agente
    // (o que falta pra Operação). Front usa como prefill do textarea que vai pro
    // campo Instrução do SSW (extras.texto_descricao) — sempre editável. Só quando
    // o caller sinaliza que a 56 é a proposta destacada (textoSsw56Override).
    if (p.codigo_ssw_proposto === 56 && args.textoSsw56Override) {
      propostaMeta["texto_ssw_sugerido"] = args.textoSsw56Override;
    }

    // OC 11 FORA DO RAIO (Isadora 07/08 — "Padronização Ocorrência 11"; texto
    // exigido pelo Caio 07/08). Acima de 4.000 m o lançamento é improcedente:
    // a tratativa é oc 21 CANCELANDO a reentrega, e a Operação precisa LER no
    // SSW por que a reentrega parou ("BAIXA FEITA MUITO DISTANTE DO LOCAL DE
    // ENTREGA, CORRIGIR") pra gerar nova evidência.
    //
    // Os extras vão no PRÓPRIO todo (args.extras), não só em meta: assim a
    // informação chega ao SSW mesmo na aprovação de 1 clique pelo banner —
    // prefill de front é editável e pode ser limpo (classe de regressão
    // INV-041/046: "aprovação às cegas" já lançou 56 com casca vazia, NF 62566).
    //
    // Gatilho duplo (código 21 + override presente) de propósito: o mecanismo
    // cancelar_reentrega_24h é compartilhado com o vinculador e o agente da
    // oc 13 — vazar aqui cancelaria reentrega legítima em todo card com 21.
    if (p.codigo_ssw_proposto === 21 && args.oc21ForaDoRaioOverride) {
      const extrasOc21 = (propostaArgs["extras"] ?? {}) as Record<string, unknown>;
      extrasOc21["texto_descricao"] = args.oc21ForaDoRaioOverride.textoSsw;
      extrasOc21["cancelar_reentrega_24h"] = true;
      extrasOc21["motivo_cancelamento"] = args.oc21ForaDoRaioOverride.motivoCancelamento;
      extrasOc21["origem"] = "agente-ocs-padrao-oc11-fora-do-raio";
      propostaArgs["extras"] = extrasOc21;
      // Front: mostra o texto no modal (editável) e já deixa o checkbox de
      // cancelamento marcado — espelha o que o todo carrega.
      propostaMeta["texto_ssw_sugerido"] = args.oc21ForaDoRaioOverride.textoSsw;
      propostaMeta["cancelar_reentrega_sugerido"] = true;
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

    // Gate da oc 33 (extravio parcial): anota natureza + bloqueio pro front.
    // Só em card parcial; extravio total e demais fluxos ficam intactos.
    if (ehParcialCard && lancaOc33) {
      const natureza = classificarOc33({ codigo_ssw: p.codigo_ssw_proposto, tool }, casoParcialCard);
      if (natureza) {
        const g = decidirGateOc33(natureza, dossieParcialCard);
        propostaMeta["gate_oc33"] = { natureza, bloqueada: g.bloqueada, faltando: g.faltando };
        if (g.bloqueada) {
          oc33BloqueadasRegra.push({ codigo: p.codigo_ssw_proposto, natureza, faltando: g.faltando });
        }
      }
    }

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
          // Identidade única da ação (Caio 2026-06-26). Front destaca/vincula por
          // acao_key, nunca pelo número da oc — "lancar_oc_e_enviar_email:54" e
          // "lancar_ocorrencia:54" são ações DISTINTAS.
          acao_key: acaoKey(tool, p.codigo_ssw_proposto),
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
          p_cnpj_remetente: cnpjRemetenteCru,
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

        // Gate (extravio parcial, Caio 2026-07-01): esta ação também lança oc 33
        // (busca/anexa o romaneio interno) — em card PARCIAL é COMPLETUDE e não
        // pode furar o gate. PRATI parcial é raro, mas o bypass seria uma brecha.
        let gateRomaneioInterno: { natureza: string; bloqueada: boolean; faltando: string[] } | null = null;
        if (ehParcialCard) {
          const natR = classificarOc33({ tool: "enviar_email_e_lancar_33_romaneio_interno", codigo_ssw: 33 }, casoParcialCard);
          if (natR) {
            const gR = decidirGateOc33(natR, dossieParcialCard);
            gateRomaneioInterno = { natureza: natR, bloqueada: gR.bloqueada, faltando: gR.faltando };
            if (gR.bloqueada) oc33BloqueadasRegra.push({ codigo: 33, natureza: natR, faltando: gR.faltando });
          }
        }

        const { data: newTodo, error: todoErr } = await supabase
          .from("todos")
          .insert({
            card_id: cardId,
            action_id: crypto.randomUUID(),
            descricao: `Email + Lançar oc 33 — Extravio Total (${cfgRow.nome_cliente ?? "cliente"}, romaneio interno)`,
            status: "pendente",
            proposta_payload: {
              tool: "enviar_email_e_lancar_33_romaneio_interno",
              acao_key: acaoKey("enviar_email_e_lancar_33_romaneio_interno", 33),
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
                ...(gateRomaneioInterno ? { gate_oc33: gateRomaneioInterno } : {}),
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

  // Caio 2026-06-23: ação independente "lançar só a oc, SEM e-mail" pra cada
  // opção "54 + e-mail" criada/ativa neste card. Roda no fluxo normal (cards
  // novos e adição incremental). A versão dentro do early-return cobre os cards
  // já 100% propostos. Idempotente via meta.sem_email_explicito.
  await garantirOpcaoLancarSemEmail(supabase, {
    cardId,
    cardNf,
    chaveCTe,
    cnpjRemetente,
    // Caio 2026-07-13 (separação 54/59): regra com propostas REMAPEADAS (ver call site
    // do early-return) — habilita o gêmeo "59 SEM e-mail" quando o override virou 59.
    regra: { ...regra, propostas: propostasDaRegra },
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

  // Telemetria do gate da oc 33 (baseline p/ ligar o enforce). Só quando há
  // oc 33 bloqueada por dossiê incompleto num card de extravio parcial.
  if (oc33BloqueadasRegra.length > 0) {
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "Oc33BloqueadaDossieIncompleto",
      actor_type: "system",
      actor_id: actorId,
      payload: { origem: "regras_auto_acao", regra: `oc=${codUltimaOc}`, bloqueadas: oc33BloqueadasRegra },
    });
  }
}

// =============================================================================
// garantirOpcaoLancarSemEmail — Caio 2026-06-23 / reforçado 2026-06-26 (NF 463457)
//
// Pra cada proposta da regra que tem `enviar_email_template` (hoje só as
// variações de oc=54 "+ e-mail"), cria a AÇÃO INDEPENDENTE "lançar SÓ a oc no
// SSW, SEM disparar e-mail" — restaurando a opção que existia "de graça"
// enquanto faltava template/contato (modoSemEmail) e sumiu quando passamos a ter
// e-mail de quase todo cliente. Casos pontuais: a operadora avisa a IA que ela
// errou e segue pra outra oc, OU o e-mail já existe (thread pré-card). A
// "54 + e-mail" recomendada pela IA continua intocada.
//
// IMPORTANTE (NF 463457): "54 + e-mail" e "54 SEM e-mail" são AÇÕES OPOSTAS, não
// "gêmeas"/variantes. Cada uma tem `acao_key` própria (lancar_oc_e_enviar_email:54
// vs lancar_ocorrencia:54). O front destaca/vincula pela acao_key — nunca pelo
// número da oc — pra o banner mostrar EXATAMENTE a ação que executa.
//
// Independente da dedup-por-código do fluxo principal: as duas compartilham o
// codigo_ssw (54), então a dedup-por-código sozinha nunca criaria as duas em
// cards já propostos. Por isso a função é chamada também no early-return (cards
// 100% propostos) e roda direto no `existingTodos` já carregado (sem nova query).
//
// Regras:
//   - Só cria a ação sem-e-mail quando a "com e-mail" do MESMO código está ATIVA
//     (todo pré-existente OU recém-criado em modo completo). Se a 54 só existe
//     em modo sem_email (fallback por falta de template/contato), NÃO duplica.
//   - Idempotente: não recria se já há a ação sem-e-mail ativa (meta.sem_email_explicito).
//   - Pula codigo 33 (a 33 "+ e-mail" usa tool_override próprio, não este path).
//   - args.descricao = descricao_acao limpa (texto que vai pro SSW é igual ao
//     da "54 + e-mail"; o "sem e-mail" é distinção interna do Cockpit, não vai
//     pro SSW). A flag fica em proposta_payload.meta.sem_email_explicito.
// =============================================================================
async function garantirOpcaoLancarSemEmail(
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

  // Códigos com opção "com e-mail" ATIVA e códigos que já têm a ação sem-e-mail ativa —
  // derivados dos todos pré-existentes.
  const comEmailAtivo = new Set<number>();
  const jaTemSemEmail = new Set<number>();
  for (const t of existingTodos) {
    const status = t["status"] as string | undefined;
    if (!status || !STATUS_ATIVOS.has(status)) continue;
    const payload = t["proposta_payload"] as Record<string, unknown> | null;
    const tArgs = payload?.["args"] as Record<string, unknown> | undefined;
    const meta = payload?.["meta"] as Record<string, unknown> | undefined;
    const cod = tArgs?.["codigo_ssw"];
    if (typeof cod !== "number") continue;
    if (meta?.["sem_email_explicito"] === true) {
      jaTemSemEmail.add(cod);
    } else if (
      payload?.["tool"] === "lancar_oc_e_enviar_email" ||
      meta?.["modo"] === "completo" ||
      typeof tArgs?.["template_id"] === "string"
    ) {
      comEmailAtivo.add(cod);
    }
  }
  // Recém-criados neste run (a "54 + e-mail" criada agora também habilita a sem-e-mail).
  for (const t of todosCriados) {
    if (t.modoEmail === "completo") comEmailAtivo.add(t.codigo);
  }

  for (const p of regra.propostas) {
    if (!p.enviar_email_template) continue;
    const cod = p.codigo_ssw_proposto;
    if (cod === 33) continue;
    if (!comEmailAtivo.has(cod)) continue;
    if (jaTemSemEmail.has(cod)) continue;

    const { data: semEmailTodo, error: semEmailErr } = await supabase
      .from("todos")
      .insert({
        card_id: cardId,
        action_id: crypto.randomUUID(),
        // Caio 2026-06-26 (NF 463457): label INEQUÍVOCA e OPOSTA à "+ e-mail".
        // Lançar a oc SEM e-mail = o cliente NÃO é notificado. É uso deliberado,
        // não é variante/"gêmeo" da com-email — é outra ação.
        descricao: `⚠️ Lançar oc ${cod} SEM e-mail — NÃO notifica o cliente (lança a oc e segue; cliente fica sem aviso)`,
        status: "pendente",
        proposta_payload: {
          tool: "lancar_ocorrencia",
          // Identidade própria — distinta da "lancar_oc_e_enviar_email:<cod>".
          acao_key: acaoKey("lancar_ocorrencia", cod),
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
            // sendo oc 54, E EXIGIR CONFIRMAÇÃO ("cliente não será notificado").
            // Diferencia do fallback modoSemEmail (que carrega motivo_sem_email)
            // — aqui é opção deliberada, lado a lado (não derivada) da "+ e-mail".
            sem_email_explicito: true,
          },
        },
      })
      .select("id")
      .single();

    if (semEmailErr) {
      console.error(`auto-proposta opção sem-email oc=${codUltimaOc}→${cod}: ${semEmailErr.message}`);
      continue;
    }
    jaTemSemEmail.add(cod);
    if (semEmailTodo) {
      todosCriados.push({ todoId: semEmailTodo.id as string, codigo: cod, modoEmail: "sem_email" });
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
          acao_key: acaoKey("lancar_ocorrencia", p.codigo),
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
