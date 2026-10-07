// =============================================================================
// operacao-sugestao — sugestão para a fila da Operação (ADR 0041, D6 e D10).
//
// TRÊS CAMADAS, nesta ordem (a primeira que responde decide; INV-188):
//   0. REGRA FIXA  — `REGRAS_SUGESTAO_OPERACAO`, no código, por commit revisável.
//   1. REGRA APRENDIDA do histórico — tabela `op_regras_sugestao` (mig 434), no
//      formato {estado → ação, código, texto, confiança, casos, base_regra}. Nasce
//      VAZIA; a carga vem de uma migration TIPO B gerada a partir de regras.json
//      (formato em `RegraAprendidaOperacao` e no ADR 0041 D10).
//   2. AGENTE DE IA — só quando nenhuma regra casa (`operacao-agente-sugestao.ts`),
//      fora deste módulo, atrás da flag `operacao_sugestao_ia` (OFF).
//
// A sugestão é gravada EM SOMBRA no item (op_itens.sugestao + evento
// SugestaoGerada): ela nunca lança nada sozinha. Aceitar é um clique de pessoa,
// com a prévia do que vai ao SSW confirmada. A sugestão pode ser de dois tipos:
//   - `lancar_ocorrencia`  : um código que a Operação lança (nunca os proibidos);
//   - `encaminhar_relacionamento`: o próximo passo é do Relacionamento (cliente,
//     reentrega autorizada, devolução, indenização…). O botão é "Encaminhar ao
//     Relacionamento" (prévia + clique; ADR 0041 D11).
//
// PURO (sem I/O): deno test.
// =============================================================================

import { OCS_PROIBIDAS_OPERACAO, OCS_TEXTO_OBRIGATORIO_OPERACAO, normalizarUnidade } from "./operacao-comum.ts";

/** Muda quando a tabela de regras FIXAS muda: entra no registro em sombra para medir por versão. */
export const VERSAO_REGRAS_SUGESTAO_OPERACAO = "v0-vazia-2026-10-07";
/** Versão do CONTRATO do campo op_itens.sugestao (ver `SugestaoOperacao`). */
export const VERSAO_CONTRATO_SUGESTAO = 2 as const;
/** Texto sugerido: cabe nas "Informações complementares" do SSW (70). A Instrução aceita 500. */
export const TEXTO_SUGESTAO_MAX = 70;

/** Regra aprendida só decide com pelo menos isto de confiança e de casos (abaixo: vira contexto do agente). */
export const MIN_CONFIANCA_REGRA_APRENDIDA = 0.6;
export const MIN_CASOS_REGRA_APRENDIDA = 5;

export type AcaoSugestao = "lancar_ocorrencia" | "encaminhar_relacionamento";
export type FonteSugestao = "regra_fixa" | "regra_aprendida" | "agente_ia";

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
  sugerir:
    | { acao?: "lancar_ocorrencia"; codigo: number; texto: string }
    | { acao: "encaminhar_relacionamento"; texto: string };
}

/**
 * A tabela de regras FIXAS. VAZIA de propósito (conservadora): a Operação ainda não
 * disse quais padrões quer ver sugeridos, e uma sugestão errada ensina o clique
 * errado. Ver ADR 0041, D6, "Como uma regra entra".
 */
export const REGRAS_SUGESTAO_OPERACAO: readonly RegraSugestaoOperacao[] = [];

/**
 * Uma regra APRENDIDA do histórico (linha de `op_regras_sugestao`, ou elemento do
 * regras.json que gera a migration de carga). "Estado" = a situação do item.
 *
 * regras.json (array):
 *   { "id": "h13-vga-36", "estado": { "oc": 13, "unidade": "VGA" | null, "dias_parado_min": 2 | null },
 *     "acao": "lancar_ocorrencia" | "encaminhar_relacionamento",
 *     "codigo": 36 | null,          // null só quando acao = encaminhar_relacionamento
 *     "texto": "...",               // ≤ 70
 *     "confianca": 0.83,            // 0..1 = acertos / casos no histórico
 *     "casos": 41,                  // nº de casos que embasam
 *     "base_regra": "historico:2026-07..2026-09" }
 */
export interface RegraAprendidaOperacao {
  id: string;
  estado: { oc: number; unidade?: string | null; dias_parado_min?: number | null };
  acao: AcaoSugestao;
  codigo: number | null;
  texto: string;
  confianca: number;
  casos: number;
  base_regra: string;
  ativo?: boolean;
}

/** Seed da camada 1 no código: VAZIO. As regras reais vêm da tabela (carga TIPO B). */
export const REGRAS_APRENDIDAS_SEED: readonly RegraAprendidaOperacao[] = [];

export interface ItemParaSugestao {
  cod_ultima_ocorrencia: number | null;
  data_ultima_ocorrencia: string | null;
  unidade: string | null;
}

/**
 * CONTRATO do campo `op_itens.sugestao` (jsonb), versão 2. Ver ADR 0041 D10.
 * Campos sempre presentes: versao_contrato, acao, fonte, base_regra, regra_id,
 * codigo, texto, motivo, lancavel, confianca, casos, oc_base, versao_regras.
 * Só do agente: modelo, versao_prompt, justificativa.
 */
export interface SugestaoOperacao {
  versao_contrato: typeof VERSAO_CONTRATO_SUGESTAO;
  acao: AcaoSugestao;
  fonte: FonteSugestao;
  /** regra_fixa: o id; regra_aprendida: base_regra da linha; agente_ia: "agente_ia". */
  base_regra: string;
  /** Compat (op_lancamentos.sugestao_regra_id). Para o agente: "agente_ia". */
  regra_id: string;
  /** null quando acao = encaminhar_relacionamento. */
  codigo: number | null;
  texto: string;
  motivo: string;
  /** true só se acao = lancar_ocorrencia e o código está ATIVO em op_codigos_lancaveis agora. */
  lancavel: boolean;
  /** 0..1; regra fixa = null (não é estimativa). */
  confianca: number | null;
  casos: number | null;
  /** A oc do item quando a sugestão foi feita: oc mudou → a sugestão vale mais nada. */
  oc_base: number | null;
  versao_regras: string;
  modelo?: string | null;
  versao_prompt?: string | null;
  justificativa?: string | null;
}

/** Pura: problemas de uma tabela de regras fixas (vazio = válida). Travado em teste. */
export function validarRegrasSugestao(regras: readonly RegraSugestaoOperacao[]): string[] {
  const erros: string[] = [];
  const ids = new Set<string>();
  for (const r of regras) {
    if (!r.id || ids.has(r.id)) erros.push(`regra com id vazio ou repetido: "${r.id}"`);
    ids.add(r.id);
    if (!r.quando.ocs || r.quando.ocs.length === 0) erros.push(`${r.id}: regra sem oc pegaria a fila inteira`);
    if (r.sugerir.acao !== "encaminhar_relacionamento") {
      const codigo = r.sugerir.codigo;
      if (OCS_PROIBIDAS_OPERACAO.has(codigo)) erros.push(`${r.id}: sugere a oc ${codigo}, que a Operação nunca lança`);
      if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(codigo)) {
        erros.push(`${r.id}: a oc ${codigo} existe pelo texto do operador (INV-046); sugestão não escreve por ele`);
      }
    }
    if (r.sugerir.texto.trim().length < 3) erros.push(`${r.id}: texto sugerido vazio`);
    if (r.sugerir.texto.length > 400) erros.push(`${r.id}: texto sugerido passa de 400 caracteres`);
  }
  return erros;
}

/** Pura: por que uma regra aprendida NÃO pode sugerir (null = pode). */
export function problemaRegraAprendida(r: RegraAprendidaOperacao): string | null {
  if (!r.id) return "sem id";
  if (!Number.isInteger(r.estado?.oc)) return "estado sem oc";
  if (r.acao !== "lancar_ocorrencia" && r.acao !== "encaminhar_relacionamento") return `ação desconhecida: ${r.acao}`;
  if (r.acao === "lancar_ocorrencia") {
    if (r.codigo === null || !Number.isInteger(r.codigo)) return "lançar sem código";
    if (OCS_PROIBIDAS_OPERACAO.has(r.codigo)) return `código ${r.codigo} proibido para a Operação`;
    if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(r.codigo)) return `código ${r.codigo} exige o texto da pessoa (INV-046)`;
    if (r.codigo === r.estado.oc) return "sugere a própria oc atual";
  } else if (r.codigo !== null) {
    return "encaminhar não leva código";
  }
  const t = (r.texto ?? "").trim();
  if (t.length < 3) return "texto vazio";
  if (t.length > TEXTO_SUGESTAO_MAX) return `texto acima de ${TEXTO_SUGESTAO_MAX}`;
  if (!(r.confianca >= 0 && r.confianca <= 1)) return "confiança fora de 0..1";
  if (!Number.isInteger(r.casos) || r.casos < 0) return "casos inválido";
  if (!r.base_regra?.trim()) return "sem base_regra";
  return null;
}

/** Pura: problemas de um regras.json inteiro (gera a migration de carga só se vazio). */
export function validarRegrasAprendidas(regras: readonly RegraAprendidaOperacao[]): string[] {
  const erros: string[] = [];
  const ids = new Set<string>();
  for (const r of regras) {
    if (ids.has(r.id)) erros.push(`${r.id}: id repetido`);
    ids.add(r.id);
    const p = problemaRegraAprendida(r);
    if (p) erros.push(`${r.id}: ${p}`);
  }
  return erros;
}

function horasDesde(iso: string | null, agoraMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (agoraMs - t) / 3_600_000 : null;
}

/** Pura: a regra aprendida casa com o item (estado), sem olhar limiar? */
function estadoCasa(r: RegraAprendidaOperacao, item: ItemParaSugestao, agoraMs: number): boolean {
  if (item.cod_ultima_ocorrencia === null || r.estado.oc !== item.cod_ultima_ocorrencia) return false;
  const u = normalizarUnidade(r.estado.unidade ?? null);
  if (u && u !== normalizarUnidade(item.unidade)) return false;
  const dias = r.estado.dias_parado_min;
  if (dias !== null && dias !== undefined) {
    const h = horasDesde(item.data_ultima_ocorrencia, agoraMs);
    if (h === null || h < dias * 24) return false;
  }
  return true;
}

/** Mais específica primeiro (unidade, depois dias parado), depois confiança e casos. */
function ordemRegraAprendida(a: RegraAprendidaOperacao, b: RegraAprendidaOperacao): number {
  const espA = (a.estado.unidade ? 2 : 0) + (a.estado.dias_parado_min ? 1 : 0);
  const espB = (b.estado.unidade ? 2 : 0) + (b.estado.dias_parado_min ? 1 : 0);
  return espB - espA || b.confianca - a.confianca || b.casos - a.casos || a.id.localeCompare(b.id);
}

/**
 * Pura: as regras aprendidas do MESMO estado (oc), para dar contexto ao agente
 * ("top-3 do histórico"), inclusive as que ficaram abaixo do limiar.
 */
export function historicoDoEstado(
  regras: readonly RegraAprendidaOperacao[],
  item: ItemParaSugestao,
  n = 3,
): RegraAprendidaOperacao[] {
  return regras
    .filter((r) => r.ativo !== false && r.estado.oc === item.cod_ultima_ocorrencia && problemaRegraAprendida(r) === null)
    .sort((a, b) => b.casos - a.casos || b.confianca - a.confianca || a.id.localeCompare(b.id))
    .slice(0, n);
}

/** Pura: CAMADA 0 — a primeira regra fixa que casa decide. Sem regra que case → null. */
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
    const enc = r.sugerir.acao === "encaminhar_relacionamento";
    const codigo = r.sugerir.acao === "encaminhar_relacionamento" ? null : r.sugerir.codigo;
    // Regra inválida nunca sugere (defesa além do teste da tabela).
    if (codigo !== null && (OCS_PROIBIDAS_OPERACAO.has(codigo) || OCS_TEXTO_OBRIGATORIO_OPERACAO.has(codigo))) continue;
    if (r.quando.unidades && r.quando.unidades.length > 0) {
      if (!unidade || !r.quando.unidades.map((u) => normalizarUnidade(u)).includes(unidade)) continue;
    }
    if (r.quando.horasParadoMin !== undefined) {
      const h = horasDesde(args.item.data_ultima_ocorrencia, args.agoraMs);
      if (h === null || h < r.quando.horasParadoMin) continue;
    }
    return {
      versao_contrato: VERSAO_CONTRATO_SUGESTAO,
      acao: enc ? "encaminhar_relacionamento" : "lancar_ocorrencia",
      fonte: "regra_fixa",
      base_regra: r.id,
      regra_id: r.id,
      codigo,
      texto: r.sugerir.texto.trim(),
      motivo: r.descricao,
      lancavel: codigo !== null && args.codigosLancaveisAtivos.has(codigo),
      confianca: null,
      casos: null,
      oc_base: oc,
      versao_regras: VERSAO_REGRAS_SUGESTAO_OPERACAO,
    };
  }
  return null;
}

/** Pura: CAMADA 1 — a regra aprendida mais específica, acima do limiar, decide. */
export function sugerirPorRegraAprendida(args: {
  item: ItemParaSugestao;
  regras: readonly RegraAprendidaOperacao[];
  codigosLancaveisAtivos: ReadonlySet<number>;
  agoraMs: number;
  minConfianca?: number;
  minCasos?: number;
}): SugestaoOperacao | null {
  const minConf = args.minConfianca ?? MIN_CONFIANCA_REGRA_APRENDIDA;
  const minCasos = args.minCasos ?? MIN_CASOS_REGRA_APRENDIDA;
  const r = args.regras
    .filter((x) => x.ativo !== false && problemaRegraAprendida(x) === null)
    .filter((x) => x.confianca >= minConf && x.casos >= minCasos)
    .filter((x) => estadoCasa(x, args.item, args.agoraMs))
    .sort(ordemRegraAprendida)[0];
  if (!r) return null;
  return {
    versao_contrato: VERSAO_CONTRATO_SUGESTAO,
    acao: r.acao,
    fonte: "regra_aprendida",
    base_regra: r.base_regra.trim(),
    regra_id: r.id,
    codigo: r.acao === "lancar_ocorrencia" ? r.codigo : null,
    texto: r.texto.trim(),
    motivo: `histórico: ${r.casos} casos com a oc ${r.estado.oc}` + (r.estado.unidade ? ` na ${normalizarUnidade(r.estado.unidade)}` : "") +
      ` (${Math.round(r.confianca * 100)}%)`,
    lancavel: r.acao === "lancar_ocorrencia" && r.codigo !== null && args.codigosLancaveisAtivos.has(r.codigo),
    confianca: r.confianca,
    casos: r.casos,
    oc_base: args.item.cod_ultima_ocorrencia,
    versao_regras: `aprendidas:${r.base_regra.trim()}`,
  };
}

/** Pura: camadas 0 e 1, nesta ordem. null = nenhuma regra casa (aí, e só aí, o agente). */
export function sugerirPorRegras(args: {
  item: ItemParaSugestao;
  regrasFixas?: readonly RegraSugestaoOperacao[];
  regrasAprendidas?: readonly RegraAprendidaOperacao[];
  codigosLancaveisAtivos: ReadonlySet<number>;
  agoraMs: number;
}): SugestaoOperacao | null {
  return sugerirLancamentoOperacao({
    item: args.item,
    regras: args.regrasFixas,
    codigosLancaveisAtivos: args.codigosLancaveisAtivos,
    agoraMs: args.agoraMs,
  }) ?? sugerirPorRegraAprendida({
    item: args.item,
    regras: args.regrasAprendidas ?? REGRAS_APRENDIDAS_SEED,
    codigosLancaveisAtivos: args.codigosLancaveisAtivos,
    agoraMs: args.agoraMs,
  });
}

/** Linha crua de `op_regras_sugestao` (mig 434) → regra. Pura. */
export function regraAprendidaDeLinha(l: Record<string, unknown>): RegraAprendidaOperacao {
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  return {
    id: String(l.id ?? ""),
    estado: {
      oc: Number(l.estado_oc),
      unidade: (l.estado_unidade as string | null) ?? null,
      dias_parado_min: num(l.estado_dias_parado_min),
    },
    acao: l.acao as AcaoSugestao,
    codigo: num(l.codigo),
    texto: String(l.texto ?? ""),
    confianca: Number(l.confianca),
    casos: Number(l.casos),
    base_regra: String(l.base_regra ?? ""),
    ativo: l.ativo !== false,
  };
}
