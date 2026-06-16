// AVISO IMPORTANTE (Caio 2026-06-16):
// Este arquivo serve APENAS pros testes Bun (lib/ é TypeScript estrito).
// Em RUNTIME (Deno edges) a verdade absoluta vem de `ocorrencias_dicionario`
// (mig 204) e é carregada dinamicamente em `_shared/bastao-rules.ts` via
// top-level await. Os dois arquivos podem divergir propositalmente.
//
// Pra atualizar este Set hardcoded (testes), reflita o conteúdo atual da
// planilha "Responsáveis por Ocorrência.xlsx" / tabela ocorrencias_dicionario.
//
// 54 (Cliente) é caso especial — precisa estar no Set pra Pass B reconhecer
// "ainda no escopo Cockpit" mesmo após state AGUARDANDO_CLIENTE (INV-010).
// Caio 2026-05-13 (bug crítico): removi 54 por erro de análise — Pass B
// moveu TODOS os cards AGUARDANDO_CLIENTE pra TRANSFERIDO. Restaurada.
// Caio 2026-06-16: removido 52 (Operação) + adicionado 57 (Relacionamento)
// pra alinhar com dicionário atual.
export const OCORRENCIAS_DE_RELACIONAMENTO: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 54, 57,
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
/**
 * @deprecated Caio 2026-05-14 (multi-operador onboarding Duilio):
 * substituído por `resolveOperadorDoCard` em `supabase/functions/_shared/operador-resolver.ts`.
 */
export const DEFAULT_OPERATOR_NAME_FOR_NEW_CARDS: string | null = null;

export function isOcorrenciaDeRelacionamento(codigo: number | null | undefined): boolean {
  if (codigo == null) return false;
  return OCORRENCIAS_DE_RELACIONAMENTO.has(codigo);
}

/**
 * Caio 2026-05-19: versão context-aware pra suportar exceções por CNPJ.
 *
 * Hoje oc=13 NÃO é de relacionamento — é responsabilidade do cliente final
 * e o CTRC de reentrega é emitido automaticamente pela operação. EXCETO pros
 * CNPJs em `cliente_config_oc13` (4 grupos, 12 CNPJs total: F E F, União
 * Química, O.V.D., Ferramentas Gerais), onde a reentrega NÃO é emitida auto
 * e o card precisa entrar no Cockpit pra Larissa/Duilio tratarem.
 *
 * Caller passa o Set de CNPJs em exceção (sync-bastao carrega 1x no Pass A).
 * Sem ctx ou sem cnpjPagador, retorna comportamento legacy.
 */
export function isOcorrenciaDeRelacionamentoCtx(
  codigo: number | null | undefined,
  ctx?: { cnpjPagador?: string | null; excecoesOc13?: ReadonlySet<string> },
): boolean {
  if (codigo == null) return false;
  if (OCORRENCIAS_DE_RELACIONAMENTO.has(codigo)) return true;
  // Exceção oc=13: cliente em cliente_config_oc13 vira caso de relacionamento.
  if (
    codigo === 13 &&
    ctx?.cnpjPagador &&
    ctx.excecoesOc13?.has(ctx.cnpjPagador)
  ) {
    return true;
  }
  return false;
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
