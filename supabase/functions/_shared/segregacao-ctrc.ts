// =============================================================================
// segregacao-ctrc — cerca da marcação "Segregar CTRC" (campo f8 da tela 101).
//
// Caio 2026-09-21: a PRATI pediu poder BARRAR a carga junto com a ocorrência de
// cliente do card de extravio. No portal SSW isso é o campo "Segregar CTRC"
// (`f8`, maxlength=1, default "N") — confirmado no HTML do form act=O:
//   <input name="f8" exc="1" id="8" value="N" maxlength="1" ...>
// NÃO confundir com `f11`, que é "Resposta a um Fale Conosco" — o outro campo
// S/N da mesma tela. Trocar os dois manda resposta de Fale Conosco e NÃO
// segrega: falha silenciosa com cara de sucesso.
//
// Segregar bloqueia o CT-e pra transferência, movimentação e entrega (não
// romaneia). A RETIRADA é manual pelo operador (opção 091) — o Cockpit não
// desfaz. Por isso a marcação é SEMPRE humana: nenhum agente autônomo pode
// ligá-la (ver `segregacaoPermitida` — exige `origemHumana`).
//
// Escopo fechado (Caio 2026-09-21):
//   - só clientes na whitelist (hoje: PRATI, os 2 CNPJs do grupo);
//   - só ocorrência de cliente do extravio: 54 (parcial) ou 59 (total);
//   - só ação manual da operadora — robô nunca segrega.
// =============================================================================

/**
 * Ocorrências que aceitam segregação. São as duas ocs de CLIENTE que o card de
 * extravio propõe: 54 (RETORNO TRATATIVA, extravio parcial) e 59 (RETORNO
 * INDENIZAÇÃO, extravio total) — a escolha entre elas é do
 * `extravio-enrichment` (separação 54/59 do Caio 2026-07-13), não daqui.
 * Qualquer outra oc (49, 55, 33, 44...) NÃO segrega.
 */
export const OCS_COM_SEGREGACAO: ReadonlySet<number> = new Set([54, 59]);

/** Normaliza CNPJ pra comparação: só dígitos, exige 14. "" quando inválido. */
export function normalizarCnpj(cnpj: string | null | undefined): string {
  const dig = (cnpj ?? "").replace(/\D/g, "");
  return dig.length === 14 ? dig : "";
}

/**
 * Ocorrências do CARD que caracterizam um card de EXTRAVIO.
 *
 * Caio 2026-09-21, ao fechar o escopo: "Somente nos cards de extravio".
 * Auditoria pré-merge do mesmo dia achou que essa frase existia no pedido, no
 * cabeçalho da migration e no texto da tela — mas NÃO no código: um card da
 * PRATI em RECUSA (oc 10/11/35) com proposta de 54 passava pela cerca e
 * barrava a carga de uma recusa, efeito que o Cockpit não desfaz.
 *
 * O conjunto: {6, 9, 16} são as ocorrências de extravio do SSW
 * (`EXTRAVIO_OCS` em agente-extravio-regras.ts); 49 é "PRAZO DE PERDAS
 * EXPIRADO", que o robô lança no D+4 e que passa a ser a última ocorrência do
 * card exatamente quando a operadora recebe a sugestão de 54/59 — que é o
 * momento em que ela marca a segregação.
 */
export const OCS_CARD_EXTRAVIO: ReadonlySet<number> = new Set([6, 9, 16, 49]);

export interface OrigemHumanaArgs {
  /** O SELECT em `todos` foi lido com sucesso? (sem erro E com linha) */
  leuTodo: boolean;
  /** `todos.auto_approval_rule`: null = aprovação humana; preenchido = robô. */
  regraAuto: string | null | undefined;
}

/**
 * A aprovação foi HUMANA, e isso está PROVADO?
 *
 * Auditoria pré-merge 2026-09-21: o executor lia `todos.auto_approval_rule`
 * ignorando o `error` do SELECT e colapsava três estados em "regra nula":
 *   (a) todo humano de verdade   → origem humana ✓
 *   (b) erro de query/RLS/timeout → NÃO dá pra afirmar nada
 *   (c) todo inexistente          → NÃO dá pra afirmar nada
 * Em (b) e (c) o código antigo concluía "foi humano" — fail-OPEN numa cerca
 * que existe justamente porque segregar é irreversível pelo Cockpit.
 *
 * Regra: ausência de prova não é prova de ausência de robô. Quem não consegue
 * provar que um humano olhou, não segrega.
 */
export function origemHumanaComprovada(args: OrigemHumanaArgs): boolean {
  if (!args.leuTodo) return false;
  return args.regraAuto == null;
}

export interface SegregacaoPermitidaArgs {
  /** CNPJ do pagador do card (vem de `agent_state.cnpj_pagador`). */
  cnpjPagador: string | null | undefined;
  /**
   * Ocorrências do CARD que provam que ele é de extravio. Passe as DUAS fontes:
   * `cards.cod_ultima_ocorrencia` E `agent_state.cod_ultima_ocorrencia`.
   *
   * Por que duas: o executor SOBRESCREVE `cards.cod_ultima_ocorrencia` a cada
   * lançamento (index.ts:1363), então num card que já recebeu a 54 o campo vale
   * 54, não 49 — a fonte canônica do "que o card era" é o agent_state
   * (index.ts:1331-1338, convenção do Caio 2026-05-25, NF 29920). Olhar só o
   * campo do card BLOQUEARIA o fluxo real de extravio em silêncio, que é o
   * modo de falha oposto e igualmente ruim.
   *
   * Basta UMA das fontes estar em `OCS_CARD_EXTRAVIO`. Fail-closed: lista
   * vazia, só nulos ou nenhuma no conjunto → não segrega.
   */
  codigosOcorrenciaCard: ReadonlyArray<number | null | undefined>;
  /** Código da ocorrência sendo lançada. */
  codigoSsw: number | null | undefined;
  /** Whitelist carregada do banco. Vazia = ninguém segrega (fail-closed). */
  cnpjsAutorizados: ReadonlySet<string>;
  /**
   * A marcação veio de uma aprovação HUMANA? Ação autônoma/robô = false.
   * Sem isso a segregação vira efeito irreversível sem ninguém ter olhado.
   */
  origemHumana: boolean;
}

/**
 * Guard PURO: esta ação pode segregar o CTRC?
 *
 * Fail-closed em tudo: CNPJ inválido, oc fora de {54,59}, whitelist vazia ou
 * origem não-humana → false. O default do portal continua "N".
 */
export function segregacaoPermitida(args: SegregacaoPermitidaArgs): boolean {
  if (!args.origemHumana) return false;
  if (args.codigoSsw == null || !OCS_COM_SEGREGACAO.has(args.codigoSsw)) return false;
  // Escopo do Caio: SÓ card de extravio. Sem nenhuma ocorrência de extravio em
  // mãos não dá pra afirmar que é extravio — e na dúvida não se barra carga.
  const ehCardExtravio = (args.codigosOcorrenciaCard ?? []).some(
    (oc) => oc != null && OCS_CARD_EXTRAVIO.has(oc),
  );
  if (!ehCardExtravio) return false;
  const cnpj = normalizarCnpj(args.cnpjPagador);
  if (!cnpj) return false;
  return args.cnpjsAutorizados.has(cnpj);
}

/**
 * Lê a marcação do payload do todo. Aceita boolean e string ("true"/"S"),
 * porque o front pode serializar de formas diferentes — mesmo contrato do
 * `forcar_lancamento_ctrc_baixado` (executor).
 *
 * IMPORTANTE: `segregar_ctrc` é flag de CONTROLE. Não entra em
 * `EXTRAS_PRA_DESCRICAO_SSW` — não pode virar texto da ocorrência.
 */
export function lerMarcacaoSegregar(extras: unknown): boolean {
  if (!extras || typeof extras !== "object") return false;
  const v = (extras as Record<string, unknown>)["segregar_ctrc"];
  return v === true || v === "true" || v === "S" || v === "s";
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** Kill-switch sem deploy (mig 407). OFF = ninguém segrega, mesmo whitelistado. */
export const FLAG_SEGREGACAO = "segregacao_ctrc_enabled";

/**
 * Whitelist de clientes que podem segregar, de `cliente_config_segregacao_ctrc`
 * (só linhas `ativo = true`), atrás da flag mestra `segregacao_ctrc_enabled`.
 *
 * FAIL-CLOSED em tudo: flag OFF/ausente, tabela ausente, erro de permissão,
 * coluna faltando ou exceção → Set VAZIO → ninguém segrega. Nunca lança, porque
 * roda no caminho quente do executor e uma exceção aqui derrubaria lançamentos
 * que não têm nada a ver com segregação. Mesmo contrato do
 * `seguir-parcial-carregar`.
 */
export async function carregarCnpjsSegregacao(
  supabase: SupabaseLike,
): Promise<ReadonlySet<string>> {
  try {
    const { data: flag } = await supabase
      .from("feature_flags").select("enabled").eq("key", FLAG_SEGREGACAO).maybeSingle();
    if ((flag as { enabled?: boolean } | null)?.enabled !== true) return new Set();

    const { data, error } = await supabase
      .from("cliente_config_segregacao_ctrc")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error || !Array.isArray(data)) {
      if (error) console.warn(`[segregacao-ctrc] whitelist indisponível: ${error.message}`);
      return new Set();
    }
    const out = new Set<string>();
    for (const row of data as Array<{ cnpj_pagador?: string | null }>) {
      const cnpj = normalizarCnpj(row?.cnpj_pagador);
      if (cnpj) out.add(cnpj);
    }
    return out;
  } catch (e) {
    console.warn(`[segregacao-ctrc] whitelist falhou: ${e instanceof Error ? e.message : String(e)}`);
    return new Set();
  }
}
