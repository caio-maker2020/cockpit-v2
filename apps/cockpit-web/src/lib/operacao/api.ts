// =============================================================================
// A porta única da tela da Operação para o backend (ADR 0041, "Contrato com o
// front"). A tela NUNCA chama supabase direto: fala com uma OpApi.
//   - produção: `criarOpApiSupabase` (apiSupabase.ts) — RPCs e a view de verdade;
//   - demonstração local: o adaptador em memória (demo/), carregado SÓ com
//     VITE_OPERACAO_DEMO=true em `vite dev` (ver carregarOpApi).
// =============================================================================
import type {
  OpCodigo,
  OpFilaLinha,
  OpRespostaAssumir,
  OpRespostaCancelar,
  OpRespostaDetalhe,
  OpRespostaPrevia,
  OpRespostaSolicitar,
  OpSessao,
} from "./tipos";

export interface OpApi {
  readonly modo: "supabase" | "demo";
  /** null = não deu para saber (RPC ausente/erro) → a tela trata como "não é da Operação". */
  minhaSessao(): Promise<OpSessao | null>;
  /** `op_v_fila` (a RLS decide o que cada um vê). Lança em erro (a tela mostra). */
  fila(): Promise<OpFilaLinha[]>;
  itemDetalhe(opItemId: string): Promise<OpRespostaDetalhe>;
  codigosDisponiveis(): Promise<OpCodigo[]>;
  assumir(opItemId: string, forcar?: boolean): Promise<OpRespostaAssumir>;
  previa(opItemId: string, codigoOc: number, texto: string): Promise<OpRespostaPrevia>;
  solicitar(opItemId: string, codigoOc: number, texto: string, confirmacao: string): Promise<OpRespostaSolicitar>;
  aceitarSugestao(opItemId: string, confirmacao: string): Promise<OpRespostaSolicitar>;
  cancelar(lancamentoId: string): Promise<OpRespostaCancelar>;
  /** Só o modo demo: avisa quando o "worker" falso mexe nos dados. O real usa Realtime. */
  assinarMudancas?(cb: () => void): () => void;
}

/** Converte erro de transporte (rede, RPC ausente, modo leitura) em falha legível. */
export function falhaDeComunicacao(motivo: string) {
  return { ok: false as const, erro: "falha_de_comunicacao" as const, motivo };
}

/**
 * Type guard das respostas `{ok:false,...}`. O tsconfig do app não é strict,
 * então `if (!r.ok)` não estreita a união; use isto.
 */
export function ehFalhaOp<T extends { ok: boolean }>(r: T): r is Extract<T, { ok: false }> {
  return r.ok === false;
}
