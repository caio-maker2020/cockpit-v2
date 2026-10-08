// =============================================================================
// Dados FICTÍCIOS do modo demonstração (VITE_OPERACAO_DEMO=true). Nenhum CTRC,
// NF, pagador ou destinatário aqui é real. Só existe no `vite dev`.
// =============================================================================
import type { OpCodigo, OpLancamento, OpMembro, OpSugestao, StatusLancamentoOp } from "../tipos";

/** Descrições do dicionário SSW (as mesmas das migrations do Cockpit). */
export const DESCRICOES_OC: Record<number, string> = {
  13: "Entrega impossibilitada: limitação cliente",
  14: "Entrega iniciada",
  15: "Entrega impossib: limit. base op. entreg",
  21: "Reentrega solicitada pelo cliente",
  36: "Chegada na base para entrega",
  37: "Entrega impossibilitada por problema no veículo",
  40: "Redespacho final",
  39: "Entrega impossib: problemas com janela",
  56: "Falta de informação operacional ou indevida",
};

/** Os códigos "liberados" na demo (na vida real a lista nasce vazia — ADR 0041 D5). */
export const CODIGOS_DEMO: OpCodigo[] = [
  { codigo: 15, descricao: DESCRICOES_OC[15]!, exige_texto: false },
  { codigo: 36, descricao: DESCRICOES_OC[36]!, exige_texto: false },
  { codigo: 37, descricao: DESCRICOES_OC[37]!, exige_texto: false },
  { codigo: 56, descricao: DESCRICOES_OC[56]!, exige_texto: true },
  // Os que as regras aprendidas do histórico SSW sugerem (saida/regras.json).
  { codigo: 12, descricao: "Comprovante retido para conferência", exige_texto: false },
  { codigo: 22, descricao: "Retirada da carga (pelo cliente) na base", exige_texto: false },
  { codigo: 38, descricao: "Problemas na transferência", exige_texto: false },
  { codigo: 39, descricao: DESCRICOES_OC[39]!, exige_texto: false },
];

export const MEMBRO_DEMO: OpMembro = {
  id: "demo-membro-supervisora",
  nome: "Marina Duarte",
  email: "supervisao.demo@exemplo.invalid",
  papel_op: "supervisor_op",
  unidades: ["VGA", "POA", "BHZ"],
  pode_lancar: true,
};

export const OUTROS_MEMBROS = {
  rafael: { id: "demo-membro-rafael", nome: "Rafael Lima" },
  juliana: { id: "demo-membro-juliana", nome: "Juliana Prado" },
};

const CIDADES: Record<string, string[]> = {
  VGA: ["Varginha", "Três Corações", "Lavras", "Elói Mendes", "Três Pontas"],
  POA: ["Pouso Alegre", "Itajubá", "Santa Rita do Sapucaí", "Extrema", "Cambuí"],
  BHZ: ["Belo Horizonte", "Contagem", "Betim", "Sete Lagoas", "Nova Lima"],
};

const PAGADORES = [
  "DISTRIBUIDORA SERRA AZUL LTDA (fictício)",
  "ALFA COSMÉTICOS S.A. (fictício)",
  "MOINHO VALE VERDE LTDA (fictício)",
  "AUTOPEÇAS RIO CLARO LTDA (fictício)",
  "LATICÍNIOS BOA VISTA (fictício)",
];

const DESTINATARIOS = [
  "MERCADO BOM PREÇO",
  "FARMÁCIA SÃO JOSÉ",
  "ATACADO CENTRAL",
  "LOJA DO PRODUTOR",
  "SUPERMERCADO FAMÍLIA",
  "DROGARIA POPULAR",
  "CASA DAS FERRAGENS",
];

export interface ItemSemente {
  unidade: string | null;
  oc: number;
  horasParado: number;
  semNf?: boolean;
  /** Simula um card do Relacionamento aberto DEPOIS de o item entrar (a cerca barra). */
  cardAtivoNoRelacionamento?: boolean;
  assumidoPor?: keyof typeof OUTROS_MEMBROS;
  atrasoDias?: number;
  previsaoEmDias?: number;
  sugestao?: Omit<OpSugestao, "versao_regras" | "lancavel">;
  /** Encaminhamento AUTOMÁTICO agendado (D11) que vence daqui a N minutos — dá para desfazer. */
  encaminhamentoAgendadoEmMin?: number;
  lancamento?: {
    status: StatusLancamentoOp;
    codigo: number;
    texto: string;
    minutosAtras: number;
    por: keyof typeof OUTROS_MEMBROS;
    detalhe?: string;
    categoria_erro?: string;
  };
}

/** 27 itens: mistura de unidade, oc, tempo parado, sugestão e status de lançamento (2 em oc 40 pro relógio do redespacho). */
export const SEMENTES: ItemSemente[] = [
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-13-reentrega", codigo: 21, texto: "Cliente pediu reentrega", confianca: 0.58, casos: { n: 29, m: 50 }, motivo: "oc 13 parada há mais de 3 dias", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "VGA", oc: 13, horasParado: 75, atrasoDias: 3 },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-36-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje", confianca: 0.82, casos: { n: 41, m: 50 }, motivo: "oc 36 parada há mais de 48 h na base", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "VGA", oc: 36, horasParado: 52, atrasoDias: 2 },
  { unidade: "POA", oc: 13, horasParado: 30, previsaoEmDias: -1,
    lancamento: { status: "fila", codigo: 36, texto: "", minutosAtras: 6, por: "juliana" } },
  { unidade: "BHZ", oc: 21, horasParado: 6, previsaoEmDias: 1 },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-15-volta-base", codigo: 36, texto: "Carga voltou para a base; nova tentativa programada", confianca: 0.74, casos: { n: 37, m: 50 }, motivo: "oc 15 seguida de nova chegada na base", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "VGA", oc: 15, horasParado: 28, assumidoPor: "rafael", atrasoDias: 1 },
  { unidade: "POA", oc: 37, horasParado: 4, previsaoEmDias: 0,
    lancamento: { status: "lancado", codigo: 36, texto: "Veículo substituto chegou à base", minutosAtras: 40, por: "juliana" } },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-36-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje", confianca: 0.82, casos: { n: 41, m: 50 }, motivo: "oc 36 parada há mais de 48 h na base", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "BHZ", oc: 36, horasParado: 49 },
  { unidade: "VGA", oc: 56, horasParado: 2, previsaoEmDias: 2 },
  { unidade: "POA", oc: 14, horasParado: 3,
    lancamento: { status: "confirmado", codigo: 36, texto: "", minutosAtras: 130, por: "juliana" } },
  { sugestao: { versao_contrato: 2, fonte: "agente_ia", base_regra: "agente_ia", regra_id: "agente_ia", modelo: "claude-haiku-4-5", versao_prompt: "agente-operacao@1", acao: "encaminhar_relacionamento", codigo: null, texto: "Cliente recusa receber; pedir autorização de reentrega", confianca: 0.72, motivo: "três tentativas frustradas por limitação do cliente", justificativa: "Três tentativas sem sucesso pelo cliente: o próximo passo é contato com o pagador, que é do Relacionamento." },
    unidade: "BHZ", oc: 13, horasParado: 96, atrasoDias: 5 },
  { unidade: "VGA", oc: 37, horasParado: 20, cardAtivoNoRelacionamento: true, atrasoDias: 1 },
  { unidade: "POA", oc: 15, horasParado: 33,
    lancamento: { status: "nao_confirmado", codigo: 36, texto: "", minutosAtras: 300, por: "juliana",
      detalhe: "o SSW mostrou outra oc depois do lançamento; uma pessoa precisa conferir" } },
  { unidade: "BHZ", oc: 14, horasParado: 1, previsaoEmDias: 1 },
  { sugestao: { versao_contrato: 2, fonte: "agente_ia", base_regra: "agente_ia", regra_id: "agente_ia", modelo: "claude-haiku-4-5", versao_prompt: "agente-operacao@1", acao: "lancar_ocorrencia", codigo: 22, texto: "Cliente vai retirar a carga na base", confianca: 0.64, motivo: "reentrega pedida para endereço da própria base", justificativa: "A reentrega foi pedida para retirada no balcão; nas notas parecidas a Operação lançou a 22." },
    unidade: "VGA", oc: 21, horasParado: 12, previsaoEmDias: 0 },
  { unidade: "POA", oc: 36, horasParado: 26, atrasoDias: 1,
    lancamento: { status: "erro", codigo: 15, texto: "", minutosAtras: 320, por: "juliana", categoria_erro: "expirado",
      detalhe: "ficou mais de 4 h na fila sem ir ao SSW (expirado). Nada foi lançado." } },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-37-veiculo", codigo: 36, texto: "Veículo substituto chegou à base", confianca: 0.67, casos: { n: 22, m: 33 }, motivo: "oc 37 resolvida com veículo substituto", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "BHZ", oc: 37, horasParado: 8, assumidoPor: "rafael" },
  { unidade: "VGA", oc: 13, horasParado: 44, atrasoDias: 2,
    lancamento: { status: "recusado", codigo: 37, texto: "", minutosAtras: 90, por: "rafael", categoria_erro: "tripe",
      detalhe: "o SSW mostrou localização ENTREGUE no tripé; o envelope não enviou" } },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-36-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje", confianca: 0.82, casos: { n: 41, m: 50 }, motivo: "oc 36 parada há mais de 48 h na base", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "POA", oc: 36, horasParado: 50, atrasoDias: 2 },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-15-volta-base", codigo: 36, texto: "Carga voltou para a base; nova tentativa programada", confianca: 0.74, casos: { n: 37, m: 50 }, motivo: "oc 15 seguida de nova chegada na base", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "BHZ", oc: 15, horasParado: 18, previsaoEmDias: -2 },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-37-janela", codigo: 39, texto: "Reagendar pela janela do cliente", confianca: 0.51, casos: { n: 18, m: 35 }, motivo: "oc 37 em cliente com janela", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "VGA", oc: 37, horasParado: 10 },
  { unidade: "POA", oc: 21, horasParado: 0.6, previsaoEmDias: 3 },
  { unidade: "BHZ", oc: 13, horasParado: 22, semNf: true },
  { unidade: "VGA", oc: 14, horasParado: 0.3, previsaoEmDias: 0 },
  { sugestao: { versao_contrato: 2, fonte: "agente_ia", base_regra: "agente_ia", regra_id: "agente_ia", modelo: "claude-haiku-4-5", versao_prompt: "agente-operacao@1", acao: "encaminhar_relacionamento", codigo: null, texto: "Endereço incompleto; confirmar com o cliente", confianca: 0.91, motivo: "falta de informação que só o cliente resolve", justificativa: "A instrução diz que falta o número do endereço; quem obtém isso é o Relacionamento com o cliente." },
    encaminhamentoAgendadoEmMin: 25,
    unidade: null, oc: 56, horasParado: 60, atrasoDias: 3 },
  { sugestao: { versao_contrato: 2, acao: "lancar_ocorrencia", fonte: "regra_aprendida", regra_id: "hist-37-veiculo", codigo: 36, texto: "Veículo substituto chegou à base", confianca: 0.67, casos: { n: 22, m: 33 }, motivo: "oc 37 resolvida com veículo substituto", base_regra: "histórico da Sal, abr–set/2026" },
    unidade: "POA", oc: 37, horasParado: 15, assumidoPor: "juliana", previsaoEmDias: 1 },
  // Redespacho (40): relógio de 2 dias — 1 dia (no prazo) e 3 dias (cobrar o parceiro).
  { unidade: "VGA", oc: 40, horasParado: 30, previsaoEmDias: 2 },
  { unidade: "BHZ", oc: 40, horasParado: 75, atrasoDias: 1 },
];

export function cidadeDe(unidade: string | null, i: number): string {
  const lista = CIDADES[unidade ?? "BHZ"] ?? CIDADES.BHZ!;
  return lista[i % lista.length]!;
}
export function pagadorDe(i: number): string {
  return PAGADORES[i % PAGADORES.length]!;
}
export function destinatarioDe(i: number): string {
  return `${DESTINATARIOS[(i * 3) % DESTINATARIOS.length]!} (fictício)`;
}
export function ctrcDe(unidade: string | null, i: number): string {
  const base = 401200 + i * 37;
  return `${unidade ?? "MTZ"}${base}-${(i * 7) % 10}`;
}
export function nfDe(i: number): string {
  return String(880100 + i * 113);
}

export type LancamentoDemo = OpLancamento;
