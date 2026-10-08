// =============================================================================
// Setores da Operação e o setor dono de cada código de ocorrência (ADR 0042).
//
// Fonte: o Pendências (tatiana-kelly/pendency-tracker @ a884368):
//   - src/types/pendencia.ts:63-86 (OCORRENCIA_RESPONSAVEL_MAP, "Tabela Oficial");
//   - etl/notas-ciclo/src/setores.js:44-58 (o mesmo mapa no ETL);
//   - tabela ocorrencias_setores (fonte de verdade lá desde 24/09/2026), com a 52 →
//     OPERACAO (mig 20260615150051) e a 60 → CLIENTE (decisão da gestão, Sara, 24/09).
// Espelho da semente da mig 441 (`op_setor_por_oc`): o teste setores.test.ts lê a
// migration e trava que os dois dizem a mesma coisa.
//
// Hierarquia (a mesma do Pendências e do state_pelo_bastao): o `responsavel_atual` do
// Bastão manda; vazio → o mapa pelo código; código fora do mapa → NAO_IDENTIFICADO (régua
// de 24/09 do Pendências: "não é um setor, é a recusa a chutar um").
// =============================================================================

export type SetorId = "OPERACAO" | "AGENDAMENTO" | "DEVOLUCAO" | "RESSARCIMENTO" | "PERDAS" | "CLIENTE" | "RELACIONAMENTO";
export type SetorOuNaoIdentificado = SetorId | "NAO_IDENTIFICADO";

export interface SetorDef {
  id: SetorId;
  nome: string;
  /** O que o setor faz, em linguagem de operador. */
  funcao: string;
  codigos: readonly number[];
}

export const SETORES: readonly SetorDef[] = [
  {
    id: "OPERACAO",
    nome: "Operação",
    funcao: "Transferência, chegada na base, entrega, reentrega, redespacho e informação operacional",
    codigos: [1, 2, 4, 5, 7, 12, 13, 14, 15, 21, 22, 24, 25, 27, 29, 32, 34, 36, 37, 38, 39, 40, 41, 45, 48, 50, 51, 52, 55, 56, 57],
  },
  { id: "AGENDAMENTO", nome: "Agendamento", funcao: "Aguardando agendamento com o destinatário", codigos: [31] },
  { id: "DEVOLUCAO", nome: "Devolução", funcao: "Devolução autorizada, retorno de carga e liberação de devolução", codigos: [30, 44, 53, 58] },
  { id: "RESSARCIMENTO", nome: "Ressarcimento", funcao: "Sinistro, reversão de perdas e análise de ressarcimento", codigos: [18, 33, 42, 46, 47] },
  { id: "PERDAS", nome: "Perdas", funcao: "Extravio na coleta, na transferência e na entrega", codigos: [6, 9, 16] },
  { id: "CLIENTE", nome: "Cliente", funcao: "Aguardando retorno ou documentação do cliente pagador", codigos: [54, 59, 60] },
  {
    id: "RELACIONAMENTO",
    nome: "Relacionamento",
    funcao: "Avaria, recusa, falta, documentação e tratativa com o cliente (Cockpit do Relacionamento)",
    codigos: [3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49],
  },
];

/** Setores que podem ter gente na Operação. O Relacionamento nunca (separação do ADR 0041 D2). */
export const SETORES_DA_OPERACAO: readonly SetorId[] = SETORES.filter((s) => s.id !== "RELACIONAMENTO").map((s) => s.id);

const MAPA = new Map<number, SetorId>();
for (const s of SETORES) for (const c of s.codigos) MAPA.set(c, s.id);

const POR_RESPONSAVEL: Record<string, SetorId> = Object.fromEntries(SETORES.map((s) => [s.id.toLowerCase(), s.id]));

export function setorPorId(id: string | null | undefined): SetorDef | null {
  return SETORES.find((s) => s.id === id) ?? null;
}

export function nomeDoSetor(id: SetorOuNaoIdentificado | string | null | undefined): string {
  if (id === "NAO_IDENTIFICADO") return "Sem setor";
  return setorPorId(id)?.nome ?? "Sem setor";
}

/** Setor pelo código da ocorrência ('01', '1' e 1 viram 1). */
export function setorDaOcorrencia(cod: number | string | null | undefined): SetorOuNaoIdentificado {
  const n = Number(String(cod ?? "").trim());
  if (cod == null || String(cod).trim() === "" || !Number.isFinite(n)) return "NAO_IDENTIFICADO";
  return MAPA.get(n) ?? "NAO_IDENTIFICADO";
}

/** Setor do item: `setor` já resolvido pela view (mig 441) > responsavel_atual > mapa pelo código. */
export function setorDoItem(l: { setor?: string | null; responsavel_atual?: string | null; cod_ultima_ocorrencia: number | null }): SetorOuNaoIdentificado {
  const pronto = (l.setor ?? "").trim().toUpperCase();
  if (pronto === "NAO_IDENTIFICADO") return pronto;
  if (setorPorId(pronto)) return pronto as SetorId;
  const resp = (l.responsavel_atual ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  // Responsável preenchido manda, mesmo desconhecido: NAO_IDENTIFICADO (como o materializador e a 441).
  if (resp) return POR_RESPONSAVEL[resp] ?? "NAO_IDENTIFICADO";
  return setorDaOcorrencia(l.cod_ultima_ocorrencia);
}
