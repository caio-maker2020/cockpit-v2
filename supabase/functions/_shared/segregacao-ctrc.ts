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

export interface SegregacaoPermitidaArgs {
  /** CNPJ do pagador do card (vem de `agent_state.cnpj_pagador`). */
  cnpjPagador: string | null | undefined;
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

/**
 * Whitelist de clientes que podem segregar, de `cliente_config_segregacao_ctrc`
 * (só linhas `ativo = true`).
 *
 * FAIL-CLOSED em tudo: tabela ausente, erro de permissão, coluna faltando ou
 * exceção → Set VAZIO → ninguém segrega. Nunca lança, porque roda no caminho
 * quente do executor e uma exceção aqui derrubaria lançamentos que não têm
 * nada a ver com segregação. Mesmo contrato do `seguir-parcial-carregar`.
 */
export async function carregarCnpjsSegregacao(
  supabase: SupabaseLike,
): Promise<ReadonlySet<string>> {
  try {
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
