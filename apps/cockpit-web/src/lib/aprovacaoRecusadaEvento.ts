// =============================================================================
// aprovacaoRecusadaEvento — registra a aprovação que a PAREDE recusou.
//
// Karol 2026-09-11 (NF 436268): o buraco de medição que deixou este problema
// invisível por meses. Quando `aprovar_e_executar` faz RAISE EXCEPTION, a
// transação inteira volta atrás — nenhum INSERT dela sobrevive, nem o
// `AprovacaoOperador`. E o front só mostrava um toast e esquecia. Resultado
// medido em 11/09: 903 eventos `Oc33BloqueadaDossieIncompleto` no banco, TODOS
// de `regras_auto_acao` montando a proposta, ZERO de operadora clicando. A
// pergunta "quantas vezes a Karol bateu nessa parede?" não tinha resposta.
//
// Este módulo monta o evento; quem grava é o `onError` da mutation, FORA da
// transação que morreu. Best-effort: falhar aqui NUNCA pode atrapalhar a
// operadora — ela já levou o erro real na tela.
//
// ⚠ RLS `card_events_insert_operator` exige `actor_type='operator'` E
//   `actor_id = current_operador_id()::text` E o card ser dela. Foi exatamente
//   aqui que a telemetria do conversor de PDF ficou CEGA de 08/09: mandava a
//   string "front-conversao-pdf" como actor_id e todo insert era recusado em
//   silêncio pelo catch. Por isso `operadorId` é obrigatório e a função devolve
//   `null` sem ele — em vez de montar um evento que o banco vai rejeitar.
//   (Existe ainda `trava_visualizacao_ins`: operador em modo visualização não
//   insere. Também não aprova, então não há caso a registrar.)
// =============================================================================

/**
 * Cancelamento local (operadora fechou o popup de divergência / desistiu do
 * motivo). NÃO é recusa da parede — nada a registrar. FONTE ÚNICA: o
 * ProposedActions importa daqui. Era um `const` solto dentro do componente;
 * duplicar o literal aqui criaria duas verdades que silenciosamente divergem, e
 * o lado errado passaria a gravar "cancelei" como se fosse recusa do banco.
 */
export const MSG_APROVACAO_CANCELADA = "aprovacao_cancelada_pelo_operador";

export interface EventoAprovacaoRecusada {
  card_id: string;
  event_type: "AprovacaoRecusadaNaParede";
  actor_type: "operator";
  actor_id: string;
  payload: Record<string, unknown>;
}

/**
 * Extrai o código da recusa ("OC33_DOSSIE_INCOMPLETO", "FEEDBACK_OC49_OBRIGATORIO"…)
 * — o prefixo em CAIXA ALTA antes do primeiro ':'. Sem prefixo reconhecível,
 * devolve "OUTRO": agrupar erro solto por mensagem inteira não gera métrica.
 */
export function codigoDaRecusa(mensagem: string | null | undefined): string {
  if (!mensagem) return "OUTRO";
  const m = /^([A-Z][A-Z0-9_]{2,63}):/.exec(mensagem.trim());
  return m?.[1] ?? "OUTRO";
}

/**
 * Monta o evento, ou `null` quando não se deve registrar.
 *
 * `null` quando: falta card/todo/operador (RLS recusaria), ou o "erro" é o
 * cancelamento local do próprio operador (ele desistiu; não houve parede).
 */
export function montarEventoAprovacaoRecusada(args: {
  cardId: string | null | undefined;
  todoId: string | null | undefined;
  operadorId: string | null | undefined;
  mensagemErro: string | null | undefined;
  propostaPayload?: unknown;
  extrasEnviados?: Record<string, unknown> | null;
}): EventoAprovacaoRecusada | null {
  const { cardId, todoId, operadorId, mensagemErro } = args;
  if (!cardId || !todoId || !operadorId) return null;
  if (mensagemErro === MSG_APROVACAO_CANCELADA) return null;

  const pl = (args.propostaPayload ?? {}) as Record<string, unknown>;
  const meta = (pl["meta"] ?? {}) as Record<string, unknown>;
  const argsPl = (pl["args"] ?? {}) as Record<string, unknown>;

  // Quantos anexos a operadora tinha marcado quando levou a recusa. É a medida
  // do trabalho perdido — o motivo de o relato ter chegado como "os anexos não
  // vão pro SSW".
  const anexos = args.extrasEnviados?.["anexos_ids"];
  const anexosSelecionados = Array.isArray(anexos) ? anexos.length : 0;

  return {
    card_id: cardId,
    event_type: "AprovacaoRecusadaNaParede",
    actor_type: "operator",
    actor_id: operadorId,
    payload: {
      todo_id: todoId,
      motivo_codigo: codigoDaRecusa(mensagemErro),
      mensagem: (mensagemErro ?? "").slice(0, 500),
      tool: typeof pl["tool"] === "string" ? pl["tool"] : null,
      codigo_ssw: argsPl["codigo_ssw"] ?? null,
      gate_oc33: meta["gate_oc33"] ?? null,
      anexos_selecionados: anexosSelecionados,
      origem: "front_aprovar_e_executar",
    },
  };
}
