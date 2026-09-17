// =============================================================================
// ciclos-tratativa (_shared) — PORT server-side da lib do front
// apps/cockpit-web/src/lib/ciclosTratativa.ts (definição validada pelo Caio
// 25/08: ciclo = passagem do card; abre na importação/reabertura).
//
// ⚠ ANTI-DRIFT: `EVENTOS_ABERTURA_CICLO` e `atribuirCiclo` existem em DUAS
// cópias (front não importa de _shared). Mudou aqui → mudar lá (e vice-versa).
// O /verify-cockpit tem check de drift comparando as duas listas por grep.
// Criado pra "Memória do Card" (plano estado-tratativa, Caio 17/09).
// =============================================================================

/** Eventos que ABREM um ciclo (entrada ou reabertura do card). */
export const EVENTOS_ABERTURA_CICLO: ReadonlyArray<string> = [
  "BastaoCardImportado",
  "ExtravioImportado",
  "BastaoReabriuNFFonteRelacionamento",
  "CardReaberto",
  "CardReabertoPorRespostaCliente",
];

export interface PosicaoCiclo {
  ciclo: number;
  totalCiclos: number;
  etapa: number;
  etapasNoCiclo: number;
}

/** PURO — idêntico ao front (ver anti-drift acima). */
export function atribuirCiclo(
  aberturasTs: readonly number[],
  paresTs: readonly number[],
  parAlvoTs: number,
): PosicaoCiclo {
  const aberturas = [...aberturasTs].sort((a, b) => a - b);
  const totalCiclos = Math.max(1, aberturas.length);
  const cicloDe = (t: number): number => {
    let n = 0;
    for (const a of aberturas) { if (a <= t) n++; else break; }
    return Math.max(1, n);
  };
  const ciclo = cicloDe(parAlvoTs);
  const doCiclo = [...paresTs].filter((t) => cicloDe(t) === ciclo).sort((a, b) => a - b);
  const etapasNoCiclo = Math.max(1, doCiclo.length);
  let etapa = doCiclo.findIndex((t) => t === parAlvoTs) + 1;
  if (etapa === 0) etapa = doCiclo.filter((t) => t < parAlvoTs).length + 1;
  return { ciclo, totalCiclos, etapa, etapasNoCiclo };
}

/** Início (ms) do ciclo ATUAL = timestamp da última abertura; null = sem
 *  abertura registrada (card legado → ciclo 1 desde sempre). */
export function inicioDoCicloAtual(aberturasTs: readonly number[]): number | null {
  if (aberturasTs.length === 0) return null;
  return Math.max(...aberturasTs);
}
