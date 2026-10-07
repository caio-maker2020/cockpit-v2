// =============================================================================
// operacao-sugestao — sugestão de lançamento para a fila da Operação (ADR 0041, D6).
//
// REGRAS PURAS, sem LLM nesta fase. A sugestão é gravada EM SOMBRA no item
// (op_itens.sugestao + evento SugestaoGerada): ela nunca lança nada sozinha.
// Aceitar é um clique de pessoa, com a prévia do que vai ao SSW confirmada
// (RPC op_aceitar_sugestao, que relê a cerca de card ativo e a lista de códigos).
//
// A TABELA NASCE VAZIA. Cada regra nova entra por commit revisável, com teste,
// e só sugere código que a Operação pode lançar (nunca os proibidos). Mesmo com
// regra, a sugestão só vira botão se o código estiver ATIVO em op_codigos_lancaveis
// (`lancavel`); senão fica só como registro em sombra, para medir.
//
// PURO (sem I/O): deno test.
// =============================================================================

import { OCS_PROIBIDAS_OPERACAO, OCS_TEXTO_OBRIGATORIO_OPERACAO, normalizarUnidade } from "./operacao-comum.ts";

/** Muda quando a tabela de regras muda: entra no registro em sombra para medir por versão. */
export const VERSAO_REGRAS_SUGESTAO_OPERACAO = "v0-vazia-2026-10-07";

export interface RegraSugestaoOperacao {
  id: string;
  descricao: string;
  quando: {
    /** Última oc do item (Bastão) — obrigatório: regra sem oc pegaria tudo. */
    ocs: readonly number[];
    /** A oc está parada há pelo menos isto (horas), pela data_ultima_ocorrencia. */
    horasParadoMin?: number;
    /** Só nestas unidades (vazio/ausente = todas). */
    unidades?: readonly string[];
  };
  sugerir: { codigo: number; texto: string };
}

/**
 * A tabela de regras. VAZIA de propósito (conservadora): a Operação ainda não
 * disse quais padrões quer ver sugeridos, e uma sugestão errada ensina o clique
 * errado. Ver ADR 0041, D6, "Como uma regra entra".
 */
export const REGRAS_SUGESTAO_OPERACAO: readonly RegraSugestaoOperacao[] = [];

export interface ItemParaSugestao {
  cod_ultima_ocorrencia: number | null;
  data_ultima_ocorrencia: string | null;
  unidade: string | null;
}

export interface SugestaoOperacao {
  regra_id: string;
  codigo: number;
  texto: string;
  motivo: string;
  /** true só se o código está ATIVO em op_codigos_lancaveis agora. */
  lancavel: boolean;
  versao_regras: string;
}

/** Pura: problemas de uma tabela de regras (vazio = válida). Travado em teste. */
export function validarRegrasSugestao(regras: readonly RegraSugestaoOperacao[]): string[] {
  const erros: string[] = [];
  const ids = new Set<string>();
  for (const r of regras) {
    if (!r.id || ids.has(r.id)) erros.push(`regra com id vazio ou repetido: "${r.id}"`);
    ids.add(r.id);
    if (!r.quando.ocs || r.quando.ocs.length === 0) erros.push(`${r.id}: regra sem oc pegaria a fila inteira`);
    if (OCS_PROIBIDAS_OPERACAO.has(r.sugerir.codigo)) {
      erros.push(`${r.id}: sugere a oc ${r.sugerir.codigo}, que a Operação nunca lança`);
    }
    if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(r.sugerir.codigo)) {
      erros.push(`${r.id}: a oc ${r.sugerir.codigo} existe pelo texto do operador (INV-046); sugestão não escreve por ele`);
    }
    if (r.sugerir.texto.trim().length < 3) erros.push(`${r.id}: texto sugerido vazio`);
    if (r.sugerir.texto.length > 400) erros.push(`${r.id}: texto sugerido passa de 400 caracteres`);
  }
  return erros;
}

function horasDesde(iso: string | null, agoraMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (agoraMs - t) / 3_600_000 : null;
}

/** Pura: a primeira regra que casa decide. Sem regra que case → null. */
export function sugerirLancamentoOperacao(args: {
  item: ItemParaSugestao;
  regras?: readonly RegraSugestaoOperacao[];
  codigosLancaveisAtivos: ReadonlySet<number>;
  agoraMs: number;
}): SugestaoOperacao | null {
  const regras = args.regras ?? REGRAS_SUGESTAO_OPERACAO;
  const oc = args.item.cod_ultima_ocorrencia;
  if (oc === null) return null;
  const unidade = normalizarUnidade(args.item.unidade);
  for (const r of regras) {
    if (!r.quando.ocs.includes(oc)) continue;
    // Regra inválida nunca sugere (defesa além do teste da tabela).
    if (OCS_PROIBIDAS_OPERACAO.has(r.sugerir.codigo) || OCS_TEXTO_OBRIGATORIO_OPERACAO.has(r.sugerir.codigo)) continue;
    if (r.quando.unidades && r.quando.unidades.length > 0) {
      if (!unidade || !r.quando.unidades.map((u) => normalizarUnidade(u)).includes(unidade)) continue;
    }
    if (r.quando.horasParadoMin !== undefined) {
      const h = horasDesde(args.item.data_ultima_ocorrencia, args.agoraMs);
      if (h === null || h < r.quando.horasParadoMin) continue;
    }
    return {
      regra_id: r.id,
      codigo: r.sugerir.codigo,
      texto: r.sugerir.texto.trim(),
      motivo: r.descricao,
      lancavel: args.codigosLancaveisAtivos.has(r.sugerir.codigo),
      versao_regras: VERSAO_REGRAS_SUGESTAO_OPERACAO,
    };
  }
  return null;
}
