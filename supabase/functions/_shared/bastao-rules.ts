// Caio 2026-06-16: ANTES era AUTO-MIRROR de /lib/bastao-rules.ts (Set hardcoded
// `OCORRENCIAS_DE_RELACIONAMENTO`). Bug recorrente — drift entre planilha
// oficial (ocorrencias_dicionario) e hardcoded gerou cards roteados pro
// operador errado (NF 681942 oc=52 puxada pra Relacionamento em vez de
// Operação).
//
// Agora o Set é carregado do DB no cold start via top-level await:
//   SELECT codigo FROM ocorrencias_dicionario WHERE responsabilidade='Relacionamento'
// + oc=54 forçada como caso especial documentado (Cliente, mas tratada como
// "ainda no escopo Cockpit" pra Pass B reconhecer cards AGUARDANDO_CLIENTE).
//
// Fonte única: tabela `ocorrencias_dicionario` (mig 204 declarou como verdade
// absoluta). Edição da planilha → reimportar UPSERT → próximo cold start lê
// novo Set. Sem necessidade de tocar código.
//
// Fallback: se DB indisponível no cold start (rede/migration em andamento),
// usa Set hardcoded conservador. Edge segue funcionando, sem drift silencioso.
//
// `lib/bastao-rules.ts` continua com Set hardcoded síncrono — usado só pelos
// testes Bun, divergiu do _shared/ propositalmente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Fallback usado SE DB indisponível no cold start. Conservador: deixa entrar
// no Cockpit em caso de dúvida (operador resolve manual), em vez de
// transferir pra TRANSFERIDO erroneamente.
const FALLBACK_HARDCODED: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 54, 57,
]);

async function loadOcorrenciasRelacionamentoDoDicionario(): Promise<ReadonlySet<number>> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.warn("[bastao-rules] SUPABASE_URL/SERVICE_ROLE_KEY ausentes — usando fallback hardcoded");
    return FALLBACK_HARDCODED;
  }
  try {
    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await sb
      .from("ocorrencias_dicionario")
      .select("codigo")
      .eq("responsabilidade", "Relacionamento");
    if (error || !data) {
      console.warn(`[bastao-rules] dicionario lookup falhou (${error?.message ?? "data null"}) — fallback hardcoded`);
      return FALLBACK_HARDCODED;
    }
    const set = new Set<number>(data.map((r) => (r as { codigo: number }).codigo));
    // oc=54 (Cliente) é caso especial documentado: precisa estar no Set pra
    // Pass B reconhecer "ainda no escopo Cockpit" mesmo após state
    // AGUARDANDO_CLIENTE. Adicionada em runtime, não no DB.
    set.add(54);
    console.log(`[bastao-rules] OCORRENCIAS_DE_RELACIONAMENTO carregada do dicionario: ${[...set].sort((a,b)=>a-b).join(',')}`);
    return set;
  } catch (err) {
    console.warn(`[bastao-rules] dicionario lookup exception (${err}) — fallback hardcoded`);
    return FALLBACK_HARDCODED;
  }
}

// Top-level await: carrega 1x por cold start. ~50-150ms na 1ª request da edge.
export const OCORRENCIAS_DE_RELACIONAMENTO: ReadonlySet<number> =
  await loadOcorrenciasRelacionamentoDoDicionario();

// Caio 2026-05-12: substituído por leitura dinâmica de operadores.cockpit_ativo=true
// no runPassA. Antes era hardcode "LARISSA". Mantida como null pra compat caso
// algum outro caller importe — mas o sync-bastao não usa mais.
export const BASTAO_TEST_FILTER_OPERATOR: string | null = null;

export const VERIFICATION_TIMEOUT_MINUTES = 90;
export const SYNC_INTERVAL_MINUTES = 5;

/**
 * @deprecated Caio 2026-05-14 (multi-operador onboarding Duilio):
 * substituído por `resolveOperadorDoCard` em `operador-resolver.ts`.
 * Resolução agora é por hints (responsavel_relacionamento → carteira → segmento)
 * via lookup dinâmico em `operadores`. Constante mantida como null pra não
 * quebrar mirror em `lib/bastao-rules.ts` até cleanup completo do bundling.
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
