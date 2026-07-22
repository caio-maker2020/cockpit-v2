// =============================================================================
// Detector: recusa/falta no destino (oc 10/19/35) ORIGINADA de extravio anterior
// (oc 6/9/16) que o cliente ainda NÃO foi notificado.
//
// Caio 2026-06-24 (NF 148558): sequência oc=6 (extravio) → operação mandou pra
// entrega → oc=10 (recusa) "não recebe faltando volume". A recusa foi causada
// pelo extravio. Regra do Caio: existe 6/9/16 E NÃO existe 20/54/49 lançada
// DEPOIS do extravio (= operador ainda não notificou o cliente da falta).
// Nesse caso o agente sinaliza o conflito de contexto pro operador.
//
// Caio 2026-06-25 (NF 179799): a AÇÃO sugerida depende da oc da recusa/falta —
// oc=19 e oc=35 NÃO são iguais:
//   - oc=19 (ENTREGUE com falta): os volumes faltantes foram EXTRAVIADOS
//     (perdidos) — NÃO há nada físico a devolver. É só NOTIFICAÇÃO + pedido de
//     romaneio + descrição + valor pra abrir o ressarcimento (extravio parcial).
//     NUNCA pergunta "devolução x nova entrega".
//   - oc=10/35 (RECUSA): EXISTE volume físico parado no destino → pergunta
//     destino (devolução x nova entrega) E pede romaneio + descrição + valor.
// Quem decide template/mensagem é montarSugestaoRecusaPorExtravio (abaixo).
//
// Fonte ÚNICA da regra — consumida pelo agente-sugere-ocs-padrao. Funções puras,
// testáveis (recusa-por-extravio.test.ts).
// =============================================================================

/** Ocorrências de extravio que originam a recusa. */
export const OCS_EXTRAVIO = new Set<number>([6, 9, 16]);

/**
 * Ocorrências cuja presença DEPOIS do extravio indica que o cliente já foi
 * notificado / o relacionamento já assumiu a tratativa.
 *   20 = relacionamento, 54 = aguardando cliente, 49 = tratativa relacionamento.
 *   Caio 2026-07-13 (separação 54/59): 59 (RETORNO INDENIZAÇÃO) também é "cliente
 *   notificado" — extravio TOTAL agora notifica via 59 (extravio-enrichment).
 */
export const OCS_NOTIFICOU_APOS_EXTRAVIO = new Set<number>([20, 54, 59, 49]);

export interface OcComCodigo {
  codigo: number | null;
}

/**
 * Ocorrências de RECUSA PARCIAL no destino. Caio 2026-07-06 (NF 28002): quando
 * uma dessas aparece no histórico, o contexto é RECUSA PARCIAL — a rota de
 * extravio da oc=49 (decidirOc49 Caso 1) NÃO pode sobrepor sugerindo
 * EXTRAVIO_PARCIAL. A oc=35 prevalece como RECUSA_PARCIAL.
 */
export const OCS_RECUSA_PARCIAL = new Set<number>([35]);

/**
 * Retorna a ocorrência de recusa parcial (oc=35) mais recente do histórico
 * (que deve vir MAIS-RECENTE-PRIMEIRO), ou null se não houver. Usado pela
 * precedência recusa-sobre-extravio no agente-sugere-ocs-padrao.
 */
export function recusaParcialNoHistorico<T extends OcComCodigo>(
  historico: T[],
): T | null {
  for (const o of historico) {
    if (o.codigo != null && OCS_RECUSA_PARCIAL.has(o.codigo)) return o;
  }
  return null;
}

/**
 * Retorna a ocorrência de extravio (6/9/16) quando há extravio no histórico E
 * NÃO há 20/54/49 lançada depois dele; senão null.
 *
 * `historico` deve vir MAIS-RECENTE-PRIMEIRO (como o puxar-historico-ssw-card
 * devolve). "Lançada depois do extravio" = índice MENOR que o do extravio.
 */
export function recusaOriginadaDeExtravioNaoNotificada<T extends OcComCodigo>(
  historico: T[],
): T | null {
  const idxExtravio = historico.findIndex(
    (o) => o.codigo != null && OCS_EXTRAVIO.has(o.codigo),
  );
  if (idxExtravio === -1) return null;
  for (let i = 0; i < idxExtravio; i++) {
    const c = historico[i]?.codigo;
    if (c != null && OCS_NOTIFICOU_APOS_EXTRAVIO.has(c)) return null; // já notificou
  }
  return historico[idxExtravio] ?? null;
}

export interface SugestaoRecusaExtravio {
  /** Template de e-mail final que o agente deve sugerir. */
  template: string;
  /** Texto do banner / observacao_orquestrador pro operador. */
  observacao: string;
  /**
   * true => o e-mail pergunta destino (devolução x nova entrega) porque há
   * volume físico parado (oc 10/35). false => oc=19, só notifica + romaneio.
   */
  perguntaDestino: boolean;
}

/**
 * Decide template + mensagem de conflito quando a recusa/falta foi originada de
 * extravio anterior NÃO notificado.
 *
 * DIFERENÇA ESSENCIAL oc=19 x oc=35 (Caio 2026-06-25, NF 179799):
 *   - oc=19 (entregue COM falta): volumes faltantes EXTRAVIADOS (perdidos) — não
 *     há nada a devolver. Mantém o template default da oc=19 (que só notifica +
 *     pede romaneio/descrição/valor); NUNCA pergunta destino.
 *   - oc=10/35 (recusa): existe volume físico → template combinado que pergunta
 *     destino (devolução x nova entrega) + pede romaneio/descrição/valor.
 *
 * `templatePadraoDaOc` é o template default da oc (usado no ramo oc=19).
 */
export function montarSugestaoRecusaPorExtravio(
  codigoOc: number,
  templatePadraoDaOc: string,
  extravioOc: number | null,
  extravioData: string | null,
): SugestaoRecusaExtravio {
  const ref = `oc=${extravioOc}${extravioData ? ` em ${extravioData}` : ""}`;
  if (codigoOc === 19) {
    return {
      template: templatePadraoDaOc, // ENTREGUE_COM_FALTA_PEDIR_ROMANEIO
      perguntaDestino: false,
      observacao:
        `⚠️ CONFLITO DE CONTEXTO: a falta na entrega (oc=19) foi originada de um ` +
        `extravio anterior (${ref}) do qual o cliente ainda NÃO foi notificado. ` +
        `Como na oc=19 a entrega foi feita COM falta (volumes extraviados — não há ` +
        `nada a devolver), sugere oc=54 + e-mail que SÓ notifica a falta e pede ` +
        `romaneio + descrição + valor dos itens pra abrir o ressarcimento (futuro oc=33).`,
    };
  }
  return {
    template: "RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR",
    perguntaDestino: true,
    observacao:
      `⚠️ CONFLITO DE CONTEXTO: a recusa (oc=${codigoOc}) foi originada de um extravio ` +
      `anterior (${ref}) do qual o cliente ainda NÃO foi notificado. Sugere oc=54 + ` +
      `e-mail combinado: notifica a falta, pergunta devolução x nova entrega E pede ` +
      `romaneio + descrição + valor dos itens pra abrir o ressarcimento (futuro combo 33+44).`,
  };
}
