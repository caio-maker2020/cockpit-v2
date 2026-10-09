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
// com a prévia do que vai ao SSW confirmada. A sugestão pode ser de três tipos:
//   - `lancar_ocorrencia`  : um código que a Operação lança (nunca os proibidos,
//     nunca 41/56, nunca 01 — entrega é do motorista);
//   - `encaminhar_relacionamento`: o próximo passo é do Relacionamento (passagem de
//     bastão real: cliente, reentrega autorizada, devolução, indenização…). O botão é
//     "Encaminhar ao Relacionamento" (prévia + clique; ADR 0041 D11/D12);
//   - `aguardar`: nada a fazer agora (ex.: comprovante em trânsito no malote), com o
//     motivo e QUANDO reavaliar. Sem botão de lançar; a tela mostra "Aguardar: motivo".
//
// PURO (sem I/O): deno test.
// =============================================================================

import { OCS_PROIBIDAS_OPERACAO, OCS_TEXTO_OBRIGATORIO_OPERACAO, normalizarUnidade } from "./operacao-comum.ts";

/** 01 (entregue) nunca é sugerida: a entrega é do motorista (achado do treino real, 07/10). */
export const CODIGO_ENTREGA = 1;
/** O que NENHUMA sugestão (regra ou agente) propõe: proibidos + 41/56 + 01. */
export const OCS_NUNCA_SUGERIR: ReadonlySet<number> = new Set([
  ...OCS_PROIBIDAS_OPERACAO, ...OCS_TEXTO_OBRIGATORIO_OPERACAO, CODIGO_ENTREGA,
]);
/** "Aguardar": quando reavaliar (horas). */
export const REAVALIAR_HORAS_MIN = 1;
export const REAVALIAR_HORAS_MAX = 720;
export const REAVALIAR_HORAS_PADRAO = 24;

/**
 * Pura: a forma canônica da instrução para casar regra aprendida por IGUALDADE:
 * maiúsculas, sem acento, espaços colapsados, sem espaço nas pontas. "" → null.
 */
export function normalizarInstrucaoPadrao(t: string | null | undefined): string | null {
  const s = (t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/**
 * Token que contém dígito (número, data, hora, código, placa, CTRC…), aplicado DEPOIS de
 * `normalizarInstrucaoPadrao` (maiúsculas, sem acento). Cada token vira "#"; a pontuação
 * em volta fica ("12/10" → "#/#", "14:30" → "#:#", "OVD396328-4" → "#-#").
 * O minerador do v3 usa ESTA regex (ADR 0041 D10, emenda instrucao_modelo).
 */
export const REGEX_TOKEN_COM_DIGITO = /[A-Z0-9]*[0-9][A-Z0-9]*/g;

/**
 * Pura: o "modelo" da instrução — a forma normalizada com números, datas, horas e códigos
 * trocados por "#". Ex.: "Malote 4521 - dia 03/10" → "MALOTE # - DIA #/#". Idempotente.
 * Casa regra por IGUALDADE com `estado.instrucao_modelo`. "" → null.
 */
export function modeloDaInstrucao(t: string | null | undefined): string | null {
  const n = normalizarInstrucaoPadrao(t);
  if (!n) return null;
  return n.replace(REGEX_TOKEN_COM_DIGITO, "#").replace(/\s+/g, " ").trim();
}

/** Pura: CNPJ/CPF só com dígitos (14 ou 11); outro tamanho → null. */
export function normalizarCnpj(c: string | null | undefined): string | null {
  const d = (c ?? "").replace(/\D/g, "");
  return d.length === 14 || d.length === 11 ? d : null;
}

/** Muda quando a tabela de regras FIXAS muda: entra no registro em sombra para medir por versão. */
export const VERSAO_REGRAS_SUGESTAO_OPERACAO = "v0-vazia-2026-10-07";
/** Versão do CONTRATO do campo op_itens.sugestao (ver `SugestaoOperacao`). v2 + acao "aguardar" (aditivo). */
export const VERSAO_CONTRATO_SUGESTAO = 2 as const;
/** Texto sugerido: cabe nas "Informações complementares" do SSW (70). A Instrução aceita 500. */
export const TEXTO_SUGESTAO_MAX = 70;

/** Regra aprendida só decide com pelo menos isto de confiança e de casos (abaixo: vira contexto do agente). */
export const MIN_CONFIANCA_REGRA_APRENDIDA = 0.6;
export const MIN_CASOS_REGRA_APRENDIDA = 5;

export type AcaoSugestao = "lancar_ocorrencia" | "encaminhar_relacionamento" | "aguardar";
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
    | { acao: "encaminhar_relacionamento"; texto: string }
    | { acao: "aguardar"; texto: string; reavaliarEmHoras?: number };
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
 *   { "id": "h13-vga-36",
 *     "estado": { "oc": 13,                          // obrigatório
 *                 "unidade": "VGA" | null,
 *                 "dias_parado_min": 2 | null,
 *                 "dias_parado_max": 7 | null,       // TETO: parada há mais que isso (dias) não casa
 *                 "instrucao_padrao": "COMPROVANTE NO MALOTE" | null,  // casa por IGUALDADE após
 *                                                     // normalizarInstrucaoPadrao (maiúsculas, sem
 *                                                     // acento, espaços colapsados)
 *                 "instrucao_modelo": "MALOTE # - DIA #/#" | null,    // modeloDaInstrucao(); exclusivo
 *                                                     // com instrucao_padrao
 *                 "pagador_cnpj": "12345678000199" | null,            // só dígitos (14 ou 11)
 *                 "previsao_vencida": true | false | null,            // previsão de entrega < agora
 *                 "ocorrencias_anteriores_min": 3 | null },           // ocorrências antes da atual
 *     "acao": "lancar_ocorrencia" | "encaminhar_relacionamento" | "aguardar",
 *     "codigo": 36 | null,          // null quando acao ≠ lancar_ocorrencia
 *     "texto": "...",               // ≤ 70 (em "aguardar", é o motivo)
 *     "reavaliar_em_horas": 48,     // só "aguardar" (1..720; ausente = 24)
 *     "alternativa": { "acao": "lancar_ocorrencia" | "encaminhar_relacionamento",   // só "aguardar":
 *                      "codigo": 36 | null, "texto": "...", "confianca": 0.4,       // o que a Operação
 *                      "casos": 12, "taxa_acao": 0.25 } | null,                     // fez quando NÃO esperou
 *     "confianca": 0.83,            // 0..1 = acertos / casos no histórico
 *     "casos": 41,                  // nº de casos que embasam
 *     "base_regra": "historico:2026-07..2026-09" }
 *
 * Hierarquia de especificidade (a mais específica casa primeiro): pagador_cnpj (32) +
 * instrucao_padrao (16) | instrucao_modelo (8) + unidade (4) + cada condição extra
 * (dias_parado_min, previsao_vencida, ocorrencias_anteriores_min) (1); o teto dias_parado_max
 * soma 0 (ele só RESTRINGE a regra, não a torna mais específica que a filha d:N); empate → confiança,
 * casos, id.
 */
/** Só em "aguardar": o que a Operação fez quando NÃO esperou (copiado para a sugestão). */
export interface AlternativaAguardar {
  acao: "lancar_ocorrencia" | "encaminhar_relacionamento";
  codigo: number | null;
  texto: string;
  confianca: number;
  casos: number;
  /** Fração dos casos do estado em que a Operação agiu (não esperou): 0..1. */
  taxa_acao: number;
}

export interface RegraAprendidaOperacao {
  id: string;
  estado: {
    oc: number;
    unidade?: string | null;
    dias_parado_min?: number | null;
    /** Teto da idade (dias desde a última oc): acima disso a regra NÃO casa (mig 444, rodada 8). */
    dias_parado_max?: number | null;
    instrucao_padrao?: string | null;
    instrucao_modelo?: string | null;
    pagador_cnpj?: string | null;
    previsao_vencida?: boolean | null;
    ocorrencias_anteriores_min?: number | null;
  };
  acao: AcaoSugestao;
  codigo: number | null;
  texto: string;
  reavaliar_em_horas?: number | null;
  alternativa?: AlternativaAguardar | null;
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
  /**
   * Unidade onde a última ocorrência foi registrada (Bastão `unidade_atual`): é a unidade do
   * TREINO ("unidade da ocorrência", rodada 1–8). Regra aprendida com unidade casa por ela;
   * ausente → cai em `unidade` (a de visibilidade, pela op_regra_unidade_por_oc).
   */
  unidade_ocorrencia?: string | null;
  /** Para regra aprendida com `instrucao_padrao` (casa por igualdade normalizada). */
  instrucao_ultima_ocorrencia?: string | null;
  /** Para regra aprendida com `pagador_cnpj`. */
  cnpj_pagador?: string | null;
  /** Para `previsao_vencida` (sem previsão = a condição não casa). */
  previsao_entrega?: string | null;
  /** Para `ocorrencias_anteriores_min` (desconhecido = a condição não casa). */
  ocorrencias_anteriores?: number | null;
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
  /** null quando acao ≠ lancar_ocorrencia. */
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
  /** Só "aguardar": em quantas horas reavaliar e o instante (ISO). */
  reavaliar_em_horas?: number | null;
  reavaliar_em?: string | null;
  /** Só "aguardar" de regra aprendida: o que a Operação fez quando não esperou. */
  alternativa?: AlternativaAguardar | null;
}

/** Pura: horas de reavaliação válidas (inteiro 1..720) ou null. */
export function horasReavaliarValidas(h: unknown): number | null {
  return typeof h === "number" && Number.isInteger(h) && h >= REAVALIAR_HORAS_MIN && h <= REAVALIAR_HORAS_MAX ? h : null;
}

/** Pura: problemas de uma tabela de regras fixas (vazio = válida). Travado em teste. */
export function validarRegrasSugestao(regras: readonly RegraSugestaoOperacao[]): string[] {
  const erros: string[] = [];
  const ids = new Set<string>();
  for (const r of regras) {
    if (!r.id || ids.has(r.id)) erros.push(`regra com id vazio ou repetido: "${r.id}"`);
    ids.add(r.id);
    if (!r.quando.ocs || r.quando.ocs.length === 0) erros.push(`${r.id}: regra sem oc pegaria a fila inteira`);
    if (r.sugerir.acao === undefined || r.sugerir.acao === "lancar_ocorrencia") {
      const codigo = r.sugerir.codigo;
      if (OCS_PROIBIDAS_OPERACAO.has(codigo)) erros.push(`${r.id}: sugere a oc ${codigo}, que a Operação nunca lança`);
      if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(codigo)) {
        erros.push(`${r.id}: a oc ${codigo} existe pelo texto do operador (INV-046); sugestão não escreve por ele`);
      }
      if (codigo === CODIGO_ENTREGA) erros.push(`${r.id}: sugere a oc 01 — a entrega é do motorista`);
    }
    if (r.sugerir.acao === "aguardar" && r.sugerir.reavaliarEmHoras !== undefined && horasReavaliarValidas(r.sugerir.reavaliarEmHoras) === null) {
      erros.push(`${r.id}: reavaliarEmHoras fora de 1..720`);
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
  if (r.acao !== "lancar_ocorrencia" && r.acao !== "encaminhar_relacionamento" && r.acao !== "aguardar") {
    return `ação desconhecida: ${r.acao}`;
  }
  if (r.acao === "lancar_ocorrencia") {
    if (r.codigo === null || !Number.isInteger(r.codigo)) return "lançar sem código";
    if (OCS_PROIBIDAS_OPERACAO.has(r.codigo)) return `código ${r.codigo} proibido para a Operação`;
    if (OCS_TEXTO_OBRIGATORIO_OPERACAO.has(r.codigo)) return `código ${r.codigo} exige o texto da pessoa (INV-046)`;
    if (r.codigo === CODIGO_ENTREGA) return "código 01 nunca é sugerido (entrega é do motorista)";
    if (r.codigo === r.estado.oc) return "sugere a própria oc atual";
  } else if (r.codigo !== null) {
    return `${r.acao === "aguardar" ? "aguardar" : "encaminhar"} não leva código`;
  }
  if (r.acao === "aguardar" && r.reavaliar_em_horas !== null && r.reavaliar_em_horas !== undefined &&
    horasReavaliarValidas(r.reavaliar_em_horas) === null) return "reavaliar_em_horas fora de 1..720";
  if (r.estado.instrucao_padrao !== null && r.estado.instrucao_padrao !== undefined &&
    normalizarInstrucaoPadrao(r.estado.instrucao_padrao) !== r.estado.instrucao_padrao) {
    return "instrucao_padrao não está normalizada (maiúsculas, sem acento, espaços colapsados)";
  }
  if (r.estado.instrucao_modelo !== null && r.estado.instrucao_modelo !== undefined &&
    modeloDaInstrucao(r.estado.instrucao_modelo) !== r.estado.instrucao_modelo) {
    return "instrucao_modelo não é a saída de modeloDaInstrucao (normalizada, números/datas/códigos como #)";
  }
  if (r.estado.instrucao_padrao && r.estado.instrucao_modelo) return "use instrucao_padrao OU instrucao_modelo, não os dois";
  if (r.estado.pagador_cnpj !== null && r.estado.pagador_cnpj !== undefined &&
    normalizarCnpj(r.estado.pagador_cnpj) !== r.estado.pagador_cnpj) return "pagador_cnpj tem de ter só dígitos (14 ou 11)";
  const d = r.estado.dias_parado_min;
  if (d !== null && d !== undefined && !(Number.isInteger(d) && d >= 0 && d <= 365)) return "dias_parado_min fora de 0..365";
  const dx = r.estado.dias_parado_max;
  if (dx !== null && dx !== undefined) {
    if (!(Number.isInteger(dx) && dx >= 1 && dx <= 365)) return "dias_parado_max fora de 1..365";
    if (d !== null && d !== undefined && dx < d) return "dias_parado_max menor que dias_parado_min";
  }
  const pv = r.estado.previsao_vencida;
  if (pv !== null && pv !== undefined && typeof pv !== "boolean") return "previsao_vencida tem de ser true/false";
  const oa = r.estado.ocorrencias_anteriores_min;
  if (oa !== null && oa !== undefined && !(Number.isInteger(oa) && oa >= 0 && oa <= 1000)) return "ocorrencias_anteriores_min fora de 0..1000";
  if (r.alternativa !== null && r.alternativa !== undefined) {
    if (r.acao !== "aguardar") return "alternativa só em regra aguardar";
    const p = problemaAlternativa(r.alternativa, r.estado.oc);
    if (p) return `alternativa: ${p}`;
  }
  const t = (r.texto ?? "").trim();
  if (t.length < 3) return "texto vazio";
  if (t.length > TEXTO_SUGESTAO_MAX) return `texto acima de ${TEXTO_SUGESTAO_MAX}`;
  if (!(r.confianca >= 0 && r.confianca <= 1)) return "confiança fora de 0..1";
  if (!Number.isInteger(r.casos) || r.casos < 0) return "casos inválido";
  if (!r.base_regra?.trim()) return "sem base_regra";
  return null;
}

/** Pura: por que a alternativa de um "aguardar" é inválida (null = ok). */
export function problemaAlternativa(a: AlternativaAguardar, ocEstado: number): string | null {
  if (!a || typeof a !== "object") return "não é objeto";
  if (a.acao !== "lancar_ocorrencia" && a.acao !== "encaminhar_relacionamento") return `ação inválida: ${String(a.acao)}`;
  if (a.acao === "lancar_ocorrencia") {
    if (a.codigo === null || !Number.isInteger(a.codigo)) return "lançar sem código";
    if (OCS_NUNCA_SUGERIR.has(a.codigo)) return `código ${a.codigo} nunca é sugerido`;
    if (a.codigo === ocEstado) return "sugere a própria oc atual";
  } else if (a.codigo !== null) return "encaminhar não leva código";
  const t = (a.texto ?? "").trim();
  if (t.length < 3 || t.length > TEXTO_SUGESTAO_MAX) return `texto fora de 3..${TEXTO_SUGESTAO_MAX}`;
  if (!(typeof a.confianca === "number" && a.confianca >= 0 && a.confianca <= 1)) return "confiança fora de 0..1";
  if (!Number.isInteger(a.casos) || a.casos < 0) return "casos inválido";
  if (!(typeof a.taxa_acao === "number" && a.taxa_acao >= 0 && a.taxa_acao <= 1)) return "taxa_acao fora de 0..1";
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

/** Pura: a unidade com que a regra aprendida compara (a da ocorrência; senão a de visibilidade). */
export function unidadeDaRegra(item: Pick<ItemParaSugestao, "unidade" | "unidade_ocorrencia">): string | null {
  return normalizarUnidade(item.unidade_ocorrencia ?? null) ?? normalizarUnidade(item.unidade);
}

/**
 * Pura: o teto de idade. Sem teto → casa. Com teto, a idade (dias INTEIROS desde a data da última
 * oc, que no Bastão vem sem hora) tem de ser ≤ teto; idade desconhecida não casa (conservador: um
 * "aguardar" com teto não vale para nota sem data).
 */
export function dentroDoTeto(teto: number | null | undefined, horas: number | null): boolean {
  if (teto === null || teto === undefined) return true;
  if (horas === null) return false;
  return Math.floor(horas / 24) <= teto;
}

function horasDesde(iso: string | null, agoraMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (agoraMs - t) / 3_600_000 : null;
}

/** Pura: a regra aprendida casa com o item (estado), sem olhar limiar? */
export function estadoCasa(r: RegraAprendidaOperacao, item: ItemParaSugestao, agoraMs: number, opts: { ignorarDias?: boolean } = {}): boolean {
  if (item.cod_ultima_ocorrencia === null || r.estado.oc !== item.cod_ultima_ocorrencia) return false;
  const u = normalizarUnidade(r.estado.unidade ?? null);
  if (u && u !== unidadeDaRegra(item)) return false;
  const cnpj = normalizarCnpj(r.estado.pagador_cnpj ?? null);
  if (cnpj && cnpj !== normalizarCnpj(item.cnpj_pagador ?? null)) return false;
  const instr = normalizarInstrucaoPadrao(r.estado.instrucao_padrao ?? null);
  if (instr && instr !== normalizarInstrucaoPadrao(item.instrucao_ultima_ocorrencia ?? null)) return false;
  const modelo = modeloDaInstrucao(r.estado.instrucao_modelo ?? null);
  if (modelo && modelo !== modeloDaInstrucao(item.instrucao_ultima_ocorrencia ?? null)) return false;
  // Condições extras (as "de momento": dias parado, previsão, ocorrências) — ignoráveis no histórico do agente.
  if (opts.ignorarDias) return true;
  const dias = r.estado.dias_parado_min;
  if (dias !== null && dias !== undefined) {
    const h = horasDesde(item.data_ultima_ocorrencia, agoraMs);
    if (h === null || h < dias * 24) return false;
  }
  if (!dentroDoTeto(r.estado.dias_parado_max, horasDesde(item.data_ultima_ocorrencia, agoraMs))) return false;
  const pv = r.estado.previsao_vencida;
  if (pv === true || pv === false) {
    const t = item.previsao_entrega ? Date.parse(item.previsao_entrega) : NaN;
    if (!Number.isFinite(t)) return false; // sem previsão: não casa nem "vencida" nem "no prazo"
    if ((t < agoraMs) !== pv) return false;
  }
  const oa = r.estado.ocorrencias_anteriores_min;
  if (oa !== null && oa !== undefined) {
    const n = item.ocorrencias_anteriores;
    if (typeof n !== "number" || n < oa) return false; // desconhecido não casa (conservador)
  }
  return true;
}

/**
 * Pura: especificidade do estado — pagador (32) + instrução exata (16) ou modelo da
 * instrução (8) + unidade (4) + 1 por condição extra (dias parado, previsão vencida,
 * ocorrências anteriores). instrucao_padrao > instrucao_modelo.
 */
export function especificidadeRegra(r: RegraAprendidaOperacao): number {
  const e = r.estado;
  const tem = (v: unknown) => v !== null && v !== undefined;
  return (e.pagador_cnpj ? 32 : 0) + (e.instrucao_padrao ? 16 : 0) + (e.instrucao_modelo ? 8 : 0) +
    (e.unidade ? 4 : 0) + (e.dias_parado_min ? 1 : 0) + (tem(e.previsao_vencida) ? 1 : 0) +
    (tem(e.ocorrencias_anteriores_min) ? 1 : 0);
}

/** Mais específica primeiro, depois confiança e casos. */
function ordemRegraAprendida(a: RegraAprendidaOperacao, b: RegraAprendidaOperacao): number {
  return especificidadeRegra(b) - especificidadeRegra(a) || b.confianca - a.confianca || b.casos - a.casos ||
    a.id.localeCompare(b.id);
}

/**
 * Pura: as regras aprendidas que casam com o estado do item (dias parado à parte),
 * para dar contexto ao agente ("top-3 do histórico"), inclusive as que ficaram abaixo
 * do limiar. Regra de outra unidade/pagador/instrução não entra (não é o mesmo estado).
 */
export function historicoDoEstado(
  regras: readonly RegraAprendidaOperacao[],
  item: ItemParaSugestao,
  n = 3,
  agoraMs = Date.now(),
): RegraAprendidaOperacao[] {
  return regras
    .filter((r) => r.ativo !== false && problemaRegraAprendida(r) === null && estadoCasa(r, item, agoraMs, { ignorarDias: true }))
    .sort((a, b) => especificidadeRegra(b) - especificidadeRegra(a) || b.casos - a.casos || b.confianca - a.confianca ||
      a.id.localeCompare(b.id))
    .slice(0, n);
}

function reavaliarEm(horas: number, agoraMs: number): string {
  return new Date(agoraMs + horas * 3_600_000).toISOString();
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
    const sug = r.sugerir;
    const acao: AcaoSugestao = sug.acao === "encaminhar_relacionamento" || sug.acao === "aguardar" ? sug.acao : "lancar_ocorrencia";
    const codigo = sug.acao === "encaminhar_relacionamento" || sug.acao === "aguardar" ? null : sug.codigo;
    const horas = sug.acao === "aguardar" ? (horasReavaliarValidas(sug.reavaliarEmHoras) ?? REAVALIAR_HORAS_PADRAO) : null;
    // Regra inválida nunca sugere (defesa além do teste da tabela).
    if (codigo !== null && OCS_NUNCA_SUGERIR.has(codigo)) continue;
    if (r.quando.unidades && r.quando.unidades.length > 0) {
      if (!unidade || !r.quando.unidades.map((u) => normalizarUnidade(u)).includes(unidade)) continue;
    }
    if (r.quando.horasParadoMin !== undefined) {
      const h = horasDesde(args.item.data_ultima_ocorrencia, args.agoraMs);
      if (h === null || h < r.quando.horasParadoMin) continue;
    }
    return {
      versao_contrato: VERSAO_CONTRATO_SUGESTAO,
      acao,
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
      ...(horas !== null ? { reavaliar_em_horas: horas, reavaliar_em: reavaliarEm(horas, args.agoraMs) } : {}),
    };
  }
  return null;
}

/**
 * Regras aprendidas PRÉ-COMPILADAS (incidente WORKER_RESOURCE_LIMIT, 08/10): validação,
 * limiar, ordem e normalizações da regra feitas UMA vez, com índice por estado.oc.
 * Antes, cada item revalidava e renormalizava as 374 regras (≈1,8 milhão de pares por
 * rodada, 1,3 s de CPU só nisso). O resultado é idêntico (teste de equivalência).
 */
interface RegraCompilada {
  r: RegraAprendidaOperacao;
  unidade: string | null;
  cnpj: string | null;
  instr: string | null;
  modelo: string | null;
}
export interface RegrasAprendidasCompiladas {
  readonly porOc: ReadonlyMap<number, readonly RegraCompilada[]>;
}

/** Pura: compila as regras que podem decidir (ativas, válidas, acima do limiar), na ordem de decisão. */
export function compilarRegrasAprendidas(
  regras: readonly RegraAprendidaOperacao[],
  opts: { minConfianca?: number; minCasos?: number } = {},
): RegrasAprendidasCompiladas {
  const minConf = opts.minConfianca ?? MIN_CONFIANCA_REGRA_APRENDIDA;
  const minCasos = opts.minCasos ?? MIN_CASOS_REGRA_APRENDIDA;
  const ordenadas = regras
    .filter((x) => x.ativo !== false && problemaRegraAprendida(x) === null)
    .filter((x) => x.confianca >= minConf && x.casos >= minCasos)
    .sort(ordemRegraAprendida);
  const porOc = new Map<number, RegraCompilada[]>();
  for (const r of ordenadas) {
    const c: RegraCompilada = {
      r,
      unidade: normalizarUnidade(r.estado.unidade ?? null),
      cnpj: normalizarCnpj(r.estado.pagador_cnpj ?? null),
      instr: normalizarInstrucaoPadrao(r.estado.instrucao_padrao ?? null),
      modelo: modeloDaInstrucao(r.estado.instrucao_modelo ?? null),
    };
    const l = porOc.get(r.estado.oc);
    if (l) l.push(c);
    else porOc.set(r.estado.oc, [c]);
  }
  return { porOc };
}

/** Mesmo critério de `estadoCasa`, com regra e item já normalizados (o item, preguiçoso e uma vez). */
function primeiraQueCasa(
  lista: readonly RegraCompilada[],
  item: ItemParaSugestao,
  agoraMs: number,
): RegraAprendidaOperacao | null {
  let unidade: string | null | undefined, cnpj: string | null | undefined, instr: string | null | undefined;
  let modelo: string | null | undefined, horas: number | null | undefined, prev: number | undefined;
  for (const c of lista) {
    if (c.unidade && c.unidade !== (unidade === undefined ? (unidade = unidadeDaRegra(item)) : unidade)) continue;
    if (c.cnpj && c.cnpj !== (cnpj === undefined ? (cnpj = normalizarCnpj(item.cnpj_pagador ?? null)) : cnpj)) continue;
    if (c.instr && c.instr !== (instr === undefined ? (instr = normalizarInstrucaoPadrao(item.instrucao_ultima_ocorrencia ?? null)) : instr)) continue;
    if (c.modelo && c.modelo !== (modelo === undefined ? (modelo = modeloDaInstrucao(item.instrucao_ultima_ocorrencia ?? null)) : modelo)) continue;
    const e = c.r.estado;
    const dias = e.dias_parado_min;
    if (dias !== null && dias !== undefined) {
      if (horas === undefined) horas = horasDesde(item.data_ultima_ocorrencia, agoraMs);
      if (horas === null || horas < dias * 24) continue;
    }
    if (e.dias_parado_max !== null && e.dias_parado_max !== undefined) {
      if (horas === undefined) horas = horasDesde(item.data_ultima_ocorrencia, agoraMs);
      if (!dentroDoTeto(e.dias_parado_max, horas)) continue;
    }
    const pv = e.previsao_vencida;
    if (pv === true || pv === false) {
      if (prev === undefined) prev = item.previsao_entrega ? Date.parse(item.previsao_entrega) : NaN;
      if (!Number.isFinite(prev)) continue;
      if ((prev < agoraMs) !== pv) continue;
    }
    const oa = e.ocorrencias_anteriores_min;
    if (oa !== null && oa !== undefined) {
      const n = item.ocorrencias_anteriores;
      if (typeof n !== "number" || n < oa) continue;
    }
    return c.r;
  }
  return null;
}

/** Pura: CAMADA 1 — a regra aprendida mais específica, acima do limiar, decide. */
export function sugerirPorRegraAprendida(args: {
  item: ItemParaSugestao;
  regras: readonly RegraAprendidaOperacao[];
  /** Pré-compiladas de `regras` (com os mesmos limiares): o materializador compila uma vez por rodada. */
  compiladas?: RegrasAprendidasCompiladas;
  codigosLancaveisAtivos: ReadonlySet<number>;
  agoraMs: number;
  minConfianca?: number;
  minCasos?: number;
}): SugestaoOperacao | null {
  const oc = args.item.cod_ultima_ocorrencia;
  if (oc === null) return null;
  const comp = args.compiladas ??
    compilarRegrasAprendidas(args.regras, { minConfianca: args.minConfianca, minCasos: args.minCasos });
  const lista = comp.porOc.get(oc);
  const r = lista ? primeiraQueCasa(lista, args.item, args.agoraMs) : null;
  if (!r) return null;
  const horas = r.acao === "aguardar" ? (horasReavaliarValidas(r.reavaliar_em_horas) ?? REAVALIAR_HORAS_PADRAO) : null;
  const partes = [
    r.estado.unidade ? `na ${normalizarUnidade(r.estado.unidade)}` : "",
    r.estado.instrucao_padrao ? `instrução "${r.estado.instrucao_padrao}"` : "",
    r.estado.instrucao_modelo ? `instrução como "${r.estado.instrucao_modelo}"` : "",
    r.estado.dias_parado_max ? `parada há até ${r.estado.dias_parado_max} dia(s)` : "",
    r.estado.previsao_vencida === true ? "previsão vencida" : r.estado.previsao_vencida === false ? "no prazo" : "",
    r.estado.ocorrencias_anteriores_min ? `${r.estado.ocorrencias_anteriores_min}+ ocorrências antes` : "",
    r.estado.pagador_cnpj ? "deste pagador" : "",
  ].filter(Boolean);
  return {
    versao_contrato: VERSAO_CONTRATO_SUGESTAO,
    acao: r.acao,
    fonte: "regra_aprendida",
    base_regra: r.base_regra.trim(),
    regra_id: r.id,
    codigo: r.acao === "lancar_ocorrencia" ? r.codigo : null,
    texto: r.texto.trim(),
    motivo: `histórico: ${r.casos} casos com a oc ${r.estado.oc}` + (partes.length ? ` ${partes.join(", ")}` : "") +
      ` (${Math.round(r.confianca * 100)}%)`,
    lancavel: r.acao === "lancar_ocorrencia" && r.codigo !== null && args.codigosLancaveisAtivos.has(r.codigo),
    confianca: r.confianca,
    casos: r.casos,
    oc_base: args.item.cod_ultima_ocorrencia,
    versao_regras: `aprendidas:${r.base_regra.trim()}`,
    ...(horas !== null ? { reavaliar_em_horas: horas, reavaliar_em: reavaliarEm(horas, args.agoraMs) } : {}),
    ...(r.acao === "aguardar" && r.alternativa ? { alternativa: { ...r.alternativa, texto: r.alternativa.texto.trim() } } : {}),
  };
}

/** Pura: camadas 0 e 1, nesta ordem. null = nenhuma regra casa (aí, e só aí, o agente). */
export function sugerirPorRegras(args: {
  item: ItemParaSugestao;
  regrasFixas?: readonly RegraSugestaoOperacao[];
  regrasAprendidas?: readonly RegraAprendidaOperacao[];
  /** Pré-compiladas de `regrasAprendidas` (limiares padrão): uma vez por rodada, não por item. */
  regrasAprendidasCompiladas?: RegrasAprendidasCompiladas;
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
    compiladas: args.regrasAprendidasCompiladas,
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
      dias_parado_max: num(l.estado_dias_parado_max),
      instrucao_padrao: (l.estado_instrucao_padrao as string | null) ?? null,
      instrucao_modelo: (l.estado_instrucao_modelo as string | null) ?? null,
      pagador_cnpj: (l.estado_pagador_cnpj as string | null) ?? null,
      previsao_vencida: typeof l.estado_previsao_vencida === "boolean" ? l.estado_previsao_vencida : null,
      ocorrencias_anteriores_min: num(l.estado_ocorrencias_anteriores_min),
    },
    reavaliar_em_horas: num(l.reavaliar_em_horas),
    alternativa: l.alternativa && typeof l.alternativa === "object"
      ? (() => {
        const a = l.alternativa as Record<string, unknown>;
        return {
          acao: a.acao as AlternativaAguardar["acao"], codigo: num(a.codigo), texto: String(a.texto ?? ""),
          confianca: Number(a.confianca), casos: Number(a.casos), taxa_acao: Number(a.taxa_acao),
        };
      })()
      : null,
    acao: l.acao as AcaoSugestao,
    codigo: num(l.codigo),
    texto: String(l.texto ?? ""),
    confianca: Number(l.confianca),
    casos: Number(l.casos),
    base_regra: String(l.base_regra ?? ""),
    ativo: l.ativo !== false,
  };
}
