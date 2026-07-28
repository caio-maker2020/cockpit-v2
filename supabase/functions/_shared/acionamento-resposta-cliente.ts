// =============================================================================
// FONTE ÚNICA: "resposta real de cliente acorda este card?"
//
// PREMISSA DO CAIO (2026-07-23, refinada após NF 73220):
//   1. Cliente respondeu + card ATIVO no Cockpit → o card SE MOVE. Sempre.
//   2. Card TRANSFERIDO/RESOLVIDO NÃO reaparece — transferido = alguém tratou.
//      Resposta nele ANEXA SEM MOVER (visível na aba Mensagens + evento de
//      auditoria; card não volta). Se a NF tiver OUTRO card ativo, a resposta
//      é ROTEADA pra ele (premissa 1 vale pro card vivo da NF) — roteamento
//      feito pelo caller (vinculador), não aqui.
//   3. Card novo criado depois pelas regras de negócio entra na premissa 1.
//
// Histórico: a 1ª versão deste fix (22-23/07) REABRIA card terminal — o Caio
// refinou a regra no mesmo dia: reabrir ressuscitava tratativa já tratada.
// O buraco original (NF 73220: romaneio mudo 7 dias) era um card que SÓ
// estava terminal por regressão (confirmador pré-59, corrigida 22/07);
// com o estado correto (AGUARDANDO_CLIENTE), a premissa 1 já o cobria.
//
// Por que fonte única: o vinculador tinha DUAS cópias divergentes dessa
// decisão (thread × NF) e a divergência criou o buraco. Nunca reimplementar
// inline (INV-042).
//
// Bounce/DSN nunca chega aqui: filtrado no gmail-poll-inbox (ehBounce, NF 5826).
// EXTRAVIO_MONITORADO fora de propósito (reconciliação própria, INV-017).
// =============================================================================

import {
  ehOcAguardandoCliente,
  OCORRENCIAS_DE_RELACIONAMENTO,
} from "./bastao-rules.ts";

/** Estados terminais: resposta anexa SEM mover (premissa 2). */
export const STATES_TERMINAIS_ANEXA_SEM_MOVER: ReadonlyArray<string> = [
  "TRANSFERIDO",
  "RESOLVIDO",
];

/**
 * Regra do Caio (2026-07-25, verbatim): "Se o card está ativo no cockpit
 * (AGUARDANDO CLIENTE), ele deve ser puxado sempre que tiver email do cliente
 * respondido. Se o card foi transferido (E SE ATENHA AO QUE É TRANSFERIDO:
 * não está mais com ocorrência de relacionamento ou cliente), mesmo se tiver
 * email não deve recriar ou puxar o card."
 *
 * Ou seja: quem define "está no cockpit" é a OCORRÊNCIA, não o rótulo do
 * estado. O confirmador marca TRANSFERIDO no instante do lançamento e o
 * próprio sweep reverte minutos depois ("NUNCA mantém TRANSFERIDO" com oc 54)
 * — resposta que chegava nessa janela era engolida pra sempre (NFs 150431/
 * 174438 24/07, 6 cards em 48h). Card "TRANSFERIDO" com oc de relacionamento/
 * cliente é transitório, não tratado.
 */
export function ocPertenceAoCockpit(oc: number | null | undefined): boolean {
  if (oc == null) return false;
  return ehOcAguardandoCliente(oc) || OCORRENCIAS_DE_RELACIONAMENTO.has(oc);
}

export type AcionamentoResposta =
  | { acao: "acionar" }
  | { acao: "anexar_sem_mover"; motivo: string }
  | { acao: "ignorar"; motivo: string };

/**
 * Decide o efeito de uma resposta real de cliente sobre o card.
 *
 * @param state estado atual do card no momento da resposta.
 * @param tinhaClienteRespondeu `cards.cliente_respondeu_em != null` — só é
 *   relevante quando state=AGUARDANDO_VALIDACAO_HUMANA (re-resposta em card
 *   já na aba CLIENTE RESPONDEU re-aciona a IA; AVH "normal" não).
 * @param ocAtual `cards.cod_ultima_ocorrencia` — desempata o terminal
 *   transitório (regra do Caio 25/07): estado terminal + oc de relacionamento/
 *   cliente = card AINDA é do cockpit → aciona. Sem oc (null/undefined),
 *   comportamento conservador antigo (anexa sem mover).
 */
export function decidirAcionamentoPorRespostaCliente(
  state: string | null | undefined,
  tinhaClienteRespondeu: boolean,
  ocAtual?: number | null,
  acaoCockpitRecente?: boolean,
): AcionamentoResposta {
  if (state === "AGUARDANDO_CLIENTE" || state === "ACAO_EXECUTADA") {
    return { acao: "acionar" };
  }
  if (state === "AGUARDANDO_VALIDACAO_HUMANA") {
    return tinhaClienteRespondeu
      ? { acao: "acionar" }
      : {
        acao: "ignorar",
        motivo:
          "AVH sem cliente_respondeu_em — card já tem propostas pendentes por outro motivo",
      };
  }
  if (state != null && STATES_TERMINAIS_ANEXA_SEM_MOVER.includes(state)) {
    // Regra do Caio 25/07: a OC define se o card é do cockpit. Terminal com
    // oc de relacionamento/cliente é TRANSITÓRIO (confirmador marcou e o
    // sweep vai reverter) — a resposta ACIONA, nunca é engolida.
    //
    // Corrida do TRANSFERIDO transitório (Duílio 2026-07-28, NFs 1494200/174873/
    // 20219): o confirmador marca TRANSFERIDO no INSTANTE do lançamento, mas
    // `cod_ultima_ocorrencia` só vira a oc de relacionamento quando o Bastão
    // sincroniza (minutos depois). Resposta que chega nessa janela é avaliada
    // com a oc DEFASADA (ocPertenceAoCockpit=false) e era engolida — mesmo o
    // card sendo aguardando-cliente de verdade. Sinal robusto e independente da
    // oc defasada: o Cockpit ACABOU de agir no SSW neste card (acaoCockpitRecente)
    // → card ainda está no fluxo, é transitório → ACIONA. Card genuinamente
    // terminal (entregue/transferido de área) NÃO tem ação Cockpit recente.
    if (ocPertenceAoCockpit(ocAtual) || acaoCockpitRecente === true) {
      return { acao: "acionar" };
    }
    return {
      acao: "anexar_sem_mover",
      motivo:
        "card terminal com oc FORA de relacionamento/cliente = tratado de verdade (premissa 2 + regra da oc, Caio 25/07) — mensagem anexa, card não volta; se houver card ativo da NF, caller roteia pra ele",
    };
  }
  return {
    acao: "ignorar",
    motivo: `state ${state ?? "null"} fora do acionamento por resposta de cliente`,
  };
}
