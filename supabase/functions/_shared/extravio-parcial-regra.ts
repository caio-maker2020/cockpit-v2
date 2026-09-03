// =============================================================================
// extravio-parcial-regra — REGRA ANTI-VETO R3 (playbook 02/09).
//
// A maior família de vetos (5 em 7 dias): extravio PARCIAL com volumes em
// poder da transportadora e o robô mandando "aguardar" (NFs 5419/773332/
// 1011929, LARISSA: "HÁ VOLUMES A MOVIMENTAR, OCORRÊNCIA CORRETA É A 54") ou
// 55/56 na hora errada (NFs 120149/25021, ISABELY).
//
// Regra confirmada (Duilio p6-p8 + Caio 02/09):
//  - SEM autorização do cliente no ciclo → 54 PERGUNTANDO se pode seguir
//    parcial ou devolver (template literal do Duilio, p8);
//  - COM autorização (sinal objetivo: 55 já lançada APÓS o extravio, ou o
//    LLM leu autorização na resposta → já sugere 55 sozinho) → segue 55;
//  - quantidade INDETERMINÁVEL → não decide (Duilio liga pra base — fora do
//    nosso alcance): manual como hoje;
//  - card JÁ em 54 → o cliente JÁ foi perguntado: aguardar é correto (INV-094).
// =============================================================================

/** Ocorrências de extravio que abrem o cenário parcial. */
const OCS_EXTRAVIO: ReadonlySet<number> = new Set([6, 9, 16, 31]);

export interface ExtravioParcialDetectado {
  oc: number;
  /** índice no histórico (pra checar o que veio depois) */
  idx: number;
  /** nº de volumes faltantes lido da instrução (null = indeterminável) */
  volumes_faltantes: number | null;
}

/** Extrai o nº de volumes faltantes da instrução do extravio (null se não dá). */
export function extrairVolumesFaltantes(instrucao: string): number | null {
  const t = instrucao ?? "";
  const m = t.match(/FALTA\s+DE\s+(\d{1,3})\s+VOLUME/i) ??
    t.match(/(\d{1,3})\s+VOLUMES?\s+(?:EXTRAVIADO|FALTANTE|N[AÃ]O\s+LOCALIZADO)/i) ??
    t.match(/EXTRAVIO\s+(?:PARCIAL\s+)?DE\s+(\d{1,3})\s+VOLUME/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Instrução indica extravio PARCIAL? (parte ficou, parte sumiu) */
export function instrucaoIndicaParcial(instrucao: string): boolean {
  const t = instrucao ?? "";
  if (/PARCIAL/i.test(t)) return true;
  return extrairVolumesFaltantes(t) != null;
}

/** Acha o extravio parcial mais recente do histórico (ordem cronológica). */
export function detectarExtravioParcialNoHistorico(
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>,
): ExtravioParcialDetectado | null {
  for (let i = historico.length - 1; i >= 0; i--) {
    const o = historico[i]!;
    if (!OCS_EXTRAVIO.has(o.codigo ?? -1)) continue;
    if (!instrucaoIndicaParcial(o.instrucao ?? "")) return null; // extravio mais recente não é parcial
    return { oc: o.codigo!, idx: i, volumes_faltantes: extrairVolumesFaltantes(o.instrucao ?? "") };
  }
  return null;
}

/** Já houve 55 (autorização de seguir) DEPOIS do extravio? — sinal objetivo
 *  de autorização prévia (Duilio p6). */
export function houve55AposExtravio(
  historico: ReadonlyArray<{ codigo: number | null }>,
  idxExtravio: number,
): boolean {
  for (let i = idxExtravio + 1; i < historico.length; i++) {
    if (historico[i]!.codigo === 55) return true;
  }
  return false;
}

/** Template da 54 de autorização parcial — texto literal do Duilio (p8),
 *  com N parametrizado e as DUAS saídas (parcial ou devolução). */
export function template54Parcial(volumesFaltantes: number | null): string {
  const falta = volumesFaltantes === 1
    ? "1 volume"
    : volumesFaltantes != null
    ? `${volumesFaltantes} volumes`
    : "parte dos volumes";
  return (
    `Bom dia, Prezado!!\n\n` +
    `Estamos com falta de ${falta} da NF em assunto, podemos seguir de forma parcial ou devemos devolver?\n\n` +
    `Obrigado!`
  );
}

export interface DecisaoParcial {
  acao: "54_perguntar";
  volumes_faltantes: number | null;
  corpo_email: string;
}

/** A decisão R3: virar a sugestão pra 54-perguntar? (null = mantém o fluxo)
 *  Pré-condições verificáveis, nada de adivinhação:
 *  - extravio parcial detectado no histórico (ou sinal externo `ehParcial`);
 *  - SEM 55 após o extravio (sem autorização prévia);
 *  - card NÃO está em 54 (senão o cliente já foi perguntado — aguardar);
 *  - o LLM não sugeriu ação resolutiva própria (55/44/21/33 passam intactas). */
export function decidirParcialSemAutorizacao(opts: {
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>;
  ocCard: number | null;
  ocSugerida: number | null;
  ehParcialSinalExterno: boolean;
  /**
   * Caio 2026-09-03 (ADR 0025, D7): cliente com AUTORIZAÇÃO PERMANENTE de seguir
   * parcial (`cliente_config_seguir_parcial_auto`). Para ele a resposta da
   * pergunta já é conhecida — perguntar de novo é ruído, e pior: o Cockpit lança
   * a 55 de um lado enquanto este caminho manda e-mail perguntando do outro.
   * Duas vozes contraditórias pro mesmo cliente na mesma NF.
   *
   * A autorização mora no CADASTRO, não no histórico da NF — por isso o sinal
   * objetivo do `houve55AposExtravio` (55 já lançada) não a enxerga.
   *
   * OMITIR/`false` = comportamento histórico intacto pra todos os demais.
   */
  autorizacaoPermanenteDoCliente?: boolean;
}): DecisaoParcial | null {
  if (opts.autorizacaoPermanenteDoCliente === true) return null;
  if (opts.ocCard === 54) return null;
  if (opts.ocSugerida != null && ![54, 56, 59].includes(opts.ocSugerida)) return null;
  const det = detectarExtravioParcialNoHistorico(opts.historico);
  if (!det && !opts.ehParcialSinalExterno) return null;
  if (det && houve55AposExtravio(opts.historico, det.idx)) return null;
  const vols = det?.volumes_faltantes ?? null;
  return { acao: "54_perguntar", volumes_faltantes: vols, corpo_email: template54Parcial(vols) };
}
