// =============================================================================
// veto-elegibilidade — as CERCAS da janela de veto, PURAS e testáveis
// (Etapa D do plano 25/08). Cada cerca reprovada devolve um MOTIVO distinto:
// o agendador loga e a Auditoria conta por motivo (o que mais barra vira
// pauta de destravamento).
//
// Ordem deliberada: das cercas de sistema (flag/escada) pras de conteúdo e
// então as situacionais. A PRIMEIRA reprovada ganha — motivo único e estável.
// =============================================================================

/** Extras com efeito embutido que NUNCA executam sozinhos (risco 24).
 *  Exceção do Caio: cancelar_reentrega_24h da oc 21 é PERMITIDO (a regra das
 *  24h existente segue valendo) — por isso NÃO está aqui. */
export const EXTRAS_PROIBIDOS_VETO: ReadonlySet<string> = new Set([
  "skip_oc",
  "skip_evidencia",
]);

export interface PropostaVeto {
  tool?: string;
  args?: {
    codigo_ssw?: number | string;
    template_id?: string | null;
    email_destino?: string | null;
    extras?: Record<string, unknown> | null;
  };
  meta?: Record<string, unknown> | null;
}

/** Risco 7 (classe NF 158084): ação só agenda com o CONTEÚDO completo. */
export function conteudoCompletoParaVeto(
  acaoKey: string,
  proposta: PropostaVeto | null | undefined,
): { completo: boolean; faltando: string[] } {
  const faltando: string[] = [];
  if (!proposta?.tool || proposta.args?.codigo_ssw == null) {
    return { completo: false, faltando: ["proposta_sem_tool_ou_codigo"] };
  }
  if (acaoKey.startsWith("lancar_oc_e_enviar_email:")) {
    // INV-041 emendado (ADR 0016): a janela É o olhar — mas só quando o card
    // MOSTRA o e-mail completo. Sem template semeado ou sem destinatário
    // resolvido não há o que mostrar → manual (risco 19).
    if (!proposta.args?.template_id) faltando.push("template_email");
    if (!proposta.args?.email_destino) faltando.push("destinatario_resolvido");
  }
  return { completo: faltando.length === 0, faltando };
}

export interface CercasVeto {
  flagMasterOn: boolean;
  acaoAtivaNaEscada: boolean;
  acaoKey: string | null;
  proposta: PropostaVeto | null;
  temTodoPendente: boolean;
  operadorDonoId: string | null;
  /** AcaoRevertidaPosFalha recente no card (risco 22: 1 tentativa, falhou → humano). */
  falhaRecenteNoCard: boolean;
  /** Mesma oc já executada pelo Cockpit no CICLO atual (risco 35 — régua 25/08). */
  mesmaAcaoNoCicloAtual: boolean;
  /** Operador JÁ VETOU esta ação neste ciclo (auditoria 25/08): re-análise
   *  nunca re-agenda por cima de um veto — o humano decidiu; robô não insiste. */
  vetadoPeloOperadorNoCiclo: boolean;
  /** Pagador com exceção registrada (cerca alimentada pelos cancelamentos). */
  clienteComExcecao: boolean;
  confianca: number | null;
  pisoConfianca: number;
}

export type ResultadoElegibilidade =
  | { elegivel: true }
  | { elegivel: false; motivo: string };

export function decidirElegibilidadeVeto(c: CercasVeto): ResultadoElegibilidade {
  const nao = (motivo: string): ResultadoElegibilidade => ({ elegivel: false, motivo });

  if (!c.flagMasterOn) return nao("flag_master_off");
  if (!c.acaoKey) return nao("sem_acao_key");
  if (!c.acaoAtivaNaEscada) return nao("acao_inativa_na_escada");
  if (!c.temTodoPendente) return nao("todo_nao_encontrado");
  if (!c.operadorDonoId) return nao("card_sem_operador_dono");

  const extras = (c.proposta?.args?.extras ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(extras)) {
    if (EXTRAS_PROIBIDOS_VETO.has(k) && extras[k] === true) {
      return nao(`extra_proibido:${k}`);
    }
  }

  const conteudo = conteudoCompletoParaVeto(c.acaoKey, c.proposta);
  if (!conteudo.completo) return nao(`conteudo_incompleto:${conteudo.faltando.join(",")}`);

  if (c.falhaRecenteNoCard) return nao("falha_recente_no_card");
  if (c.mesmaAcaoNoCicloAtual) return nao("mesma_acao_no_ciclo");
  if (c.vetadoPeloOperadorNoCiclo) return nao("vetado_pelo_operador_no_ciclo");
  if (c.clienteComExcecao) return nao("cliente_com_excecao");

  if (c.confianca != null && c.confianca < c.pisoConfianca) {
    return nao("confianca_abaixo_do_piso");
  }

  return { elegivel: true };
}
