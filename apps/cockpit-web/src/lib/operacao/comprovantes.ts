// =============================================================================
// COMPROVANTES DE ENTREGA — entregas feitas cujo canhoto ainda não foi escaneado.
//
// Recria o "Comprovantes de Entrega" do Pendências (tatiana-kelly/pendency-tracker
// @a884368), que lá é SÓ LEITURA. Aqui também: o que sai daqui é leitura, um texto
// de cobrança copiado para a área de transferência e um CSV baixado no navegador.
// Nada vai ao SSW, ao WhatsApp ou a banco nenhum.
//
// FONTE REAL (ADR 0042 D6): a edge `comprovantes-operacao` lê as views do projeto
// Supabase secundário do Pendências, já filtradas pelas unidades de quem pediu e
// sem as exclusões (CTRC em duplicidade, ressarcimento). Na demonstração, o
// adaptador de demo devolve fictícios no MESMO formato.
// =============================================================================
import { baseDaUnidade, diaSP } from "./regua";
import type { OpFilaLinha } from "./tipos";

export interface ComprovantePendente {
  ctrc: string;
  nf: string | null;
  /** Sigla SSW da unidade receptora (base). */
  unidade: string | null;
  /** Nome da base, como a fonte manda (nome_base). */
  base_nome?: string | null;
  /** Tipo da base em minúsculas (ex.: 'filial', 'parceiro'). */
  base_tipo: string | null;
  cliente_pagador: string | null;
  placa: string | null;
  /** Data da entrega realizada, 'YYYY-MM-DD'. */
  data_entrega: string | null;
  /** Idade da pendência em dias (da fonte, ou calculada em São Paulo). Sem ela, calcula pela entrega. */
  idade_dias?: number | null;
  ultima_oc?: number | null;
  descricao_oc: string | null;
  tipo_documento?: string | null;
  valor_frete: number | null;
  valor_mercadoria: number | null;
  /** 'fonte' = views do Pendências; 'fila' = nota da fila com oc 12; 'demo' = fictício. */
  origem?: "fonte" | "fila" | "demo";
  /** A nota da fila da Operação (oc 12) com o mesmo CTRC, quando existe: "Abrir na fila". */
  op_item_id?: string;
}

/** O que a edge (ou o adaptador de demo) devolve. */
export interface DadosComprovantes {
  linhas: ComprovantePendente[];
  /** Entregues com comprovante nas mesmas unidades; null = não deu para contar. */
  entregues: number | null;
  /** Último escaneamento lido na fonte ('YYYY-MM-DD'). */
  ultimaAtualizacao: string | null;
  escopo: { todas: boolean; unidades: string[] };
  excluidas: number;
}

export type ErroComprovantes = "comprovantes_sem_credencial" | "sem_acesso" | "tela_desligada" | "fonte_falhou" | "falha_de_comunicacao";

export type OpRespostaComprovantes = ({ ok: true } & DadosComprovantes) | { ok: false; erro: ErroComprovantes | string; motivo?: string };

// --------------------------------------------------------------------------- resposta → linhas

const txt = (v: unknown): string | null => (v == null || String(v).trim() === "" ? null : String(v).trim());
const numOuNull = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const dataOuNull = (v: unknown): string | null => {
  const s = txt(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Linha crua da edge → ComprovantePendente (defensivo: tipos errados viram null). */
export function linhaDaApi(r: Record<string, unknown>): ComprovantePendente | null {
  const ctrc = txt(r.ctrc);
  if (!ctrc) return null;
  return {
    ctrc,
    nf: txt(r.nf),
    unidade: txt(r.unidade)?.toUpperCase() ?? null,
    base_nome: txt(r.base_nome),
    base_tipo: txt(r.base_tipo)?.toLowerCase() ?? null,
    cliente_pagador: txt(r.cliente_pagador),
    placa: txt(r.placa),
    data_entrega: dataOuNull(r.data_entrega),
    idade_dias: numOuNull(r.idade_dias),
    descricao_oc: txt(r.descricao_oc),
    tipo_documento: txt(r.tipo_documento),
    valor_frete: numOuNull(r.valor_frete),
    valor_mercadoria: numOuNull(r.valor_mercadoria),
    origem: "fonte",
  };
}

/** Corpo da edge → resposta tipada. Qualquer forma inesperada vira falha de comunicação. */
export function respostaDaApi(corpo: unknown): OpRespostaComprovantes {
  const b = (corpo ?? {}) as Record<string, unknown>;
  if (b.ok === false) return { ok: false, erro: String(b.erro ?? "falha_de_comunicacao"), motivo: txt(b.mensagem) ?? undefined };
  if (b.ok !== true || !Array.isArray(b.linhas)) return { ok: false, erro: "falha_de_comunicacao", motivo: "resposta inesperada do servidor" };
  const esc = (b.escopo ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    linhas: (b.linhas as Record<string, unknown>[]).map(linhaDaApi).filter((x): x is ComprovantePendente => x != null),
    entregues: numOuNull(b.entregues),
    ultimaAtualizacao: dataOuNull(b.ultimaAtualizacao),
    escopo: { todas: esc.todas === true, unidades: Array.isArray(esc.unidades) ? esc.unidades.map(String) : [] },
    excluidas: numOuNull(b.excluidas) ?? 0,
  };
}

// --------------------------------------------------------------------------- idade e faixas

/** Dias CORRIDOS entre a entrega e hoje, em São Paulo. Sem data = null. */
export function idadeDias(dataEntrega: string | null | undefined, agoraMs: number): number | null {
  const d = diaSP(dataEntrega);
  const h = diaSP(agoraMs);
  if (d == null || h == null) return null;
  return Math.max(0, h - d);
}

/** Idade do comprovante: a que veio da fonte; sem ela, pela data da entrega. */
export function idadeDe(c: Pick<ComprovantePendente, "idade_dias" | "data_entrega">, agoraMs: number): number | null {
  return c.idade_dias != null && Number.isFinite(c.idade_dias) ? Math.max(0, Math.floor(c.idade_dias)) : idadeDias(c.data_entrega, agoraMs);
}

export type FaixaIdade = "0-5" | "6-10" | "11-30" | "31-60" | "61-90" | "91-150" | "151+";

/**
 * As faixas que o Pendências EXECUTA (gráficos de evolução,
 * src/components/comprovantes/EvolucaoPendenciasCharts.tsx:58-66). O texto de ajuda de lá
 * falava em outras 4 (Em dia/Atrasada/Crítica/Vencida) que nenhum código usa: valem estas.
 * `nivel` só decide a cor: 0 neutro, 1 atenção, 2 sinal, 3 sinal forte.
 */
export const FAIXAS_IDADE: readonly { id: FaixaIdade; rotulo: string; de: number; ate: number | null; nivel: 0 | 1 | 2 | 3 }[] = [
  { id: "0-5", rotulo: "0 a 5 dias", de: 0, ate: 5, nivel: 0 },
  { id: "6-10", rotulo: "6 a 10 dias", de: 6, ate: 10, nivel: 0 },
  { id: "11-30", rotulo: "11 a 30 dias", de: 11, ate: 30, nivel: 1 },
  { id: "31-60", rotulo: "31 a 60 dias", de: 31, ate: 60, nivel: 1 },
  { id: "61-90", rotulo: "61 a 90 dias", de: 61, ate: 90, nivel: 2 },
  { id: "91-150", rotulo: "91 a 150 dias", de: 91, ate: 150, nivel: 2 },
  { id: "151+", rotulo: "151 dias ou mais", de: 151, ate: null, nivel: 3 },
];

/** Índice da faixa (0 = mais nova, 6 = mais velha). */
const INDICE_FAIXA = Object.fromEntries(FAIXAS_IDADE.map((f, i) => [f.id, i])) as Record<FaixaIdade, number>;

export function faixaIdade(dias: number | null): FaixaIdade | null {
  if (dias == null || !Number.isFinite(dias)) return null;
  for (let i = FAIXAS_IDADE.length - 1; i >= 0; i--) if (dias >= FAIXAS_IDADE[i]!.de) return FAIXAS_IDADE[i]!.id;
  return FAIXAS_IDADE[0]!.id;
}

const faixasZeradas = () => Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, 0])) as Record<FaixaIdade, number>;

// --------------------------------------------------------------------------- exclusões

/** CTRCs em duplicidade na fonte (Pendências, src/lib/comprovantes/exclusoesPendencia.ts). */
export const CTRCS_EXCLUIDOS: ReadonlySet<string> = new Set(["OVD352980-1"]);

/**
 * Sai da lista: CTRC em duplicidade, ou última ocorrência com "RESSARCIMENTO" (a pendência
 * deixou de ser da base). A edge já tira; aqui é a segunda trava (e vale para a demo).
 */
export function excluidoDaLista(c: Pick<ComprovantePendente, "descricao_oc"> & { ctrc?: string | null }): boolean {
  if (c.ctrc && CTRCS_EXCLUIDOS.has(c.ctrc.trim().toUpperCase())) return true;
  return (c.descricao_oc ?? "").toUpperCase().includes("RESSARCIMENTO");
}

// --------------------------------------------------------------------------- a fila (oc 12)

export const OC_COMPROVANTE_RETIDO = 12;
const chaveCtrc = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Notas da fila com a oc 12 (comprovante retido), como comprovantes (usado pela demo). */
export function comprovantesDaFila(linhas: readonly OpFilaLinha[]): ComprovantePendente[] {
  return linhas
    .filter((l) => l.cod_ultima_ocorrencia === OC_COMPROVANTE_RETIDO && !excluidoDaLista({ ctrc: l.ctrc, descricao_oc: l.descricao_oc }))
    .map((l) => {
      const b = baseDaUnidade(l.unidade);
      return {
        ctrc: l.ctrc,
        nf: l.nf,
        unidade: l.unidade,
        base_tipo: b ? (b.tipo === "FILIAL" ? "filial" : "parceiro") : null,
        cliente_pagador: l.pagador,
        placa: null,
        // Aproximação: a fila não traz a data da entrega; vale a data da oc 12.
        data_entrega: l.data_ultima_ocorrencia ? l.data_ultima_ocorrencia.slice(0, 10) : null,
        ultima_oc: l.cod_ultima_ocorrencia,
        descricao_oc: l.descricao_oc,
        valor_frete: null,
        valor_mercadoria: null,
        origem: "fila" as const,
        op_item_id: l.op_item_id,
      };
    });
}

/** Liga cada comprovante à nota da fila com oc 12 e o mesmo CTRC ("Abrir na fila"). */
export function ligarComFila(cs: readonly ComprovantePendente[], linhas: readonly OpFilaLinha[]): ComprovantePendente[] {
  const porCtrc = new Map<string, string>();
  for (const l of linhas) if (l.cod_ultima_ocorrencia === OC_COMPROVANTE_RETIDO && l.op_item_id) porCtrc.set(chaveCtrc(l.ctrc), l.op_item_id);
  if (porCtrc.size === 0) return [...cs];
  return cs.map((c) => {
    if (c.op_item_id) return c;
    const id = porCtrc.get(chaveCtrc(c.ctrc));
    return id ? { ...c, op_item_id: id } : c;
  });
}

// --------------------------------------------------------------------------- agregados

export const SEM_BASE = "Sem base";
export const SEM_PLACA = "Sem placa";
const num = (v: number | null | undefined) => (Number.isFinite(Number(v)) && v != null ? Number(v) : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
export const chaveBase = (c: Pick<ComprovantePendente, "unidade">) => (c.unidade?.trim() ? c.unidade.trim().toUpperCase() : SEM_BASE);

export function mediana(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : r1((s[m - 1]! + s[m]!) / 2);
}

export interface KpisComprovantes {
  pendentes: number;
  /**
   * % de pendência = pendentes ÷ (pendentes + entregues), em %. APROXIMAÇÃO: as exclusões
   * tiram linhas só do lado das pendentes. null sem o total de entregues.
   */
  percentual: number | null;
  frete: number;
  mercadoria: number;
  medianaIdade: number | null;
  porFaixa: Record<FaixaIdade, number>;
}

export function kpis(cs: readonly ComprovantePendente[], agoraMs: number, entregues: number | null = null): KpisComprovantes {
  const porFaixa = faixasZeradas();
  const idades: number[] = [];
  for (const c of cs) {
    const d = idadeDe(c, agoraMs);
    if (d != null) idades.push(d);
    const f = faixaIdade(d);
    if (f) porFaixa[f]++;
  }
  const total = entregues == null ? null : entregues + cs.length;
  return {
    pendentes: cs.length,
    percentual: total ? r1((cs.length / total) * 100) : null,
    frete: cs.reduce((a, c) => a + num(c.valor_frete), 0),
    mercadoria: cs.reduce((a, c) => a + num(c.valor_mercadoria), 0),
    medianaIdade: mediana(idades),
    porFaixa,
  };
}

/** Mais velho primeiro; sem idade por último; empate pelo CTRC. */
export function ordenarPorIdade(cs: readonly ComprovantePendente[], agoraMs: number): ComprovantePendente[] {
  return [...cs].sort((a, b) => {
    const da = idadeDe(a, agoraMs);
    const db = idadeDe(b, agoraMs);
    if (da == null || db == null) return da == null && db == null ? a.ctrc.localeCompare(b.ctrc) : da == null ? 1 : -1;
    return db - da || a.ctrc.localeCompare(b.ctrc);
  });
}

export interface GrupoPlaca {
  placa: string;
  qtd: number;
  maisVelho: number | null;
  itens: ComprovantePendente[];
}

export interface ResumoBaseComprovante {
  unidade: string;
  /** Nome da base (fonte, ou o cadastro de unidades). */
  base: string | null;
  tipo: string | null;
  qtd: number;
  porFaixa: Record<FaixaIdade, number>;
  /** A faixa mais velha presente. */
  pior: FaixaIdade | null;
  maisVelho: number | null;
  medianaIdade: number | null;
  frete: number;
  mercadoria: number;
  /** Base → placa: placas com mais pendências primeiro, "Sem placa" por último. */
  placas: GrupoPlaca[];
  /** Itens da base, mais velho primeiro. */
  itens: ComprovantePendente[];
}

/** Resumo por base, a pior primeiro: faixa mais velha → mais itens nela → mais velho → mais pendências. */
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
      const itens = ordenarPorIdade(g, agoraMs);
      const pp = new Map<string, ComprovantePendente[]>();
      for (const c of itens) {
        const p = c.placa?.trim() ? c.placa.trim().toUpperCase() : SEM_PLACA;
        const x = pp.get(p);
        if (x) x.push(c);
        else pp.set(p, [c]);
      }
      const placas = [...pp.entries()]
        .map(([placa, xs]) => ({ placa, qtd: xs.length, maisVelho: idadeDe(xs[0]!, agoraMs), itens: xs }))
        .sort((a, b) => (a.placa === SEM_PLACA ? 1 : 0) - (b.placa === SEM_PLACA ? 1 : 0) || b.qtd - a.qtd || (b.maisVelho ?? -1) - (a.maisVelho ?? -1) || a.placa.localeCompare(b.placa));
      const pior = [...FAIXAS_IDADE].reverse().find((f) => k.porFaixa[f.id] > 0)?.id ?? null;
      return {
        unidade,
        base: g.find((c) => c.base_nome)?.base_nome ?? baseDaUnidade(unidade === SEM_BASE ? null : unidade)?.base ?? null,
        tipo: g.find((c) => c.base_tipo)?.base_tipo ?? null,
        qtd: g.length,
        porFaixa: k.porFaixa,
        pior,
        maisVelho: idadeDe(itens[0]!, agoraMs),
        medianaIdade: k.medianaIdade,
        frete: k.frete,
        mercadoria: k.mercadoria,
        placas,
        itens,
      };
    })
    .sort(
      (a, b) =>
        (a.unidade === SEM_BASE ? 1 : 0) - (b.unidade === SEM_BASE ? 1 : 0) ||
        (b.pior ? INDICE_FAIXA[b.pior] : -1) - (a.pior ? INDICE_FAIXA[a.pior] : -1) ||
        (b.pior ? b.porFaixa[b.pior] : 0) - (a.pior ? a.porFaixa[a.pior] : 0) ||
        (b.maisVelho ?? -1) - (a.maisVelho ?? -1) ||
        b.qtd - a.qtd ||
        a.unidade.localeCompare(b.unidade),
    );
}

// --------------------------------------------------------------------------- datas e dinheiro

/** 'YYYY-MM-DD' → 'DD/MM/YYYY' sem passar por Date (nada de deslocamento de fuso). */
export function dataBr(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

const moedaCsv = (v: number | null) => (v == null ? "" : v.toFixed(2).replace(".", ","));

// --------------------------------------------------------------------------- texto de cobrança

/** Quantos itens o texto lista; o resto vai no CSV (dito no fim do texto). */
export const LIMITE_ITENS_TEXTO = 40;

/** Texto pronto para colar (e-mail, chat interno) cobrando a base. Só texto: nada é enviado daqui. */
export function textoCobranca(b: ResumoBaseComprovante, agoraMs: number): string {
  const nome = b.base ? `${b.unidade} (${b.base})` : b.unidade;
  const linhas = [
    `Cobrança de comprovantes de entrega — base ${nome}`,
    `${b.qtd} ${b.qtd === 1 ? "entrega sem comprovante escaneado" : "entregas sem comprovante escaneado"}` +
      (b.maisVelho != null ? `; a mais antiga tem ${b.maisVelho} ${b.maisVelho === 1 ? "dia" : "dias"}.` : "."),
  ];
  const top = b.placas.filter((p) => p.placa !== SEM_PLACA).slice(0, 3);
  if (top.length) linhas.push(`Placas com mais pendências: ${top.map((p) => `${p.placa} (${p.qtd})`).join(", ")}.`);
  linhas.push("", "CTRC | NF | Cliente | Idade");
  for (const c of b.itens.slice(0, LIMITE_ITENS_TEXTO)) {
    const d = idadeDe(c, agoraMs);
    linhas.push(`${c.ctrc} | ${c.nf ?? "-"} | ${c.cliente_pagador ?? "-"} | ${d == null ? "-" : `${d} ${d === 1 ? "dia" : "dias"}`}`);
  }
  if (b.itens.length > LIMITE_ITENS_TEXTO) linhas.push(`… e mais ${b.itens.length - LIMITE_ITENS_TEXTO}. A lista completa está no CSV.`);
  linhas.push("", "Por favor, escaneiem os comprovantes e nos avisem.");
  return linhas.join("\n");
}

// --------------------------------------------------------------------------- CSV de cobrança

export const COLUNAS_COBRANCA = [
  "Base",
  "Nome da base",
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

/**
 * CSV da cobrança (colunas da exportação do Pendências, mais nome da base, idade e faixa).
 * `unidade` = só essa base; sem ela, todas. Mais velho primeiro. Devolve TEXTO; quem chama
 * só baixa no navegador.
 */
export function csvCobranca(cs: readonly ComprovantePendente[], agoraMs: number, unidade?: string | null): string {
  const alvo = unidade ? cs.filter((c) => chaveBase(c) === (unidade === SEM_BASE ? SEM_BASE : unidade.toUpperCase())) : cs;
  const rotFaixa = Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, f.rotulo]));
  const out = [COLUNAS_COBRANCA.join(";")];
  const ordenados = unidade ? ordenarPorIdade(alvo, agoraMs) : resumoPorBase(alvo, agoraMs).flatMap((b) => b.itens);
  for (const c of ordenados) {
    const d = idadeDe(c, agoraMs);
    const f = faixaIdade(d);
    const oc = c.ultima_oc != null ? `${c.ultima_oc}${c.descricao_oc ? ` - ${c.descricao_oc}` : ""}` : c.descricao_oc ?? "";
    out.push(
      [
        chaveBase(c),
        c.base_nome ?? baseDaUnidade(c.unidade)?.base ?? "",
        c.base_tipo ? c.base_tipo.charAt(0).toUpperCase() + c.base_tipo.slice(1) : "",
        c.cliente_pagador,
        c.ctrc,
        c.nf,
        c.placa,
        dataBr(c.data_entrega),
        d,
        f ? rotFaixa[f] : "",
        oc,
        moedaCsv(c.valor_frete),
        moedaCsv(c.valor_mercadoria),
      ]
        .map(campo)
        .join(";"),
    );
  }
  return out.join("\r\n");
}
