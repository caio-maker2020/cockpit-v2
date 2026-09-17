// =============================================================================
// oc33-confirmacao-operador — INV-155.
//
// REGRA (Carlos 2026-09-16, palavras dele):
//   "a opcao tem q estar liberado desde q ela confirme q o dossie esta completo
//    e anexado / qdo ela tentar lancar neste caso deve abrir um popup
//    questionando que a descricao de itens nao foi identificada e questionando
//    se o cliente informou via anexo / se ela marcar SIM, libera lancar a 33
//    CONFIRMANDO QUE O DOSSIE ESTA COMPLETO / se ela marcar NAO, nao libera a 33
//    pois o dossie esta incompleto"
//
// POR QUE A CONFIRMACAO ENTRA NO DOSSIE, E NAO SO NO CARIMBO
//   O carimbo (`proposta_payload.meta.gate_oc33`) e ESCRITO EM TRES LUGARES —
//   propostas-pos-resposta-cliente.ts:518, regras-auto-acao.ts:1392 e o repatch
//   do interpretador-resposta-cliente/index.ts:1217 — e os tres o RECALCULAM a
//   partir do dossie via decidirGateOc33(). Apagar so o carimbo seria desfeito
//   pela proxima mensagem do cliente, em silencio, e o botao voltaria a ficar
//   cinza. A confirmacao precisa entrar no DOSSIE para sobreviver ao recarimbo.
//   Isso nao e escolha de design: e a unica forma que se sustenta.
//
// O QUE ESTE MODULO **NAO** FAZ (limites que o Carlos fixou):
//   - NAO pergunta sobre ROMANEIO. Sem romaneio o SSW reverte a 33 (NF 660746)
//     e o pop-up nao cobre isso: card sem romaneio continua bloqueado.
//   - NAO libera lancamento AUTONOMO. So o botao. O caminho automatico segue
//     barrado por veto-elegibilidade.ts:68 lendo o mesmo carimbo.
//   - NAO aparece em card sem anexo nenhum.
//   - NAO vale para o combo 33+44 (natureza "operacional"), que esta fora desta
//     rodada e exige so romaneio.
//
// IRREVERSIBILIDADE (consequencia conhecida, nao efeito colateral)
//   mergeEvidencia e MONOTONICO: `presente` nunca volta para false. Um SIM
//   errado marca o card como completo para sempre e o robo para de cobrar aquele
//   cliente. Por isso a confirmacao carrega operador_id + visto_em e o chamador
//   grava card_event ANTES de escrever (event sourcing, convencao nº 1).
//
// PURO de proposito: sem supabase, sem fetch, sem Date.now(). Testado em
// oc33-confirmacao-operador.test.ts.
//   deno test --no-check --allow-all supabase/functions/_shared/oc33-confirmacao-operador.test.ts
// =============================================================================

import {
  type DossieExtravioParcial,
  type EvidenciasRecebidas,
  JANELA_VISIVEL_SSW,
  mergeEvidencia,
  montarTextoDescricaoValor,
  ROTULO_EVIDENCIA,
} from "./extravio-parcial-dossie.ts";

export type AlvoConfirmacao = "descricao" | "valor";

/**
 * Piso anti-trivial. Mesmo piso de `corpoContemTrecho` (3 chars): um SIM com
 * "x" digitado produz exatamente a oc 33 vazia que voltou do Ressarcimento
 * pedindo "DESCRICAO E VALOR" (NF 660746). Marcar SIM sem escrever nao vale.
 */
export const PISO_TEXTO_CONFIRMACAO = 3;

/**
 * Tetos dos dois campos. Somados aos rotulos de montarTextoDescricaoValor
 * ("Itens: " = 7, " | " + "Valor: " = 10, total 17) cabem na janela de 70 que o
 * setor le. Nao sao camisa de forca — a previa mostra o corte real; sao o limite
 * do que faz sentido digitar.
 */
export const LIMITE_DESCRICAO_CONFIRMACAO = 60;
export const LIMITE_VALOR_CONFIRMACAO = 25;

/** Custo fixo dos rotulos dentro da janela visivel. Derivado, nunca chutado. */
export const OVERHEAD_ROTULOS_SSW = "Itens: ".length + " | ".length + "Valor: ".length;

export type MotivoSemPergunta =
  | "sem_dossie"
  | "nao_bloqueada"
  | "natureza_operacional"
  | "falta_romaneio"
  | "nada_faltando"
  | "card_sem_anexo";

export interface DecisaoPerguntaOc33 {
  /** true = a tela DEVE abrir o pop-up em vez de manter o botao cinza. */
  perguntar: boolean;
  /** Codigo de maquina do porque nao perguntar. `null` quando perguntar=true. */
  motivo: MotivoSemPergunta | null;
  /** Quais evidencias a confirmacao vai preencher (ordem descricao → valor). */
  alvos: AlvoConfirmacao[];
  /** Rotulos humanos dos alvos, para a pergunta na tela. */
  rotulos: string[];
}

/**
 * A operadora pode ser perguntada neste to-do?
 *
 * Todas as condicoes sao E. A ordem dos testes e deliberada: devolve o motivo
 * MAIS ESPECIFICO primeiro, para a tela poder explicar em vez de so apagar o
 * botao. Puro.
 */
export function decidirPerguntaOc33(args: {
  natureza: "operacional" | "completude" | null;
  bloqueada: boolean;
  dossie: DossieExtravioParcial | null | undefined;
  temAnexoNoCard: boolean;
}): DecisaoPerguntaOc33 {
  const nada: DecisaoPerguntaOc33 = { perguntar: false, motivo: null, alvos: [], rotulos: [] };
  const recusa = (motivo: MotivoSemPergunta): DecisaoPerguntaOc33 => ({ ...nada, motivo });

  if (!args.dossie) return recusa("sem_dossie");
  // Carimbo ausente ou bloqueada=false => a parede JA deixa passar. Nao ha o que
  // confirmar, e perguntar aqui seria pedir digitacao para destravar o que ja
  // esta destravado.
  if (args.bloqueada !== true) return recusa("nao_bloqueada");
  // Combo 33+44 (operacional) esta FORA desta rodada e exige so romaneio.
  if (args.natureza !== "completude") return recusa("natureza_operacional");
  // O pop-up nao pergunta sobre romaneio: sem ele o SSW reverte a 33.
  if (args.dossie.romaneio?.presente !== true) return recusa("falta_romaneio");

  const alvos: AlvoConfirmacao[] = [];
  if (args.dossie.descricao?.presente !== true) alvos.push("descricao");
  if (args.dossie.valor?.presente !== true) alvos.push("valor");
  if (alvos.length === 0) return recusa("nada_faltando");

  // Regra do Carlos: sem anexo nenhum no card nao ha o que o cliente pudesse ter
  // informado "via anexo" — o fluxo segue como hoje, o robo continua cobrando.
  if (!args.temAnexoNoCard) return recusa("card_sem_anexo");

  return {
    perguntar: true,
    motivo: null,
    alvos,
    rotulos: alvos.map((a) => ROTULO_EVIDENCIA[a]),
  };
}

export interface ConfirmacaoOperador {
  /** Marcou SIM? NAO => nao libera (dossie segue incompleto). */
  confirmou: boolean;
  descricao?: string | null;
  valor?: string | null;
  operador_id?: string | null;
  /** ISO. Vem do chamador — este modulo nao le relogio. */
  visto_em: string;
}

export interface ValidacaoConfirmacao {
  ok: boolean;
  /** Mensagens humanas, prontas para a tela. Vazio quando ok. */
  erros: string[];
  descricao: string | null;
  valor: string | null;
}

/**
 * Valida o que a operadora marcou/digitou contra os alvos que faltam. Puro.
 *
 * NAO confia na tela: o mesmo validador roda no servidor antes de escrever.
 */
export function validarConfirmacao(
  c: ConfirmacaoOperador,
  alvos: readonly AlvoConfirmacao[],
): ValidacaoConfirmacao {
  const erros: string[] = [];
  if (!c.confirmou) {
    return { ok: false, erros: ["A operadora marcou NAO — o dossie segue incompleto."], descricao: null, valor: null };
  }
  if (alvos.length === 0) {
    return { ok: false, erros: ["Nao ha evidencia faltando para confirmar."], descricao: null, valor: null };
  }

  const limpar = (t: string | null | undefined, teto: number) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, teto);
  const descricao = alvos.includes("descricao") ? limpar(c.descricao, LIMITE_DESCRICAO_CONFIRMACAO) : null;
  const valor = alvos.includes("valor") ? limpar(c.valor, LIMITE_VALOR_CONFIRMACAO) : null;

  // Carlos escolheu a opcao (a): ela DIGITA. SIM em branco produz a mesma oc 33
  // vazia que o Ressarcimento devolveu — o SIM sozinho nao vale.
  if (alvos.includes("descricao") && (descricao?.length ?? 0) < PISO_TEXTO_CONFIRMACAO) {
    erros.push(`Escreva a ${ROTULO_EVIDENCIA.descricao} (minimo ${PISO_TEXTO_CONFIRMACAO} caracteres).`);
  }
  if (alvos.includes("valor") && (valor?.length ?? 0) < PISO_TEXTO_CONFIRMACAO) {
    erros.push(`Escreva o ${ROTULO_EVIDENCIA.valor} (minimo ${PISO_TEXTO_CONFIRMACAO} caracteres).`);
  }

  return { ok: erros.length === 0, erros, descricao, valor };
}

/**
 * Converte a confirmacao VALIDADA em evidencias para mergeEvidencia. Puro.
 *
 * O texto vai em `texto_bruto` (conteudo literal, que e o que o SSW mostra) e a
 * procedencia fica em `fonte: "operador"` + `operador_id`. NAO usa
 * `texto_extraido`: aquele campo significa "a MAQUINA leu dentro do arquivo", e
 * `fontesLidasEmAnexo` o usa para escrever "lido de: <arquivo>" no fim da
 * Instrucao — com filename vazio, sujaria o texto do SSW.
 *
 * Devolve {} quando a validacao reprovou: nada entra no dossie sem passar.
 */
export function evidenciasDaConfirmacao(
  v: ValidacaoConfirmacao,
  c: ConfirmacaoOperador,
): EvidenciasRecebidas {
  if (!v.ok) return {};
  const base = {
    fonte: "operador" as const,
    operador_id: c.operador_id ?? null,
    visto_em: c.visto_em,
  };
  const out: EvidenciasRecebidas = {};
  if (v.descricao) out.descricao = { ...base, texto_bruto: v.descricao };
  if (v.valor) out.valor = { ...base, texto_bruto: v.valor };
  return out;
}

export interface PreviaSetor {
  /** Texto completo de descricao+valor que vai para a Instrucao do SSW. */
  texto: string;
  /** Os primeiros JANELA_VISIVEL_SSW caracteres — o que o setor REALMENTE le. */
  janela: string;
  /** true = sobrou texto fora da janela (o setor nao vai ver o resto). */
  cortado: boolean;
}

/**
 * Previa do que o setor de Ressarcimento vai ler, montada pelo MESMO caminho que
 * gera o texto real (mergeEvidencia → montarTextoDescricaoValor). Puro.
 *
 * Existe para a tela nao ter a propria conta: qualquer mudanca nos rotulos ou na
 * ordem aparece na previa sozinha, sem ninguem lembrar de sincronizar.
 */
export function previaTextoDoSetor(
  dossie: DossieExtravioParcial,
  v: ValidacaoConfirmacao,
  c: ConfirmacaoOperador,
): PreviaSetor {
  const simulado = mergeEvidencia(dossie, evidenciasDaConfirmacao(v, c));
  const texto = montarTextoDescricaoValor(simulado);
  return {
    texto,
    janela: texto.slice(0, JANELA_VISIVEL_SSW),
    cortado: texto.length > JANELA_VISIVEL_SSW,
  };
}
