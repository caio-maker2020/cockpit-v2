// =============================================================================
// oc11-pos-resposta.ts — ETAPA 2 da "Padronização Ocorrência 11" (Isadora
// 07/08/2026; escopo confirmado pelo Caio 08/08).
//
// Fluxo ≤4.000 m do desenho: oc 11 procedente → 54 + e-mail pedindo a correção
// → o CLIENTE RESPONDE → aqui entra esta etapa:
//
//   • Resposta ÚTIL (novo endereço / telefone de contato / informação concreta
//     do destino) → oc 21 **com cancelamento da reentrega** (registra o retorno
//     e libera a nova tentativa) + texto no SSW registrando a correção.
//   • Resposta VAZIA (encaminhamento interno, "vou verificar", sem o dado) →
//     NÃO lança oc: a sugestão é responder o e-mail cobrando a informação
//     completa (interpretador mantém 54 + pendências — INV-017 já rebaixa 21
//     com pendência pra 54 deterministicamente).
//
// Este módulo é a parte DETERMINÍSTICA: quando a decisão final do interpretador
// é 21 num card do fluxo-endereço da oc 11, semeia no todo de 21 ATIVO o pacote
// (texto pro SSW + cancelar_reentrega_24h + motivo) — mesmo racional do
// repatcharOc21ForaDoRaioExistente (o todo pós-resposta nasce sem extras).
// Chamado por: interpretador (após persistir a decisão) e
// atualizarPropostasAposRespostaCliente (cobre a ordem inversa — todos criados
// depois da decisão). Idempotente nos dois.
//
// Sinal do fluxo-endereço (durável): analise_padrao_resultado.codigo_oc_card
// === 11 — a análise da época da oc 11 fica no card (o cron só re-analisa
// oc ∈ {10,11,19,35,49} em AVH; card pós-resposta está com oc-âncora 54).
//
// Rodar testes: deno test --allow-env supabase/functions/_shared/oc11-pos-resposta.test.ts
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** Frase-âncora que a Operação lê no SSW (≤70 chars pro campo f6 — NF 59299). */
export const TEXTO_SSW_CORRECAO_RECEBIDA = "CORRECAO DE ENDERECO RECEBIDA DO CLIENTE";

/** Motivo do cancelamento agendado da reentrega (auditável em acoes_agendadas). */
export const MOTIVO_CANCELAMENTO_CORRECAO = "CORRECAO DE ENDERECO RECEBIDA";

/**
 * O card veio do fluxo-endereço da oc 11? A análise gravada quando o card era
 * oc 11 é o sinal durável (sobrevive à âncora virar 54 e à resposta chegar).
 */
export function ehFluxoEnderecoOc11(
  analisePadraoResultado: Record<string, unknown> | null | undefined,
): boolean {
  return analisePadraoResultado?.["codigo_oc_card"] === 11;
}

/** ASCII puro (portal SSW é iso-8859-1 e descarta UTF-8 multi-byte em silêncio). */
function paraAsciiSsw(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Texto do SSW: frase-âncora PRIMEIRO (sobrevive ao corte de 70 do campo que o
 * setor lê), correção do cliente como contexto depois.
 */
export function montarTextoSswCorrecaoRecebida(instrucaoReentrega: string | null): string {
  const detalhe = paraAsciiSsw(instrucaoReentrega ?? "");
  const texto = detalhe
    ? `${TEXTO_SSW_CORRECAO_RECEBIDA} - ${detalhe.toUpperCase()}`
    : TEXTO_SSW_CORRECAO_RECEBIDA;
  return texto.slice(0, 500);
}

export interface PacoteOc11PosResposta {
  texto_ssw: string;
  motivo_cancelamento: string;
}

/**
 * Decide (puro) se a resposta do cliente fecha o ciclo da oc 11 com 21 +
 * cancelamento. Regras:
 *  - Só no fluxo-endereço da oc 11 (analise da época com codigo_oc_card=11).
 *  - Só quando a decisão FINAL do interpretador é 21 (pós INV-017: 21 final =
 *    sem pendência = a correção veio; resposta vazia fica em 54 + pendências,
 *    cuja sugestão é responder o e-mail cobrando o dado).
 */
export function decidirPacoteOc11PosResposta(
  analisePadraoResultado: Record<string, unknown> | null | undefined,
  iaSugestao: Record<string, unknown> | null | undefined,
): PacoteOc11PosResposta | null {
  if (!ehFluxoEnderecoOc11(analisePadraoResultado)) return null;
  if (iaSugestao?.["oc_sugerida"] !== 21) return null;
  const instrucao = typeof iaSugestao?.["instrucao_reentrega_sugerida"] === "string"
    ? (iaSugestao["instrucao_reentrega_sugerida"] as string)
    : null;
  return {
    texto_ssw: montarTextoSswCorrecaoRecebida(instrucao),
    motivo_cancelamento: MOTIVO_CANCELAMENTO_CORRECAO,
  };
}

/**
 * Aplica o pacote no todo de 21 ATIVO do card (pendente/aprovado). Idempotente;
 * nunca cria todo (a criação é do vinculador/propostas-pos-resposta); grava
 * card_event Oc11PosRespostaPacoteAplicado quando patcha. Best-effort por
 * desenho — falha aqui não pode derrubar o caller (regra inviolável: cliente
 * respondeu → operador VÊ as ações).
 */
export async function aplicarPacoteOc11PosResposta(
  supabase: SupabaseClient,
  cardId: string,
  actorId: string,
): Promise<boolean> {
  const { data: card } = await supabase
    .from("cards")
    .select("analise_padrao_resultado, ia_sugestao_oc_resposta")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return false;

  const pacote = decidirPacoteOc11PosResposta(
    (card.analise_padrao_resultado ?? null) as Record<string, unknown> | null,
    (card.ia_sugestao_oc_resposta ?? null) as Record<string, unknown> | null,
  );
  if (!pacote) return false;

  const { data: todos } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", cardId);

  const ATIVOS = new Set(["pendente", "aprovado"]);
  const alvo = ((todos ?? []) as Array<Record<string, unknown>>).find((t) => {
    const status = t["status"] as string | undefined;
    if (!status || !ATIVOS.has(status)) return false;
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    if (!pp || pp["tool"] !== "lancar_ocorrencia") return false;
    const a = pp["args"] as Record<string, unknown> | undefined;
    return a?.["codigo_ssw"] === 21;
  });
  if (!alvo) return false;

  const pp = alvo["proposta_payload"] as Record<string, unknown>;
  const a = (pp["args"] ?? {}) as Record<string, unknown>;
  const extrasAtuais = (a["extras"] ?? {}) as Record<string, unknown>;
  if (
    extrasAtuais["cancelar_reentrega_24h"] === true &&
    extrasAtuais["texto_descricao"] === pacote.texto_ssw
  ) {
    return false; // idempotente
  }

  const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
  const novoPayload = {
    ...pp,
    args: {
      ...a,
      extras: {
        ...extrasAtuais,
        texto_descricao: pacote.texto_ssw,
        cancelar_reentrega_24h: true,
        motivo_cancelamento: pacote.motivo_cancelamento,
        origem: "oc11-pos-resposta-cliente",
      },
    },
    meta: {
      ...meta,
      texto_ssw_sugerido: pacote.texto_ssw,
      cancelar_reentrega_sugerido: true,
    },
  };
  const { error } = await supabase
    .from("todos")
    .update({ proposta_payload: novoPayload })
    .eq("id", alvo["id"] as string);
  if (error) return false;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "Oc11PosRespostaPacoteAplicado",
    actor_type: "system",
    actor_id: actorId,
    payload: {
      todo_id: alvo["id"] ?? null,
      texto_ssw: pacote.texto_ssw,
      motivo_cancelamento: pacote.motivo_cancelamento,
    },
  });
  return true;
}
