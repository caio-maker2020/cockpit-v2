// =============================================================================
// auditoriaVeto — números PUROS da seção Janela de Veto da Auditoria
// (Etapa F do plano 25/08). Entrada: eventos crus do card_events; saída:
// linha do tempo rotulada + placar (% executado sem toque × editado ×
// cancelado × devolvido/expirado) por acao_key. Total SEMPRE = soma das
// partes (regra da casa: números batem exatamente).
// =============================================================================

export interface EventoVetoCru {
  id: string;
  card_id: string;
  event_type: string;
  actor_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** Eventos do trilho (fonte única: _shared/acao-autonoma-veto.ts). */
export const EVENTOS_TRILHO_VETO = [
  "AcaoAutonomaAgendada",
  "AcaoAutonomaSubstituida",
  "AcaoAutonomaEditadaPeloOperador",
  "AcaoAutonomaCanceladaPeloOperador",
  "AcaoAutonomaDevolvidaProHumano",
  "AcaoAutonomaExpirada",
  "AutoAprovacaoPermitida",
] as const;

export const ROTULO_EVENTO_VETO: Record<string, string> = {
  AcaoAutonomaAgendada: "programada",
  AcaoAutonomaSubstituida: "substituída (nova análise)",
  AcaoAutonomaEditadaPeloOperador: "editada pelo operador",
  AcaoAutonomaCanceladaPeloOperador: "CANCELADA pelo operador",
  AcaoAutonomaDevolvidaProHumano: "devolvida pro humano",
  AcaoAutonomaExpirada: "expirada (TTL)",
  AutoAprovacaoPermitida: "EXECUTADA (janela venceu)",
};

/** Só AutoAprovacaoPermitida do TRILHO DE VETO conta como execução da janela
 *  (a mesma marca é usada por outras regras autônomas — actor distingue). */
export function ehExecucaoDaJanela(e: EventoVetoCru): boolean {
  return e.event_type === "AutoAprovacaoPermitida" && e.actor_id === "veto-janela";
}

export function acaoKeyDoEvento(e: EventoVetoCru): string {
  const p = e.payload ?? {};
  const direto = p["acao_key"];
  if (typeof direto === "string" && direto) return direto;
  // AutoAprovacaoPermitida guarda a regra "veto_janela:<agente>:<acao_key>"
  const regra = p["regra"];
  if (typeof regra === "string" && regra.startsWith("veto_janela:")) {
    const partes = regra.split(":");
    if (partes.length >= 4) return `${partes[2]}:${partes[3]}`;
  }
  return "desconhecida";
}

export interface PlacarVetoLinha {
  acaoKey: string;
  programadas: number;
  executadasSemToque: number;
  executadasComEdicao: number;
  canceladas: number;
  devolvidas: number;
  expiradas: number;
  substituidas: number;
  /** minutos médios entre programar e o veto (só canceladas com par). */
  tempoMedioAteVetoMin: number | null;
}

/**
 * PURO: placar por acao_key. "Executada com edição" = houve evento de edição
 * no MESMO card antes da execução; "sem toque" = execução sem edição prévia.
 */
export function placarVeto(eventos: readonly EventoVetoCru[]): PlacarVetoLinha[] {
  const doTrilho = eventos.filter(
    (e) => e.event_type !== "AutoAprovacaoPermitida" || ehExecucaoDaJanela(e),
  );
  const porAcao = new Map<string, EventoVetoCru[]>();
  for (const e of doTrilho) {
    const k = acaoKeyDoEvento(e);
    const arr = porAcao.get(k) ?? [];
    arr.push(e);
    porAcao.set(k, arr);
  }

  const linhas: PlacarVetoLinha[] = [];
  for (const [acaoKey, evs] of porAcao) {
    const ord = [...evs].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const cardsEditados = new Set(
      ord.filter((e) => e.event_type === "AcaoAutonomaEditadaPeloOperador").map((e) => e.card_id),
    );
    const execucoes = ord.filter(ehExecucaoDaJanela);
    const executadasComEdicao = execucoes.filter((e) => cardsEditados.has(e.card_id)).length;

    // tempo até o veto: pareia cancelamento com a última programação do card
    const ultimaProgramacao = new Map<string, number>();
    const temposVeto: number[] = [];
    for (const e of ord) {
      if (e.event_type === "AcaoAutonomaAgendada") {
        ultimaProgramacao.set(e.card_id, new Date(e.created_at).getTime());
      } else if (e.event_type === "AcaoAutonomaCanceladaPeloOperador") {
        const t0 = ultimaProgramacao.get(e.card_id);
        if (t0 != null) temposVeto.push((new Date(e.created_at).getTime() - t0) / 60000);
      }
    }

    linhas.push({
      acaoKey,
      programadas: ord.filter((e) => e.event_type === "AcaoAutonomaAgendada").length,
      executadasSemToque: execucoes.length - executadasComEdicao,
      executadasComEdicao,
      canceladas: ord.filter((e) => e.event_type === "AcaoAutonomaCanceladaPeloOperador").length,
      devolvidas: ord.filter((e) => e.event_type === "AcaoAutonomaDevolvidaProHumano").length,
      expiradas: ord.filter((e) => e.event_type === "AcaoAutonomaExpirada").length,
      substituidas: ord.filter((e) => e.event_type === "AcaoAutonomaSubstituida").length,
      tempoMedioAteVetoMin: temposVeto.length
        ? Math.round(temposVeto.reduce((a, b) => a + b, 0) / temposVeto.length)
        : null,
    });
  }
  return linhas.sort((a, b) => b.programadas - a.programadas);
}

/** % de execução sem toque sobre os DESFECHOS decididos (exec+cancel). */
export function pctSemToque(l: PlacarVetoLinha): number | null {
  const decididos = l.executadasSemToque + l.executadasComEdicao + l.canceladas;
  if (decididos === 0) return null;
  return Math.round((100 * l.executadasSemToque) / decididos);
}
