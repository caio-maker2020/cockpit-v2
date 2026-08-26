// Detecção PURA de divergência operador×IA (F4 — popup de divergência).
// Divergente = operador aprova ação diferente da destacada pela IA no card.
// Sem sugestão da IA (ou dados insuficientes) → NUNCA incomoda o operador.
// Testes: src/lib/divergencia.test.ts

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Divergencia {
  divergente: boolean;
  acaoKeySugerida: string | null;
  acaoKeyAprovada: string | null;
  ocSugerida: number | null;
  ocAprovada: number | null;
}

export function acaoKeyDoPayload(pl: any): string | null {
  if (!pl) return null;
  if (typeof pl.acao_key === "string" && pl.acao_key) return pl.acao_key;
  const tool = pl.tool;
  const cod = pl?.args?.codigo_ssw;
  if (typeof tool === "string" && (typeof cod === "number" || typeof cod === "string")) {
    return `${tool}:${cod}`;
  }
  return null;
}

export function codigoDaAcaoKey(k: string | null): number | null {
  if (!k) return null;
  const suf = k.split(":").pop() ?? "";
  return /^\d+$/.test(suf) ? Number(suf) : null;
}

export function acaoKeySugeridaDoCard(card: any): string | null {
  return (
    // Camada mais RECENTE por definição (nasce da última mensagem do cliente) —
    // persistida pelo backend na etapa B do veto (destaque-resposta-cliente.ts).
    card?.ia_sugestao_oc_resposta?.proposta_destacada_acao ??
    card?.analise_padrao_resultado?.proposta_destacada_acao ??
    card?.analise_oc13_resultado?.proposta_destacada_acao ??
    null
  );
}

export function ocSugeridaDoCard(card: any): number | null {
  const daAcao = codigoDaAcaoKey(acaoKeySugeridaDoCard(card));
  if (daAcao !== null) return daAcao;
  const interp = card?.ia_sugestao_oc_resposta?.oc_sugerida;
  return typeof interp === "number" ? interp : null;
}

export function detectarDivergencia(card: any, propostaPayload: any): Divergencia {
  const acaoKeyAprovada = acaoKeyDoPayload(propostaPayload);
  const acaoKeySugerida = acaoKeySugeridaDoCard(card);
  const ocAprovada = codigoDaAcaoKey(acaoKeyAprovada);
  const ocSugerida = ocSugeridaDoCard(card);
  const base: Divergencia = {
    divergente: false,
    acaoKeySugerida,
    acaoKeyAprovada,
    ocSugerida,
    ocAprovada,
  };

  // ===== Alguma sugestão VIVA do card endossa a aprovação → NUNCA divergente.
  // NF 158084 (DUILIO 24/07): o banner padrão destacou 59+email (23/07 14:05);
  // o cliente respondeu (21:38) e o interpretador sugeriu oc33 solo. O operador
  // aprovou EXATAMENTE a sugestão nova e o popup disparou contra a velha
  // ("Sugeriu 33 eu aprovei lançar 33 e apareceu o pop up - errado" — motivo
  // digitado pelo próprio operador). Divergente só quando NENHUMA camada de
  // sugestão endossa a ação aprovada.

  // (1) O próprio todo veio carimbado como recomendado pelo backend.
  if (propostaPayload?.recomendada === true) return base;

  // (2) O todo aprovado NASCEU do fluxo pós-resposta do cliente — camada mais
  // nova por definição (o vinculador cria essas opções a partir da última
  // mensagem do cliente; o banner de ocs-padrão é anterior a ela). Cobre os
  // cards em que ia_sugestao_oc_resposta fica NULO — expurgo de 24/07: 2 dos
  // 3 falso-positivos provados eram exatamente esta variante.
  if (propostaPayload?.meta?.origem === "vinculador_pos_resposta_cliente") return base;

  // (3) Interpretador da resposta do cliente — camada mais RECENTE que o
  // banner de ocs-padrão (nasce da última mensagem do cliente).
  const interp = card?.ia_sugestao_oc_resposta;
  if (interp) {
    const tool = propostaPayload?.tool;
    const tipo = propostaPayload?.meta?.tipo_acao;
    if (
      interp.sugere_oc33_solo === true &&
      (tool === "lancar_oc33_solo_portal" || tipo === "oc33_solo")
    ) {
      return base;
    }
    if (
      interp.sugere_combo_33_44 === true &&
      (tool === "lancar_combo_33_44" || tipo === "combo_33_44")
    ) {
      return base;
    }
    if (
      interp.sugere_combo_44_59 === true &&
      (tool === "lancar_combo_44_59" || tipo === "combo_44_59")
    ) {
      return base;
    }
    if (
      typeof interp.oc_sugerida === "number" &&
      ocAprovada !== null &&
      interp.oc_sugerida === ocAprovada
    ) {
      return base;
    }
  }

  // (4) Mesmo CÓDIGO da sugerida em outra variante (com/sem e-mail): pela
  // regra das 4 opções (Caio 23/07), a variante é prerrogativa da operadora —
  // não é divergência de oc; não incomodar nem sujar o dataset do loop.
  if (ocSugerida !== null && ocAprovada !== null && ocSugerida === ocAprovada) {
    return base;
  }

  let divergente = false;
  if (acaoKeySugerida && acaoKeyAprovada) {
    divergente = acaoKeySugerida !== acaoKeyAprovada;
  } else if (ocSugerida !== null && ocAprovada !== null) {
    divergente = ocSugerida !== ocAprovada;
  }
  return { ...base, divergente };
}
