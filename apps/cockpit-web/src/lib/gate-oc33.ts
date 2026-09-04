// Gate da oc 33 no front (Carlos/Caio 2026-09-04, âncora NF 632603 / DUILIO).
//
// O ADR 0023 especifica modo AVISADO: "o front desabilita e mostra 'faltam: X'".
// Isso NUNCA foi implementado — `gate_oc33` não existia em lugar nenhum de
// apps/cockpit-web. Resultado: a ação de oc 33 aparecia HABILITADA, o operador
// clicava, e a RPC `aprovar_e_executar` (parede da mig 365) devolvia a exceção
// crua `OC33_DOSSIE_INCOMPLETO` num toast genérico "Erro ao aprovar".
//
// Este módulo é PURO (sem React, sem Supabase) pra ser testado isolado.

export const MARCA_OC33_DOSSIE_INCOMPLETO = "OC33_DOSSIE_INCOMPLETO";

export type NaturezaOc33 = "operacional" | "completude";

export interface GateOc33 {
  bloqueada: boolean;
  faltando: string[];
  natureza: NaturezaOc33 | null;
}

const GATE_LIVRE: GateOc33 = { bloqueada: false, faltando: [], natureza: null };

/**
 * Lê `meta.gate_oc33` do proposta_payload. Tolerante: payload sem gate (proposta
 * que não é oc 33, ou criada antes do gate existir) devolve "livre" — o front
 * NUNCA inventa bloqueio que o backend não carimbou.
 */
export function lerGateOc33(propostaPayload: unknown): GateOc33 {
  const pl = propostaPayload as { meta?: { gate_oc33?: unknown } } | null | undefined;
  const g = pl?.meta?.gate_oc33 as
    | { bloqueada?: unknown; faltando?: unknown; natureza?: unknown }
    | null
    | undefined;
  if (!g || typeof g !== "object") return GATE_LIVRE;

  const bloqueada = g.bloqueada === true || g.bloqueada === "true";
  const faltando = Array.isArray(g.faltando)
    ? g.faltando.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];
  const natureza = g.natureza === "operacional" || g.natureza === "completude" ? g.natureza : null;
  return { bloqueada, faltando, natureza };
}

/** "romaneio de coleta assinado e valor dos itens" — pra frase corrida. */
export function textoFaltando(faltando: readonly string[]): string {
  if (faltando.length === 0) return "";
  if (faltando.length === 1) return faltando[0]!;
  return `${faltando.slice(0, -1).join(", ")} e ${faltando[faltando.length - 1]}`;
}

/** Chaves do dossiê ainda faltantes, derivadas dos rótulos humanos do backend. */
export type ChaveEvidencia = "romaneio" | "descricao" | "valor";

const ROTULO_PARA_CHAVE: Array<{ re: RegExp; chave: ChaveEvidencia }> = [
  { re: /romaneio/i, chave: "romaneio" },
  { re: /descri/i, chave: "descricao" },
  { re: /valor/i, chave: "valor" },
];

export function chavesFaltantes(faltando: readonly string[]): ChaveEvidencia[] {
  const out: ChaveEvidencia[] = [];
  for (const rotulo of faltando) {
    for (const { re, chave } of ROTULO_PARA_CHAVE) {
      if (re.test(rotulo) && !out.includes(chave)) out.push(chave);
    }
  }
  return out;
}

/** true quando o erro devolvido pela RPC é a parede da oc 33. */
export function ehErroDossieIncompleto(err: unknown): boolean {
  const msg = (err as { message?: unknown } | null | undefined)?.message;
  return typeof msg === "string" && msg.includes(MARCA_OC33_DOSSIE_INCOMPLETO);
}

/**
 * Mensagem curta pro operador no lugar do erro cru de banco.
 * Ex.: "Falta o romaneio de coleta assinado para lançar a oc 33."
 */
export function mensagemGateOc33(faltando: readonly string[]): string {
  const alvo = textoFaltando(faltando);
  if (!alvo) return "O dossiê da oc 33 está incompleto.";
  return `Falta ${alvo} para lançar a oc 33.`;
}
