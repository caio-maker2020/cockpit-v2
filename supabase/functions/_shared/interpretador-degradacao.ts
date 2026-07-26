// Rede de segurança do interpretador de resposta do cliente (INV-055).
//
// Incidente 26/07 (NF 164346 e mais 10 cards): a resposta do LLM vinha cortada
// por max_tokens, o JSON não parseava, o interpretador gravava só um
// card_event de falha e devolvia {ok:false} — o card ficava SEM sugestão, e
// como a fila de pendentes procura exatamente "respondeu mas não tem
// sugestão", ele voltava pra fila a cada 5 min, para sempre. 899 chamadas
// sobre 11 mensagens em um domingo.
//
// Regra do Caio (2026-07-26, verbatim): "Não podemos deixar o card sem
// interpretar, sem ações, e sem nada. (…) Não adianta só jogar para o
// operador fazer."
//
// Ordem de defesa (a primeira que resolver, resolve):
//   1. teto de saída compatível com o schema (não trunca)           — index.ts
//   2. retry que dobra o teto quando truncou                        — anthropic-client.ts
//   3. leitura PARCIAL remendada, com confiança degradada           — aqui
//   4. desistência DETERMINÍSTICA com sugestão conservadora + ações — aqui
//
// O passo 4 nunca é "abre um chamado pro humano": ele devolve a mesma
// estrutura de sugestão que o fluxo normal produz, então o card segue com
// banner, propostas e to-dos — só que marcado como leitura degradada.
//
// Rodar: deno test supabase/functions/_shared/interpretador-degradacao.test.ts

/** Falhas de LLM na MESMA (card, mensagem) antes de assumir o determinístico. */
export const MAX_FALHAS_LLM = 3;

/** Teto de confiança quando a leitura veio pela metade (nunca dispara ação automática). */
export const CONFIANCA_MAX_LEITURA_PARCIAL = 0.5;

export const PENDENCIA_LEITURA_PARCIAL =
  "Leitura automática veio incompleta — confira o e-mail do cliente no card";

export const PENDENCIA_LEITURA_FALHOU =
  "Não consegui ler a resposta do cliente automaticamente — leia o e-mail no card";

/**
 * Já falhou vezes demais nesta mesma mensagem? Corta o gasto e assume o
 * caminho determinístico. Sem isso, cada falha volta pela fila pra sempre.
 */
export function deveDesistirDoLlm(falhasAnteriores: number): boolean {
  return falhasAnteriores >= MAX_FALHAS_LLM;
}

/**
 * Sugestão conservadora para quando o LLM não é utilizável.
 *
 * Escolha determinística: mantém o card no trilho em que ele já está —
 * 59 quando a oc-âncora é 59 (indenização), senão 54 (aguardando cliente).
 * Nenhuma das duas dispara ação em SSW por conta própria; ambas rendem as
 * ações normais de "cliente respondeu" pro operador decidir com 1 clique.
 */
export function montarSugestaoDegradada(ocUltima: number | null | undefined): {
  oc_sugerida: number;
  confianca: number;
  motivo: string;
  pendencias_resposta_cliente: string[];
  sugere_combo_33_44: boolean;
  sugere_oc33_solo: boolean;
  sugere_combo_44_59: boolean;
  cliente_autorizou_reentrega_sem_pagar: boolean;
  contexto_extravio_parcial: boolean;
} {
  return {
    oc_sugerida: ocUltima === 59 ? 59 : 54,
    confianca: 0,
    motivo:
      "A leitura automática da resposta falhou (problema técnico, não do cliente). " +
      "Mantive o card aguardando retorno e trouxe as ações normais — abra o e-mail " +
      "no card pra decidir.",
    pendencias_resposta_cliente: [PENDENCIA_LEITURA_FALHOU],
    sugere_combo_33_44: false,
    sugere_oc33_solo: false,
    sugere_combo_44_59: false,
    cliente_autorizou_reentrega_sem_pagar: false,
    contexto_extravio_parcial: false,
  };
}

/**
 * Degrada uma leitura PARCIAL (JSON remendado): confiança limitada e pendência
 * explícita. Preserva a decisão que o modelo chegou a emitir — os campos de
 * decisão vêm primeiro no schema, então costumam ter chegado inteiros.
 */
export function degradarLeituraParcial<
  T extends { confianca: number; pendencias_resposta_cliente?: string[] },
>(sugestao: T): T {
  const pend = [
    PENDENCIA_LEITURA_PARCIAL,
    ...(sugestao.pendencias_resposta_cliente ?? []),
  ].slice(0, 3);
  return {
    ...sugestao,
    confianca: Math.min(sugestao.confianca, CONFIANCA_MAX_LEITURA_PARCIAL),
    pendencias_resposta_cliente: pend,
  };
}
