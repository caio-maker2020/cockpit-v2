// AUTO-MIRROR de /lib/bastao-rules.ts — não edite direto.
// Atualize /lib/bastao-rules.ts e copie aqui antes do deploy.
// (Lib/ vive em TypeScript estrito Bun-testável; _shared/ é pra Deno runtime.)

export const OCORRENCIAS_DE_RELACIONAMENTO: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52, 54, 58,
]);

// Caio 2026-05-12: substituído por leitura dinâmica de operadores.cockpit_ativo=true
// no runPassA. Antes era hardcode "LARISSA". Mantida como null pra compat caso
// algum outro caller importe — mas o sync-bastao não usa mais.
export const BASTAO_TEST_FILTER_OPERATOR: string | null = null;

export const VERIFICATION_TIMEOUT_MINUTES = 90;
export const SYNC_INTERVAL_MINUTES = 5;

/**
 * Quando vinculador cria card sem dados do Bastão (caminho SSW tracking ou
 * incompleto), atribui o card a esse operador por default. Garante que o
 * TEST_FILTER do executor reconheça e processe.
 *
 * Em produção (todos os 11 operadores), implementar atribuição inteligente
 * via tabela contato → cliente → segmento → operador. Por enquanto, fixo.
 */
export const DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS: string | null = "LARISSA";

export function isOcorrenciaDeRelacionamento(codigo: number | null | undefined): boolean {
  if (codigo == null) return false;
  return OCORRENCIAS_DE_RELACIONAMENTO.has(codigo);
}

/**
 * Caio 2026-05-11: state final de um card após Bastão confirmar a oc atual.
 * Usado pelo sync-bastao em 2 lugares (Pass A e Pass G).
 *
 * Regra:
 *   - oc=54 → AGUARDANDO_CLIENTE (sem lock)
 *   - oc finalizadora (1/30/32) → RESOLVIDO (sem lock)
 *   - oc relacionamento + tem REGRAS_AUTO_ACAO mapeada → AGUARDANDO_VALIDACAO_HUMANA + lock
 *   - oc relacionamento + SEM regra mapeada → AGUARDANDO_AGENTE (PARA FAZER), sem lock
 *     (regra Caio 2026-05-11: sem opções sugeridas, card fica em PARA FAZER aguardando
 *      próxima oc do Bastão. Se vier oc de operação, Pass A move pra TRANSFERIDO.)
 *   - outras → TRANSFERIDO (sem lock)
 */
export const OCS_FINALIZADORAS: ReadonlySet<number> = new Set([1, 30, 32]);

export function stateFinalAposBastao(
  oc: number,
  ocTemRegraAutoAcao: boolean,
): { state: string; lock: boolean } {
  if (oc === 54) return { state: "AGUARDANDO_CLIENTE", lock: false };
  if (OCS_FINALIZADORAS.has(oc)) return { state: "RESOLVIDO", lock: false };
  if (OCORRENCIAS_DE_RELACIONAMENTO.has(oc)) {
    return ocTemRegraAutoAcao
      ? { state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true }
      : { state: "AGUARDANDO_AGENTE", lock: false };
  }
  return { state: "TRANSFERIDO", lock: false };
}
