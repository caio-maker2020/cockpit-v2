// =============================================================================
// Fila da Operação — funções PURAS (filtros, ordenação, relógio, status).
//
// O relógio "parado há" mede desde `data_ultima_ocorrencia` (quando a nota
// ficou parada na oc atual, vinda do Bastão). NUNCA `materializado_em` nem
// `updated_at`: o materializador reescreve os dois a cada rodada de 10 min, e
// um relógio que zera sozinho mente "chegou agora" (mesma lição do INV-151).
// =============================================================================
import type { OpFilaLinha, OpMembro, StatusLancamentoOp } from "./tipos";

const HORA_MS = 3_600_000;

/** Ms parado desde a última ocorrência; null quando o Bastão não trouxe a data. */
export function tempoParadoMs(linha: Pick<OpFilaLinha, "data_ultima_ocorrencia">, agoraMs: number): number | null {
  if (!linha.data_ultima_ocorrencia) return null;
  const t = Date.parse(linha.data_ultima_ocorrencia);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, agoraMs - t);
}

/** "45 min", "3 h", "2 d 4 h". */
export function formatarDuracao(ms: number | null): string {
  if (ms == null) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  const resto = h % 24;
  return resto > 0 ? `${d} d ${resto} h` : `${d} d`;
}

export type TomTempo = "ok" | "atencao" | "critico";
export function tomTempoParado(ms: number | null): TomTempo {
  if (ms == null) return "ok";
  if (ms >= 48 * HORA_MS) return "critico";
  if (ms >= 24 * HORA_MS) return "atencao";
  return "ok";
}

// --- status do lançamento, como a pessoa lê -----------------------------------

export type StatusLancamentoTela =
  | "sem_lancamento"
  | "na_fila"
  | "lancando"
  | "lancado"
  | "confirmado"
  | "nao_confirmado"
  | "erro";

/** Status do ÚLTIMO lançamento do item, no vocabulário da tela. Cancelado = sem lançamento. */
export function statusLancamentoTela(s: StatusLancamentoOp | null | undefined): StatusLancamentoTela {
  switch (s) {
    case "fila":
      return "na_fila";
    case "lancando":
      return "lancando";
    case "lancado":
      return "lancado";
    case "confirmado":
      return "confirmado";
    case "nao_confirmado":
      return "nao_confirmado";
    case "recusado":
    case "erro":
      return "erro";
    default:
      return "sem_lancamento";
  }
}

export const ROTULO_STATUS_LANCAMENTO: Record<StatusLancamentoTela, string> = {
  sem_lancamento: "Sem lançamento",
  na_fila: "Na fila",
  lancando: "Lançando no SSW",
  lancado: "Lançado",
  confirmado: "Confirmado",
  nao_confirmado: "Não confirmado",
  erro: "Erro",
};

/** Lançamento ativo = ainda pode virar SSW (o índice único do banco usa o mesmo conjunto). */
export function lancamentoAtivo(s: StatusLancamentoOp | null | undefined): boolean {
  return s === "fila" || s === "lancando" || s === "lancado";
}

// --- filtros -------------------------------------------------------------------

export type FiltroTempo = "todos" | "4h" | "24h" | "72h";
export type FiltroStatus = "todos" | StatusLancamentoTela;

export interface FiltrosFila {
  busca: string;
  minhasUnidades: boolean;
  oc: number | null;
  cidade: string | null;
  /** Tipo do CT-e (Caio 08/10): NORMAL, DEVOLUCAO, REDESPACHO, REVERSA… */
  tipoCte: string | null;
  tempo: FiltroTempo;
  comSugestao: boolean;
  status: FiltroStatus;
}

export const FILTROS_PADRAO: FiltrosFila = {
  busca: "",
  minhasUnidades: false,
  oc: null,
  cidade: null,
  tipoCte: null,
  tempo: "todos",
  comSugestao: false,
  status: "todos",
};

const LIMIAR_TEMPO_H: Record<Exclude<FiltroTempo, "todos">, number> = { "4h": 4, "24h": 24, "72h": 72 };

export function rotuloCidade(l: Pick<OpFilaLinha, "cidade_destino" | "uf_destino">): string | null {
  if (!l.cidade_destino) return null;
  return l.uf_destino ? `${l.cidade_destino}/${l.uf_destino}` : l.cidade_destino;
}

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function filtrarFila(
  linhas: readonly OpFilaLinha[],
  f: FiltrosFila,
  ctx: { membro: Pick<OpMembro, "unidades"> | null; agoraMs: number },
): OpFilaLinha[] {
  const busca = normalizar(f.busca);
  const unidades = new Set((ctx.membro?.unidades ?? []).map((u) => u.toUpperCase()));
  return linhas.filter((l) => {
    if (f.minhasUnidades && !(l.unidade && unidades.has(l.unidade.toUpperCase()))) return false;
    if (f.oc != null && l.cod_ultima_ocorrencia !== f.oc) return false;
    if (f.cidade != null && rotuloCidade(l) !== f.cidade) return false;
    if (f.tipoCte != null && (l.tipo_cte ?? "") !== f.tipoCte) return false;
    if (f.tempo !== "todos") {
      const ms = tempoParadoMs(l, ctx.agoraMs);
      if (ms == null || ms < LIMIAR_TEMPO_H[f.tempo] * HORA_MS) return false;
    }
    if (f.comSugestao && !l.sugestao) return false;
    if (f.status !== "todos" && statusLancamentoTela(l.lancamento_status) !== f.status) return false;
    if (busca) {
      const alvo = normalizar(
        [l.nf, l.ctrc, l.pagador, l.destinatario, l.cidade_destino, l.unidade].filter(Boolean).join(" "),
      );
      if (!alvo.includes(busca)) return false;
    }
    return true;
  });
}

/** Mais parado primeiro. Sem data vai para o fim (não dá para dizer que é urgente nem que não é). */
export function ordenarPorTempoParado(
  linhas: readonly OpFilaLinha[],
  agoraMs: number,
  direcao: "mais_parado" | "menos_parado" = "mais_parado",
): OpFilaLinha[] {
  const sinal = direcao === "mais_parado" ? -1 : 1;
  return [...linhas].sort((a, b) => {
    const ta = tempoParadoMs(a, agoraMs);
    const tb = tempoParadoMs(b, agoraMs);
    if (ta == null && tb == null) return a.ctrc.localeCompare(b.ctrc);
    if (ta == null) return 1;
    if (tb == null) return -1;
    if (ta !== tb) return sinal * (ta - tb);
    return a.ctrc.localeCompare(b.ctrc);
  });
}

/** Opções dos selects, tiradas da própria fila (só o que existe). */
export function opcoesDaFila(linhas: readonly OpFilaLinha[]): {
  ocs: { codigo: number; descricao: string | null }[];
  cidades: string[];
  tiposCte: string[];
} {
  const ocs = new Map<number, string | null>();
  const cidades = new Set<string>();
  const tiposCte = new Set<string>();
  for (const l of linhas) {
    if (l.cod_ultima_ocorrencia != null && !ocs.has(l.cod_ultima_ocorrencia)) {
      ocs.set(l.cod_ultima_ocorrencia, l.descricao_oc);
    }
    const c = rotuloCidade(l);
    if (c) cidades.add(c);
    if (l.tipo_cte) tiposCte.add(l.tipo_cte);
  }
  return {
    ocs: [...ocs.entries()].sort((a, b) => a[0] - b[0]).map(([codigo, descricao]) => ({ codigo, descricao })),
    cidades: [...cidades].sort((a, b) => a.localeCompare(b, "pt-BR")),
    tiposCte: [...tiposCte].sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}

/** Atraso em dias (do Bastão) ou, sem ele, a previsão já vencida. */
export function situacaoPrazo(
  l: Pick<OpFilaLinha, "atraso_original" | "previsao_entrega">,
  agoraMs: number,
): { texto: string; atrasado: boolean } {
  if (l.atraso_original != null && l.atraso_original > 0) {
    return { texto: `${l.atraso_original} d de atraso`, atrasado: true };
  }
  if (l.previsao_entrega) {
    const t = Date.parse(l.previsao_entrega);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      const dataFmt = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
      return t < agoraMs
        ? { texto: `previsão ${dataFmt} vencida`, atrasado: true }
        : { texto: `previsão ${dataFmt}`, atrasado: false };
    }
  }
  return { texto: "sem previsão", atrasado: false };
}
