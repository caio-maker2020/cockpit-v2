// =============================================================================
// Régua do Pendências portada para a Operação do Cockpit (só regras, puras).
//
// Fonte: tatiana-kelly/pendency-tracker @a884368. Cada regra cita o arquivo:linha
// de onde saiu. Quando o código e o texto de ajuda do Pendências discordam, vale o
// CÓDIGO (é o que roda lá hoje) e a divergência fica exposta numa constante, para o
// dono decidir.
//
// Relógio: dias úteis desde a ÚLTIMA OCORRÊNCIA (o "tempo parado" do Pendências),
// contados em dias do calendário de São Paulo. Nunca `materializado_em` (INV-151).
// =============================================================================
import { regionalDaBase } from "./regionais";
import { SIGLA_BASE, type TipoBase } from "./unidadesPendencias";
import type { OpFilaLinha } from "./tipos";

const DIA_MS = 86_400_000;
/** Brasília sem horário de verão desde 2019: UTC-3 fixo. */
const OFFSET_SP_MS = -3 * 3_600_000;

// --------------------------------------------------------------------------- feriados

/**
 * Feriados nacionais 2025–2027. No Pendências a fonte é a tabela `feriados_nacionais`
 * (src/lib/businessDays.ts:3-31); a rede de segurança do ETL calcula a mesma lista
 * (etl/notas-ciclo/src/calendario.js:44-55): fixos + Carnaval (seg/ter), Sexta-feira
 * Santa e Corpus Christi ("a operação de transporte para"). Lista abaixo gerada com
 * aquela função. Fora de 2025–2027 só sábado e domingo contam como não úteis.
 */
export const FERIADOS_NACIONAIS: ReadonlySet<string> = new Set([
  "2025-01-01", "2025-03-03", "2025-03-04", "2025-04-18", "2025-04-21", "2025-05-01", "2025-06-19",
  "2025-09-07", "2025-10-12", "2025-11-02", "2025-11-15", "2025-11-20", "2025-12-25",
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-04-03", "2026-04-21", "2026-05-01", "2026-06-04",
  "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25",
  "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-26", "2027-04-21", "2027-05-01", "2027-05-27",
  "2027-09-07", "2027-10-12", "2027-11-02", "2027-11-15", "2027-11-20", "2027-12-25",
]);

/** Índice do dia (dias desde 1970-01-01) no calendário de São Paulo. Data pura ('YYYY-MM-DD') vale como está. */
export function diaSP(valor: string | number | null | undefined): number | null {
  if (valor == null || valor === "") return null;
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    const [y, m, d] = valor.trim().split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d) / DIA_MS;
  }
  const t = typeof valor === "number" ? valor : Date.parse(valor);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t + OFFSET_SP_MS) / DIA_MS);
}

const isoDoDia = (idx: number) => new Date(idx * DIA_MS).toISOString().slice(0, 10);

export function ehDiaUtil(idx: number): boolean {
  const dow = new Date(idx * DIA_MS).getUTCDay();
  return dow !== 0 && dow !== 6 && !FERIADOS_NACIONAIS.has(isoDoDia(idx));
}

/**
 * Dias úteis de `isoData` (exclusivo) até hoje (inclusivo). Mesmo algoritmo de
 * calcularDiasDesdeUltimaOcorrencia (src/types/pendencia.ts:122-144): ocorrência hoje = 0,
 * no dia útil anterior = 1; sábado, domingo e feriado nacional não contam.
 * Sem data (ou data futura) = 0, como lá. Use `temData` para separar "0" de "sem data".
 */
export function diasUteisDesde(isoData: string | null | undefined, agoraMs: number): number {
  const de = diaSP(isoData);
  const ate = diaSP(agoraMs);
  if (de == null || ate == null || ate <= de) return 0;
  let n = 0;
  for (let d = de + 1; d <= ate; d++) if (ehDiaUtil(d)) n++;
  return n;
}

/**
 * Primeiro dia útil DEPOIS de `idx` (índice do dia de SP). Sexta → segunda; véspera de
 * feriado → o dia seguinte ao feriado. Usado no "obrigatórias até o próximo dia útil".
 */
export function proximoDiaUtil(idx: number): number {
  let d = idx + 1;
  while (!ehDiaUtil(d)) d++;
  return d;
}

/**
 * Atraso na previsão de entrega, em dias CORRIDOS (src/types/pendencia.ts:92-104):
 * ceil(hoje − previsão); no prazo ou sem previsão = 0. É outra conta que a do tempo
 * parado: esta mede atraso da entrega, aquela mede nota sem andar.
 */
export function atrasoPrevisaoDias(previsao: string | null | undefined, agoraMs: number): number {
  const p = diaSP(previsao);
  const h = diaSP(agoraMs);
  if (p == null || h == null) return 0;
  return h - p > 0 ? h - p : 0;
}

// --------------------------------------------------------------------------- carga parada

/**
 * Faixas da Análise de Carga Parada (src/components/gestao/CargaParadaAnalise.tsx:15-23):
 * "Há 0 dias" … "Há 7 dias" e "Acima de 7 dias" (> 7), em dias úteis.
 */
export type FaixaCargaParada = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8+";
export const FAIXAS_CARGA_PARADA: readonly { id: FaixaCargaParada; rotulo: string }[] = [
  { id: "0", rotulo: "Há 0 dias" },
  { id: "1", rotulo: "Há 1 dia" },
  { id: "2", rotulo: "Há 2 dias" },
  { id: "3", rotulo: "Há 3 dias" },
  { id: "4", rotulo: "Há 4 dias" },
  { id: "5", rotulo: "Há 5 dias" },
  { id: "6", rotulo: "Há 6 dias" },
  { id: "7", rotulo: "Há 7 dias" },
  { id: "8+", rotulo: "Acima de 7 dias" },
];

export function faixaCargaParada(diasUteis: number): FaixaCargaParada {
  if (diasUteis > 7) return "8+";
  return String(Math.max(0, Math.floor(diasUteis))) as FaixaCargaParada;
}

/** Carga crítica: parada há MAIS de 5 dias úteis (src/components/gestao/CargasCriticasPanel.tsx:13-16). */
export const DIAS_CARGA_CRITICA = 5;
export const cargaCritica = (diasUteis: number) => diasUteis > DIAS_CARGA_CRITICA;

// --------------------------------------------------------------------------- regra de exportação "carga parada"

/** Pré-entrega (GestaoHelpPanel.tsx:144; docs/INDICADORES-DE-PENDENCIA.md: 07 entrou em 29/09/2026). */
export const OCS_PRE_ENTREGA: readonly number[] = [7, 13, 15, 21, 36, 39, 55];

// A regra do botão "Exportar carga parada" mora em ./cargaParada.ts.

// --------------------------------------------------------------------------- indicadores "regra atual" (estoque)

/**
 * REGRA ATUAL (ESTOQUE), não a regra do ciclo: das notas abertas hoje, quantas
 * estouraram o limite. A do ciclo ("finalizadas no prazo") precisa do histórico de
 * desfecho, que a fila não tem.
 *
 * Acima de 7 dias: `dias >= 7` (src/components/gestao/AcompanhamentoMetaPanel.tsx:357),
 * fora as notas de pré-entrega (que caem no "priorizar", :359-362). A ajuda diz
 * "7 dias úteis ou mais" (GestaoHelpPanel.tsx:113); a faixa do gráfico de carga parada
 * usa "> 7" (CargaParadaAnalise.tsx:23). Valem as duas contas, cada uma no seu lugar.
 * Devolução/reversa ficam fora lá (tipo de documento); aqui não dá para tirar.
 */
export const DIAS_INDICADOR_7 = 7;
/**
 * Pré-entrega: `dias >= 2` vira prioridade (AcompanhamentoMetaPanel.tsx:79,91; era 3 até
 * 29/09/2026). No indicador do ciclo, "<= 2 é dentro" (docs/INDICADORES-DE-PENDENCIA.md),
 * ou seja, o estoque cobra a nota no 2º dia útil e o ciclo só a conta fora no 3º.
 */
export const DIAS_INDICADOR_PRE_ENTREGA = 2;

export function entraAcima7(l: Pick<OpFilaLinha, "cod_ultima_ocorrencia" | "data_ultima_ocorrencia">, agoraMs: number): boolean {
  if (!l.data_ultima_ocorrencia) return false;
  if (l.cod_ultima_ocorrencia != null && OCS_PRE_ENTREGA.includes(l.cod_ultima_ocorrencia)) return false;
  return diasUteisDesde(l.data_ultima_ocorrencia, agoraMs) >= DIAS_INDICADOR_7;
}

export function entraPreEntregaAcima2(l: Pick<OpFilaLinha, "cod_ultima_ocorrencia" | "data_ultima_ocorrencia">, agoraMs: number): boolean {
  if (!l.data_ultima_ocorrencia || l.cod_ultima_ocorrencia == null || !OCS_PRE_ENTREGA.includes(l.cod_ultima_ocorrencia)) return false;
  return diasUteisDesde(l.data_ultima_ocorrencia, agoraMs) >= DIAS_INDICADOR_PRE_ENTREGA;
}

// --------------------------------------------------------------------------- regionais

// Regional → bases: lib/operacao/regionais.ts (cópia de src/lib/regionais.ts @a884368).
export { REGIONAL_BASES, REGIONAL_ORDEM, SEM_REGIONAL, regionalDaBase } from "./regionais";

export function baseDaUnidade(sigla: string | null | undefined): { base: string; tipo: TipoBase } | null {
  if (!sigla) return null;
  const v = SIGLA_BASE[sigla.trim().toUpperCase()];
  return v ? { base: v[0], tipo: v[1] } : null;
}

/** Regional da sigla da unidade; null = "Sem regional" (mostrado com o nome, nunca descartado). */
export function regionalDaUnidade(sigla: string | null | undefined): string | null {
  return regionalDaBase(baseDaUnidade(sigla)?.base);
}

// --------------------------------------------------------------------------- SLA por setor

/**
 * Prazo e crítico por setor, em dias úteis desde a última ocorrência. Semente da tabela
 * `sla_setores` (supabase/migrations/20260305193540_06240cfc-….sql:16-22). Comparação
 * estrita: > crítico = crítico; > prazo = fora; senão dentro
 * (src/hooks/useEficienciaPendencias.ts:87-94).
 * DÚVIDA: AGENDAMENTO não tem linha na tabela; o código cai no padrão 3/7 (:89-90), o
 * mesmo da OPERACAO. "Sem setor" também cai no padrão.
 */
export const SLA_SETORES: Readonly<Record<string, { prazo: number; critico: number }>> = {
  OPERACAO: { prazo: 3, critico: 7 },
  RELACIONAMENTO: { prazo: 3, critico: 7 },
  PERDAS: { prazo: 5, critico: 10 },
  RESSARCIMENTO: { prazo: 5, critico: 10 },
  DEVOLUCAO: { prazo: 3, critico: 7 },
  CLIENTE: { prazo: 5, critico: 10 },
};
export const SLA_PADRAO = { prazo: 3, critico: 7 } as const;

export type StatusSla = "dentro" | "fora" | "critico";

export function slaDoSetor(setor: string | null | undefined): { prazo: number; critico: number; padrao: boolean } {
  const s = SLA_SETORES[(setor ?? "").toUpperCase()];
  return s ? { ...s, padrao: false } : { ...SLA_PADRAO, padrao: true };
}

export function statusSla(diasUteis: number, setor: string | null | undefined): StatusSla {
  const s = slaDoSetor(setor);
  if (diasUteis > s.critico) return "critico";
  if (diasUteis > s.prazo) return "fora";
  return "dentro";
}
