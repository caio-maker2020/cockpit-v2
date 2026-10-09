// =============================================================================
// diagnostico-evidencias-dossie — INV-191 (Carlos 2026-10-09, NF 387252).
//
// O QUE O ROBÔ LEU × O QUE O DOSSIÊ ACEITOU. Só OBSERVA; nunca decide.
//
// Por quê: na NF 387252 o cliente mandou a descrição do item no CORPO do e-mail.
// O interpretador escreveu no motivo "as 3 evidências estão presentes", mas o
// dossiê gravou só romaneio e valor. Não deu para provar se o modelo deixou a
// descrição de fora ou se a copiou com palavras diferentes do e-mail (e a prova
// literal `corpoContemTrecho` recusou): o evento `DossieExtravioAtualizado` só
// guardava `Object.keys(recebidas)` e a resposta crua do modelo não fica em
// lugar nenhum. 7 cards em 30 dias com o mesmo sintoma. Este módulo grava, por
// evidência, o que o modelo devolveu e os FATOS medidos contra o e-mail — para o
// próximo caso virar prova, não palpite.
//
// REGRAS:
//   - Puro e sem efeito. Não altera `llm`, não chama banco, não decide nada:
//     quem decide continua sendo `montarEvidenciasRecebidas` (prova literal).
//   - Reaproveita as MESMAS funções da prova (`corpoContemTrecho`,
//     `acharAnexoInbound`, `normalizarTexto`) — o diagnóstico não pode
//     discordar da prova por usar outra régua.
//   - Texto do cliente vai cortado (≤200), igual ao teto do prompt.
//   - Nunca lança: entrada estranha vira campo vazio, e o chamador ainda
//     envolve em try/catch (falha aqui nunca derruba a leitura do e-mail).
// =============================================================================
import {
  acharAnexoInbound,
  corpoContemTrecho,
  normalizarTexto,
  type AnexoInbound,
  type EvidenciaLlmRaw,
  type EvidenciasRecebidas,
} from "./extravio-parcial-dossie.ts";

/** Teto do texto do cliente guardado no evento (mesmo teto do prompt). */
export const TETO_TEXTO_DIAGNOSTICO = 200;

export type ChaveEvidencia = "romaneio" | "descricao" | "valor";

export interface DiagnosticoEvidencia {
  /** O modelo devolveu esta evidência? (false = deixou a chave de fora) */
  modelo_informou: boolean;
  /** O que o modelo disse — cortado. null quando não informou. */
  modelo: {
    fonte: string | null;
    trecho: string | null;
    anexo_filename: string | null;
    tem_texto_extraido: boolean;
  } | null;
  /** Entrou no dossiê nesta leitura (passou na prova)? */
  aceita: boolean;
  /**
   * O trecho que o modelo deu está, literalmente (caixa e espaços normalizados),
   * no corpo? null = o modelo não deu trecho.
   */
  trecho_no_corpo: boolean | null;
  /** Trecho abaixo do piso anti-trivial (3 chars normalizados)? */
  trecho_curto: boolean;
  /**
   * Quantas palavras (≥3 letras) do trecho existem no corpo, "achadas/total".
   * Separa "copiou com palavras diferentes" (quase tudo achado, prova literal
   * recusou) de "inventou" (quase nada achado). null = sem trecho.
   */
  palavras_no_corpo: string | null;
  /** O nome de arquivo que o modelo citou casa com um anexo? null = não citou. */
  anexo_casou: boolean | null;
}

export interface DiagnosticoEvidencias {
  /** O modelo devolveu o bloco `evidencias_recebidas`? */
  modelo_devolveu_bloco: boolean;
  /** Tamanho do corpo do e-mail que a prova usou (o prompt vê só 3.000). */
  corpo_chars: number;
  romaneio: DiagnosticoEvidencia;
  descricao: DiagnosticoEvidencia;
  valor: DiagnosticoEvidencia;
}

function textoOuNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function cortar(v: string | null): string | null {
  return v === null ? null : v.slice(0, TETO_TEXTO_DIAGNOSTICO);
}

/** Palavras de 3+ letras, normalizadas como na prova. */
function palavras(s: string): string[] {
  return normalizarTexto(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length >= 3);
}

function contarPalavrasNoCorpo(trecho: string, corpoNorm: string): string {
  const ps = palavras(trecho);
  const achadas = ps.filter((p) => corpoNorm.includes(p)).length;
  return `${achadas}/${ps.length}`;
}

function diagnosticarUma(
  ev: EvidenciaLlmRaw | null | undefined,
  aceita: boolean,
  anexos: readonly AnexoInbound[],
  conteudo: string,
  corpoNorm: string,
  opts: { exato?: boolean } | undefined,
): DiagnosticoEvidencia {
  if (!ev || typeof ev !== "object") {
    return {
      modelo_informou: false,
      modelo: null,
      aceita,
      trecho_no_corpo: null,
      trecho_curto: false,
      palavras_no_corpo: null,
      anexo_casou: null,
    };
  }
  const trecho = textoOuNull(ev.trecho_verbatim);
  const filename = textoOuNull(ev.anexo_filename);
  return {
    modelo_informou: true,
    modelo: {
      fonte: textoOuNull(ev.fonte),
      trecho: cortar(trecho),
      anexo_filename: cortar(filename),
      tem_texto_extraido: textoOuNull(ev.texto_extraido) !== null,
    },
    aceita,
    trecho_no_corpo: trecho === null ? null : corpoContemTrecho(trecho, conteudo),
    trecho_curto: trecho !== null && normalizarTexto(trecho).length < 3,
    palavras_no_corpo: trecho === null ? null : contarPalavrasNoCorpo(trecho, corpoNorm),
    anexo_casou: filename === null ? null : acharAnexoInbound(filename, anexos, opts) !== null,
  };
}

/**
 * Diagnóstico por evidência: o que o modelo devolveu × o que a prova aceitou.
 * `opts` tem de ser o MESMO objeto passado a `montarEvidenciasRecebidas`.
 */
export function diagnosticarEvidenciasLlm(
  llm: { romaneio?: EvidenciaLlmRaw; descricao?: EvidenciaLlmRaw; valor?: EvidenciaLlmRaw } | null | undefined,
  recebidas: EvidenciasRecebidas,
  anexos: readonly AnexoInbound[],
  conteudo: string,
  opts?: { exato?: boolean },
): DiagnosticoEvidencias {
  const corpo = typeof conteudo === "string" ? conteudo : "";
  const corpoNorm = normalizarTexto(corpo);
  const bloco = llm && typeof llm === "object" ? llm : null;
  const uma = (k: ChaveEvidencia) =>
    diagnosticarUma(bloco?.[k], recebidas?.[k] != null, anexos ?? [], corpo, corpoNorm, opts);
  return {
    modelo_devolveu_bloco: bloco !== null,
    corpo_chars: corpo.length,
    romaneio: uma("romaneio"),
    descricao: uma("descricao"),
    valor: uma("valor"),
  };
}
