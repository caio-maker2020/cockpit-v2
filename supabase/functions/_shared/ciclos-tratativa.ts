// =============================================================================
// ciclos-tratativa (_shared) — PORT server-side da lib do front
// apps/cockpit-web/src/lib/ciclosTratativa.ts (definição validada pelo Caio
// 25/08: ciclo = passagem do card; abre na importação/reabertura; ajuste de
// 05/10, INV-168: extravio 6/9/16 não abre, 49 autônoma abre, reaberturas
// seguidas sem ação = uma entrada).
//
// ⚠ ANTI-DRIFT: `EVENTOS_ABERTURA_CICLO` e `atribuirCiclo` existem em DUAS
// cópias (front não importa de _shared). Mudou aqui → mudar lá (e vice-versa).
// O /verify-cockpit (Fase 7.10) compara as duas listas por diff.
// Criado pra "Memória do Card" (plano estado-tratativa, Caio 17/09).
// =============================================================================

/** Eventos que ABREM um ciclo (entrada ou reabertura do card NO RELACIONAMENTO).
 *  Caio 05/10 (INV-168): a ocorrência de EXTRAVIO (6/9/16 — `ExtravioImportado`)
 *  NÃO abre ciclo; o extravio monitorado passa a contar a partir da 49 lançada
 *  pelo próprio Cockpit (`AgenteExtravioLancou49`). */
export const EVENTOS_ABERTURA_CICLO: ReadonlyArray<string> = [
  "BastaoCardImportado",
  "BastaoReabriuNFFonteRelacionamento",
  "CardReaberto",
  "CardReabertoPorRespostaCliente",
  "AgenteExtravioLancou49",
];

/** A 49 autônoma do extravio: abre ciclo e ABSORVE a reabertura que o sync
 *  registra logo depois (mesma entrada, vista duas vezes). */
export const EVENTO_ABERTURA_49_AUTONOMA = "AgenteExtravioLancou49";

export interface EventoAbertura {
  ts: number;
  tipo: string;
  /** payload.para_state do CardReaberto (quando houver). */
  paraState?: string | null;
}

export interface AcaoDoCard {
  ts: number;
  codigo?: number | null;
}

/**
 * PURO (Caio 05/10, INV-168): das aberturas BRUTAS do card, devolve os
 * timestamps (asc) das que CONTAM como ciclo:
 *  - reabertura que cai em EXTRAVIO_MONITORADO não conta (fora do relacionamento);
 *  - reaberturas seguidas SEM nenhuma ação executada no meio são UMA entrada só
 *    (caso oc 57: ~90 reaberturas/card em 30 dias, card indo e voltando de
 *    TRANSFERIDO sem ninguém agir — seria "ciclo 90");
 *  - depois da 49 autônoma, só abre ciclo novo se houve ação DIFERENTE de 49 no
 *    meio (a reabertura do sync e o re-lançamento da 49 são a mesma entrada).
 * `acoes` = ações executadas COM SUCESSO pelo Cockpit.
 */
export function aberturasValidas(
  eventos: readonly EventoAbertura[],
  acoes: readonly AcaoDoCard[],
): number[] {
  const evs = [...eventos]
    .filter((e) => Number.isFinite(e.ts) && e.paraState !== "EXTRAVIO_MONITORADO")
    .sort((a, b) => a.ts - b.ts);
  const mantidas: EventoAbertura[] = [];
  for (const ev of evs) {
    const ultima = mantidas[mantidas.length - 1];
    if (!ultima) { mantidas.push(ev); continue; }
    const entre = acoes.filter((a) => a.ts > ultima.ts && a.ts <= ev.ts);
    if (ultima.tipo === EVENTO_ABERTURA_49_AUTONOMA) {
      if (entre.some((a) => a.codigo !== 49)) mantidas.push(ev);
    } else if (ev.tipo === EVENTO_ABERTURA_49_AUTONOMA) {
      mantidas.push(ev);
    } else if (entre.length > 0) {
      mantidas.push(ev);
    }
  }
  return mantidas.map((e) => e.ts);
}

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
