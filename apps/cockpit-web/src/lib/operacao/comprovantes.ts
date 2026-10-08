// =============================================================================
// COMPROVANTES DE ENTREGA — entregas feitas cujo canhoto ainda não foi escaneado.
//
// Regras do módulo "Comprovantes de Entrega" do Pendências (tatiana-kelly/pendency-tracker
// @a884368), que lá é SÓ LEITURA (src/pages/ComprovantesEntrega.tsx:1178-1184): não marca
// escaneado, não envia nada. Aqui também: o que sai daqui é leitura e um CSV de cobrança
// que só é baixado no navegador.
//
// FONTE A DEFINIR: o Pendências lê views de comprovantes de OUTRO projeto Supabase
// (src/integrations/supabase-comprovantes). O Cockpit ainda não tem essa fonte. O que já é
// real: as notas da fila da Operação com a oc 12 (COMPROVANTE RETIDO PARA CONFERENCIA).
// =============================================================================
import { baseDaUnidade, diaSP } from "./regua";
import type { OpFilaLinha } from "./tipos";

export interface ComprovantePendente {
  ctrc: string;
  nf: string | null;
  /** Sigla SSW da unidade (base). */
  unidade: string | null;
  base_tipo: "filial" | "parceiro" | null;
  cliente_pagador: string | null;
  placa: string | null;
  /** Data da entrega realizada (ISO ou 'YYYY-MM-DD'). */
  data_entrega: string | null;
  ultima_oc: number | null;
  descricao_oc: string | null;
  valor_frete: number | null;
  valor_mercadoria: number | null;
  /** 'fila' = nota real da fila da Operação (oc 12); 'demo' = dado fictício. */
  origem?: "fila" | "demo";
  /** Só para origem 'fila': o item a abrir na fila. */
  op_item_id?: string;
}

// --------------------------------------------------------------------------- idade e faixas

/**
 * Idade da pendência: dias CORRIDOS entre a entrega realizada e hoje
 * (src/pages/ComprovantesEntrega.tsx:304-311, floor((hoje − entrega)/1 dia)).
 * Sem data = null.
 */
export function idadeDias(dataEntrega: string | null | undefined, agoraMs: number): number | null {
  const d = diaSP(dataEntrega);
  const h = diaSP(agoraMs);
  if (d == null || h == null) return null;
  return Math.max(0, h - d);
}

export type FaixaIdade = "em_dia" | "atrasada" | "critica" | "vencida";

/**
 * Faixas do operador (texto de ajuda, src/pages/ComprovantesEntrega.tsx:1107-1145):
 * Em dia 1–3, Atrasada 4–8, Crítica 9–15, Vencida 16+.
 * DÚVIDAS: (1) o dia 0 (entregue hoje) não aparece na tabela; tratamos como "Em dia".
 * (2) Os gráficos usam outras faixas: 0–5, 6–10, 11–30, 31–60, 61–90, 91–150, >150
 * (src/components/comprovantes/EvolucaoPendenciasCharts.tsx:58-66). A lista de trabalho
 * usa as 4 do operador. (3) `faixa_idade` vem pronta da view do outro projeto; a regra SQL
 * dela não está no repositório.
 */
export const FAIXAS_IDADE: readonly { id: FaixaIdade; rotulo: string; de: number; ate: number | null; significado: string }[] = [
  { id: "vencida", rotulo: "Vencida", de: 16, ate: null, significado: "Pendência grave; escalonar com a base." },
  { id: "critica", rotulo: "Crítica", de: 9, ate: 15, significado: "Pendência preocupante; cobrança ativa." },
  { id: "atrasada", rotulo: "Atrasada", de: 4, ate: 8, significado: "Começou a atrasar; deve ser cobrada." },
  { id: "em_dia", rotulo: "Em dia", de: 0, ate: 3, significado: "Recém-entregue, dentro do prazo normal de digitalização." },
];

export function faixaIdade(dias: number | null): FaixaIdade | null {
  if (dias == null) return null;
  if (dias >= 16) return "vencida";
  if (dias >= 9) return "critica";
  if (dias >= 4) return "atrasada";
  return "em_dia";
}

const PESO_FAIXA: Record<FaixaIdade, number> = { vencida: 0, critica: 1, atrasada: 2, em_dia: 3 };

// --------------------------------------------------------------------------- exclusões

/**
 * Última ocorrência com "RESSARCIMENTO" sai da lista: a pendência deixou de ser da base
 * (src/lib/comprovantes/exclusoesPendencia.ts:27,44-46). A lista manual de CTRCs em
 * duplicidade (:10-18) é caso a caso e não foi portada.
 */
export function excluidoDaLista(c: Pick<ComprovantePendente, "descricao_oc">): boolean {
  return (c.descricao_oc ?? "").toUpperCase().includes("RESSARCIMENTO");
}

// --------------------------------------------------------------------------- da fila real

export const OC_COMPROVANTE_RETIDO = 12;

/**
 * Notas REAIS da fila com a oc 12 viram itens de comprovante (origem 'fila').
 * Aproximação: a fila não traz a data da entrega; usamos a data da oc 12 como início da
 * idade. Placa e valores não vêm na fila (null).
 */
export function comprovantesDaFila(linhas: readonly OpFilaLinha[]): ComprovantePendente[] {
  return linhas
    .filter((l) => l.cod_ultima_ocorrencia === OC_COMPROVANTE_RETIDO && !excluidoDaLista({ descricao_oc: l.descricao_oc }))
    .map((l) => {
      const b = baseDaUnidade(l.unidade);
      return {
        ctrc: l.ctrc,
        nf: l.nf,
        unidade: l.unidade,
        base_tipo: b ? (b.tipo === "FILIAL" ? "filial" : "parceiro") : null,
        cliente_pagador: l.pagador,
        placa: null,
        data_entrega: l.data_ultima_ocorrencia,
        ultima_oc: l.cod_ultima_ocorrencia,
        descricao_oc: l.descricao_oc,
        valor_frete: null,
        valor_mercadoria: null,
        origem: "fila" as const,
        op_item_id: l.op_item_id,
      };
    });
}

// --------------------------------------------------------------------------- agregados

export const SEM_BASE = "Sem base";
export const SEM_PLACA = "Sem placa";
const num = (v: number | null | undefined) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const chaveBase = (c: ComprovantePendente) => (c.unidade?.trim() ? c.unidade.trim().toUpperCase() : SEM_BASE);

export interface KpisComprovantes {
  pendencias: number;
  /** Pendências ÷ (entregues com comprovante + pendências) (useComprovantesData.ts:464-465); null sem o total de entregues. */
  percentual: number | null;
  frete: number;
  mercadoria: number;
  idadeMedia: number | null;
  porFaixa: Record<FaixaIdade, number>;
}

export function kpis(cs: readonly ComprovantePendente[], agoraMs: number, totalEntregues: number | null = null): KpisComprovantes {
  const porFaixa: Record<FaixaIdade, number> = { vencida: 0, critica: 0, atrasada: 0, em_dia: 0 };
  const idades: number[] = [];
  for (const c of cs) {
    const d = idadeDias(c.data_entrega, agoraMs);
    if (d != null) idades.push(d);
    const f = faixaIdade(d);
    if (f) porFaixa[f]++;
  }
  const total = totalEntregues == null ? null : totalEntregues + cs.length;
  return {
    pendencias: cs.length,
    percentual: total ? r1((cs.length / total) * 100) : null,
    frete: cs.reduce((a, c) => a + num(c.valor_frete), 0),
    mercadoria: cs.reduce((a, c) => a + num(c.valor_mercadoria), 0),
    idadeMedia: idades.length ? r1(idades.reduce((a, b) => a + b, 0) / idades.length) : null,
    porFaixa,
  };
}

/** Mais urgente primeiro: Vencida → Crítica → Atrasada → Em dia, e a mais velha antes. Sem data por último. */
export function ordenarPorUrgencia(cs: readonly ComprovantePendente[], agoraMs: number): ComprovantePendente[] {
  return [...cs].sort((a, b) => {
    const da = idadeDias(a.data_entrega, agoraMs);
    const db = idadeDias(b.data_entrega, agoraMs);
    if (da == null || db == null) return da == null && db == null ? a.ctrc.localeCompare(b.ctrc) : da == null ? 1 : -1;
    return PESO_FAIXA[faixaIdade(da)!] - PESO_FAIXA[faixaIdade(db)!] || db - da || a.ctrc.localeCompare(b.ctrc);
  });
}

export interface ResumoBaseComprovante {
  unidade: string;
  base: string | null;
  tipo: "filial" | "parceiro" | null;
  qtd: number;
  porFaixa: Record<FaixaIdade, number>;
  /** A pior faixa presente (para ordenar e colorir). */
  pior: FaixaIdade | null;
  idadeMedia: number | null;
  frete: number;
  mercadoria: number;
  /** 3 placas com mais pendências (ComprovantesEntrega.tsx:262-278). */
  topPlacas: { placa: string; qtd: number }[];
  /** Itens da base, mais urgente primeiro. */
  itens: ComprovantePendente[];
}

/** Resumo por base, a de pior faixa primeiro (mais vencidas, depois mais pendências). */
export function resumoPorBase(cs: readonly ComprovantePendente[], agoraMs: number): ResumoBaseComprovante[] {
  const m = new Map<string, ComprovantePendente[]>();
  for (const c of cs) {
    const k = chaveBase(c);
    const g = m.get(k);
    if (g) g.push(c);
    else m.set(k, [c]);
  }
  return [...m.entries()]
    .map(([unidade, g]) => {
      const k = kpis(g, agoraMs);
      const placas = new Map<string, number>();
      for (const c of g) if (c.placa) placas.set(c.placa, (placas.get(c.placa) ?? 0) + 1);
      const pior = (["vencida", "critica", "atrasada", "em_dia"] as const).find((f) => k.porFaixa[f] > 0) ?? null;
      return {
        unidade,
        base: baseDaUnidade(unidade === SEM_BASE ? null : unidade)?.base ?? null,
        tipo: g.find((c) => c.base_tipo)?.base_tipo ?? null,
        qtd: g.length,
        porFaixa: k.porFaixa,
        pior,
        idadeMedia: k.idadeMedia,
        frete: k.frete,
        mercadoria: k.mercadoria,
        topPlacas: [...placas.entries()].map(([placa, qtd]) => ({ placa, qtd })).sort((a, b) => b.qtd - a.qtd || a.placa.localeCompare(b.placa)).slice(0, 3),
        itens: ordenarPorUrgencia(g, agoraMs),
      };
    })
    .sort(
      (a, b) =>
        (a.unidade === SEM_BASE ? 1 : 0) - (b.unidade === SEM_BASE ? 1 : 0) ||
        (a.pior ? PESO_FAIXA[a.pior] : 9) - (b.pior ? PESO_FAIXA[b.pior] : 9) ||
        b.porFaixa.vencida - a.porFaixa.vencida ||
        b.qtd - a.qtd ||
        a.unidade.localeCompare(b.unidade),
    );
}

export interface LinhaPlaca {
  placa: string;
  qtd: number;
  vencidas: number;
  idadeMedia: number | null;
  frete: number;
  mercadoria: number;
  /** Base com mais pendências dessa placa, e quantas outras (ComprovantesEntrega.tsx:282-330). */
  baseTop: string;
  outrasBases: number;
}

/** Ranking global de placas (sem placa não entra no ranking). */
export function rankingPlacas(cs: readonly ComprovantePendente[], agoraMs: number): LinhaPlaca[] {
  const m = new Map<string, ComprovantePendente[]>();
  for (const c of cs) {
    if (!c.placa) continue;
    const g = m.get(c.placa);
    if (g) g.push(c);
    else m.set(c.placa, [c]);
  }
  return [...m.entries()]
    .map(([placa, g]) => {
      const k = kpis(g, agoraMs);
      const bases = new Map<string, number>();
      for (const c of g) bases.set(chaveBase(c), (bases.get(chaveBase(c)) ?? 0) + 1);
      const ord = [...bases.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { placa, qtd: g.length, vencidas: k.porFaixa.vencida, idadeMedia: k.idadeMedia, frete: k.frete, mercadoria: k.mercadoria, baseTop: ord[0]![0], outrasBases: ord.length - 1 };
    })
    .sort((a, b) => b.qtd - a.qtd || b.vencidas - a.vencidas || a.placa.localeCompare(b.placa));
}

export function porCliente(cs: readonly ComprovantePendente[], agoraMs: number): { cliente: string; qtd: number; idadeMedia: number | null; frete: number; mercadoria: number }[] {
  const m = new Map<string, ComprovantePendente[]>();
  for (const c of cs) {
    const k = c.cliente_pagador?.trim() || "Sem cliente";
    const g = m.get(k);
    if (g) g.push(c);
    else m.set(k, [c]);
  }
  return [...m.entries()]
    .map(([cliente, g]) => {
      const k = kpis(g, agoraMs);
      return { cliente, qtd: g.length, idadeMedia: k.idadeMedia, frete: k.frete, mercadoria: k.mercadoria };
    })
    .sort((a, b) => b.qtd - a.qtd || a.cliente.localeCompare(b.cliente));
}

// --------------------------------------------------------------------------- variação

export type Situacao = "melhorando" | "piorando" | "estavel";

/**
 * Melhorando / Piorando / Estável (src/components/comprovantes/EvolucaoPendenciasCharts.tsx:83-101):
 * pct = (atual − anterior) / anterior; |pct| < 2% = estável; anterior 0 e atual > 0 = piorando ("novo").
 * DÚVIDA: a tabela Mês × Mês (VariacaoBaseTables.tsx:69-77) usa 0,5% como "estável". Usamos 2%.
 */
export function variacaoBase(atual: number, anterior: number): { situacao: Situacao; rotulo: string; pct: number | null } {
  if (anterior === 0 && atual === 0) return { situacao: "estavel", rotulo: "0%", pct: 0 };
  if (anterior === 0) return { situacao: "piorando", rotulo: "novo", pct: null };
  const pct = ((atual - anterior) / anterior) * 100;
  if (Math.abs(pct) < 2) return { situacao: "estavel", rotulo: "0%", pct: 0 };
  return { situacao: pct > 0 ? "piorando" : "melhorando", rotulo: `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`, pct };
}

/**
 * Situação por base como o Pendências calcula (EvolucaoPendenciasCharts.tsx:194-217): valor de
 * mercadoria pendente ACUMULADO até o fim do mês anterior × acumulado até hoje, pela data da
 * entrega. A ajuda (ComprovantesEntrega.tsx:1094-1096) fala em "quantidade de pendências do mês
 * atual × mês anterior" — DÚVIDA: vale o código (valor acumulado).
 */
export function situacaoPorBase(cs: readonly ComprovantePendente[], agoraMs: number): { unidade: string; ateMesAnterior: number; ateHoje: number; qtd: number; situacao: Situacao; rotulo: string }[] {
  const hoje = diaSP(agoraMs)!;
  const h = new Date(hoje * 86_400_000);
  const inicioMes = Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), 1) / 86_400_000;
  const m = new Map<string, { ateMesAnterior: number; ateHoje: number; qtd: number }>();
  for (const c of cs) {
    const d = diaSP(c.data_entrega);
    if (d == null || d > hoje) continue;
    const k = chaveBase(c);
    const r = m.get(k) ?? { ateMesAnterior: 0, ateHoje: 0, qtd: 0 };
    const v = num(c.valor_mercadoria);
    r.ateHoje += v;
    r.qtd++;
    if (d < inicioMes) r.ateMesAnterior += v;
    m.set(k, r);
  }
  return [...m.entries()]
    .map(([unidade, r]) => {
      const v = variacaoBase(r.ateHoje, r.ateMesAnterior);
      return { unidade, ...r, situacao: v.situacao, rotulo: v.rotulo };
    })
    .sort((a, b) => b.qtd - a.qtd);
}

// --------------------------------------------------------------------------- CSV de cobrança

export const COLUNAS_COBRANCA = [
  "Base",
  "Tipo base",
  "Cliente pagador",
  "CTRC",
  "Número NF",
  "Placa",
  "Data entrega",
  "Dias desde a entrega",
  "Faixa",
  "Última ocorrência",
  "Valor frete",
  "Valor mercadoria",
] as const;

const campo = (v: string | number | null | undefined) => {
  const s = v == null ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dataBr = (iso: string | null) => {
  const d = diaSP(iso);
  if (d == null) return "";
  const [y, m, dd] = new Date(d * 86_400_000).toISOString().slice(0, 10).split("-");
  return `${dd}/${m}/${y}`;
};
const moeda = (v: number | null) => (v == null ? "" : v.toFixed(2).replace(".", ","));

/**
 * CSV da cobrança (colunas da exportação do Pendências, ComprovantesEntrega.tsx:402-424,
 * mais idade e faixa). `unidade` = só essa base; sem ela, todas. Mais urgente primeiro.
 * Devolve TEXTO; quem chama só baixa no navegador.
 */
export function csvCobranca(cs: readonly ComprovantePendente[], agoraMs: number, unidade?: string | null): string {
  const alvo = unidade ? cs.filter((c) => chaveBase(c) === unidade.toUpperCase() || (unidade === SEM_BASE && chaveBase(c) === SEM_BASE)) : cs;
  const rotFaixa = Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, f.rotulo]));
  const out = [COLUNAS_COBRANCA.join(";")];
  for (const c of ordenarPorUrgencia(alvo, agoraMs)) {
    const d = idadeDias(c.data_entrega, agoraMs);
    const f = faixaIdade(d);
    const oc = c.ultima_oc != null ? `${c.ultima_oc}${c.descricao_oc ? ` - ${c.descricao_oc}` : ""}` : c.descricao_oc ?? "";
    out.push(
      [
        chaveBase(c),
        c.base_tipo === "filial" ? "Filial" : c.base_tipo === "parceiro" ? "Parceiro" : "",
        c.cliente_pagador,
        c.ctrc,
        c.nf,
        c.placa,
        dataBr(c.data_entrega),
        d,
        f ? rotFaixa[f] : "",
        oc,
        moeda(c.valor_frete),
        moeda(c.valor_mercadoria),
      ]
        .map(campo)
        .join(";"),
    );
  }
  return out.join("\r\n");
}
