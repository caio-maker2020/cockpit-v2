// =============================================================================
// TORRE DA OPERAÇÃO — a fila lida como uma torre de agentes, para o operador.
//
//   1. Agente principal: lê a fila e resume o turno.
//   2. Regras da Sal: cada nota com sugestão FIRME (regra da Sal, certeza alta) fica
//      pronta para 1 clique; DÚVIDA vai para o agente analisar ou para o operador.
//   3. Especialistas: um por família de problema (familias.ts).
//   4. Conselheiro: avisos de padrão repetido antes de gravar.
//   5. Operador: revisa a prévia e confirma (o humano clica, o sistema grava).
//   6. Registro do turno: o que aconteceu, em linguagem simples.
//
// Tudo DERIVADO da fila (nenhum estado novo, nenhuma chamada nova). Puro e testado.
// =============================================================================
import { FAMILIAS_PROBLEMA, familiaDaOc, type FamiliaId } from "./familias";
import { lancamentoAtivo, tempoParadoMs } from "./fila";
import { acaoDaSugestao, nivelCerteza, sugestaoFirme, sugereAguardar, sugestaoLancavel, type NivelCerteza } from "./sugestao";
import type { OpFilaLinha } from "./tipos";

const DIA_MS = 24 * 3_600_000;

/** Como a torre classifica cada nota. */
export type DecisaoTorre =
  | "firme_acao" // regra firme com ação de 1 clique (lançar ou encaminhar)
  | "firme_aguardar" // regra firme: nada a fazer agora, a nota segue sozinha
  | "duvida" // há sugestão, mas a certeza não basta: o agente analisa / o operador decide
  | "sem_sugestao" // nenhuma regra cobre: pergunta ao operador
  | "em_andamento"; // já foi pedida ao SSW ou encaminhada: só acompanhar

export function decisaoDaNota(l: OpFilaLinha): DecisaoTorre {
  if (lancamentoAtivo(l.lancamento_status) || l.lancamento_status === "confirmado" || !!l.encaminhamento_id) return "em_andamento";
  const s = l.sugestao;
  if (!s || !acaoDaSugestao(s)) return "sem_sugestao";
  if (sugestaoFirme(s)) return sugereAguardar(s) ? "firme_aguardar" : "firme_acao";
  return "duvida";
}

export type FocoTorre =
  | { tipo: "familia"; id: FamiliaId }
  | { tipo: "decisao"; id: "firme" | "duvida" | "sem_sugestao" }
  | { tipo: "itens"; ids: readonly string[]; rotulo: string }
  | null;

export function casaFoco(l: OpFilaLinha, foco: FocoTorre): boolean {
  if (!foco) return true;
  if (foco.tipo === "familia") return familiaDaOc(l.cod_ultima_ocorrencia) === foco.id;
  if (foco.tipo === "itens") return foco.ids.includes(l.op_item_id);
  const d = decisaoDaNota(l);
  if (foco.id === "firme") return d === "firme_acao" || d === "firme_aguardar";
  return d === foco.id;
}

export interface Especialista {
  id: FamiliaId;
  titulo: string;
  acao: string;
  total: number;
  prontas: number; // firmes com ação de 1 clique
  aguardando: number; // firmes "aguardar"
  duvidas: number; // dúvida + sem sugestão
  emAndamento: number;
  paradasMais1d: number;
  status: "livre" | "trabalhando" | "precisa_voce";
  frase: string;
}

export interface ResumoTorre {
  total: number;
  firmesAcao: number;
  firmesAguardar: number;
  duvidas: number;
  semSugestao: number;
  emAndamento: number;
  paradasMais1d: number;
  certeza: Record<NivelCerteza, number>;
  especialistas: Especialista[];
  /** Último instante em que a fila foi relida (ISO), quando houver. */
  lidaEm: string | null;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export function resumirTorre(linhas: readonly OpFilaLinha[], agoraMs: number, codigosLiberados: ReadonlySet<number> | null): ResumoTorre {
  const r: ResumoTorre = {
    total: linhas.length,
    firmesAcao: 0,
    firmesAguardar: 0,
    duvidas: 0,
    semSugestao: 0,
    emAndamento: 0,
    paradasMais1d: 0,
    certeza: { alta: 0, media: 0, baixa: 0 },
    especialistas: [],
    lidaEm: null,
  };
  const porFam = new Map<FamiliaId, Especialista>();
  for (const f of FAMILIAS_PROBLEMA) {
    porFam.set(f.id, {
      id: f.id,
      titulo: f.titulo,
      acao: f.acao,
      total: 0,
      prontas: 0,
      aguardando: 0,
      duvidas: 0,
      emAndamento: 0,
      paradasMais1d: 0,
      status: "livre",
      frase: "",
    });
  }
  let lida = 0;
  for (const l of linhas) {
    const e = porFam.get(familiaDaOc(l.cod_ultima_ocorrencia))!;
    e.total++;
    const ms = tempoParadoMs(l, agoraMs);
    if (ms != null && ms >= DIA_MS) {
      r.paradasMais1d++;
      e.paradasMais1d++;
    }
    const nivel = nivelCerteza(l.sugestao);
    if (nivel) r.certeza[nivel]++;
    let d = decisaoDaNota(l);
    // Firme de lançar com código fora da lista não vira botão: volta para o operador.
    if (d === "firme_acao" && acaoDaSugestao(l.sugestao) === "lancar_ocorrencia" && !sugestaoLancavel(l.sugestao, codigosLiberados, l.cod_ultima_ocorrencia)) {
      d = "duvida";
    }
    if (d === "firme_acao") {
      r.firmesAcao++;
      e.prontas++;
    } else if (d === "firme_aguardar") {
      r.firmesAguardar++;
      e.aguardando++;
    } else if (d === "duvida") {
      r.duvidas++;
      e.duvidas++;
    } else if (d === "sem_sugestao") {
      r.semSugestao++;
      e.duvidas++;
    } else {
      r.emAndamento++;
      e.emAndamento++;
    }
    const t = Date.parse(l.sugestao_em ?? l.materializado_em);
    if (Number.isFinite(t) && t > lida) lida = t;
  }
  r.lidaEm = lida > 0 ? new Date(lida).toISOString() : null;
  r.especialistas = [...porFam.values()]
    .filter((e) => e.id !== "outros" || e.total > 0)
    .map((e) => {
      const status: Especialista["status"] = e.total === 0 ? "livre" : e.duvidas > 0 ? "precisa_voce" : "trabalhando";
      let frase: string;
      if (e.total === 0) frase = "Nada parado nesta família agora.";
      else if (e.duvidas > 0) frase = `${plural(e.duvidas, "nota precisa", "notas precisam")} de você${e.prontas ? `; ${plural(e.prontas, "pronta", "prontas")} para 1 clique` : ""}.`;
      else if (e.prontas > 0) frase = `${plural(e.prontas, "nota pronta", "notas prontas")} para 1 clique.`;
      else if (e.aguardando > 0) frase = `Acompanhando ${plural(e.aguardando, "nota que segue", "notas que seguem")} sozinha${e.aguardando === 1 ? "" : "s"}.`;
      else frase = `Acompanhando ${plural(e.emAndamento, "nota", "notas")} em andamento.`;
      return { ...e, status, frase };
    })
    .sort((a, b) => b.duvidas - a.duvidas || b.total - a.total);
  return r;
}

// --------------------------------------------------------------------------- Conselheiro

export interface AvisoConselheiro {
  id: string;
  tom: "critico" | "atencao" | "info";
  titulo: string;
  detalhe: string;
  /** Notas do aviso (para abrir a primeira). */
  itens: string[];
}

const nomeOc = (l: OpFilaLinha) => (l.descricao_oc ? `“${capitalizar(l.descricao_oc)}”` : `ocorrência ${l.cod_ultima_ocorrencia ?? "sem código"}`);

function capitalizar(t: string): string {
  const s = t.trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const diasTxt = (d: number) => (d === 1 ? "1 dia" : `${d} dias`);

/**
 * O que o conselheiro avisa antes de gravar. Ordem: erros de lançamento, padrão repetido
 * (mesma ocorrência para a mesma cidade, 3+ notas paradas há 3+ dias), mesmo cliente com
 * várias notas, e as dúvidas. No máximo `limite` avisos.
 */
export function avisosDoConselheiro(linhas: readonly OpFilaLinha[], agoraMs: number, limite = 5): AvisoConselheiro[] {
  const avisos: AvisoConselheiro[] = [];

  const comErro = linhas.filter((l) => l.lancamento_status === "erro" || l.lancamento_status === "nao_confirmado" || l.lancamento_status === "recusado");
  if (comErro.length > 0) {
    avisos.push({
      id: "erro-lancamento",
      tom: "critico",
      titulo: `${plural(comErro.length, "lançamento não confirmou", "lançamentos não confirmaram")} no SSW`,
      detalhe: "Confira antes de pedir de novo: repetir o mesmo pedido gera ocorrência dobrada.",
      itens: comErro.map((l) => l.op_item_id),
    });
  }

  const grupos = new Map<string, OpFilaLinha[]>();
  for (const l of linhas) {
    if (!l.cidade_destino || l.cod_ultima_ocorrencia == null) continue;
    const ms = tempoParadoMs(l, agoraMs);
    if (ms == null || ms < 3 * DIA_MS) continue;
    const k = `${l.cod_ultima_ocorrencia}|${l.cidade_destino}`;
    const g = grupos.get(k) ?? [];
    g.push(l);
    grupos.set(k, g);
  }
  const repetidos = [...grupos.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length);
  for (const g of repetidos.slice(0, 2)) {
    const minDias = Math.floor(Math.min(...g.map((l) => tempoParadoMs(l, agoraMs) ?? 0)) / DIA_MS);
    const l0 = g[0]!;
    avisos.push({
      id: `repetido-${l0.cod_ultima_ocorrencia}-${l0.cidade_destino}`,
      tom: "atencao",
      titulo: `${g.length} notas iguais paradas há ${diasTxt(minDias)} ou mais`,
      detalhe: `${nomeOc(l0)} para ${capitalizar(l0.cidade_destino!)}${l0.uf_destino ? `/${l0.uf_destino}` : ""}. Pode ser um problema só: resolva a causa uma vez.`,
      itens: g.map((l) => l.op_item_id),
    });
  }

  const porCliente = new Map<string, OpFilaLinha[]>();
  for (const l of linhas) {
    const c = (l.destinatario ?? "").trim();
    if (!c) continue;
    const g = porCliente.get(c) ?? [];
    g.push(l);
    porCliente.set(c, g);
  }
  const cliente = [...porCliente.entries()].filter(([, g]) => g.length >= 4).sort((a, b) => b[1].length - a[1].length)[0];
  if (cliente) {
    avisos.push({
      id: `cliente-${cliente[0]}`,
      tom: "info",
      titulo: `${cliente[1].length} notas paradas do mesmo cliente`,
      detalhe: `${capitalizar(cliente[0])}. Vale um contato só, em vez de um por nota.`,
      itens: cliente[1].map((l) => l.op_item_id),
    });
  }

  const duvidas = linhas.filter((l) => decisaoDaNota(l) === "duvida");
  if (duvidas.length > 0) {
    avisos.push({
      id: "duvidas",
      tom: "info",
      titulo: `${plural(duvidas.length, "sugestão sem certeza alta", "sugestões sem certeza alta")}`,
      detalhe: "Leia o porquê de cada uma antes de confirmar. Na dúvida, não grave.",
      itens: duvidas.map((l) => l.op_item_id),
    });
  }

  return avisos.slice(0, limite);
}

// --------------------------------------------------------------------------- Registro do turno

export interface EventoTurno {
  id: string;
  em: string; // ISO
  quem: string;
  texto: string;
  tipo: "operador" | "agente" | "sistema";
}

const nf = (l: OpFilaLinha) => `NF ${l.nf ?? l.ctrc}`;

/** O que aconteceu no turno, mais recente primeiro, derivado da própria fila. */
export function registroDoTurno(linhas: readonly OpFilaLinha[], resumo: ResumoTorre, limite = 8): EventoTurno[] {
  const ev: EventoTurno[] = [];
  for (const l of linhas) {
    if (l.lancamento_solicitado_em && l.lancamento_codigo_oc != null) {
      const quem = l.lancamento_solicitado_por_nome ?? "Operador";
      const status =
        l.lancamento_status === "confirmado"
          ? "e o SSW confirmou"
          : l.lancamento_status === "erro" || l.lancamento_status === "nao_confirmado" || l.lancamento_status === "recusado"
            ? "mas o SSW não confirmou"
            : "e o pedido está na fila do SSW";
      ev.push({ id: `lanc-${l.op_item_id}`, em: l.lancamento_solicitado_em, quem, tipo: "operador", texto: `confirmou a ocorrência ${l.lancamento_codigo_oc} na ${nf(l)}, ${status}.` });
    }
    if (l.encaminhamento_id && l.encaminhamento_executar_apos) {
      ev.push({
        id: `enc-${l.op_item_id}`,
        em: l.encaminhamento_executar_apos,
        quem: "Agente",
        tipo: "agente",
        texto: `agendou o encaminhamento da ${nf(l)} ao Relacionamento (dá para desfazer até a hora marcada).`,
      });
    }
    if (l.assumido_em && l.assumido_por_nome) {
      ev.push({ id: `ass-${l.op_item_id}`, em: l.assumido_em, quem: l.assumido_por_nome, tipo: "operador", texto: `assumiu a ${nf(l)}.` });
    }
  }
  if (resumo.lidaEm) {
    ev.push({
      id: "leitura",
      em: resumo.lidaEm,
      quem: "Agente",
      tipo: "agente",
      texto: `leu ${plural(resumo.total, "nota", "notas")} da fila: ${plural(resumo.firmesAcao, "pronta", "prontas")} para 1 clique, ${resumo.firmesAguardar} seguindo sozinhas, ${resumo.duvidas + resumo.semSugestao} com você.`,
    });
  }
  return ev.sort((a, b) => Date.parse(b.em) - Date.parse(a.em)).slice(0, limite);
}

// --------------------------------------------------------------------------- Trabalho do dia pelo fluxo da torre

export type EtapaFluxoId = "duvida" | "pronta" | "segue" | "conselheiro" | "enviada";

export interface EtapaFluxo {
  id: EtapaFluxoId;
  titulo: string;
  /** Rótulo curto da barra de topo. */
  curto: string;
  /** Uma linha: o que acontece com as notas desta etapa. */
  dica: string;
  /** Cor do nó (token CSS). */
  cor: string;
}

/** Ordem do fluxo: o que precisa de você primeiro, o que já foi por último. */
export const ETAPAS_FLUXO: readonly EtapaFluxo[] = [
  { id: "duvida", titulo: "Aguardando você", curto: "Aguardando você", dica: "Dúvida: a regra não tem certeza. Abra e decida.", cor: "var(--signal)" },
  { id: "pronta", titulo: "Com sugestão", curto: "Com sugestão", dica: "Regra firme da Sal. Veja a prévia e confirme.", cor: "var(--positive)" },
  { id: "segue", titulo: "Aguardar", curto: "Aguardar", dica: "Regra firme: nada a fazer agora. O agente reavalia na hora marcada.", cor: "var(--c-ink-mute)" },
  { id: "conselheiro", titulo: "Conselheiro alertou", curto: "Conselheiro", dica: "Erro no SSW ou padrão repetido. Confira antes de gravar.", cor: "var(--warning)" },
  { id: "enviada", titulo: "Na fila do SSW / Lançada / Confirmada", curto: "Lançada", dica: "Já pedidas ao SSW ou encaminhadas. Só acompanhar.", cor: "hsl(var(--ink))" },
];

/** Notas que o conselheiro marcou (só avisos de erro ou de padrão repetido; o aviso geral de dúvidas não conta). */
export function notasAlertadas(avisos: readonly AvisoConselheiro[]): Set<string> {
  const s = new Set<string>();
  for (const a of avisos) if (a.tom !== "info") for (const id of a.itens) s.add(id);
  return s;
}

export function etapaDaNota(l: OpFilaLinha, alertadas: ReadonlySet<string>, codigosLiberados: ReadonlySet<number> | null): EtapaFluxoId {
  const st = l.lancamento_status;
  if (st === "erro" || st === "nao_confirmado" || st === "recusado") return "conselheiro";
  if (lancamentoAtivo(st) || st === "confirmado" || !!l.encaminhamento_id) return "enviada";
  if (alertadas.has(l.op_item_id)) return "conselheiro";
  const d = decisaoDaNota(l);
  if (d === "firme_aguardar") return "segue";
  if (d === "firme_acao") {
    if (acaoDaSugestao(l.sugestao) === "lancar_ocorrencia" && !sugestaoLancavel(l.sugestao, codigosLiberados, l.cod_ultima_ocorrencia)) return "duvida";
    return "pronta";
  }
  return "duvida";
}

/** Agrupa preservando a ordem de entrada (a fila já chega ordenada por tempo parado). */
export function agruparPorEtapa(
  linhas: readonly OpFilaLinha[],
  alertadas: ReadonlySet<string>,
  codigosLiberados: ReadonlySet<number> | null,
): Record<EtapaFluxoId, OpFilaLinha[]> {
  const g: Record<EtapaFluxoId, OpFilaLinha[]> = { duvida: [], pronta: [], segue: [], conselheiro: [], enviada: [] };
  for (const l of linhas) g[etapaDaNota(l, alertadas, codigosLiberados)].push(l);
  return g;
}

/** Para cada nota alertada, o aviso do conselheiro que vale para ela (o primeiro, o mais grave). */
export function avisoPorNota(avisos: readonly AvisoConselheiro[]): Map<string, AvisoConselheiro> {
  const m = new Map<string, AvisoConselheiro>();
  for (const a of avisos) if (a.tom !== "info") for (const id of a.itens) if (!m.has(id)) m.set(id, a);
  return m;
}

/**
 * A ordem em que o operador percorre as notas (j/k e "próxima nota" depois de confirmar):
 * no fluxo, coluna a coluna na ordem da torre; nas outras visões, a ordem da fila.
 */
export function ordemDeNavegacao(
  linhas: readonly OpFilaLinha[],
  porEtapa: boolean,
  alertadas: ReadonlySet<string>,
  codigosLiberados: ReadonlySet<number> | null,
): string[] {
  if (!porEtapa) return linhas.map((l) => l.op_item_id);
  const g = agruparPorEtapa(linhas, alertadas, codigosLiberados);
  return ETAPAS_FLUXO.flatMap((e) => g[e.id].map((l) => l.op_item_id));
}

/** Contagem por filial (unidade do SSW), da maior para a menor; "sem filial" por último. */
export function contagemPorFilial(linhas: readonly OpFilaLinha[]): { unidade: string | null; total: number }[] {
  const m = new Map<string | null, number>();
  for (const l of linhas) m.set(l.unidade ?? null, (m.get(l.unidade ?? null) ?? 0) + 1);
  return [...m.entries()]
    .map(([unidade, total]) => ({ unidade, total }))
    .sort((a, b) => (a.unidade == null ? 1 : b.unidade == null ? -1 : b.total - a.total || a.unidade.localeCompare(b.unidade)));
}
