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

/** Sugestão mais velha que isto NÃO agenda — precisa de re-análise (caso NF
 *  26033: decisão de 20h re-armada pelo backfill enquanto o mundo mudava). */
export const TETO_IDADE_SUGESTAO_HORAS = 4;

export interface PropostaVeto {
  tool?: string;
  args?: {
    codigo_ssw?: number | string;
    descricao?: string | null;
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
  const extras = (proposta.args?.extras ?? {}) as Record<string, unknown>;
  if (acaoKey === "lancar_ocorrencia:56") {
    // Caio 26/08 (2ª rodada — NFs 133103/797315/895809/1036286): a 56 autônoma
    // exige texto no CANAL QUE O EXECUTOR VALIDA (extras.texto_descricao,
    // OCS_TEXTO_OBRIGATORIO). args.descricao NÃO conta: nos todos do menu ela
    // é boilerplate ("Cliente questionou evidência…") e o executor falharia
    // 3x + reverteria — foi exatamente o que aconteceu nas 4 execuções do 1º
    // dia. Sem texto REAL do agente (enxerto/tradução) → manual.
    const texto = ((extras["texto_descricao"] as string | undefined) ?? "").trim();
    if (!texto) faltando.push("texto_56");
  }
  if (acaoKey === "lancar_oc33_solo_portal:33") {
    // Caio 26/08: 33 SOLO autônoma só com anexos JÁ traduzidos pro canal do
    // executor (extras.anexos_ids) — o agendador faz a tradução a partir de
    // meta.anexos_sugeridos; e o gate do dossiê incompleto barra antes.
    const ids = extras["anexos_ids"];
    if (!Array.isArray(ids) || ids.length === 0) faltando.push("anexos_33");
    const gate = (proposta.meta?.["gate_oc33"] ?? null) as { bloqueada?: boolean } | null;
    if (gate?.bloqueada === true) faltando.push("dossie_incompleto");
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
  /** PILOTO (Caio 26/08): só FELIPE/ISABELY/LARISSA por ora — operador fora
   *  da tabela acoes_autonomas_veto_operadores fica 100% como hoje. */
  operadorNoPiloto: boolean;
  /** AcaoRevertidaPosFalha recente no card (risco 22: 1 tentativa, falhou → humano). */
  falhaRecenteNoCard: boolean;
  /** Mesma oc já executada pelo Cockpit no CICLO atual (risco 35 — régua 25/08). */
  mesmaAcaoNoCicloAtual: boolean;
  /** Operador JÁ VETOU esta ação neste ciclo (auditoria 25/08): re-análise
   *  nunca re-agenda por cima de um veto — o humano decidiu; robô não insiste. */
  vetadoPeloOperadorNoCiclo: boolean;
  /** Idade da SUGESTÃO que sustenta a ação, em horas (caso NF 26033: o
   *  backfill re-armou decisão de 20h e o mundo tinha mudado). null = fresca
   *  (agente acabou de decidir). */
  idadeSugestaoHoras: number | null;
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
  if (!c.operadorNoPiloto) return nao("operador_fora_do_piloto");

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
  if (c.idadeSugestaoHoras != null && c.idadeSugestaoHoras > TETO_IDADE_SUGESTAO_HORAS) {
    return nao("sugestao_velha_precisa_reanalise");
  }
  if (c.clienteComExcecao) return nao("cliente_com_excecao");

  if (c.confianca != null && c.confianca < c.pisoConfianca) {
    return nao("confianca_abaixo_do_piso");
  }

  return { elegivel: true };
}
