// =============================================================================
// instrucao-email-21.ts — enxerto da instrução vinda do E-MAIL do cliente na
// proposta de oc 21 ativa (Caio 2026-08-14, NF 674757 Würth/Ingrid).
//
// PROBLEMA REAL: a Würth respondeu por e-mail (13/08 16:25) autorizando a
// reentrega COM os dados novos (Josiele/Larissa, tel 33 98427-3432, 07-17h, ao
// lado da prefeitura). O interpretador leu certo (oc 21 +
// instrucao_reentrega_sugerida), MAS a decisão ficava só em
// cards.ia_sugestao_oc_resposta — nenhum caminho gravava a instrução no todo 21
// que JÁ EXISTIA (criado pelo robô da intranet com a Obs do ciclo anterior).
// A oc 21 não exige input inline (precisaInputInline: 41/56/44/55), então a
// aprovação ⭐ RECOMENDADA foi com extras=null e o SSW recebeu o texto VELHO
// ("HOR COML S/ ALMOCO | BERENICE") em vez do contato novo do e-mail.
//
// FIX (raiz): mesmo racional do enxerto da intranet (enxertarInstrucaoReentrega
// em wurth-intranet.ts) e do pacote oc 11 (oc11-pos-resposta.ts) — quando a
// decisão FINAL do interpretador é 21 com instrução preenchida, grava a
// instrução comprimida em args.descricao do(s) todo(s) 21 ATIVO(s). Assim
// QUALQUER caminho de aprovação (quick-approve da recomendada, banner, painel)
// lança o texto certo — o dado é consertado, não um caminho de UI.
//
// Precedências (por construção, sem código novo):
//  - extras.texto_descricao (painel do operador / pacote oc 11) SUBSTITUI a
//    descricao em montarDescricaoSsw → input humano continua vencendo tudo.
//  - E-mail × intranet: quem escreve por ÚLTIMO vence. E-mail chega depois →
//    sobrescreve a Obs da intranet; linha NOVA da intranet (dedupe só processa
//    linha inédita + guard de ciclo barra linha velha) → robô sobrescreve.
//    Ambos são o cliente falando; a informação mais recente manda.
//
// Chamado por interpretador-resposta-cliente (decisão depois dos todos) E por
// atualizarPropostasAposRespostaCliente (todos depois da decisão) — cobre as
// duas ordens, como o pacote oc 11. Best-effort + idempotente nos dois.
//
// Rodar testes: deno test supabase/functions/_shared/instrucao-email-21.test.ts
// =============================================================================

import { type SupabaseClient as SupabaseClientGeneric } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { normalizarObs } from "./instrucao-ssw-wurth.ts";

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** Marca de origem gravada no meta do todo — o front mostra o chip por ela. */
export const ORIGEM_INSTRUCAO_EMAIL = "email_cliente";

/** Tamanho do campo observ (Instrução textarea) do portal 101. */
const SSW_OBSERV_MAXLEN = 500;

/** Cortesia que só queima o orçamento de 70 do f6 — nunca muda o sentido. */
const RUIDO_EMAIL: RegExp[] = [
  /\bBO[AM]\s+(TARDE|DIA|NOITE)\b[!.,]*/g,
  /\bPOR\s+GENTILEZA\b/g,
  /\bPOR\s+FAVOR\b/g,
  /\bOBRIGAD[OA]\b[!.,]*/g,
];

/**
 * Texto do SSW a partir da instrução que o INTERPRETADOR extraiu do e-mail.
 *
 * DELIBERADAMENTE NÃO usa comprimirInstrucaoWurth: aquele é um EXTRATOR
 * ancorado nos rótulos do relatório da intranet ("Pessoa a ser contatada",
 * "Ponto de referência"...) — em texto LIVRE ele perde dado (verificado
 * 2026-08-14: "Falar com Josiele ou Larissa, tel..., ao lado da prefeitura"
 * virava só "TEL 33 98427-3432"). A instrucao_reentrega_sugerida já é um
 * resumo compacto (≤250, o prompt manda endereço/contato/horário primeiro),
 * então aqui só normaliza: CAIXA ALTA SEM ACENTO (latin-1 seguro no submit,
 * ver ssw-internal-client) + tira cortesia. O f6 corta nos primeiros 70; o
 * texto inteiro segue no observ (≤500).
 */
export function montarTextoSswEmail21(instrucao: string): string {
  let s = normalizarObs(instrucao);
  for (const re of RUIDO_EMAIL) s = s.replace(re, " ");
  return s
    .replace(/[—–]/g, "-") // travessão não existe no latin-1 do portal
    .replace(/[^\x20-\x7E]/g, " ") // qualquer outro não-ASCII vira espaço
    .replace(/\s+/g, " ")
    .replace(/^[\s!,.;:-]+/, "") // pontuação órfã da cortesia removida
    .trim()
    .slice(0, SSW_OBSERV_MAXLEN);
}

/**
 * Decide (puro) se há instrução de e-mail a enxertar: decisão final 21 (pós
 * INV-017 — 21 com pendência já foi rebaixado pra 54 antes de chegar aqui) e
 * instrucao_reentrega_sugerida preenchida. Senão null.
 */
export function decidirInstrucaoEmail21(
  iaSugestao: Record<string, unknown> | null | undefined,
): string | null {
  if (iaSugestao?.["oc_sugerida"] !== 21) return null;
  const instrucao = typeof iaSugestao?.["instrucao_reentrega_sugerida"] === "string"
    ? (iaSugestao["instrucao_reentrega_sugerida"] as string).trim()
    : "";
  return instrucao !== "" ? instrucao : null;
}

/**
 * Novo proposta_payload com a instrução do e-mail enxertada (puro, testável).
 * Espelha enxertarInstrucaoReentrega da intranet: args.descricao é O texto que
 * vira a Instrução do SSW (≤70 úteis, sem boilerplate — NF 669899); contexto
 * explicativo vai no rationale; auditoria completa no meta.
 */
export function enxertarInstrucaoEmail21(
  propostaPayload: Record<string, unknown> | null | undefined,
  instrucao: string,
  sugeridoEm: string | null,
): Record<string, unknown> {
  const pp = (propostaPayload ?? {}) as Record<string, unknown>;
  const argsAntigos = (pp["args"] as Record<string, unknown> | undefined) ?? {};
  const metaAntiga = (pp["meta"] as Record<string, unknown> | undefined) ?? {};
  const rationaleAntigo = typeof pp["rationale"] === "string" ? (pp["rationale"] as string) : "";
  const textoSsw = montarTextoSswEmail21(instrucao);
  return {
    ...pp,
    texto: textoSsw,
    args: {
      ...argsAntigos,
      descricao: textoSsw, // vira a Instrução do SSW — qualquer caminho de aprovação
    },
    rationale:
      (rationaleAntigo ? `${rationaleAntigo} · ` : "") +
      `E-mail do cliente${sugeridoEm ? ` (${sugeridoEm.slice(0, 16).replace("T", " ")} UTC)` : ""}: ${instrucao}`,
    meta: {
      ...metaAntiga,
      origem_instrucao: ORIGEM_INSTRUCAO_EMAIL,
      texto_ssw_sugerido: textoSsw,
      instrucao_email_original: instrucao, // auditoria: o que o cliente escreveu
      // o que estava lá antes (ex.: Obs da intranet do robô) — auditável
      instrucao_anterior: {
        descricao: (argsAntigos["descricao"] as string | undefined) ?? null,
        origem: (metaAntiga["origem"] as string | undefined) ?? null,
      },
    },
  };
}

/**
 * Aplica o enxerto no(s) todo(s) 21 ATIVO(s) (pendente/aprovado) do card.
 * Idempotente; nunca cria todo (criação é do vinculador/propostas-pos-resposta);
 * grava card_event InstrucaoEmailAplicadaNaProposta21 quando patcha.
 * Best-effort por desenho — falha aqui não pode derrubar o caller (regra
 * inviolável: cliente respondeu → operador VÊ as ações).
 */
export async function aplicarInstrucaoEmailNaProposta21(
  supabase: SupabaseClient,
  cardId: string,
  actorId: string,
): Promise<boolean> {
  const { data: card } = await supabase
    .from("cards")
    .select("ia_sugestao_oc_resposta")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return false;

  const iaSugestao = (card.ia_sugestao_oc_resposta ?? null) as Record<string, unknown> | null;
  const instrucao = decidirInstrucaoEmail21(iaSugestao);
  if (!instrucao) return false;
  const sugeridoEm = typeof iaSugestao?.["sugerido_em"] === "string"
    ? (iaSugestao["sugerido_em"] as string)
    : null;

  const { data: todos } = await supabase
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", cardId);

  const ATIVOS = new Set(["pendente", "aprovado"]);
  const alvos = ((todos ?? []) as Array<Record<string, unknown>>).filter((t) => {
    const status = t["status"] as string | undefined;
    if (!status || !ATIVOS.has(status)) return false;
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    if (!pp || pp["tool"] !== "lancar_ocorrencia") return false;
    const a = pp["args"] as Record<string, unknown> | undefined;
    return a?.["codigo_ssw"] === 21;
  });
  if (alvos.length === 0) return false;

  const textoSsw = montarTextoSswEmail21(instrucao);
  const patchados: string[] = [];
  for (const alvo of alvos) {
    const pp = alvo["proposta_payload"] as Record<string, unknown>;
    const a = (pp["args"] ?? {}) as Record<string, unknown>;
    const meta = (pp["meta"] ?? {}) as Record<string, unknown>;
    if (
      meta["origem_instrucao"] === ORIGEM_INSTRUCAO_EMAIL &&
      a["descricao"] === textoSsw
    ) {
      continue; // idempotente — este e-mail já foi enxertado
    }
    const novoPayload = enxertarInstrucaoEmail21(pp, instrucao, sugeridoEm);
    const { error } = await supabase
      .from("todos")
      .update({ proposta_payload: novoPayload })
      .eq("id", alvo["id"] as string);
    if (!error) patchados.push(alvo["id"] as string);
  }
  if (patchados.length === 0) return false;

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "InstrucaoEmailAplicadaNaProposta21",
    actor_type: "system",
    actor_id: actorId,
    payload: {
      todos_patchados: patchados,
      texto_ssw: textoSsw,
      instrucao_email_original: instrucao,
      sugerido_em: sugeridoEm,
    },
  });
  return true;
}
