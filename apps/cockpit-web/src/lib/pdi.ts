// =============================================================================
// pdi — domínio do Plano de Desenvolvimento da Isadora (Caio 16/09, mig 399).
// Aba visível SÓ pra Isadora + Caio (RLS no banco reforça; front só esconde).
// Funções puras testadas em pdi.test.ts.
// =============================================================================

export const PDI_EMAIL_ISADORA = "isadora.baldoni@salexpress.com.br";
export const PDI_EMAIL_CAIO = "caio@salexpress.com.br";

export function ehParticipantePdi(email: string | null | undefined): boolean {
  const e = (email ?? "").toLowerCase();
  return e === PDI_EMAIL_ISADORA || e === PDI_EMAIL_CAIO;
}
export function ehCaioPdi(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === PDI_EMAIL_CAIO;
}

// ── vocabulário do Mapa de Demanda (Frente 1) ────────────────────────────────
export const PDI_CANAIS = [
  { v: "whatsapp", l: "WhatsApp" },
  { v: "email", l: "E-mail" },
  { v: "telefone", l: "Telefone" },
  { v: "presencial", l: "Presencial" },
  { v: "cockpit", l: "Cockpit" },
] as const;

export const PDI_TEMPOS_MIN = [5, 15, 30, 60] as const;

export const PDI_CLASSES_CAUSA = [
  { v: "falta_conhecimento", l: "Falta de conhecimento" },
  { v: "processo_disfuncional", l: "Processo disfuncional" },
  { v: "expectativa_desalinhada", l: "Expectativa desalinhada" },
  { v: "excecao", l: "Exceção (Murphy)" },
] as const;

export const PDI_DESTINOS = [
  { v: "vira_conhecimento", l: "Vira conhecimento", d: "documentar e treinar" },
  { v: "vira_alcada", l: "Vira alçada", d: "liberar a decisão pra alguém" },
  { v: "vira_projeto", l: "Vira projeto", d: "atacar a causa raiz" },
  { v: "fica_execucao", l: "Fica execução", d: "complexidade real do papel" },
] as const;

const mapa = (arr: ReadonlyArray<{ v: string; l: string }>) =>
  Object.fromEntries(arr.map((x) => [x.v, x.l]));
const CANAL_L = mapa(PDI_CANAIS);
const CLASSE_L = mapa(PDI_CLASSES_CAUSA);
const DESTINO_L = mapa(PDI_DESTINOS);

export const rotuloCanal = (v: string | null | undefined) => CANAL_L[v ?? ""] ?? (v ?? "—");
export const rotuloClasse = (v: string | null | undefined) => CLASSE_L[v ?? ""] ?? (v ?? "—");
export const rotuloDestino = (v: string | null | undefined) => DESTINO_L[v ?? ""] ?? "Pendente";

// ── linhas do banco ──────────────────────────────────────────────────────────
export interface PdiFrenteRow {
  id: number; nome: string; descricao: string;
  liberada: boolean; liberada_em: string | null;
}
export interface PdiEntregaRow {
  id: string; frente_id: number; titulo: string; definicao_de_pronto: string;
  prazo: string | null; status: string; conteudo: string; devolutiva: string | null;
  entregue_em: string | null; validada_em: string | null;
}
export interface PdiTodoRow {
  id: string; frente_id: number | null; titulo: string; detalhe: string | null;
  origem: string; prazo: string | null; status: string; created_at: string;
}
export interface PdiDemandaRow {
  id: string; criado_em: string; ator: string; pedido: string; canal: string;
  tempo_min: number; classe_causa: string; destino: string | null;
  destino_det: string | null; enderecada_em: string | null;
}
export interface Pdi1a1Row {
  id: string; data: string; audio_path: string | null; transcricao: string | null;
  resumo: Pdi1a1Resumo | null; status: string; erro: string | null; created_at: string;
}
export interface Pdi1a1Resumo {
  pauta?: string[];
  feedbacks?: string[];
  compromissos?: Array<{ titulo: string; responsavel?: string; prazo?: string | null }>;
  sinais?: string[];
}

// ── indicadores do Mapa de Demanda (o que o Caio mede) ───────────────────────
/** Segunda-feira da semana da data, em YYYY-MM-DD (fuso local). */
export function inicioDaSemana(iso: string): string {
  const d = new Date(iso);
  const dow = (d.getDay() + 6) % 7; // seg=0 ... dom=6
  d.setDate(d.getDate() - dow);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface SemanaDemanda {
  semana: string;               // segunda-feira (YYYY-MM-DD)
  acionamentos: number;
  tempoMin: number;
  porClasse: Record<string, number>;
  pendentes: number;            // sem destino
}

/** Agrega o log por semana (mais recente primeiro). Puro — testado. */
export function resumoDemandaSemanal(
  rows: ReadonlyArray<Pick<PdiDemandaRow, "criado_em" | "tempo_min" | "classe_causa" | "destino">>,
): SemanaDemanda[] {
  const por = new Map<string, SemanaDemanda>();
  for (const r of rows) {
    const s = inicioDaSemana(r.criado_em);
    const acc = por.get(s) ??
      { semana: s, acionamentos: 0, tempoMin: 0, porClasse: {}, pendentes: 0 };
    acc.acionamentos += 1;
    acc.tempoMin += r.tempo_min ?? 0;
    acc.porClasse[r.classe_causa] = (acc.porClasse[r.classe_causa] ?? 0) + 1;
    if (!r.destino) acc.pendentes += 1;
    por.set(s, acc);
  }
  return [...por.values()].sort((a, b) => (a.semana < b.semana ? 1 : -1));
}
