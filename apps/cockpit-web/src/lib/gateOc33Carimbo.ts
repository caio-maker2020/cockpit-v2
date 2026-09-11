// =============================================================================
// gateOc33Carimbo — "o banco VAI recusar esta aprovação de oc 33?"
//
// Karol 2026-09-11 (NF 436268, CTRC AMP589740-8): o relato chegou como "marco os
// anexos e eles não vão pro SSW". Medido: os anexos nunca chegam a sair porque a
// APROVAÇÃO INTEIRA é recusada antes. A parede está em `aprovar_e_executar`
// (mig 365, reescrita até a 378) e dispara com
// `proposta_payload.meta.gate_oc33.bloqueada = true`, ANTES de qualquer linha
// que grave `args.extras`. Como é `RAISE EXCEPTION`, a transação inteira volta
// atrás: a seleção de anexos da operadora é descartada e NÃO fica registro
// nenhum da tentativa (os 903 eventos Oc33BloqueadaDossieIncompleto no banco vêm
// todos de `regras_auto_acao` montando a proposta — zero de operadora clicando).
//
// O defeito NÃO é a parede: sem dossiê completo o SSW reverte a 33 (NF 660746 —
// indenização aberta incompleta voltou 20 dias depois cobrando 46→49 "DESCRIÇÃO
// E VALOR"). O defeito é a tela oferecer o caminho: o botão renderiza aceso, o
// modal abre, a operadora marca anexos, converte PDF e espera upload — pra só
// então levar "Erro ao aprovar" e perder tudo. 156 cards de 9 operadoras no
// mesmo estado (DUILIO 34, FELIPE 31, KAROLINE 20, VICTOR 18, MARIA 15,
// INGRID 15, LARISSA 10, ISABELY 8, JULIA 5) — não é dela nem da máquina dela.
//
// ⚠ POR QUE O CARIMBO E NÃO O DOSSIÊ VIVO
//   `dossie33Faltando.ts` é o ESPELHO do dossiê e responde "o que falta". Serve
//   pra EXPLICAR. Não serve pra decidir o `disabled`, porque quem recusa é a
//   parede, e a parede lê o CARIMBO gravado no todo — não o dossiê vivo. Medido
//   em 11/09 nos todos pendentes de oc 33: 301 com carimbo=true, mas 26 SEM
//   carimbo e 3 com carimbo=false em cards de dossiê incompleto. Nesses 29 a
//   parede DEIXA passar (e `extravio_parcial_gate_enforce` está OFF desde
//   02/07, então o executor também não barra). Desabilitar pelo espelho apagaria
//   botão que o banco aceitaria — a tela passaria a inventar política que o
//   backend não tem. Aqui a tela só PROMETE o que o banco cumpre.
//
// Só LEITURA do payload já gravado. Função pura, sem rede, sem efeito.
// =============================================================================

export interface GateOc33Carimbo {
  /** true = `aprovar_e_executar` VAI lançar OC33_DOSSIE_INCOMPLETO. */
  bloqueada: boolean;
  /** Rótulos que a parede cita no erro, na ordem em que ela grava. */
  faltando: string[];
  natureza: "operacional" | "completude" | null;
}

/**
 * Lê `meta.gate_oc33` do `proposta_payload`.
 *
 * `null` = NÃO HÁ CARIMBO ⇒ a parede não recusa esta aprovação. Nunca tratar
 * `null` como bloqueio: seriam os 26 todos sem carimbo que hoje passam, e a
 * tela apagaria botão que funciona.
 */
export function lerGateOc33Carimbo(propostaPayload: unknown): GateOc33Carimbo | null {
  if (!propostaPayload || typeof propostaPayload !== "object") return null;
  const meta = (propostaPayload as Record<string, unknown>)["meta"];
  if (!meta || typeof meta !== "object") return null;
  const gate = (meta as Record<string, unknown>)["gate_oc33"];
  if (!gate || typeof gate !== "object") return null;

  const g = gate as Record<string, unknown>;
  // A parede compara com o texto 'true' (`->>'bloqueada') = 'true'`). Só o
  // booleano true carimbado conta; string "true", 1 ou truthy NÃO — carimbo
  // torto é carimbo ausente, e ausente significa "a parede deixa passar".
  const bloqueada = g["bloqueada"] === true;

  const brutos = g["faltando"];
  const faltando = Array.isArray(brutos)
    ? brutos.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

  const nat = g["natureza"];
  const natureza =
    nat === "operacional" || nat === "completude" ? nat : null;

  return { bloqueada, faltando, natureza };
}

/**
 * Texto curto pro rótulo quando a parede vai recusar e o espelho do dossiê não
 * tem nada a dizer (carimbo e dossiê vivo podem divergir). Vazio = nada a dizer.
 */
export function textoGateOc33Carimbo(g: GateOc33Carimbo | null): string {
  if (!g || !g.bloqueada) return "";
  if (g.faltando.length === 0) return "dossiê incompleto";
  return `falta ${g.faltando.join(" + ")}`;
}
