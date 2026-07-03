// Tipos do schema do Supabase usado pelo Cockpit v2.
// Mantidos manualmente até gerar via supabase gen types.

export type CardState =
  | "RECEBIDO"
  | "EM_TRIAGEM"
  | "AGUARDANDO_VINCULACAO"
  | "AGUARDANDO_CONTEXTO"
  | "AGUARDANDO_AGENTE"
  | "EM_EXECUCAO_AUTOMATICA"
  | "AGUARDANDO_VALIDACAO_HUMANA"
  | "EXECUTANDO_ACAO"
  | "ACAO_EXECUTADA"
  | "AGUARDANDO_CLIENTE"
  | "AGUARDANDO_TERCEIRO"
  | "BLOQUEADO_POR_ERRO"
  | "ESCALADO_HUMANO"
  | "TRANSFERIDO"
  | "TRATATIVA_PENDENTE"
  | "RESOLVIDO"
  | "CANCELADO";

export const ALL_STATES: CardState[] = [
  "RECEBIDO",
  "EM_TRIAGEM",
  "AGUARDANDO_VINCULACAO",
  "AGUARDANDO_CONTEXTO",
  "AGUARDANDO_AGENTE",
  "EM_EXECUCAO_AUTOMATICA",
  "AGUARDANDO_VALIDACAO_HUMANA",
  "EXECUTANDO_ACAO",
  "ACAO_EXECUTADA",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_TERCEIRO",
  "BLOQUEADO_POR_ERRO",
  "ESCALADO_HUMANO",
  "TRANSFERIDO",
  "TRATATIVA_PENDENTE",
  "RESOLVIDO",
  "CANCELADO",
];

export const DEFAULT_STATE_FILTER: CardState[] = ALL_STATES.filter(
  (s) => s !== "RESOLVIDO" && s !== "CANCELADO" && s !== "TRANSFERIDO",
);

export type CardTipo =
  | "rastreamento"
  | "reentrega"
  | "devolucao"
  | "avaria"
  | "extravio"
  | "inversao"
  | "cobranca"
  | "outros";

export const ALL_TIPOS: CardTipo[] = [
  "rastreamento",
  "reentrega",
  "devolucao",
  "avaria",
  "extravio",
  "inversao",
  "cobranca",
  "outros",
];

export type CardRisco = "alto" | "baixo";
export type CanalOrigem = "whatsapp" | "email" | "sistema";
export type ActorType = "agent" | "operator" | "system";
export type TodoStatus =
  | "pendente"
  | "aprovado"
  | "executando"
  | "executado"
  | "rejeitado"
  | "falhou"
  | "expirado"
  | "enviando"
  | "enviado";
export type Papel = "operador" | "gestor";
export type AprovacaoModo = "humana" | "autonoma";

export interface OperadorRow {
  id: string;
  user_id: string;
  nome: string;
  email: string;
  papel: Papel;
  carteira: string[] | null;
  ativo: boolean;
}

export interface CardRow {
  id: string;
  nf: string | null;
  ctrc: string | null;
  tipo_cte: string | null;
  qtde_volumes: number | null;
  canal_origem: CanalOrigem | null;
  empresa_cliente: string | null;
  nome_cliente: string | null;
  pagador: string | null;
  base_destino: string | null;
  responsavel_relacionamento: string | null;
  remetente_inicial: string | null;
  state: CardState;
  agent_state: Record<string, unknown> | null;
  tipo: CardTipo | null;
  risco: CardRisco | null;
  assigned_agent: string | null;
  assigned_operator_id: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
  cod_ultima_ocorrencia: number | null;
  aprovacao_modo: AprovacaoModo | null;
  lock_aguardando_validacao: boolean | null;
  aviso_alteracao_oc: {
    oc_anterior: number | null;
    oc_atual: number | null;
    alterada_em: string;
    alerta_caixa_lacrada?: boolean | null;
    alerta_caixa_lacrada_motivo?: string | null;
    evidencia_foto_url?: string | null;
    // Campos compartilhados com sugestões IA (oc=13/oc=49/ocs padrão)
    tipo?: string | null;
    codigo_oc_card?: number | null;
    proposta_destacada?: number | null;
    template_email_sugerido?: string | null;
    motivo_extraido?: string | null;
    confianca?: number | null;
    observacao_orquestrador?: string | null;
    observacao?: string | null;
    // === Específicos oc=49 ===
    caso_oc49?:
      | "extravio_total"
      | "extravio_parcial"
      | "extravio_sem_qtd"
      | "cobranca_retorno"
      | "devolucao_pos_56"
      | "nao_reconhecido"
      | null;
    qtd_volumes_extraviados?: number | null;
    qtd_volumes_nf?: number | null;
    cobrada_no_wpp?: boolean | null;
    cobrada_em?: string | null;
    acao_lateral?: "cobrar_retorno_mesma_thread" | null;
    thread_id_alvo?: string | null;
    texto_prefixo_sugerido?: string | null;
    cod_ocorrencia_para_token?: number | null;
    // === Recusa originada de extravio (oc 10/19/35 após oc 6/9/16) ===
    contexto_recusa_por_extravio?: boolean | null;
    extravio_anterior_oc?: number | null;
    extravio_anterior_data?: string | null;
  } | null;
  acao_falhou_motivo: string | null;
  sem_chave_cte: boolean | null;
  ia_sugestao_oc_resposta: {
    oc_sugerida: number;
    confianca: number;
    motivo: string;
    sugerido_em: string;
    instrucao_reentrega_sugerida?: string;
    pendencias_resposta_cliente?: string[];
    sugere_combo_33_44?: boolean;
    sugere_oc33_solo?: boolean;
    motivo_combo?: string;
    contexto?: "cobrou_antes_notificacao" | string | null;
    titulo?: string | null;
    acao_tool?: string | null;
    acao_codigo_ssw?: number | null;
    template_email_sugerido?: string | null;
  } | null;

  cliente_respondeu_em: string | null;
  ultimo_bounce_em?: string | null;
  ultimo_bounce_payload?: {
    destinatario?: string | null;
    motivo_smtp?: string | null;
    gmail_message_id?: string;
    subject_original?: string;
    detectado_em?: string;
  } | null;
  acao_executada_em?: string | null;
  bastao_data_ultima_ocorrencia?: string | null;
  historico_ssw?: HistoricoSswOcorrencia[] | null;
  historico_ssw_atualizado_em?: string | null;
  // Agente IA oc=13 (TODO_REMOVER_QUANDO_VALIDADO se virar permanente)
  analise_oc13_status?: "pendente" | "analisando" | "concluida" | "falhou" | null;
  analise_oc13_tentativas?: number | null;
  analise_oc13_resultado?: {
    decisao?: "autonoma" | "sugerir_54_email" | "sugerir_21_cancel" | "sugerir_56" | "operador_antecipou";
    subtipo?: string;
    motivo_extraido?: string | null;
    motivo_cancelamento?: string;
    texto_descricao?: string;
    foto_classificacao?: "destinatario" | "local_fechado" | "aleatoria" | "sem_foto" | "ilegivel";
    confianca?: number;
    template_email_sugerido?: string;
    todo_id?: string;
    erro_msg?: string;
    categoria?: string;
    tentativa?: number;
    max_tentativas?: number;
  } | null;
  // Agente IA ocs padrão 10/11/19/35 (TODO_REMOVER_QUANDO_VALIDADO)
  analise_padrao_status?: "pendente" | "analisando" | "concluida" | "falhou" | null;
  analise_padrao_tentativas?: number | null;
  analise_padrao_resultado?: {
    proposta_destacada?: 54 | 56;
    template_email_sugerido?:
      | "RECUSA_TOTAL"
      | "RECUSA_PARCIAL"
      | "FALTA_DE_VOLUME"
      | "PROBLEMAS_COM_ENDERECO"
      | null;
    corpo_email_sugerido?: string | null;
    motivo_extraido?: string | null;
    foto_classificacao?: string | null;
    tem_ressalva?: boolean;
    ressalva_texto?: string | null;
    ressalva_tipo?: "motivo_recusa" | "falta_volumes" | "endereco_errado" | "outro" | null;
    gps_distancia_metros?: number | null;
    gps_dentro_threshold?: boolean | null;
    tem_cte_devolucao?: boolean | null;
    cte_devolucao_numero?: string | null;
    confianca?: number;
    observacao_orquestrador?: string;
    erro_msg?: string;
    categoria?: string;
    tentativa?: number;
    max_tentativas?: number;
  } | null;
  // Evidências ricas por código da ocorrência (chave = String(cod_oc)).
  // Populado pelo agente oc=13 (e similares) — contém análise da foto.
  ia_sugestao_evidencia?: Record<
    string,
    {
      analise?: {
        resumo_situacao?: string | null;
        ressalva_texto?: string | null;
        descricao_imagem?: string | null;
        confianca?: number | null;
      } | null;
    } | null
  > | null;
  // Agente "relançar 54 por ressarcimento" (round-trip 54 → 46 → 49)
  ressarc54_status?: "recomendado" | "lancou" | "nao_rodou" | "nao_aplica" | null;
  ressarc54_tier?: "A" | "B" | null;
  ressarc54_motivo?: string | null;
  ressarc54_checado_em?: string | null;
}


export interface HistoricoSswOcorrencia {
  codigo: number | null;
  descricao: string;
  instrucao: string;
  data: string;
  filial: string | null;
  usuario: string | null;
  tem_foto: boolean;
}

export type Responsabilidade =
  | "Operação"
  | "Relacionamento"
  | "Cliente"
  | "Perdas"
  | "Ressarcimento"
  | "Devolução"
  | "Agendamento";

export interface OcorrenciaDicionarioRow {
  codigo: number;
  descricao: string;
  responsabilidade: Responsabilidade | string | null;
}

/** Card enriquecido com JOINs feitos via PostgREST embed. */
export interface CardWithRelations extends CardRow {
  operador: { nome: string; papel: Papel } | null;
  ocorrencia: { descricao: string; responsabilidade: string | null } | null;
}

/** Mapeamento card → coluna do Kanban (filtros compostos por state + aprovacao_modo + lock). */
export type KanbanColumnId =
  | "para_fazer"
  | "validacao"
  | "cliente_respondeu"
  | "acao_executada"
  | "cliente"
  | "executada"
  | "autonoma"
  | "tratativa";

export type KanbanVariant =
  | "todo"
  | "critical"
  | "responded"
  | "waiting"
  | "executed"
  | "pending_bastao"
  | "auto"
  | "alert";

export interface KanbanColumnDef {
  id: KanbanColumnId;
  variant: KanbanVariant;
  title: string;
  /** Filtro lógico aplicado client-side (espelha o filtro server-side da spec). */
  match: (
    c: Pick<
      CardRow,
      "state" | "aprovacao_modo" | "lock_aguardando_validacao" | "cliente_respondeu_em" | "cod_ultima_ocorrencia"
    >,
  ) => boolean;

}

/** States que somem do Kanban principal (mas aparecem em /resolvidos / histórico). */
const HIDDEN_FROM_KANBAN: CardState[] = ["TRANSFERIDO", "RESOLVIDO", "CANCELADO"];

export const KANBAN_COLUMNS: KanbanColumnDef[] = [
  {
    id: "para_fazer",
    variant: "todo",
    title: "Para fazer",
    match: (c) =>
      c.aprovacao_modo == null &&
      c.lock_aguardando_validacao !== true &&
      ["AGUARDANDO_AGENTE", "AGUARDANDO_CONTEXTO", "AGUARDANDO_VINCULACAO", "EM_TRIAGEM"].includes(
        c.state,
      ),
  },
  {
    id: "validacao",
    variant: "critical",
    title: "Aguardando você",
    // oc≠54 respondida volta pra AGUARDANDO VOCÊ (badge cliente-respondeu segue no card).
    match: (c) =>
      c.state === "AGUARDANDO_VALIDACAO_HUMANA" &&
      (c.cliente_respondeu_em == null || c.cod_ultima_ocorrencia !== 54),
  },
  {
    id: "cliente_respondeu",
    variant: "responded",
    title: "Cliente respondeu",
    // Só oc=54 (fluxo "notifiquei, aguardo retorno") entra aqui.
    match: (c) =>
      c.state === "AGUARDANDO_VALIDACAO_HUMANA" &&
      c.cliente_respondeu_em != null &&
      c.cod_ultima_ocorrencia === 54,
  },

  {
    id: "acao_executada",
    variant: "pending_bastao",
    title: "Ação executada",
    match: (c) => c.state === "ACAO_EXECUTADA",
  },
  {
    id: "cliente",
    variant: "waiting",
    title: "Aguardando cliente",
    match: (c) => c.state === "AGUARDANDO_CLIENTE" && c.lock_aguardando_validacao !== true,
  },
  {
    id: "executada",
    variant: "executed",
    title: "Ação confirmada",
    match: (c) =>
      c.aprovacao_modo === "humana" &&
      c.state !== "ACAO_EXECUTADA" &&
      !HIDDEN_FROM_KANBAN.includes(c.state),
  },
  {
    id: "autonoma",
    variant: "auto",
    title: "Ação autônoma",
    match: (c) =>
      c.aprovacao_modo === "autonoma" && !HIDDEN_FROM_KANBAN.includes(c.state),
  },
];

export interface CardEventRow {
  id: string;
  card_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown> | null;
  actor_type: ActorType;
  actor_id: string | null;
  created_at: string;
}

export interface MessageInboxRow {
  id: string;
  card_id: string | null;
  canal: CanalOrigem;
  remetente: string;
  conteudo: string;
  recebido_em: string;
  processed_at: string | null;
  processing_status: string | null;
}

export interface TodoRow {
  id: string;
  card_id: string;
  action_id: string;
  descricao: string;
  proposta_payload: Record<string, unknown> | null;
  status: TodoStatus;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  auto_approval_rule: string | null;
  created_at: string;
}
