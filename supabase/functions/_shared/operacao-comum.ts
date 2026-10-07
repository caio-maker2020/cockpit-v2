// =============================================================================
// operacao-comum — peças comuns da área de Operação no Cockpit (ADR 0041).
//
// A Operação ganha fila própria e lança ocorrências no SSW pelo clique de uma
// pessoa. Este arquivo concentra os números e as listas que o materializador, o
// worker e os testes usam. É PURO (sem I/O): deno test.
//
// Os parâmetros de vazão são os MESMOS da ponte da operação (ADR 0039, D5):
// a conta de serviço `ai.salex` é uma só (INV-159), então quem lança por ela
// segue o mesmo teto. A paridade é travada em
// `operacao-paridade-ponte-operacao.test.ts`.
// =============================================================================

// ── flags (mig 430, todas nascem OFF) ────────────────────────────────────────
/** Materializador da fila (Bastão → op_itens). OFF = edge responde `skipped`. */
export const FLAG_OPERACAO_FILA = "operacao_fila" as const;
/** Worker leva lançamentos ao SSW. OFF = nada sai; relida antes de CADA lançamento. */
export const FLAG_OPERACAO_LANCAR_SSW = "operacao_lancar_ssw" as const;
/** A tela da Operação (RLS de op_itens para membros e a visão op_v_fila). */
export const FLAG_OPERACAO_TELA = "operacao_tela" as const;

// ── vazão e prazos (iguais aos da ponte, ADR 0039 D5) ────────────────────────
/** Lançamentos por minuto que o worker PEDE. */
export const LIMITE_SSW_POR_MINUTO = 2;
/** Teto duro, repetido na RPC op_reservar_lancamentos: nem com parâmetro errado passa disso. */
export const TETO_SSW_POR_MINUTO = 3;
export const JANELA_VAZAO_SEGUNDOS = 60;
/** Depois de um login recusado, ninguém lança por este tempo (INV-159 d: esperar). */
export const QUARENTENA_LOGIN_MIN = 30;
/** Lançamento na fila que não saiu neste prazo vira `erro` (expirado): peça de novo. */
export const TTL_LANCAMENTO_HORAS = 4;
/** Reservado e não terminou (worker morreu no meio) → `erro`, conferir no SSW. NUNCA relança. */
export const LANCAMENTO_TRAVADO_MIN = 15;

// ── confirmação (ADR 0041, D7) ───────────────────────────────────────────────
/**
 * Depois de lançar, a confirmação vem da LEITURA SEGUINTE da oc (o Bastão mostra
 * a oc lançada). Só quando ela não vem em 90 min o worker pergunta ao SSW
 * (`descobrirUltimaOcSsw`). Mesmo valor do VERIFICATION_TIMEOUT_MINUTES do
 * Relacionamento (bastao-rules.ts).
 */
export const CONFIRMACAO_TIMEOUT_MIN = 90;
/** Leitura do SSW que falhou é repetida no máximo isto, espaçada; depois vira `nao_confirmado`. */
export const CONFIRMACAO_MAX_TENTATIVAS = 3;
export const CONFIRMACAO_INTERVALO_MIN = 30;
/** Leituras de confirmação no SSW por rodada do worker (cada uma é 1 login no pior caso). */
export const CONFIRMACOES_POR_RODADA = 1;

// ── o que NUNCA entra na fila da Operação (ADR 0041, D4) ─────────────────────
/** Finalizadoras: entregue, devolução autorizada, cancelada — o SSW recusaria ação. */
export const OCS_FINALIZADORAS_OPERACAO: ReadonlySet<number> = new Set([1, 30, 32]);
/** Documentais: o fato já é documento; não há o que a Operação lançar em cima. */
export const OCS_DOCUMENTAIS_OPERACAO: ReadonlySet<number> = new Set([2, 34]);

/**
 * Códigos que a Operação NUNCA lança pelo menu (CHECK em op_codigos_lancaveis):
 * 49 (tratativa do Relacionamento; só por fluxo próprio), 54/59 (cliente),
 * 33/44 (ressarcimento/devolução com documento), 6/9/16 (extravio/Perdas).
 */
export const OCS_PROIBIDAS_OPERACAO: ReadonlySet<number> = new Set([49, 54, 59, 33, 44, 6, 9, 16]);

/** 41 e 56 existem por causa do texto do operador (INV-046). Sem texto, não lança. */
export const OCS_TEXTO_OBRIGATORIO_OPERACAO: ReadonlySet<number> = new Set([41, 56]);
/** Mínimo de caracteres do texto do operador quando ele é obrigatório. */
export const TEXTO_OBRIGATORIO_MIN = 10;

export const STATES_TERMINAIS_CARD = ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"] as const;

export function cardEstaAtivo(state: string | null | undefined): boolean {
  return !!state && !(STATES_TERMINAIS_CARD as readonly string[]).includes(state);
}

/** CTRC sempre trim + maiúsculas, igual a `cards.ctrc` e a `op_itens.ctrc`. */
export function normalizarCtrcOp(ctrc: string | null | undefined): string | null {
  const s = (ctrc ?? "").trim().toUpperCase();
  return s ? s : null;
}

/** NF sem zeros à esquerda, igual a `cards.nf`. */
export function normalizarNfOp(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const t = String(nf).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}

/** Unidade (sigla de base/filial do SSW) sempre trim + maiúsculas. */
export function normalizarUnidade(u: string | null | undefined): string | null {
  const s = (u ?? "").trim().toUpperCase();
  return s ? s : null;
}

/** Pura: mesma conta da RPC `op_reservar_lancamentos`. */
export function vagasDeLancamentoOp(args: {
  limitePorMinuto: number;
  reservadosNaJanela: number;
  emQuarentena: boolean;
}): number {
  if (args.emQuarentena) return 0;
  const lim = Math.max(0, Math.min(TETO_SSW_POR_MINUTO, Math.floor(Number(args.limitePorMinuto) || 0)));
  return Math.max(0, lim - Math.max(0, Math.floor(args.reservadosNaJanela)));
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
