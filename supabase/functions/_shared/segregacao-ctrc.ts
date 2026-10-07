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
 * O conjunto são as ocorrências de extravio do SSW (dicionário: 6 transferência,
 * 9 coleta, 16 entrega — responsabilidade Perdas), espelho de `EXTRAVIO_OCS` em
 * agente-extravio-regras.ts (paridade travada por teste).
 *
 * Carlos 2026-10-06: a 49 SAIU daqui. Ela é "Tratativa de relacionamento" —
 * genérica, NÃO é extravio. Entrou em 21/09 como atalho porque o robô do
 * extravio lança uma 49 ("PRAZO DE PERDAS EXPIRADO") no D+4, e com isso
 * qualquer 49 de relacionamento passava por "card de extravio" (em 06/10, 2 dos
 * 6 cards abertos da PRATI com 49 não tinham extravio nenhum comprovado). A 49
 * agora só conta com a prova do robô — ver `ehCardDeExtravioComprovado`.
 */
export const OCS_CARD_EXTRAVIO: ReadonlySet<number> = new Set([6, 9, 16]);

/** 49 = "Tratativa de relacionamento". Só vale como extravio quando o robô do
 *  extravio a lançou (ele só lança depois de confirmar 6/9/16 no SSW, INV-020). */
export const OC_49_TRATATIVA_RELACIONAMENTO = 49;

/**
 * A prova de que a 49 do card veio do extravio: `cards.agente_extravio_status`
 * = "lancou", gravado pelo `agente-extravio-d4` junto com o evento
 * `AgenteExtravioLancou49` — e ele só lança depois de confirmar no SSW que a
 * última ocorrência real é 6/9/16 (`podeAgenteLancar49`). Qualquer outro valor
 * (nulo, "nao_rodou", "recomendado", lixo) NÃO prova nada.
 */
export function roboDoExtravioLancou49(agenteExtravioStatus: unknown): boolean {
  return agenteExtravioStatus === "lancou";
}

/**
 * O card é de extravio COMPROVADO? Basta UMA das fontes (agent_state e cards —
 * ver `codigosOcorrenciaCard`) ser 6/9/16, ou ser 49 com a prova do robô.
 * Fail-closed: lista vazia, só nulos, ou 49 sem prova → false.
 */
export function ehCardDeExtravioComprovado(
  codigosOcorrenciaCard: ReadonlyArray<number | null | undefined>,
  oc49LancadaPeloRoboDoExtravio: boolean,
): boolean {
  return (codigosOcorrenciaCard ?? []).some(
    (oc) =>
      oc != null &&
      (OCS_CARD_EXTRAVIO.has(oc) ||
        (oc === OC_49_TRATATIVA_RELACIONAMENTO && oc49LancadaPeloRoboDoExtravio === true)),
  );
}

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
   * Basta UMA das fontes estar em `OCS_CARD_EXTRAVIO` (ou ser 49 com a prova
   * do robô). Fail-closed: lista vazia, só nulos ou nenhuma no conjunto → não
   * segrega.
   */
  codigosOcorrenciaCard: ReadonlyArray<number | null | undefined>;
  /**
   * A 49 do card foi lançada pelo robô do extravio? (`roboDoExtravioLancou49`
   * sobre `cards.agente_extravio_status`). OBRIGATÓRIO de propósito: quem chama
   * a cerca tem de decidir, e 49 sem esta prova não é extravio (Carlos 06/10).
   */
  oc49LancadaPeloRoboDoExtravio: boolean;
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
  if (!ehCardDeExtravioComprovado(args.codigosOcorrenciaCard, args.oc49LancadaPeloRoboDoExtravio)) {
    return false;
  }
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

// =============================================================================
// RESERVA À OPERADORA (Carlos 2026-10-06, Larissa/PRATI).
//
// A cerca acima impede o robô de SEGREGAR — mas não impedia o robô de LANÇAR a
// 54/59 sozinho pela janela de veto. De 22/09 a 06/10, 23 ações de 54/59 da
// PRATI saíram pelo robô (20 delas na variante "+ e-mail", a que tem a caixa),
// boa parte antes de a operadora começar o dia. Resultado: a segregação nunca
// teve chance de ser marcada. Regra derivada: quando ESTA ação, aprovada por
// humano, poderia segregar, ela é da operadora — o robô não lança.
// =============================================================================

export type SegregacaoReservaArgs = Omit<SegregacaoPermitidaArgs, "origemHumana">;

/**
 * PURO: se um humano aprovasse esta ação, a segregação poderia ser marcada?
 * Mesma cerca, com a origem humana suposta — uma regra só, sem cópia que
 * divirja. Verdadeiro ⇒ o robô não pode tirar a vez da operadora.
 */
export function segregacaoReservadaAoHumano(args: SegregacaoReservaArgs): boolean {
  return segregacaoPermitida({ ...args, origemHumana: true });
}

export type WhitelistSegregacaoComStatus =
  | { ok: true; cnpjs: ReadonlySet<string> }
  | { ok: false; motivo: string };

/**
 * A whitelist da segregação DISTINGUINDO "desligado" de "não consegui ler".
 *
 * O `carregarCnpjsSegregacao` acima colapsa os dois em Set vazio — certo para o
 * executor (vazio = ninguém segrega). Aqui a direção segura é a OPOSTA: na
 * dúvida a ação fica com a operadora, então erro de leitura NÃO pode virar
 * "cliente não segrega" (isso devolveria a ação ao robô). Por isso:
 *   flag OFF/ausente            → ok, Set vazio (segregação desligada: nada a reservar);
 *   erro/exceção/dado estranho → ok:false (quem chama trata como reservado).
 */
export async function carregarWhitelistSegregacaoComStatus(
  supabase: SupabaseLike,
): Promise<WhitelistSegregacaoComStatus> {
  try {
    const { data: flag, error: flagErr } = await supabase
      .from("feature_flags").select("enabled").eq("key", FLAG_SEGREGACAO).maybeSingle();
    if (flagErr) return { ok: false, motivo: `flag_ilegivel:${flagErr.message ?? "?"}` };
    if ((flag as { enabled?: boolean } | null)?.enabled !== true) return { ok: true, cnpjs: new Set() };

    const { data, error } = await supabase
      .from("cliente_config_segregacao_ctrc")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error) return { ok: false, motivo: `whitelist_ilegivel:${error.message ?? "?"}` };
    if (!Array.isArray(data)) return { ok: false, motivo: "whitelist_formato_inesperado" };
    const out = new Set<string>();
    for (const row of data as Array<{ cnpj_pagador?: string | null }>) {
      const cnpj = normalizarCnpj(row?.cnpj_pagador);
      if (cnpj) out.add(cnpj);
    }
    return { ok: true, cnpjs: out };
  } catch (e) {
    return { ok: false, motivo: `excecao:${e instanceof Error ? e.message : String(e)}` };
  }
}

/** O mínimo do card que a reserva lê (mesmas fontes do executor). */
export interface CardParaReservaSegregacao {
  agent_state?: unknown;
  cod_ultima_ocorrencia?: number | null;
  agente_extravio_status?: string | null;
}

export interface ResultadoReservaSegregacao {
  reservado: boolean;
  motivo: string;
}

/**
 * A ação autônoma `acaoKey` neste card tem de ficar com a operadora?
 *
 * Usada nos DOIS pontos da janela de veto: ao agendar (veto-agendamento) e no
 * vencimento (processar-acoes-agendadas — pega o que já estava agendado e o
 * que mudou durante a janela). Nunca lança; na dúvida, reserva.
 *
 *  - "aguardar" (ignorar_e_aguardar:*) não lança ocorrência → nunca reserva;
 *  - oc fora de {54,59} → nunca reserva, e NÃO consulta o banco (custo zero
 *    para todas as outras ações autônomas);
 *  - card ilegível ou whitelist ilegível → reserva (fail-safe para o humano).
 */
export async function avaliarReservaSegregacaoVeto(
  supabase: SupabaseLike,
  acaoKey: string | null | undefined,
  card: CardParaReservaSegregacao | null | undefined,
): Promise<ResultadoReservaSegregacao> {
  if (!acaoKey || acaoKey.startsWith("ignorar_e_aguardar:")) {
    return { reservado: false, motivo: "acao_nao_lanca_ocorrencia" };
  }
  const codigo = Number(acaoKey.split(":").pop());
  if (!Number.isFinite(codigo) || !OCS_COM_SEGREGACAO.has(codigo)) {
    return { reservado: false, motivo: "oc_sem_segregacao" };
  }
  if (!card) return { reservado: true, motivo: "card_ilegivel" };

  const wl = await carregarWhitelistSegregacaoComStatus(supabase);
  if (!wl.ok) return { reservado: true, motivo: `whitelist_indisponivel:${wl.motivo}` };

  const agentState = (card.agent_state && typeof card.agent_state === "object")
    ? card.agent_state as Record<string, unknown>
    : {};
  const ocAgentState = agentState["cod_ultima_ocorrencia"];
  const reservado = segregacaoReservadaAoHumano({
    cnpjPagador: (agentState["cnpj_pagador"] as string | null | undefined) ?? null,
    codigoSsw: codigo,
    codigosOcorrenciaCard: [
      typeof ocAgentState === "number" ? ocAgentState : null,
      card.cod_ultima_ocorrencia ?? null,
    ],
    oc49LancadaPeloRoboDoExtravio: roboDoExtravioLancou49(card.agente_extravio_status),
    cnpjsAutorizados: wl.cnpjs,
  });
  return reservado
    ? { reservado: true, motivo: "cliente_segrega_e_card_de_extravio" }
    : { reservado: false, motivo: "fora_do_escopo_da_segregacao" };
}
