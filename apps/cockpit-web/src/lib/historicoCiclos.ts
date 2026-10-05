// =============================================================================
// historicoCiclos — a história do card agrupada por CICLO e ETAPA, pro chip
// "Ciclo N · etapa M" do painel da sugestão (Caio 05/10, INV-168).
//
// CICLO = passagem do card pelo Relacionamento (ciclosTratativa.ts — fonte da
// regra de abertura). ETAPA = cada ação executada dentro da passagem; a etapa
// em aberto (card esperando decisão) conta como a próxima.
// Cada etapa guarda: o que TROUXE o card (ocorrência nova / resposta do
// cliente), o que o agente SUGERIU (ou que não sugeriu) e o que foi LANÇADO.
// É daqui que sai a contagem "entrada com × sem sugestão".
// Função PURA sobre card_events (o front não lê acoes_executadas_ssw).
// =============================================================================

import { aberturasValidas, EVENTOS_ABERTURA_CICLO, type AcaoDoCard, type EventoAbertura } from "./ciclosTratativa";

/** Linha enxuta de card_events (só os campos do payload que a conta usa). */
export interface EventoCiclo {
  created_at: string;
  event_type: string;
  oc?: string | number | null;            // payload.oc (CardReaberto)
  oc_atual?: string | number | null;      // payload.oc_atual (AguardandoClienteOcMudou)
  cod?: string | number | null;           // payload.cod_ultima_ocorrencia (BastaoCardImportado)
  para_state?: string | null;             // payload.para_state (CardReaberto)
  codigo_ssw?: string | number | null;    // payload.codigo_ssw (AcaoExecutada)
  sucesso?: string | boolean | null;      // payload.sucesso (AcaoExecutada)
  proposta?: string | number | null;      // payload.decisao.proposta_destacada (AgenteOcsPadraoDecisao)
  decisao13?: string | null;              // payload.decisao (AgenteOc13Decisao: "sugerir_21_cancel")
  oc_sugerida?: string | number | null;   // payload.oc_sugerida (InterpretadorRespostaClienteConcluido)
}

/** Volta do card DENTRO do mesmo ciclo (54/59 respondida com oc nova). */
const EVENTOS_VOLTA_NO_CICLO: ReadonlyArray<string> = ["AguardandoClienteOcMudou", "OcComRegraChegouEmParaFazer"];
const EVENTOS_RESPOSTA_CLIENTE: ReadonlyArray<string> = ["RetornoClienteEmAguardo", "CardReabertoPorRespostaCliente"];
const EVENTOS_SUGESTAO: ReadonlyArray<string> = [
  "AgenteOcsPadraoDecisao",
  "AgenteOc13Decisao",
  "InterpretadorRespostaClienteConcluido",
];

/** Tudo que o chip precisa buscar em card_events. */
export const EVENTOS_HISTORICO_CICLOS: ReadonlyArray<string> = [
  ...EVENTOS_ABERTURA_CICLO,
  ...EVENTOS_VOLTA_NO_CICLO,
  "RetornoClienteEmAguardo",
  ...EVENTOS_SUGESTAO,
  "AcaoExecutada",
  "AprovacaoOperador",
];

/** SELECT enxuto (PostgREST) — nunca o payload inteiro (decisão carrega corpo de e-mail). */
export const SELECT_HISTORICO_CICLOS =
  "created_at,event_type,oc:payload->>oc,oc_atual:payload->>oc_atual,cod:payload->>cod_ultima_ocorrencia," +
  "para_state:payload->>para_state,codigo_ssw:payload->>codigo_ssw,sucesso:payload->>sucesso," +
  "proposta:payload->decisao->>proposta_destacada,decisao13:payload->>decisao,oc_sugerida:payload->>oc_sugerida";

export interface EtapaHistorico {
  ciclo: number;
  etapa: number;
  /** o que trouxe o card pra decisão. */
  gatilho: { tipo: "ocorrencia" | "resposta_cliente"; oc: number | null; em: number } | null;
  /** undefined = agente não rodou pra esta etapa; oc null = rodou e não destacou nada. */
  sugestao: { oc: number | null; em: number } | undefined;
  /** null = etapa em aberto (aguardando decisão). */
  lancado: { oc: number | null; em: number; automatico: boolean } | null;
}

export interface CicloHistorico {
  n: number;
  abertoEm: number | null;
  etapas: EtapaHistorico[];
}

export interface HistoricoCiclos {
  ciclos: CicloHistorico[];
  cicloAtual: number;
  etapaAtual: number;
  /** etapas (de qualquer ciclo) que chegaram por ocorrência e NÃO tiveram sugestão. */
  entradasSemSugestao: number;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** PURO: monta ciclos/etapas a partir dos eventos do card (qualquer ordem). */
export function montarHistoricoCiclos(eventos: readonly EventoCiclo[]): HistoricoCiclos {
  const evs = eventos
    .map((e) => ({ ...e, ts: new Date(e.created_at).getTime() }))
    .filter((e) => Number.isFinite(e.ts))
    .sort((a, b) => a.ts - b.ts);

  const ehAcaoOk = (e: (typeof evs)[number]) =>
    e.event_type === "AcaoExecutada" && (e.sucesso === true || e.sucesso === "true");

  const acoes: AcaoDoCard[] = evs.filter(ehAcaoOk).map((e) => ({ ts: e.ts, codigo: num(e.codigo_ssw) }));
  const brutas: EventoAbertura[] = evs
    .filter((e) => EVENTOS_ABERTURA_CICLO.includes(e.event_type))
    .map((e) => ({ ts: e.ts, tipo: e.event_type, paraState: e.para_state ?? null }));
  const aberturas = aberturasValidas(brutas, acoes);
  const cicloDe = (t: number): number => {
    let n = 0;
    for (const a of aberturas) { if (a <= t) n++; else break; }
    return Math.max(1, n);
  };

  const etapas: EtapaHistorico[] = [];
  let gatilho: EtapaHistorico["gatilho"] = null;
  let sugestao: EtapaHistorico["sugestao"] = undefined;
  let aprovadoPorOperador = false;

  for (const e of evs) {
    const t = e.event_type;
    if (EVENTOS_RESPOSTA_CLIENTE.includes(t)) {
      // A mesma resposta gera mais de um evento (captura + vinculador, com a
      // leitura da IA no meio — NF 5004): só a 1ª abre o gatilho.
      if (gatilho?.tipo === "resposta_cliente") continue;
      gatilho = { tipo: "resposta_cliente", oc: null, em: e.ts };
      sugestao = undefined; // sugestão anterior era de outro contexto
    } else if (EVENTOS_ABERTURA_CICLO.includes(t) || EVENTOS_VOLTA_NO_CICLO.includes(t)) {
      if (e.para_state === "EXTRAVIO_MONITORADO") continue;
      const oc = t === "AgenteExtravioLancou49" ? 49 : (num(e.oc_atual) ?? num(e.oc) ?? num(e.cod));
      gatilho = { tipo: "ocorrencia", oc, em: e.ts };
      sugestao = undefined;
    } else if (t === "AgenteOcsPadraoDecisao") {
      sugestao = { oc: num(e.proposta), em: e.ts };
    } else if (t === "AgenteOc13Decisao") {
      const m = /(\d{2})/.exec(e.decisao13 ?? "");
      sugestao = { oc: m ? Number(m[1]) : null, em: e.ts };
    } else if (t === "InterpretadorRespostaClienteConcluido") {
      sugestao = { oc: num(e.oc_sugerida), em: e.ts };
    } else if (t === "AprovacaoOperador") {
      aprovadoPorOperador = true;
    } else if (ehAcaoOk(e)) {
      etapas.push({
        ciclo: cicloDe(e.ts), etapa: 0, gatilho, sugestao,
        lancado: { oc: num(e.codigo_ssw), em: e.ts, automatico: !aprovadoPorOperador },
      });
      gatilho = null;
      sugestao = undefined;
      aprovadoPorOperador = false;
    }
  }
  // etapa em aberto: o card voltou e ainda não houve ação
  if (gatilho) {
    etapas.push({ ciclo: cicloDe(gatilho.em), etapa: 0, gatilho, sugestao, lancado: null });
  }

  const total = Math.max(1, aberturas.length, ...etapas.map((x) => x.ciclo));
  const ciclos: CicloHistorico[] = [];
  for (let n = 1; n <= total; n++) {
    const doCiclo = etapas.filter((x) => x.ciclo === n);
    doCiclo.forEach((x, i) => { x.etapa = i + 1; });
    ciclos.push({ n, abertoEm: aberturas[n - 1] ?? null, etapas: doCiclo });
  }
  const atual = ciclos[ciclos.length - 1]!;
  return {
    ciclos,
    cicloAtual: atual.n,
    etapaAtual: Math.max(1, atual.etapas.length),
    entradasSemSugestao: etapas.filter((x) => x.gatilho?.tipo === "ocorrencia" && x.sugestao === undefined).length,
  };
}
