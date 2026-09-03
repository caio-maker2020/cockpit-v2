// =============================================================================
// extravio-qtd-volumes — leitura da instrução da oc de extravio (6/9/16):
// quantos volumes faltam, ou se a própria mensagem diz TOTAL.
//
// Extraído de `extravio-enrichment.ts` em 2026-09-03 (ADR 0025, F3) SEM mudar
// uma vírgula da lógica. Motivo: `extravio-enrichment` importa `bastao-client`,
// que puxa `bastao-rules`, que faz **query no banco em top-level await**. Quem
// só quer ler a instrução acabava arrastando I/O de import junto — o que impede
// teste puro e torna o módulo caro de reusar.
//
// Aqui é PURO: zero import, zero I/O. `extravio-enrichment` re-exporta daqui,
// então todos os callers antigos continuam funcionando sem saber da mudança.
//
// ⚠ Existe uma TERCEIRA cópia desta lógica em
// `agente-sugere-ocs-padrao/index.ts` (`extrairQtdVolumesExtraviados`, ~L1424).
// Não foi unificada nesta rodada porque o contrato dela difere (ParseQtd próprio)
// e o blast radius sai do escopo do ADR 0025. Fica registrado como dívida: três
// leitores da mesma frase é exatamente o padrão de drift que já mordeu o Cockpit
// antes (ver D6 do ADR 0025).
// =============================================================================

/** Tira ruído do SSWMOBILE/GPS e normaliza espaços. */
function limparInstrucao(s: string): string {
  return s
    .replace(/\(SSWMOBILE\)/gi, " ")
    .replace(/GPS\s*\([^)]*\)/gi, " ")
    .replace(/\bGPS\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quantos volumes faltam, a partir da instrução da oc 6/9/16. */
export function extrairQtdVolumes(
  instrucao: string | null | undefined,
): { total: true } | { qtd: number } | null {
  if (!instrucao) return null;
  const limpa = limparInstrucao(instrucao).toUpperCase();
  if (!limpa) return null;
  if (/\b(EXTRAVIO\s+TOTAL|PERDA\s+TOTAL|TOTAL)\b/.test(limpa)) return { total: true };
  const m = limpa.match(
    /(?:FALTA(?:M)?|QTDE?|QTD\.?)\s*(\d{1,3})|\b(\d{1,3})\s*(?:VOL|VOLUMES?|VOLS?)\b/,
  );
  if (m) {
    const qtd = parseInt(m[1] ?? m[2] ?? "", 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  if (/^\d{1,3}\s*\.?\s*$/.test(limpa)) {
    const qtd = parseInt(limpa, 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  return null;
}
