// =============================================================================
// GESTÃO DA OPERAÇÃO — a fila lida pelo gestor/gerente: onde está travando.
//
// Tudo DERIVADO da fila (OpFilaLinha[]) + relógio; nada grava, nada chama rede.
// As regras vêm do Pendências (regua.ts, cargaParada.ts e regionais.ts, com arquivo:linha).
// Tempo parado aqui é em
// DIAS ÚTEIS desde a última ocorrência, como na Gestão do Pendências.
//
// Nada some da conta: nota sem setor aparece como "Sem setor", sem filial como
// "Sem filial", sigla sem regional como "Sem regional".
// =============================================================================
import { setorDoItem, nomeDoSetor, type SetorOuNaoIdentificado } from "./setores";
import {
  FAIXAS_CARGA_PARADA,
  OCS_PRE_ENTREGA,
  atrasoPrevisaoDias,
  baseDaUnidade,
  cargaCritica,
  diasUteisDesde,
  diaSP,
  entraAcima7,
  entraPreEntregaAcima2,
  faixaCargaParada,
  statusSla,
  regionalDaUnidade,
  type FaixaCargaParada,
} from "./regua";
import { REGIONAL_ORDEM, SEM_REGIONAL } from "./regionais";
import { regraCargaParada, resumirCargaParada, resumirPreEntrega, type ResumoCargaParada, type ResumoPreEntrega } from "./cargaParada";
import type { OpFilaLinha } from "./tipos";

export const SEM_FILIAL = "Sem filial";
/** Gargalo = nota parada há MAIS de 2 dias úteis (corte desta tela, não do Pendências). */
export const DIAS_GARGALO = 2;

export interface NotaGestao {
  l: OpFilaLinha;
  setor: SetorOuNaoIdentificado;
  unidade: string; // sigla ou SEM_FILIAL
  /** Dias úteis desde a última oc; null = o Bastão não trouxe a data. */
  dias: number | null;
  atraso: number;
}

export interface Estatistica {
  total: number;
  /** Paradas há mais de DIAS_GARGALO dias úteis. */
  paradas: number;
  acima7: number;
  /** SLA do setor (sla_setores do Pendências): dentro do prazo / estourou / crítico. */
  sla: { dentro: number; fora: number; critico: number };
  media: number | null;
  mediana: number | null;
}

export interface LinhaSetor extends Estatistica {
  setor: SetorOuNaoIdentificado;
  nome: string;
}

export interface LinhaFilial extends Estatistica {
  unidade: string;
  base: string | null;
  regional: string;
  /** Atraso médio na previsão (dias corridos), como o ranking do Pendências. */
  atrasoMedio: number;
}

export interface Gargalo {
  unidade: string;
  setor: SetorOuNaoIdentificado;
  nomeSetor: string;
  total: number;
  paradas: number;
  /** Estouraram o prazo do setor (SLA fora + crítico). */
  foraPrazo: number;
  maiorDias: number;
  /** Notas paradas, mais antiga primeiro (para abrir a primeira). */
  itens: string[];
}

export interface Produtividade {
  pessoa: string;
  assumidas: number;
  naFila: number;
  lancados: number;
  confirmados: number;
}

export interface AvisoGestao {
  id: string;
  tom: "critico" | "atencao" | "info";
  titulo: string;
  detalhe: string;
  itens: string[];
  unidade?: string;
}

/**
 * Painel regional (RegionalPanel.tsx do Pendências). Lá: total, "média" = atraso médio na
 * PREVISÃO em dias corridos (:20-31) e "acima de 5" = parada há mais de 5 dias úteis.
 * Aqui a idade média é em DIAS ÚTEIS desde a última ocorrência (o tempo parado), como pedido
 * para esta tela; o atraso na previsão continua no ranking de filiais.
 * Lá as notas de base sem regional somem do painel; aqui ficam em "Sem regional".
 */
export interface LinhaRegional {
  regional: string;
  total: number;
  /** Média de dias úteis parados (só notas com data); null = nenhuma com data. */
  idadeMedia: number | null;
  /** Paradas há mais de 5 dias úteis (cargaCritica). */
  acima5: number;
  paradas: number;
  acima7: number;
  unidades: string[];
  porBase: { base: string; total: number; idadeMedia: number | null; acima5: number }[];
}

export interface ResumoGestao {
  total: number;
  semData: number;
  semSetor: number;
  semFilial: number;
  porSetor: LinhaSetor[];
  porFilial: LinhaFilial[];
  porRegional: LinhaRegional[];
  /** Matriz setor × filial (só células com nota). */
  matriz: { unidade: string; setor: SetorOuNaoIdentificado; total: number; paradas: number }[];
  gargalos: Gargalo[];
  faixas: { id: FaixaCargaParada; rotulo: string; total: number }[];
  criticas: NotaGestao[];
  rankingAtraso: { unidade: string; media: number; total: number }[];
  porOcorrencia: { codigo: number | null; descricao: string | null; total: number; paradas: number }[];
  produtividade: Produtividade[];
  /** Pela régua da exportação de carga parada (cargaParada.ts). */
  cargaParada: ResumoCargaParada;
  /** Pré-entrega: obrigatórias até o próximo dia útil × podem esperar (cargaParada.ts). */
  preEntrega: ResumoPreEntrega;
  /** Regra atual (estoque). */
  indicadores: { acima7: number; baseAcima7: number; preEntregaAcima2: number; basePreEntrega: number };
  avisos: AvisoGestao[];
}

function mediana(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const media = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const r1 = (x: number) => Math.round(x * 10) / 10;

function estatistica(ns: NotaGestao[], agoraMs: number): Estatistica {
  const dias = ns.map((n) => n.dias).filter((d): d is number => d != null);
  return {
    total: ns.length,
    paradas: ns.filter((n) => n.dias != null && n.dias > DIAS_GARGALO).length,
    acima7: ns.filter((n) => entraAcima7(n.l, agoraMs)).length,
    sla: {
      dentro: ns.filter((n) => n.dias != null && statusSla(n.dias, n.setor) === "dentro").length,
      fora: ns.filter((n) => n.dias != null && statusSla(n.dias, n.setor) === "fora").length,
      critico: ns.filter((n) => n.dias != null && statusSla(n.dias, n.setor) === "critico").length,
    },
    media: (() => {
      const m = media(dias);
      return m == null ? null : r1(m);
    })(),
    mediana: mediana(dias),
  };
}

export function notasDaGestao(linhas: readonly OpFilaLinha[], agoraMs: number): NotaGestao[] {
  return linhas.map((l) => ({
    l,
    setor: setorDoItem(l),
    unidade: l.unidade?.trim() ? l.unidade.trim().toUpperCase() : SEM_FILIAL,
    dias: l.data_ultima_ocorrencia && diaSP(l.data_ultima_ocorrencia) != null ? diasUteisDesde(l.data_ultima_ocorrencia, agoraMs) : null,
    atraso: atrasoPrevisaoDias(l.previsao_entrega, agoraMs),
  }));
}

function agrupar<K>(ns: NotaGestao[], k: (n: NotaGestao) => K): Map<K, NotaGestao[]> {
  const m = new Map<K, NotaGestao[]>();
  for (const n of ns) {
    const key = k(n);
    const g = m.get(key);
    if (g) g.push(n);
    else m.set(key, [n]);
  }
  return m;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export function resumirGestao(linhas: readonly OpFilaLinha[], agoraMs: number): ResumoGestao {
  const ns = notasDaGestao(linhas, agoraMs);

  const porSetor: LinhaSetor[] = [...agrupar(ns, (n) => n.setor).entries()]
    .map(([setor, g]) => ({ setor, nome: nomeDoSetor(setor), ...estatistica(g, agoraMs) }))
    .sort((a, b) => (a.setor === "NAO_IDENTIFICADO" ? 1 : b.setor === "NAO_IDENTIFICADO" ? -1 : b.total - a.total));

  const porFilial: LinhaFilial[] = [...agrupar(ns, (n) => n.unidade).entries()]
    .map(([unidade, g]) => ({
      unidade,
      base: baseDaUnidade(unidade === SEM_FILIAL ? null : unidade)?.base ?? null,
      regional: regionalDaUnidade(unidade === SEM_FILIAL ? null : unidade) ?? SEM_REGIONAL,
      atrasoMedio: r1(g.reduce((a, n) => a + n.atraso, 0) / g.length),
      ...estatistica(g, agoraMs),
    }))
    .sort((a, b) => (a.unidade === SEM_FILIAL ? 1 : b.unidade === SEM_FILIAL ? -1 : b.paradas - a.paradas || b.total - a.total || a.unidade.localeCompare(b.unidade)));

  const ordemRegional = (r: string) => {
    const i = (REGIONAL_ORDEM as readonly string[]).indexOf(r);
    return i < 0 ? (r === SEM_REGIONAL ? 999 : 500) : i;
  };
  const idade = (g: NotaGestao[]) => {
    const ds = g.map((n) => n.dias).filter((d): d is number => d != null);
    return ds.length ? r1(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
  };
  const acima5 = (g: NotaGestao[]) => g.filter((n) => n.dias != null && cargaCritica(n.dias)).length;
  const porRegional: LinhaRegional[] = [...agrupar(ns, (n) => regionalDaUnidade(n.unidade === SEM_FILIAL ? null : n.unidade) ?? SEM_REGIONAL).entries()]
    .map(([regional, g]) => {
      const e = estatistica(g, agoraMs);
      const porBase = [...agrupar(g, (n) => baseDaUnidade(n.unidade === SEM_FILIAL ? null : n.unidade)?.base ?? n.unidade).entries()]
        .map(([base, gb]) => ({ base, total: gb.length, idadeMedia: idade(gb), acima5: acima5(gb) }))
        .sort((a, b) => b.total - a.total || a.base.localeCompare(b.base, "pt-BR"));
      return {
        regional,
        total: e.total,
        idadeMedia: idade(g),
        acima5: acima5(g),
        paradas: e.paradas,
        acima7: e.acima7,
        unidades: [...new Set(g.map((n) => n.unidade))].sort(),
        porBase,
      };
    })
    .sort((a, b) => ordemRegional(a.regional) - ordemRegional(b.regional) || b.total - a.total);

  const celulas = agrupar(ns, (n) => `${n.unidade}|${n.setor}`);
  const matriz = [...celulas.values()].map((g) => ({
    unidade: g[0]!.unidade,
    setor: g[0]!.setor,
    total: g.length,
    paradas: g.filter((n) => n.dias != null && n.dias > DIAS_GARGALO).length,
  }));

  const gargalos: Gargalo[] = [...celulas.values()]
    .map((g) => {
      const paradas = g.filter((n) => n.dias != null && n.dias > DIAS_GARGALO).sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));
      return {
        unidade: g[0]!.unidade,
        setor: g[0]!.setor,
        nomeSetor: nomeDoSetor(g[0]!.setor),
        total: g.length,
        paradas: paradas.length,
        foraPrazo: g.filter((n) => n.dias != null && statusSla(n.dias, n.setor) !== "dentro").length,
        maiorDias: paradas[0]?.dias ?? 0,
        itens: paradas.map((n) => n.l.op_item_id),
      };
    })
    .filter((g) => g.paradas > 0)
    .sort((a, b) => b.paradas - a.paradas || b.maiorDias - a.maiorDias || a.unidade.localeCompare(b.unidade));

  const contFaixa = new Map<FaixaCargaParada, number>();
  for (const n of ns) if (n.dias != null) contFaixa.set(faixaCargaParada(n.dias), (contFaixa.get(faixaCargaParada(n.dias)) ?? 0) + 1);
  const faixas = FAIXAS_CARGA_PARADA.map((f) => ({ ...f, total: contFaixa.get(f.id) ?? 0 }));

  const criticas = ns.filter((n) => n.dias != null && cargaCritica(n.dias)).sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0) || a.l.ctrc.localeCompare(b.l.ctrc));

  const rankingAtraso = porFilial
    .map((f) => ({ unidade: f.unidade, media: f.atrasoMedio, total: f.total }))
    .sort((a, b) => b.media - a.media || b.total - a.total);

  const porOcorrencia = [...agrupar(ns, (n) => n.l.cod_ultima_ocorrencia).entries()]
    .map(([codigo, g]) => ({
      codigo,
      descricao: g.find((n) => n.l.descricao_oc)?.l.descricao_oc ?? null,
      total: g.length,
      paradas: g.filter((n) => n.dias != null && n.dias > DIAS_GARGALO).length,
    }))
    .sort((a, b) => b.total - a.total || (a.codigo ?? 999) - (b.codigo ?? 999));

  // Produtividade: quem assumiu (estado atual) e os lançamentos pedidos HOJE (dia de SP).
  const hoje = diaSP(agoraMs);
  const prod = new Map<string, Produtividade>();
  const pessoa = (nome: string) => {
    let p = prod.get(nome);
    if (!p) prod.set(nome, (p = { pessoa: nome, assumidas: 0, naFila: 0, lancados: 0, confirmados: 0 }));
    return p;
  };
  for (const { l } of ns) {
    if (l.assumido_por_nome) pessoa(l.assumido_por_nome).assumidas++;
    if (l.lancamento_solicitado_por_nome && l.lancamento_solicitado_em && diaSP(l.lancamento_solicitado_em) === hoje) {
      const p = pessoa(l.lancamento_solicitado_por_nome);
      if (l.lancamento_status === "fila" || l.lancamento_status === "lancando") p.naFila++;
      else if (l.lancamento_status === "lancado") p.lancados++;
      else if (l.lancamento_status === "confirmado") p.confirmados++;
    }
  }
  const produtividade = [...prod.values()].sort(
    (a, b) => b.confirmados + b.lancados + b.naFila - (a.confirmados + a.lancados + a.naFila) || b.assumidas - a.assumidas || a.pessoa.localeCompare(b.pessoa),
  );

  const cargaParada = resumirCargaParada(linhas, agoraMs);
  const preEntrega = resumirPreEntrega(linhas, agoraMs);
  const semPrevisao = cargaParada.semPrevisao;

  const ehPre = (n: NotaGestao) => n.l.cod_ultima_ocorrencia != null && OCS_PRE_ENTREGA.includes(n.l.cod_ultima_ocorrencia);
  const operacao = ns.filter((n) => n.setor === "OPERACAO");
  const indicadores = {
    acima7: operacao.filter((n) => entraAcima7(n.l, agoraMs)).length,
    baseAcima7: operacao.filter((n) => !ehPre(n)).length,
    preEntregaAcima2: operacao.filter((n) => entraPreEntregaAcima2(n.l, agoraMs)).length,
    basePreEntrega: operacao.filter(ehPre).length,
  };

  const semSetor = ns.filter((n) => n.setor === "NAO_IDENTIFICADO");
  const semFilial = ns.filter((n) => n.unidade === SEM_FILIAL);

  const avisos: AvisoGestao[] = [];
  if (criticas.length > 0) {
    avisos.push({
      id: "criticas",
      tom: "critico",
      titulo: `${plural(criticas.length, "carga parada", "cargas paradas")} há mais de 5 dias úteis`,
      detalhe: "Comece pela mais antiga. Cada dia a mais pesa na conta da filial.",
      itens: criticas.map((n) => n.l.op_item_id),
    });
  }
  const filialAlta = porFilial
    .filter((f) => f.unidade !== SEM_FILIAL && f.total >= 3 && f.acima7 / f.total >= 0.3)
    .sort((a, b) => b.acima7 / b.total - a.acima7 / a.total)[0];
  if (filialAlta) {
    avisos.push({
      id: `filial-7d-${filialAlta.unidade}`,
      tom: "atencao",
      titulo: `${filialAlta.unidade}: ${filialAlta.acima7} de ${filialAlta.total} notas com 7 dias úteis ou mais`,
      detalhe: "Uma filial com tanta nota antiga costuma ter uma causa só. Vale ligar para o gerente.",
      itens: ns.filter((n) => n.unidade === filialAlta.unidade && entraAcima7(n.l, agoraMs)).map((n) => n.l.op_item_id),
      unidade: filialAlta.unidade,
    });
  }
  if (semPrevisao > 0) {
    avisos.push({
      id: "sem-previsao",
      tom: "info",
      titulo: `${plural(semPrevisao, "nota sem previsão", "notas sem previsão")} de entrega`,
      detalhe: "A régua da carga parada só cobra nota com previsão vencida. Sem a data, não dá para saber.",
      itens: ns.filter((n) => regraCargaParada(n.l, agoraMs).motivo === "sem-previsao").map((n) => n.l.op_item_id),
    });
  }
  if (semSetor.length > 0) {
    avisos.push({
      id: "sem-setor",
      tom: "info",
      titulo: `${plural(semSetor.length, "nota sem setor", "notas sem setor")}`,
      detalhe: "A ocorrência não está na tabela de setores. Ninguém chuta: alguém precisa dizer de quem é.",
      itens: semSetor.map((n) => n.l.op_item_id),
    });
  }
  if (semFilial.length > 0) {
    avisos.push({
      id: "sem-filial",
      tom: "info",
      titulo: `${plural(semFilial.length, "nota sem filial", "notas sem filial")}`,
      detalhe: "Sem a unidade do SSW a nota não entra na cobrança de nenhuma filial.",
      itens: semFilial.map((n) => n.l.op_item_id),
    });
  }

  return {
    total: ns.length,
    semData: ns.filter((n) => n.dias == null).length,
    semSetor: semSetor.length,
    semFilial: semFilial.length,
    porSetor,
    porFilial,
    porRegional,
    matriz,
    gargalos,
    faixas,
    criticas,
    rankingAtraso,
    porOcorrencia,
    produtividade,
    cargaParada,
    preEntrega,
    indicadores,
    avisos,
  };
}
