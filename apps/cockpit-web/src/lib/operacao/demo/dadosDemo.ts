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
  39: "Entrega impossib: problemas com janela",
  56: "Falta de informação operacional ou indevida",
};

/** Os códigos "liberados" na demo (na vida real a lista nasce vazia — ADR 0041 D5). */
export const CODIGOS_DEMO: OpCodigo[] = [
  { codigo: 14, descricao: DESCRICOES_OC[14]!, exige_texto: false },
  { codigo: 15, descricao: DESCRICOES_OC[15]!, exige_texto: false },
  { codigo: 36, descricao: DESCRICOES_OC[36]!, exige_texto: false },
  { codigo: 37, descricao: DESCRICOES_OC[37]!, exige_texto: false },
  { codigo: 56, descricao: DESCRICOES_OC[56]!, exige_texto: true },
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
  sugestao?: Omit<OpSugestao, "versao_regras">;
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

/** 25 itens: mistura de unidade, oc, tempo parado, sugestão e status de lançamento. */
export const SEMENTES: ItemSemente[] = [
  { unidade: "VGA", oc: 13, horasParado: 75, atrasoDias: 3 },
  { unidade: "VGA", oc: 36, horasParado: 52, atrasoDias: 2,
    sugestao: { regra_id: "demo-36-parado-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje",
      motivo: "Chegou na base e está parada há mais de 48 h", lancavel: true } },
  { unidade: "POA", oc: 13, horasParado: 30, previsaoEmDias: -1,
    lancamento: { status: "fila", codigo: 14, texto: "", minutosAtras: 6, por: "juliana" } },
  { unidade: "BHZ", oc: 21, horasParado: 6, previsaoEmDias: 1 },
  { unidade: "VGA", oc: 15, horasParado: 28, assumidoPor: "rafael", atrasoDias: 1 },
  { unidade: "POA", oc: 37, horasParado: 4, previsaoEmDias: 0,
    lancamento: { status: "lancado", codigo: 36, texto: "Veículo substituto chegou à base", minutosAtras: 40, por: "juliana" } },
  { unidade: "BHZ", oc: 36, horasParado: 49,
    sugestao: { regra_id: "demo-36-parado-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje",
      motivo: "Chegou na base e está parada há mais de 48 h", lancavel: true } },
  { unidade: "VGA", oc: 56, horasParado: 2, previsaoEmDias: 2 },
  { unidade: "POA", oc: 14, horasParado: 3,
    lancamento: { status: "confirmado", codigo: 14, texto: "", minutosAtras: 130, por: "juliana" } },
  { unidade: "BHZ", oc: 13, horasParado: 96, atrasoDias: 5 },
  { unidade: "VGA", oc: 37, horasParado: 20, cardAtivoNoRelacionamento: true, atrasoDias: 1 },
  { unidade: "POA", oc: 15, horasParado: 33,
    lancamento: { status: "nao_confirmado", codigo: 36, texto: "", minutosAtras: 300, por: "juliana",
      detalhe: "o SSW mostrou outra oc depois do lançamento; uma pessoa precisa conferir" } },
  { unidade: "BHZ", oc: 14, horasParado: 1, previsaoEmDias: 1 },
  { unidade: "VGA", oc: 21, horasParado: 12, previsaoEmDias: 0 },
  { unidade: "POA", oc: 36, horasParado: 26, atrasoDias: 1,
    lancamento: { status: "erro", codigo: 15, texto: "", minutosAtras: 320, por: "juliana", categoria_erro: "expirado",
      detalhe: "ficou mais de 4 h na fila sem ir ao SSW (expirado). Nada foi lançado." } },
  { unidade: "BHZ", oc: 37, horasParado: 8, assumidoPor: "rafael" },
  { unidade: "VGA", oc: 13, horasParado: 44, atrasoDias: 2,
    lancamento: { status: "recusado", codigo: 37, texto: "", minutosAtras: 90, por: "rafael", categoria_erro: "tripe",
      detalhe: "o SSW mostrou localização ENTREGUE no tripé; o envelope não enviou" } },
  { unidade: "POA", oc: 36, horasParado: 50, atrasoDias: 2,
    sugestao: { regra_id: "demo-36-parado-48h", codigo: 15, texto: "Base sem janela de entrega para a cidade hoje",
      motivo: "Chegou na base e está parada há mais de 48 h", lancavel: true } },
  { unidade: "BHZ", oc: 15, horasParado: 18, previsaoEmDias: -2 },
  { unidade: "VGA", oc: 37, horasParado: 10,
    sugestao: { regra_id: "demo-37-veiculo", codigo: 39, texto: "Reagendar pela janela do cliente",
      motivo: "Problema no veículo há mais de 8 h", lancavel: false } },
  { unidade: "POA", oc: 21, horasParado: 0.6, previsaoEmDias: 3 },
  { unidade: "BHZ", oc: 13, horasParado: 22, semNf: true },
  { unidade: "VGA", oc: 14, horasParado: 0.3, previsaoEmDias: 0 },
  { unidade: null, oc: 56, horasParado: 60, atrasoDias: 3 },
  { unidade: "POA", oc: 37, horasParado: 15, assumidoPor: "juliana", previsaoEmDias: 1 },
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
