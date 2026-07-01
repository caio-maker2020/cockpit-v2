// =============================================================================
// Detector: round-trip de RESSARCIMENTO que volta pro relacionamento pedindo
// RELANÇAR a oc 54.
//
// Caio 2026-06-25 (NF 374609, 775461): padrão recorrente. O operador notifica o
// cliente pedindo info → lança oc=54 (aguardando cliente). O time de Ressarcimento
// entra no caso e lança oc=46 ("EM ANALISE DE RESSARCIMENTO"). Logo depois a MESMA
// pessoa do Ressarcimento relança oc=49 ("tratativa de relacionamento") dizendo o
// que falta e mandando o relacionamento LANÇAR 54 NOVAMENTE. A ação correta do
// relacionamento é só RELANÇAR a oc 54 (sem e-mail novo — o cliente já foi
// notificado), pra manter o card aguardando o cliente enquanto o ressarcimento corre.
//
// Sequência cronológica OBRIGATÓRIA (mais antiga → mais nova):  54 → 46 → 49.
//   - A 54 ANTES da 46 é INVIOLÁVEL: sem ela, o cliente nunca foi notificado, então
//     "relançar 54" não faz sentido (não há o que reiterar). Detector retorna null.
//   - A 49 tem que ser a ÚLTIMA oc codificada (o card está parado nela, no
//     relacionamento). Se já veio oc codificada depois da 49, o caso já andou.
//
// Dois tiers (Caio 2026-06-25):
//   - Tier A (determinístico): a instrução da 49 manda explicitamente relançar 54
//     ("LANCAR 54", "54 NOVAMENTE", "LANCAR NOVAMENTE"...). Confiança alta —
//     elegível pra autonomia.
//   - Tier B (precisa interpretação do agente/LLM): a 49 (da MESMA pessoa do
//     Ressarcimento que lançou a 46) pede romaneio/descrição/valor/itens/acareação
//     SEM escrever "54". É o mesmo round-trip, mas o agente tem que ler o e-mail
//     original da 54: se ele pediu esses docs e o cliente NÃO respondeu, então
//     relançar 54 é a ação. A confirmação final (e-mail + resposta) é do edge.
//
// Exclusões (não é "relançar 54"):
//   - a 49 manda lançar OUTRA oc (ex.: "LANCAR 56 NOVAMENTE" — NF 2679036);
//   - a 49 diz "OC NÃO PROCEDE" (ressarcimento recusou — outra tratativa);
//   - Tier B com 46 e 49 de PESSOAS diferentes (a 49 não é a devolução do
//     ressarcimento, é um 49 do próprio relacionamento com outro contexto).
//
// Fonte ÚNICA da regra — consumida pelo agente-ressarcimento-relancar-54. Funções
// puras, testáveis (ressarcimento-relancar-54.test.ts). `historico` vem
// MAIS-RECENTE-PRIMEIRO (como o puxar-historico-ssw-card devolve).
// =============================================================================

export const OC_RELACIONAMENTO_49 = 49;
export const OC_ANALISE_RESSARCIMENTO_46 = 46;
export const OC_AGUARDANDO_CLIENTE_54 = 54;

/** A instrução da 49 manda explicitamente RELANÇAR a 54 (Tier A). */
const RE_MANDA_RELANCAR_54 =
  /(?:RE)?LAN[CÇ]AR\s*(?:A\s*)?54\b|54\s*NOVAMENTE|(?:RE)?LAN[CÇ]AR\s*NOVAMENTE/i;

/** A 49 pede os documentos que o ressarcimento aguarda do cliente (Tier B). */
const RE_PEDE_DOCS_RESSARCIMENTO =
  /\b(ROMANEIO|DESCRI[CÇ][AÃ]O|VALOR|ITENS|ACAREA[CÇ][AÃ]O)\b/i;

/** A 49 manda lançar uma oc de 2 dígitos — capturamos o número pra excluir != 54. */
const RE_MANDA_LANCAR_OC = /LAN[CÇ]AR\s*(?:A\s*)?(\d{2})\b/i;

/** A 49 diz que a ocorrência não procede (ressarcimento recusou). */
const RE_NAO_PROCEDE = /N[AÃ]O\s+PROCEDE/i;

export interface OcHistorico {
  codigo: number | null;
  instrucao?: string | null;
  usuario?: string | null;
  data?: string | null;
}

export type RessarcRelancar54Tier = "A" | "B";

export interface RessarcRelancar54Match {
  /** 'A' = determinístico (a 49 manda relançar 54). 'B' = precisa interpretação. */
  tier: RessarcRelancar54Tier;
  oc49: OcHistorico;
  oc46: OcHistorico;
  oc54: OcHistorico;
  /** true quando a 49 e a 46 foram lançadas pela MESMA pessoa (ressarcimento). */
  mesmaPessoaRessarcimento: boolean;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Detecta o round-trip de ressarcimento "relançar 54" no histórico SSW.
 *
 * Retorna o match (com tier) quando:
 *   1. a ÚLTIMA oc codificada é 49;
 *   2. existe uma 46 lançada ANTES dessa 49 (índice maior = mais antiga);
 *   3. existe uma 54 lançada ANTES dessa 46 (INVIOLÁVEL — cliente foi notificado);
 *   4. a instrução da 49 caracteriza "relançar 54" (Tier A) OU pede docs do
 *      ressarcimento sendo a 49 da mesma pessoa da 46 (Tier B).
 * Caso contrário, null.
 */
export function detectarRessarcimentoRelancar54(
  historico: OcHistorico[],
): RessarcRelancar54Match | null {
  // 1. Última oc codificada tem que ser a 49.
  const i49 = historico.findIndex((o) => o.codigo != null);
  if (i49 === -1 || historico[i49]?.codigo !== OC_RELACIONAMENTO_49) return null;
  const oc49 = historico[i49] as OcHistorico;

  // 2. 46 lançada antes da 49 (índice > i49).
  let i46 = -1;
  for (let i = i49 + 1; i < historico.length; i++) {
    if (historico[i]?.codigo === OC_ANALISE_RESSARCIMENTO_46) { i46 = i; break; }
  }
  if (i46 === -1) return null;
  const oc46 = historico[i46] as OcHistorico;

  // 3. 54 lançada antes da 46 (índice > i46) — INVIOLÁVEL.
  let i54 = -1;
  for (let i = i46 + 1; i < historico.length; i++) {
    if (historico[i]?.codigo === OC_AGUARDANDO_CLIENTE_54) { i54 = i; break; }
  }
  if (i54 === -1) return null;
  const oc54 = historico[i54] as OcHistorico;

  const instr49 = oc49.instrucao ?? "";

  // Exclusão: a 49 diz que a oc não procede (ressarcimento recusou).
  if (RE_NAO_PROCEDE.test(instr49)) return null;

  // Exclusão: a 49 manda lançar OUTRA oc explicitamente (ex.: "LANCAR 56").
  const mandaLancar = RE_MANDA_LANCAR_OC.exec(instr49);
  if (mandaLancar && mandaLancar[1] !== "54") return null;

  const mesmaPessoa = norm(oc46.usuario) !== "" &&
    norm(oc46.usuario) === norm(oc49.usuario);

  // Tier A: a 49 manda explicitamente relançar a 54.
  if (RE_MANDA_RELANCAR_54.test(instr49)) {
    return { tier: "A", oc49, oc46, oc54, mesmaPessoaRessarcimento: mesmaPessoa };
  }

  // Tier B: a 49 (mesma pessoa do ressarcimento) pede docs do ressarcimento sem
  // escrever "54". Precisa interpretação do agente (e-mail original + resposta).
  if (mesmaPessoa && RE_PEDE_DOCS_RESSARCIMENTO.test(instr49)) {
    return { tier: "B", oc49, oc46, oc54, mesmaPessoaRessarcimento: true };
  }

  return null;
}
