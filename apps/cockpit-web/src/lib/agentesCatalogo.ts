// =============================================================================
// Catálogo dos agentes — nome amigável + o que faz + o que sugere.
// Alimenta o "?" (tooltip) da Gestão Agentes (plano máquina-de-visão, 21/08).
// Conhecimento estrutural mantido em código de propósito: mudou o parque de
// agentes → atualizar aqui (guard: teste em gestaoAgentes.test.ts).
// =============================================================================

export interface AgenteInfo {
  nome: string;
  /** O que o agente faz, em 1 frase de operador. */
  oQueFaz: string;
  /** O que ele costuma sugerir. */
  oQueSugere: string;
}

export const AGENTES_CATALOGO: Record<string, AgenteInfo> = {
  "agente-sugere-ocs-padrao": {
    nome: "Sugestão de ocorrência",
    oQueFaz:
      "Analisa cards de recusa/avaria (ocs 10, 11, 19, 35, 49) e destaca a melhor ação pro operador aprovar.",
    oQueSugere: "Reentrega (21), aguardo do cliente (54), devolução (44), seguir entrega (55) ou falta info (56).",
  },
  "interpretador-resposta-cliente": {
    nome: "Leitura da resposta do cliente",
    oQueFaz:
      "Lê o e-mail que o cliente respondeu, entende a decisão dele e propõe a ocorrência correspondente.",
    oQueSugere: "A oc que o cliente pediu: devolução (44), reentrega (21), aguardo (54), falta info (56)…",
  },
  "agente-oc13-autonomo": {
    nome: "Exceções oc 13",
    oQueFaz:
      "Cuida dos cards de oc 13 (mercadoria retida) dos clientes com regra própria (O.V.D., SBD…).",
    oQueSugere: "54 + e-mail ao cliente, reentrega com cancelamento (21) ou encaminhar pra Operação (56).",
  },
  "scan-email-pre-card": {
    nome: "Varredura de e-mail",
    oQueFaz:
      "Vasculha e-mails que chegaram antes do card existir e anexa a decisão do cliente quando o card nasce.",
    oQueSugere: "A mesma família de ocs do interpretador, com base no e-mail antigo.",
  },
  "robo-intranet-wurth": {
    nome: "Robô da intranet Würth",
    oQueFaz:
      "Consulta a intranet da Würth 2x/dia, casa os retornos com os cards e sugere a tratativa.",
    oQueSugere: "Reentrega (21) com a instrução da Würth, ou devolução (44).",
  },
};

export function agenteAmigavel(agentName: string): string {
  return AGENTES_CATALOGO[agentName]?.nome ?? agentName;
}
