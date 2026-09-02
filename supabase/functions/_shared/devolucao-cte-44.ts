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

/**
 * O ciclo de devolução, como a tabela `devolucoes_cte` o guarda.
 *
 * DOIS ARTEFATOS, de propósito:
 *  - `cte_anexo_id`       = o PDF ORIGINAL. Vai no e-mail ao setor de Devolução,
 *                           porque o anexo do SSW não tem qualidade de impressão
 *                           (é a razão de aquele e-mail existir).
 *  - `cte_anexos_ssw_ids` = os JPEGs da conversão. São ESTES que sobem pro SSW,
 *                           que não aceita PDF de forma alguma.
 * Confundir os dois manda o documento errado pra cada lado.
 */
export interface CicloDevolucaoCte {
  id: string;
  nf: string;
  ctrc_origem: string;
  cte_anexo_id: string | null;
  cte_convertido_ok: boolean | null;
  cte_anexos_ssw_ids: string[] | null;
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
 * Cada regra abaixo tem uma contraparte em CHECK de banco na mig 373 — aqui é
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

  // Conversão marcada OK mas sem NENHUM JPEG registrado é estado incoerente —
  // e o SSW não aceita PDF, então lançar aqui subiria a oc sem documento algum.
  if ((ciclo.cte_anexos_ssw_ids ?? []).length < 1) return "sem_anexo_convertido_para_o_ssw";

  // O "em anexo" sem anexo: `carregarAnexosParaEnvio` devolve [] em silêncio.
  if (imagensCarregadas < 1) return "nenhuma_imagem_carregada_para_o_ssw";

  // Volumes e motivo: sem eles o setor de Devolução não consegue tratar
  // (NF 59299). Validação REUSADA, não reescrita.
  const faltando = camposObrigatoriosAusentes(CODIGO_SSW_44, extras);
  if (faltando.length > 0) return `campos_obrigatorios_ausentes:${faltando.join(",")}`;

  return null;
}

// -----------------------------------------------------------------------------
// R3 — DUAS propostas de 44 vivas no mesmo card
//
// `uniq_todos_card_tool_cod_ativo` é `(card_id, tool, codigo_ssw)`, então a 44
// "pelada" (`lancar_ocorrencia:44`) e esta coexistem. Aprovar a pelada lança 44
// **sem o CT-e** — exatamente o que a decisão nº 3 proíbe ("não há devolução sem
// CT-e, sem exceção") — e o card vai pra TRANSFERIDO, saindo do painel.
//
// Os COMBOS entram na mesma cerca, e a razão é mais forte que a da pelada:
// medido em `executor/index.ts:2510`, o combo 33+44 lança a perna 44 com `[]`
// — *"oc=44 não leva imagem"*. Numa parede de envelope isso viraria **meio-estado
// irreversível**: a 33 entra no SSW, a 44 é recusada, e o próprio código diz
// *"oc=33 já foi lançada. Não dá pra rollback"*. Barrar no MENU evita o
// meio-estado em vez de administrá-lo.
//
// Nenhuma capacidade se perde: a oc 33 SOLO continua no menu, então
// indenização + devolução segue possível como duas ações (33 solo + esta 44 com
// CT-e). O que sai é a forma EMPACOTADA, que é a que não sabe anexar o CT-e.
// -----------------------------------------------------------------------------

/** `tipo_acao` das propostas que carregam uma perna de oc 44 embutida. */
export const TIPOS_ACAO_COM_PERNA_44: readonly string[] = ["combo_33_44", "combo_44_59"];

/**
 * Tira do menu as propostas que lançariam oc 44 SEM o CT-e, quando o card tem
 * ciclo de devolução com CT-e ABERTO. Sem ciclo aberto ⇒ devolve a lista
 * INTACTA (zero efeito em qualquer outro card ou operador).
 */
export function filtrarPropostas44SemCte<
  T extends { codigo_ssw: number; tipo_acao?: string },
>(propostas: readonly T[], cicloCteAberto: boolean): T[] {
  if (!cicloCteAberto) return [...propostas];
  return propostas.filter((p) => {
    if (p.codigo_ssw === CODIGO_SSW_44 && p.tipo_acao == null) return false; // a pelada
    if (p.tipo_acao != null && TIPOS_ACAO_COM_PERNA_44.includes(p.tipo_acao)) return false;
    return true;
  });
}

/**
 * PAREDE NO ENVELOPE — último recurso, e o único ponto por onde TODA oc 44 passa.
 *
 * Por que a cerca do menu não basta: `filtrarPropostas44SemCte` só decide o que
 * é CRIADO. Um todo de 44 pelada criado ANTES de o CT-e chegar continua pendente
 * e aprovável — e `reverter_acao_falhou` chega a ressuscitar proposta (R3).
 *
 * Regra: num card com ciclo de devolução ABERTO, uma oc 44 sem NENHUMA imagem é
 * devolução sem documento (decisão nº 3). A 44 desta feature sempre carrega os
 * JPEGs do CT-e, então nunca cai aqui.
 *
 * `cicloAberto` é resolvido pelo chamador e é FAIL-OPEN no erro de infra: se a
 * tabela não existe (mig 373 não aplicada) ou a consulta falha, passa `false` e
 * nada muda. Fechar por erro de infra pararia TODA a operação de devolução do
 * Cockpit — blast radius muito maior que o risco coberto.
 */
export function motivoBloqueio44SemCte(
  codigoSsw: number,
  cicloAberto: boolean,
  quantidadeImagens: number,
): string | null {
  if (codigoSsw !== CODIGO_SSW_44) return null;
  if (!cicloAberto) return null;
  if (quantidadeImagens > 0) return null;
  return "oc44_sem_anexo_em_card_com_ciclo_de_devolucao_aberto";
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
