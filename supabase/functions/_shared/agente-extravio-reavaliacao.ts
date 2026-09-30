// =============================================================================
// agente-extravio-reavaliacao — regras PURAS de quando o agente D+4 volta a
// olhar um card que ele já marcou (Carlos 2026-09-29, NFs 14877 e 787209).
//
// O scan só olhava `agente_extravio_status IS NULL`, e a marcação 'lancou'
// nunca era desfeita (só o agente-oc43 zera). Dois furos da MESMA causa:
//   1. a 49 FALHOU no SSW (429, sessão, timeout) → o executor reverte o card
//      pra EXTRAVIO_MONITORADO, mas a marcação fica 'lancou' → ninguém tenta
//      de novo (NF 14877, 21/09);
//   2. o card TEVE UM NOVO EXTRAVIO depois de um ciclo já tratado → o sync
//      devolve o card pra Extravios sem desfazer a marcação → o novo ciclo não
//      é contado (NF 787209: 49 em 16/09, novo extravio em 23/09).
// A decisão é DERIVADA dos dados a cada rodada (data do extravio × data da
// marcação; eventos append-only) — nada depende de outro fluxo zerar campo.
//
// E o upgrade pedido pelo Carlos (29/09): "achou e perdeu de novo" (extravio →
// 20 "extravio localizado" → extravio) recebe a 49 no mesmo dia, sem esperar o
// limiar. Nasce em OBSERVAÇÃO (flag OFF): o agente só anota quem receberia.
// =============================================================================

import { EXTRAVIO_OCS } from "./agente-extravio-regras.ts";

/** Tentativas da 49 do agente por ciclo de extravio antes de chamar a operadora. */
export const MAX_TENTATIVAS_49_POR_CICLO = 3;

/** Liga o lançamento imediato da reincidência. Ausente/false = só observação. */
export const FLAG_REINCIDENCIA_IMEDIATA = "extravios_reincidencia_imediata_enabled";

/** Ocorrência SSW "Extravio localizado" (dicionário: 20). */
export const OC_EXTRAVIO_LOCALIZADO = 20;

/** Data (YYYY-MM-DD) em BRT fixo -03:00 — mesma convenção do horario-comercial.ts. */
export function dataBrt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type DecisaoReavaliacao =
  /** Segue a regra de sempre (limiar de dias úteis + pré-checagem SSW). */
  | { tipo: "avaliar_normal"; motivo: "sem_marcacao" | "ciclo_novo" }
  /** A 49 do agente falhou neste ciclo — tenta de novo (com pré-checagem SSW). */
  | { tipo: "tentar_de_novo"; tentativa: number }
  /** Falhou MAX vezes — para de tentar e manda pra operadora (NÃO RODOU). */
  | { tipo: "avisar_operadora"; tentativas: number }
  /** Nada a fazer (49 já saiu neste ciclo, execução em andamento, outra marcação). */
  | { tipo: "ignorar"; motivo: string };

export interface EstadoReavaliacao {
  /** cards.agente_extravio_status */
  status: string | null;
  /** cards.agente_extravio_checado_em (ISO) */
  checadoEm: string | null;
  /** cards.bastao_data_ultima_ocorrencia (YYYY-MM-DD) — data do extravio atual */
  dataExtravio: string | null;
  /**
   * `data_extravio` gravada no AgenteExtravioLancou49 mais recente (a partir de
   * 30/09). null = lançamento antigo, sem esse campo.
   */
  dataExtravioTratado: string | null;
  /** Existe 49 com sucesso em acoes_executadas_ssw desde a marcação. */
  teve49ComSucessoDepois: boolean;
  /** O todo da ÚLTIMA 49 do agente foi revertido por falha (AcaoRevertidaPosFalha). */
  ultimaTentativaFalhou: boolean;
  /** AgenteExtravioLancou49 do card desde a data do extravio atual. */
  tentativasNoCiclo: number;
}

/**
 * Decide o que o agente faz com um card na aba Extravios. `status` nulo segue
 * EXATAMENTE a regra de antes (não muda nada pra quem nunca foi marcado).
 */
export function decidirReavaliacaoAgente(e: EstadoReavaliacao): DecisaoReavaliacao {
  if (e.status == null) return { tipo: "avaliar_normal", motivo: "sem_marcacao" };
  if (e.status !== "lancou") return { tipo: "ignorar", motivo: `marcacao_${e.status}` };

  if (ehCicloNovo(e)) return { tipo: "avaliar_normal", motivo: "ciclo_novo" };

  if (e.teve49ComSucessoDepois) return { tipo: "ignorar", motivo: "49_ja_lancada_neste_ciclo" };
  if (!e.ultimaTentativaFalhou) return { tipo: "ignorar", motivo: "sem_falha_registrada" };
  if (e.tentativasNoCiclo < MAX_TENTATIVAS_49_POR_CICLO) {
    return { tipo: "tentar_de_novo", tentativa: e.tentativasNoCiclo + 1 };
  }
  return { tipo: "avisar_operadora", tentativas: e.tentativasNoCiclo };
}

/**
 * O extravio atual é OUTRO, posterior ao que o agente já tratou?
 * - Com `dataExtravioTratado` (lançamentos a partir de 30/09): só se a data do
 *   extravio atual for MAIS NOVA. Igual = mesmo ciclo (inclui a 49 imediata da
 *   reincidência, que sai no mesmo dia do extravio — nunca relança). Mais velha =
 *   Bastão atrasado, não é ciclo novo.
 * - Lançamento antigo (sem o campo): extravio do dia da marcação ou depois. Vale
 *   porque o caminho antigo só lançava com >= 2 dias úteis de extravio (piso do
 *   limiar) — o extravio tratado era sempre anterior ao dia da marcação.
 */
export function ehCicloNovo(
  e: Pick<EstadoReavaliacao, "checadoEm" | "dataExtravio" | "dataExtravioTratado">,
): boolean {
  if (!e.dataExtravio) return false;
  if (e.dataExtravioTratado) return e.dataExtravio > e.dataExtravioTratado;
  const diaMarcacao = dataBrt(e.checadoEm);
  return diaMarcacao != null && e.dataExtravio >= diaMarcacao;
}

/** Texto (pra operadora) quando o SSW recusou a 49 todas as vezes. */
export function motivoFalhasSsw(tentativas: number, ultimoErro: string | null): string {
  const erro = ultimoErro ? ` Último erro do SSW: ${ultimoErro.slice(0, 160)}` : "";
  return `Tentei lançar a oc 49 ${tentativas} vezes e o SSW recusou todas.${erro} Lance a 49 à mão ou reporte.`;
}

/**
 * "Achou e perdeu de novo" (Carlos 29/09) no histórico do SSW, do MAIS NOVO pro
 * MAIS ANTIGO (ordem do listarOcorrenciasNF). Verdadeiro só quando:
 *   - a última ocorrência com código é extravio (6/9/16) — o extravio atual; e
 *   - antes do episódio atual existe um 20 ("extravio localizado") que veio
 *     depois de um extravio anterior.
 * Extravios seguidos sem nada no meio (06, 06) são o MESMO episódio. Extravio
 * → tratativa → extravio (sem 20) e coleta (9) → transferência (6) NÃO contam.
 */
export function ehReincidenciaAchouEPerdeu(
  codigosMaisNovoPrimeiro: ReadonlyArray<number | null | undefined>,
): boolean {
  const cods = codigosMaisNovoPrimeiro
    .filter((c): c is number => typeof c === "number")
    .slice()
    .reverse(); // cronológico
  const n = cods.length;
  if (n === 0 || !EXTRAVIO_OCS.has(cods[n - 1]!)) return false;
  // Exigir um 20 ENTRE dois extravios já faz de "06, 06" um episódio só: numa
  // repetição seguida não existe 20 no meio.
  const antes = cods.slice(0, n - 1);
  const ultimoLocalizado = antes.lastIndexOf(OC_EXTRAVIO_LOCALIZADO);
  if (ultimoLocalizado < 0) return false;
  return antes.slice(0, ultimoLocalizado).some((c) => EXTRAVIO_OCS.has(c));
}
