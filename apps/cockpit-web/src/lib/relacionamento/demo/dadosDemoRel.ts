// Cards FICTÍCIOS para a demonstração do Relacionamento (nomes, NFs e CTRCs inventados).
// Cobrem todas as colunas do kanban e os sinais do card (cliente respondeu, robô vai agir,
// ação que falhou, ocorrência alterada, risco alto, sem chave do CT-e).
import type { CardInbox } from "../torre";
import type { CardState, CardTipo } from "@/lib/types";

const OC: Record<number, string> = {
  10: "Destinatário ausente",
  13: "Cliente recusou a entrega",
  19: "Endereço não localizado",
  21: "Reentrega solicitada pelo cliente",
  35: "Mercadoria avariada",
  9: "Extravio parcial",
  54: "Aguardando retorno do cliente",
  59: "Aguardando documentos de indenização",
  33: "Indenização aberta",
};

const CLIENTES = [
  "Farmácia Bem Viver",
  "Agro Campo Verde",
  "Distribuidora Monte Alto",
  "Casa & Lar Utilidades",
  "Vet Saúde Animal",
  "Construmais Materiais",
  "Papelaria Nova Era",
  "Ótica Visão Clara",
  "Mercado Boa Compra",
  "Auto Peças Estrada",
];
const OPERADORAS = ["Larissa", "Ingrid", "Karoline", "Maria"];

const h = (horas: number, base = Date.now()) => new Date(base - horas * 3_600_000).toISOString();

let seq = 0;
function card(p: {
  state: CardState;
  tipo: CardTipo;
  oc: number;
  horas: number;
  modo?: "humana" | "autonoma" | null;
  risco?: "alto" | "baixo";
  respondeu?: number;
  ia?: { oc: number; c: number; motivo: string };
  veto?: { status: "pendente" | "executando" | "processado"; emMin: number };
  falhou?: string;
  ocAlterada?: boolean;
  semChave?: boolean;
  pendentes?: number;
  executadaHa?: number;
  dono?: number | null;
}): CardInbox {
  seq++;
  const cliente = CLIENTES[seq % CLIENTES.length]!;
  const dono = p.dono === null ? null : OPERADORAS[(p.dono ?? seq) % OPERADORAS.length]!;
  return {
    id: `demo-rel-${seq}`,
    nf: String(410000 + seq * 137),
    ctrc: `VGA${(600000 + seq * 91).toString()}-${seq % 10}`,
    tipo_cte: seq % 9 === 0 ? "DEVOLUCAO" : "NORMAL",
    qtde_volumes: (seq % 6) + 1,
    canal_origem: seq % 3 === 0 ? "whatsapp" : "email",
    empresa_cliente: cliente,
    nome_cliente: null,
    pagador: cliente,
    base_destino: ["VGA", "BHZ", "POA", "MCU"][seq % 4]!,
    responsavel_relacionamento: dono,
    remetente_inicial: null,
    state: p.state,
    agent_state: { dias_atraso: Math.floor(p.horas / 24) },
    tipo: p.tipo,
    risco: p.risco ?? "baixo",
    assigned_agent: null,
    assigned_operator_id: dono ? `op-${dono}` : null,
    last_event_at: h(p.horas),
    created_at: h(p.horas + 30),
    updated_at: h(p.horas),
    cod_ultima_ocorrencia: p.oc,
    aprovacao_modo: p.modo ?? null,
    lock_aguardando_validacao: false,
    aviso_alteracao_oc: p.ocAlterada ? { oc_anterior: 10, oc_atual: p.oc, alterada_em: h(3) } : null,
    acao_falhou_motivo: p.falhou ?? null,
    sem_chave_cte: p.semChave ?? false,
    ia_sugestao_oc_resposta: p.ia
      ? { oc_sugerida: p.ia.oc, confianca: p.ia.c, motivo: p.ia.motivo, sugerido_em: h(1) }
      : null,
    acao_autonoma: p.veto
      ? {
          agendamento_id: seq,
          acao_key: "lancar_oc",
          executar_em: new Date(Date.now() + p.veto.emMin * 60_000).toISOString(),
          status: p.veto.status,
          hash_proposta: null,
          processed_at: p.veto.status === "processado" ? h(0.3) : null,
          cancelado_motivo: null,
        }
      : null,
    cliente_respondeu_em: p.respondeu != null ? h(p.respondeu) : null,
    acao_executada_em: p.executadaHa != null ? h(p.executadaHa) : null,
    bastao_data_ultima_ocorrencia: h(p.horas).slice(0, 10),
    operador: dono ? { nome: dono, papel: "operador" as never } : null,
    ocorrencia: { descricao: OC[p.oc] ?? `Ocorrência ${p.oc}`, responsabilidade: "Relacionamento" },
    pendentes_count: p.pendentes ?? 0,
  } as unknown as CardInbox;
}

export function cardsDemoRel(): CardInbox[] {
  seq = 0;
  const AVH: CardState = "AGUARDANDO_VALIDACAO_HUMANA";
  return [
    card({ state: AVH, tipo: "reentrega", oc: 13, horas: 52, risco: "alto", pendentes: 1, ia: { oc: 21, c: 0.92, motivo: "Cliente pediu nova tentativa amanhã de manhã." } }),
    card({ state: AVH, tipo: "reentrega", oc: 10, horas: 30, pendentes: 1, ia: { oc: 21, c: 0.71, motivo: "Destinatário ausente pela segunda vez." } }),
    card({ state: AVH, tipo: "devolucao", oc: 13, horas: 76, pendentes: 2, ia: { oc: 54, c: 0.58, motivo: "Recusa sem motivo claro; perguntar ao remetente." }, ocAlterada: true }),
    card({ state: AVH, tipo: "avaria", oc: 35, horas: 20, risco: "alto", pendentes: 1, ia: { oc: 33, c: 0.88, motivo: "Fotos confirmam avaria; abrir indenização." } }),
    card({ state: AVH, tipo: "rastreamento", oc: 19, horas: 8, pendentes: 1, ia: { oc: 21, c: 0.67, motivo: "Endereço corrigido pelo cliente no e-mail." } }),
    card({ state: AVH, tipo: "extravio", oc: 9, horas: 110, risco: "alto", pendentes: 1, falhou: "SSW recusou: CTRC bloqueado para lançamento." }),
    card({ state: AVH, tipo: "reentrega", oc: 13, horas: 14, pendentes: 1, ia: { oc: 21, c: 0.95, motivo: "Agendado com o recebedor para quinta." } }),
    card({ state: AVH, tipo: "cobranca", oc: 10, horas: 40, pendentes: 1, semChave: true, ia: { oc: 54, c: 0.62, motivo: "Cliente cobrou duas vezes; notificar o remetente." } }),
    card({ state: AVH, tipo: "outros", oc: 19, horas: 5, pendentes: 1 }),
    card({ state: AVH, tipo: "reentrega", oc: 54, horas: 26, respondeu: 2, ia: { oc: 21, c: 0.9, motivo: "Cliente autorizou a reentrega." } }),
    card({ state: AVH, tipo: "avaria", oc: 59, horas: 70, respondeu: 5, risco: "alto", ia: { oc: 33, c: 0.83, motivo: "Romaneio e nota de débito anexados." } }),
    card({ state: AVH, tipo: "devolucao", oc: 54, horas: 33, respondeu: 1, ia: { oc: 13, c: 0.6, motivo: "Cliente pede devolução ao remetente." } }),
    card({ state: AVH, tipo: "reentrega", oc: 10, horas: 9, modo: "autonoma", veto: { status: "pendente", emMin: 18 } }),
    card({ state: AVH, tipo: "rastreamento", oc: 19, horas: 6, modo: "autonoma", veto: { status: "pendente", emMin: 42 } }),
    card({ state: AVH, tipo: "reentrega", oc: 13, horas: 12, modo: "autonoma", veto: { status: "pendente", emMin: 95 } }),
    card({ state: "ACAO_EXECUTADA", tipo: "reentrega", oc: 21, horas: 1, modo: "autonoma", veto: { status: "processado", emMin: -20 }, executadaHa: 0.3 }),
    card({ state: "AGUARDANDO_AGENTE", tipo: "rastreamento", oc: 19, horas: 2 }),
    card({ state: "EM_TRIAGEM", tipo: "outros", oc: 10, horas: 1 }),
    card({ state: "AGUARDANDO_CONTEXTO", tipo: "devolucao", oc: 13, horas: 3 }),
    card({ state: "AGUARDANDO_AGENTE", tipo: "avaria", oc: 35, horas: 4, risco: "alto" }),
    card({ state: "AGUARDANDO_VINCULACAO", tipo: "cobranca", oc: 10, horas: 6, dono: null }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "reentrega", oc: 54, horas: 28 }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "devolucao", oc: 54, horas: 50 }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "avaria", oc: 59, horas: 96, risco: "alto" }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "extravio", oc: 59, horas: 140 }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "reentrega", oc: 54, horas: 18 }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "cobranca", oc: 54, horas: 22 }),
    card({ state: "ACAO_EXECUTADA", tipo: "reentrega", oc: 21, horas: 3, modo: "humana", executadaHa: 2 }),
    card({ state: "ACAO_EXECUTADA", tipo: "avaria", oc: 33, horas: 5, modo: "humana", executadaHa: 4.5 }),
    card({ state: "ACAO_EXECUTADA", tipo: "devolucao", oc: 13, horas: 7, modo: "humana", executadaHa: 6 }),
    card({ state: "AGUARDANDO_CLIENTE", tipo: "reentrega", oc: 21, horas: 9, modo: "humana" }),
    card({ state: "EXECUTANDO_ACAO", tipo: "rastreamento", oc: 21, horas: 1, modo: "humana" }),
  ];
}

export const OC_DEMO = OC;
