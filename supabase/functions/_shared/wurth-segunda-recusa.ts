// =============================================================================
// wurth-segunda-recusa.ts — R2 da devolução Würth (Caio 2026-08-14).
//
// REGRA: NF com DUAS ocorrências 10 (recusa total) → devolução autorizada por
// processo, sem nova tratativa. A sugestão PRIMÁRIA do agente vira oc 44 +
// e-mail informando as duas recusas e o prazo de logística reversa, DEIXANDO
// CLARO que é a 2ª ocorrência 10. A operadora decide (pode tratar exceção).
//
// EXCEÇÃO "volta ao normal" (stateless, decidido com o Caio): se a operadora
// tratou a 2ª recusa como exceção — lançou oc 54 DEPOIS da 2ª oc 10 — a regra
// desarma sozinha na re-análise, e o fluxo volta a esperar retorno da Würth
// (e-mail ou intranet, com o guard de ciclo). Sem tabela de estado.
//
// Detector: ≥2 ocorrências 10 com timestamps DISTINTOS no histórico da NF.
// NÃO exige oc 21 entre elas: reentrega às vezes sai por CTRC novo, sem 21 no
// histórico (caso real NF 378673 — CTRC CVL517682-4 emitido pra reentrega).
//
// Módulo PURO — o agente-sugere-ocs-padrao orquestra (flag + CNPJ na config).
// =============================================================================

import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";
import type { OcorrenciaSswHistorico } from "./wurth-ciclo.ts";

export type VeredictoSegundaRecusa =
  | {
    detectada: true;
    /** epoch ms das recusas, mais antiga primeiro. */
    recusasTs: number[];
    primeiraRecusaBrt: string;
    segundaRecusaBrt: string;
    motivo: string;
  }
  | { detectada: false; motivo: string };

/**
 * Detecta a 2ª recusa SEM exceção tratada. Fail-closed: histórico ausente ou
 * recusas sem hora → não detecta (a ação é ativa; na dúvida, fluxo normal).
 */
export function detectarSegundaRecusaWurth(
  historico: OcorrenciaSswHistorico[] | null | undefined,
): VeredictoSegundaRecusa {
  const recusas: number[] = [];
  const cincoQuatros: number[] = [];
  for (const o of historico ?? []) {
    const ts = parseSswDataHoraBrt(o?.data);
    if (ts == null) continue;
    if (o?.codigo === 10) recusas.push(ts);
    if (o?.codigo === 54) cincoQuatros.push(ts);
  }
  // timestamps distintos (o SSW pode duplicar a mesma linha em relistagens)
  const unicas = [...new Set(recusas)].sort((a, b) => a - b);
  if (unicas.length < 2) {
    return { detectada: false, motivo: `${unicas.length} ocorrência(s) 10 no histórico — R2 exige 2` };
  }

  const ultimaRecusa = unicas[unicas.length - 1]!;
  // Exceção da operadora: 54 lançada DEPOIS da última recusa = ela decidiu
  // notificar a Würth mesmo assim → regra desarma, espera retorno normal.
  const excecao = cincoQuatros.some((ts) => ts > ultimaRecusa);
  if (excecao) {
    return {
      detectada: false,
      motivo: "operadora tratou a 2ª recusa como exceção (54 lançada depois) — aguardando retorno da Würth",
    };
  }

  const primeira = unicas[unicas.length - 2]!;
  return {
    detectada: true,
    recusasTs: unicas,
    primeiraRecusaBrt: fmtBrt(primeira),
    segundaRecusaBrt: fmtBrt(ultimaRecusa),
    motivo:
      `2ª ocorrência 10 desta NF (anterior em ${fmtBrt(primeira)}, atual em ${fmtBrt(ultimaRecusa)})` +
      (unicas.length > 2 ? ` — ${unicas.length} recusas no total` : ""),
  };
}

function fmtBrt(ts: number): string {
  const d = new Date(ts - 3 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} BRT`;
}
