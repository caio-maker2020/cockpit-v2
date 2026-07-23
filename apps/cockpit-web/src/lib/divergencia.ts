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

  let divergente = false;
  if (acaoKeySugerida && acaoKeyAprovada) {
    divergente = acaoKeySugerida !== acaoKeyAprovada;
  } else if (ocSugerida !== null && ocAprovada !== null) {
    divergente = ocSugerida !== ocAprovada;
  }
  return { divergente, acaoKeySugerida, acaoKeyAprovada, ocSugerida, ocAprovada };
}
