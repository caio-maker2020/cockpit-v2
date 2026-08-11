// =============================================================================
// Alertas do agente pro operador (INV-067, Caio 2026-08-11).
//
// O agente avisa o operador quando um card DELE pode estar travado — hoje o
// único caso é "cliente respondeu e o card não se moveu". Funções puras aqui
// (testadas) para a UI ficar burra.
// =============================================================================

export interface RelatorioAlerta {
  sintoma?: string;
  o_que_aconteceu?: string[];
  qual_card?: string;
  causa_provavel?: string;
  o_que_verificar?: string[];
  impacto?: string;
  pedido?: string;
}

export interface AlertaOperadorRow {
  id: string;
  card_id: string | null;
  nf: string | null;
  tipo: string;
  titulo: string;
  relatorio: RelatorioAlerta | null;
  criado_em: string;
  lido_em: string | null;
  encaminhado_em: string | null;
}

/** Uma "fala" do agente na conversa lateral. */
export interface FalaAgente {
  id: string;
  texto: string;
  /** destaque visual: o card em questão */
  enfase?: boolean;
}

/**
 * Texto da barra inferior. Fixo por decisão do Caio (2026-08-11) — é o gancho
 * que o operador reconhece de longe; não personalizar por NF aqui.
 */
export const TEXTO_BARRA = "O agente está te chamando, você pode ter um card travado.";

/** Plural correto na barra quando há mais de um card. */
export function textoBarra(qtd: number): string {
  if (qtd <= 1) return TEXTO_BARRA;
  return `O agente está te chamando, você pode ter ${qtd} cards travados.`;
}

/**
 * Transforma o relatório do agente numa conversa: cada bloco vira uma fala,
 * na ordem em que a pessoa precisa entender — o que houve, qual card, por quê,
 * o que fazer, e o pedido final.
 */
export function montarConversa(alerta: AlertaOperadorRow): FalaAgente[] {
  const r = alerta.relatorio ?? {};
  const falas: FalaAgente[] = [];
  const push = (texto: string | undefined, enfase = false) => {
    if (texto && texto.trim()) falas.push({ id: `f${falas.length}`, texto: texto.trim(), enfase });
  };

  push(r.sintoma);
  for (const l of r.o_que_aconteceu ?? []) push(l);
  push(r.qual_card, true);
  push(r.causa_provavel);
  if ((r.o_que_verificar ?? []).length > 0) {
    push(["O que eu preciso que você faça:", ...(r.o_que_verificar ?? []).map((l) => `• ${l}`)].join("\n"));
  }
  push(r.impacto);
  push(r.pedido);

  // Alerta antigo/sem relatório estruturado não pode virar conversa vazia.
  if (falas.length === 0) push(alerta.titulo);
  return falas;
}

/** Rótulo curto de quando o agente falou (relativo, estilo mensageiro). */
export function quandoRelativo(iso: string, agoraMs: number): string {
  const min = Math.max(0, Math.floor((agoraMs - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ontem" : `há ${d} dias`;
}

/** Só alertas não lidos aparecem — LIDO faz sumir (regra do Caio). */
export function pendentes(alertas: AlertaOperadorRow[]): AlertaOperadorRow[] {
  return alertas.filter((a) => a.lido_em == null);
}
