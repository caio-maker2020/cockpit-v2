// =============================================================================
// operacao-sugerir-ia — a rodada da edge `sugerir-operacao` (ADR 0041 D10/D11).
//
// Três passos, cada um com a sua trava:
//   1. PROMOVER encaminhamentos ao Relacionamento cuja janela de desfazer acabou
//      (RPC op_encaminhamentos_promover; ela mesma confere a flag da ponte e a
//      cerca). Sempre roda: um encaminhamento já agendado não pode ficar órfão.
//   2. SUGERIR por IA (flag `operacao_sugestao_ia`, OFF): itens abertos SEM
//      sugestão e sem cache para (op_item_id, oc atual). Antes de gastar uma
//      chamada, as regras (fixas e aprendidas) são relidas: casou regra → NÃO
//      chama a IA (o materializador grava a sugestão da regra). Teto de chamadas e
//      de tempo por rodada. Falha/descartada = sem sugestão, gravada no cache
//      para não pagar de novo pela mesma (item, oc).
//   3. ENCAMINHAR SOZINHO (flag `operacao_encaminhar_auto`, OFF): sugestões de
//      encaminhamento com confiança ≥ limiar viram encaminhamento AGENDADO, com
//      evento e janela para desfazer (RPC op_encaminhar_auto).
//
// I/O injetado → deno test com fakes.
// =============================================================================

import type { ItemAgente, ResultadoAgente } from "./operacao-agente-sugestao.ts";
import { type RegraAprendidaOperacao, type RegraSugestaoOperacao, sugerirPorRegras } from "./operacao-sugestao.ts";

export const FLAG_OPERACAO_SUGESTAO_IA = "operacao_sugestao_ia" as const;
export const FLAG_OPERACAO_ENCAMINHAR_AUTO = "operacao_encaminhar_auto" as const;

/** Chamadas à IA por rodada (cron de 10 min → ≤ 1.440/dia no pior caso). */
export const LIMITE_CHAMADAS_IA_POR_RODADA = 10;
/** Orçamento de tempo da rodada de IA (a edge tem ~150 s). */
export const ORCAMENTO_IA_MS = 90_000;
/** Limiar padrão do encaminhamento automático e o PISO (nem configurado abaixo disso). */
export const LIMIAR_ENCAMINHAR_AUTO_PADRAO = 0.9;
export const LIMIAR_ENCAMINHAR_AUTO_PISO = 0.8;
/** Janela para desfazer um encaminhamento automático antes de ele sair da Operação. */
export const JANELA_DESFAZER_AUTO_MIN_PADRAO = 30;
export const JANELA_DESFAZER_AUTO_MIN_PISO = 10;
export const LIMITE_ENCAMINHAR_AUTO_POR_RODADA = 20;
export const LIMITE_PROMOVER_POR_RODADA = 20;

/** Pura: limiar efetivo (env) — nunca abaixo do piso, nunca acima de 1. */
export function resolverLimiarAuto(valor: string | null | undefined): number {
  const n = Number(valor);
  if (!valor || !Number.isFinite(n)) return LIMIAR_ENCAMINHAR_AUTO_PADRAO;
  return Math.min(1, Math.max(LIMIAR_ENCAMINHAR_AUTO_PISO, n));
}

/** Pura: janela de desfazer efetiva (env, minutos) — nunca abaixo do piso. */
export function resolverJanelaAuto(valor: string | null | undefined): number {
  const n = Math.floor(Number(valor));
  if (!valor || !Number.isFinite(n)) return JANELA_DESFAZER_AUTO_MIN_PADRAO;
  return Math.max(JANELA_DESFAZER_AUTO_MIN_PISO, Math.min(24 * 60, n));
}

export interface CandidatoSugestaoIa extends ItemAgente {
  cod_ultima_ocorrencia: number;
}

export interface GravarSugestaoIa {
  op_item_id: string;
  oc: number;
  resultado: ResultadoAgente;
}

export interface RepoSugestaoIa {
  flagLigada(key: string): Promise<boolean>;
  /** RPC op_sugestao_ia_candidatos: abertos, sem sugestão, sem cache para (id, oc). */
  candidatos(limite: number): Promise<CandidatoSugestaoIa[]>;
  /** código → descrição, responsabilidade 'Operação'. */
  codigosOperacao(): Promise<Map<number, string>>;
  /** código → descrição, dicionário inteiro (descrição da oc atual). */
  descricoesOcorrencias(): Promise<Map<number, string>>;
  codigosLancaveisAtivos(): Promise<Set<number>>;
  regrasAprendidas(): Promise<RegraAprendidaOperacao[]>;
  /** RPC op_gravar_sugestao_ia: cache (item, oc) + sugestão em sombra + evento. */
  gravar(g: GravarSugestaoIa): Promise<string>;
  /** RPC op_encaminhar_auto. Devolve quantos foram agendados. */
  encaminharAuto(limiar: number, janelaMin: number, limite: number): Promise<number>;
  /** RPC op_encaminhamentos_promover. */
  promoverEncaminhamentos(limite: number): Promise<Record<string, number>>;
}

export type AgenteFn = (c: CandidatoSugestaoIa, ctx: {
  codigosOperacao: Map<number, string>;
  descricoes: Map<number, string>;
  lancaveis: Set<number>;
  regrasAprendidas: RegraAprendidaOperacao[];
}) => Promise<ResultadoAgente>;

export interface ResumoSugestaoIa {
  promovidos: Record<string, number>;
  ia: "flag_off" | "rodou" | "erro";
  candidatos: number;
  regra_casou: number;
  chamadas: number;
  por_status: Record<string, number>;
  gravacao: Record<string, number>;
  parou_por_tempo: boolean;
  auto: "flag_off" | "rodou" | "erro";
  agendados_auto: number;
  erros: string[];
}

function conta(m: Record<string, number>, k: string, n = 1): void {
  m[k] = (m[k] ?? 0) + n;
}

export async function rodarSugestaoIa(deps: {
  repo: RepoSugestaoIa;
  agente: AgenteFn;
  regrasFixas?: readonly RegraSugestaoOperacao[];
  agora?: () => number;
  limiteChamadas?: number;
  orcamentoMs?: number;
  limiarAuto?: number;
  janelaAutoMin?: number;
}): Promise<ResumoSugestaoIa> {
  const agora = deps.agora ?? Date.now;
  const inicio = agora();
  const r: ResumoSugestaoIa = {
    promovidos: {}, ia: "flag_off", candidatos: 0, regra_casou: 0, chamadas: 0, por_status: {}, gravacao: {},
    parou_por_tempo: false, auto: "flag_off", agendados_auto: 0, erros: [],
  };
  const erro = (onde: string, e: unknown) => r.erros.push(`${onde}: ${e instanceof Error ? e.message : String(e)}`);

  // 1. Promover os agendados vencidos (a RPC confere flag da ponte e cerca).
  try {
    r.promovidos = await deps.repo.promoverEncaminhamentos(LIMITE_PROMOVER_POR_RODADA);
  } catch (e) {
    erro("promover", e);
  }

  // 2. Sugestão por IA.
  try {
    if (await deps.repo.flagLigada(FLAG_OPERACAO_SUGESTAO_IA)) {
      r.ia = "rodou";
      const limite = deps.limiteChamadas ?? LIMITE_CHAMADAS_IA_POR_RODADA;
      // Busca um pouco mais que o teto: parte deles pode casar regra (sem custo).
      const cands = await deps.repo.candidatos(limite * 3);
      r.candidatos = cands.length;
      if (cands.length > 0) {
        const [codigosOperacao, descricoes, lancaveis, regrasAprendidas] = await Promise.all([
          deps.repo.codigosOperacao(),
          deps.repo.descricoesOcorrencias(),
          deps.repo.codigosLancaveisAtivos(),
          deps.repo.regrasAprendidas().catch((e) => {
            erro("regras aprendidas", e);
            return [] as RegraAprendidaOperacao[];
          }),
        ]);
        for (const c of cands) {
          const regra = sugerirPorRegras({
            item: c, regrasFixas: deps.regrasFixas, regrasAprendidas, codigosLancaveisAtivos: lancaveis, agoraMs: agora(),
          });
          if (regra) {
            r.regra_casou++;
            continue; // a regra manda; o materializador grava (nada de IA)
          }
          if (r.chamadas >= limite) break;
          if (agora() - inicio > (deps.orcamentoMs ?? ORCAMENTO_IA_MS)) {
            r.parou_por_tempo = true;
            break;
          }
          r.chamadas++;
          const res = await deps.agente(c, { codigosOperacao, descricoes, lancaveis, regrasAprendidas });
          conta(r.por_status, res.status);
          try {
            conta(r.gravacao, await deps.repo.gravar({ op_item_id: c.op_item_id, oc: c.cod_ultima_ocorrencia, resultado: res }));
          } catch (e) {
            erro(`gravar ${c.op_item_id}`, e);
          }
        }
      }
    }
  } catch (e) {
    r.ia = "erro";
    erro("ia", e);
  }

  // 3. Encaminhamento automático (só agenda; a janela de desfazer corre).
  try {
    if (await deps.repo.flagLigada(FLAG_OPERACAO_ENCAMINHAR_AUTO)) {
      r.auto = "rodou";
      r.agendados_auto = await deps.repo.encaminharAuto(
        Math.max(LIMIAR_ENCAMINHAR_AUTO_PISO, deps.limiarAuto ?? LIMIAR_ENCAMINHAR_AUTO_PADRAO),
        Math.max(JANELA_DESFAZER_AUTO_MIN_PISO, deps.janelaAutoMin ?? JANELA_DESFAZER_AUTO_MIN_PADRAO),
        LIMITE_ENCAMINHAR_AUTO_POR_RODADA,
      );
    }
  } catch (e) {
    r.auto = "erro";
    erro("auto", e);
  }
  return r;
}
