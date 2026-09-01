// =============================================================================
// devolucao-cte-44.ts — a PAREDE do lançamento da oc 44 com CT-e de devolução.
//
// Só decisão pura aqui. O texto do SSW e os campos obrigatórios da oc 44 são
// REUSADOS de `descricao-ssw.ts` (`montarDescricaoSsw`, `camposObrigatoriosAusentes`)
// — reimplementar seria o INV-042, e aquele módulo carrega a calibração do bug
// NF 59299 (extras antes da base, senão o setor de Devolução perde "quantos
// volumes e por quê" no corte de 70 chars do campo f6).
//
// POR QUE ESTA PAREDE EXISTE (§0 do plano + ADR 0014 + ADR 0018 decisão nº 4):
// a cadeia inteira que leva daqui ao SSW transforma perda de documento fiscal em
// SUCESSO SILENCIOSO se ninguém freia:
//   1. `carregarAnexosParaEnvio` pula anexo ausente com `continue` SILENCIOSO
//      (anexos-storage.ts:46-49) ⇒ a lista de imagens vira [];
//   2. a 44 é lançada mesmo assim ⇒ `stateFinalAposBastao(44) = TRANSFERIDO`
//      ⇒ o card SAI do painel da Maria;
//   3. `finalizarAnexosPosEnvio` apaga o PDF do bucket;
//   4. o Bastão troca o CTRC (devolução gera CTRC novo — ADR 0006) ⇒ card novo
//      sem vínculo com o ciclo.
// Resultado: a Devolução tem uma oc 44 SEM CT-e, o PDF não existe mais, o card
// não é mais da Maria — e o `card_event` diz "AcaoExecutada" com sucesso.
// Irreversível e invisível. Por isso: FALHA ALTA em vez de lançar pela metade.
// =============================================================================
import { camposObrigatoriosAusentes, montarDescricaoSsw } from "./descricao-ssw.ts";

/**
 * Nome do tool. Distinto de `lancar_ocorrencia:44` DE PROPÓSITO (R3): a 44
 * "pelada" e a 44 com CT-e coexistiriam na UNIQUE `(card_id, tool, codigo_ssw)`,
 * e aprovar a pelada lançaria 44 SEM CT-e. Sendo tool própria, o gate de
 * `propostas-pos-resposta-cliente` pode impedir a pelada de nascer nestes cards.
 *
 * ATENÇÃO: tool nova precisa ser registrada no front NO MESMO COMMIT — senão o
 * clique cai em `aprovar-direto` e aprova com `extras = null`, sem painel.
 * Guard: `tools-registrados-no-front.test.ts`.
 */
export const TOOL_44_DEVOLUCAO_CTE = "lancar_44_devolucao_cte";

/** Código SSW. Constante nomeada pra não haver 44 solto no código. */
export const CODIGO_SSW_44 = 44;

/**
 * Descrição base. Espelha a da 44 comum (`regras-auto-acao.ts`) e acrescenta o
 * CT-e, que é a diferença que o setor de Devolução precisa ver.
 * Fica no FIM do texto: os extras da operadora vêm antes e é o que sobrevive ao
 * corte de 70 chars do campo que o setor lê.
 */
export const BASE_DESCRICAO_44_CTE =
  "Cliente autorizou devolução — CT-e de devolução anexado — encaminha pro setor de Devolução";

/** O ciclo de devolução, como a tabela `devolucoes_cte` o guarda. */
export interface CicloDevolucaoCte {
  id: string;
  nf: string;
  ctrc_origem: string;
  cte_anexo_id: string | null;
  cte_convertido_ok: boolean | null;
  oc44_lancada_em: string | null;
  encerrado_em: string | null;
}

export interface EntradaLancamento44 {
  /** O ciclo lido do banco AGORA (não o payload da proposta — pode ter mudado). */
  ciclo: CicloDevolucaoCte | null;
  /** O card como está agora. O CTRC vem DAQUI, nunca de busca por NF (REGRA CRÍTICA). */
  card: { nf: string; ctrc: string };
  /** `devolucao_cte_em_escopo(cnpj_pagador)` avaliado no banco. */
  emEscopo: boolean;
  /** Extras que a operadora preencheu no painel de aprovação. */
  extras: Record<string, unknown> | null;
  /** Quantas imagens foram REALMENTE carregadas pro envio ao SSW. */
  imagensCarregadas: number;
}

/**
 * Devolve o motivo do ABORTO, ou `null` quando pode lançar.
 * Prefixo `skip:` = não é erro, é idempotência (não reverter, não alarmar).
 *
 * Cada regra abaixo tem uma contraparte em CHECK de banco na mig 372 — aqui é
 * a mensagem legível pra Maria; lá é a parede que nem um caller novo furaria.
 */
export function motivoAbortoLancamento44(e: EntradaLancamento44): string | null {
  const { ciclo, card, emEscopo, extras, imagensCarregadas } = e;

  if (!ciclo) return "ciclo_de_devolucao_nao_encontrado";

  // Idempotência ANTES de tudo: 2ª entrega do PGMQ não pode lançar de novo.
  // (VT_SECONDS=180 vs. PDFium + scrape + envio — risco R11 do plano.)
  if (ciclo.oc44_lancada_em) return `skip:oc44_ja_lancada_em:${ciclo.oc44_lancada_em}`;

  if (ciclo.encerrado_em) return `ciclo_encerrado_em:${ciclo.encerrado_em}`;

  // Escopo fail-closed. Fora da carteira da MARIA não se lança nada — vazar
  // atinge Larissa/Karoline/Ingrid e é irreversível na relação com o cliente.
  if (!emEscopo) return "fora_do_escopo_devolucao_cte";

  // A devolução TROCA o CTRC (ADR 0006). Se o card já é o do CTRC novo, lançar a
  // 44 aqui seria lançar no documento errado — e a REGRA CRÍTICA do projeto diz
  // que o CTRC vem do card. Divergência ⇒ para e devolve pro humano.
  const norm = (s: string) => (s ?? "").trim().toUpperCase();
  if (norm(card.ctrc) !== norm(ciclo.ctrc_origem)) {
    return `ctrc_do_card_diverge_do_ciclo:card=${norm(card.ctrc)}:ciclo=${norm(ciclo.ctrc_origem)}`;
  }
  if (norm(card.nf) !== norm(ciclo.nf)) {
    return `nf_do_card_diverge_do_ciclo:card=${norm(card.nf)}:ciclo=${norm(ciclo.nf)}`;
  }

  // "Não há devolução sem CT-e", sem exceção (decisão nº 3).
  if (!ciclo.cte_anexo_id) return "sem_cte_anexado";

  // Conversão PDF→JPEG falhou ⇒ NÃO lança (decisão nº 4, INVERTIDA de propósito
  // em 01/09). Era a única regra do desenho que virava perda de documento
  // fiscal em sucesso silencioso.
  if (ciclo.cte_convertido_ok !== true) return "conversao_do_cte_nao_confirmada";

  // O "em anexo" sem anexo: `carregarAnexosParaEnvio` devolve [] em silêncio.
  if (imagensCarregadas < 1) return "nenhuma_imagem_carregada_para_o_ssw";

  // Volumes e motivo: sem eles o setor de Devolução não consegue tratar
  // (NF 59299). Validação REUSADA, não reescrita.
  const faltando = camposObrigatoriosAusentes(CODIGO_SSW_44, extras);
  if (faltando.length > 0) return `campos_obrigatorios_ausentes:${faltando.join(",")}`;

  return null;
}

/** `true` quando o motivo é idempotência (não reverter o card, não alarmar). */
export function ehSkipIdempotente(motivo: string | null): boolean {
  return typeof motivo === "string" && motivo.startsWith("skip:");
}

/**
 * Texto que vai pro SSW. Fino de propósito: só fixa a base e delega o resto.
 * A whitelist de extras (`EXTRAS_PRA_DESCRICAO_SSW`) vive em `descricao-ssw.ts`
 * — iterar por TODOS os extras vazava flags internas (`validar_evidencia:
 * false`) pro texto do SSW; ver NF 2161614.
 */
export function montarTexto44Cte(extras: Record<string, unknown> | null): string {
  return montarDescricaoSsw({ baseDescricao: BASE_DESCRICAO_44_CTE, extras });
}
