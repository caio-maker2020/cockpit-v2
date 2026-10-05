// =============================================================================
// analise-nova-entrada — a análise do agente vale pra UMA entrada do card.
//
// Caio 05/10 (INV-168): "cada vez que o card teve alteração de ocorrência, o
// agente sugere de novo com base no novo contexto". Antes a re-análise da MESMA
// oc (10 → 54 → 10) dependia só do aviso estar nulo + de um teto VITALÍCIO de 3
// tentativas (`analise_padrao_tentativas` nunca zerava no sucesso): depois da 3ª
// análise da vida do card, a oc repetida nunca mais era re-analisada pelo cron.
// Casos-âncora: NF 807171 (teto em 3 desde 29/09; reaberta com 49 em 02/10 e
// aprovada 5h depois sem análise) e NF 2509611 (teto em 5–7).
//
// Regra: a análise está VELHA quando
//   (1) o card ENTROU de novo depois dela (evento de entrada posterior), ou
//   (2) o histórico do card já mostra uma ocorrência do MESMO código mais nova
//       que a analisada (oc nova sem o card sair de AGUARDANDO VOCÊ).
// Funções PURAS. O teto por dia (anti-loop de custo) fica no caller.
// =============================================================================

import { EVENTOS_ABERTURA_CICLO } from "./ciclos-tratativa.ts";
import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

/** Eventos que marcam uma ENTRADA do card em tratativa (abertura de ciclo OU
 *  volta dentro do mesmo ciclo — 54/59 respondida pela operação com oc nova). */
export const EVENTOS_NOVA_ENTRADA: ReadonlyArray<string> = [
  ...EVENTOS_ABERTURA_CICLO,
  "AguardandoClienteOcMudou",
  "OcComRegraChegouEmParaFazer",
];

/** Evento gravado quando a análise é invalidada por entrada nova (auditoria +
 *  contador do teto diário). */
export const EVENTO_ANALISE_INVALIDADA_NOVA_ENTRADA = "AnaliseInvalidadaPorNovaEntrada";

/** Teto de re-análises por entrada nova, por card, em 24h. Corta custo de IA se
 *  um card entrar em vai-e-volta (classe oc 57: ~90 reaberturas em 30 dias). */
export const MAX_REANALISES_POR_ENTRADA_24H = 3;

export type MotivoAnaliseVelha = "entrada_posterior" | "ocorrencia_mais_nova";

export interface EntradaAnaliseVelha {
  /** cards.analise_padrao_atualizado_em (ISO). */
  analiseEmIso: string | null;
  /** created_at do evento de entrada mais recente do card (ISO) ou null. */
  ultimaEntradaIso: string | null;
  /** analise_padrao_resultado.oc_data_analisada ("DD/MM/YY HH:MM") ou null. */
  ocDataAnalisada: string | null;
  /** cards.historico_ssw (cache). */
  historicoSsw: ReadonlyArray<{ codigo?: number | null; data?: string | null }> | null;
  codigoOc: number;
}

/** PURO: a análise guardada é anterior à entrada/ocorrência atual? */
export function motivoAnaliseVelha(i: EntradaAnaliseVelha): MotivoAnaliseVelha | null {
  const analiseMs = i.analiseEmIso ? new Date(i.analiseEmIso).getTime() : NaN;
  const entradaMs = i.ultimaEntradaIso ? new Date(i.ultimaEntradaIso).getTime() : NaN;
  if (Number.isFinite(analiseMs) && Number.isFinite(entradaMs) && entradaMs > analiseMs) {
    return "entrada_posterior";
  }
  const analisadaMs = parseSswDataHoraBrt(i.ocDataAnalisada);
  if (analisadaMs != null) {
    let maisNova: number | null = null;
    for (const o of i.historicoSsw ?? []) {
      if (o?.codigo !== i.codigoOc) continue;
      const t = parseSswDataHoraBrt(o.data ?? null);
      if (t != null && (maisNova == null || t > maisNova)) maisNova = t;
    }
    if (maisNova != null && maisNova > analisadaMs) return "ocorrencia_mais_nova";
  }
  return null;
}
