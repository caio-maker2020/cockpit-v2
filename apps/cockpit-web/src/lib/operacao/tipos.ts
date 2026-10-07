// =============================================================================
// Tipos da tela da Operação — espelho do contrato do ADR 0041 ("Contrato com o
// front"). Se a RPC mudar, mude AQUI e o typecheck acusa cada tela afetada.
// =============================================================================

export type PapelOp = "operador_op" | "supervisor_op";

export interface OpMembro {
  id: string;
  nome: string;
  email: string | null;
  papel_op: PapelOp;
  unidades: string[];
  pode_lancar: boolean;
}

export interface OpFlags {
  operacao_tela: boolean;
  operacao_lancar_ssw: boolean;
  operacao_fila: boolean;
}

/** `op_minha_sessao()`. Quem não é membro nem gestor recebe membro=null (sem flags). */
export interface OpSessao {
  membro: OpMembro | null;
  eh_gestor: boolean;
  eh_supervisor?: boolean;
  flags?: OpFlags;
}

export type StatusItemOp =
  | "aberto"
  | "assumido"
  | "lancamento_pendente"
  | "aguardando_confirmacao"
  | "encerrado";

export type StatusLancamentoOp =
  | "fila"
  | "lancando"
  | "lancado"
  | "confirmado"
  | "nao_confirmado"
  | "recusado"
  | "erro"
  | "cancelado";

/**
 * `op_itens.sugestao` (em sombra — ADR 0041 D6). Hoje vem da regra pura; as regras
 * geradas do histórico real da Sal acrescentam a confiança e os casos parecidos.
 * Tudo além de `codigo` é opcional: a tela lê o que vier (ver lib/operacao/sugestao.ts).
 */
export interface OpSugestao {
  codigo: number;
  texto?: string | null;
  regra_id?: string | null;
  motivo?: string | null;
  /** true só se o código está ATIVO na lista agora. false = só registro em sombra. */
  lancavel?: boolean;
  versao_regras?: string;
  /** 0–1 (ou 0–100): quão seguro a regra está. */
  confianca?: number | null;
  /** "A Sal fez isso em N de M casos parecidos": {n, m}, ou N com `casos_total`. */
  casos?: number | { n: number; m: number } | null;
  casos_total?: number | null;
  /** De onde a regra saiu (ex.: "histórico 2026-04..09, oc 36 parada > 48 h na base"). */
  base_regra?: string | null;
}

/** Uma linha de `op_v_fila`. */
export interface OpFilaLinha {
  op_item_id: string;
  ctrc: string;
  nf: string | null;
  unidade: string | null;
  status: StatusItemOp;
  cod_ultima_ocorrencia: number | null;
  descricao_oc: string | null;
  data_ultima_ocorrencia: string | null;
  instrucao_ultima_ocorrencia: string | null;
  pagador: string | null;
  destinatario: string | null;
  cidade_destino: string | null;
  uf_destino: string | null;
  previsao_entrega: string | null;
  atraso_original: number | null;
  qtd_volumes: number | null;
  assumido_por: string | null;
  assumido_por_nome: string | null;
  assumido_em: string | null;
  sugestao: OpSugestao | null;
  sugestao_em: string | null;
  lancamento_id: string | null;
  lancamento_status: StatusLancamentoOp | null;
  lancamento_codigo_oc: number | null;
  lancamento_solicitado_por_nome: string | null;
  lancamento_solicitado_em: string | null;
  /** Reescrito a CADA rodada do materializador: nunca use como relógio (INV-151). */
  materializado_em: string;
  updated_at: string;
}

export interface OpCodigo {
  codigo: number;
  descricao: string;
  exige_texto: boolean;
}

export interface OpEvento {
  id: number;
  op_item_id: string;
  tipo: string;
  ator_tipo: "membro_op" | "system";
  ator_id: string | null;
  ator_nome: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface OpLancamento {
  id: string;
  op_item_id: string;
  ctrc: string;
  nf: string | null;
  codigo_oc: number;
  texto_operador: string;
  texto_ssw: string;
  origem: "manual" | "sugestao";
  sugestao_regra_id: string | null;
  solicitado_por: string;
  solicitado_por_nome: string;
  solicitado_em: string;
  status: StatusLancamentoOp;
  reservado_em: string | null;
  lancado_em: string | null;
  protocolo: string | null;
  categoria_erro: string | null;
  detalhe: string | null;
  confirmado_em: string | null;
  confirmado_por: "bastao" | "ssw" | null;
  oc_vista_na_confirmacao: number | null;
  finalizado_em: string | null;
  atualizado_em: string;
}

/** `op_itens` como vem em `op_item_detalhe.item` (sem snapshot_hash/cnpj_pagador). */
export interface OpItem {
  id: string;
  ctrc: string;
  nf: string | null;
  unidade: string | null;
  status: StatusItemOp;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null;
  responsavel_atual: string | null;
  pagador: string | null;
  destinatario: string | null;
  cidade_destino: string | null;
  uf_destino: string | null;
  previsao_entrega: string | null;
  atraso_original: number | null;
  qtd_volumes: number | null;
  sugestao: OpSugestao | null;
  sugestao_em: string | null;
  assumido_por: string | null;
  assumido_por_nome: string | null;
  assumido_em: string | null;
  motivo_encerramento: string | null;
  encerrado_em: string | null;
  materializado_em: string;
  created_at: string;
  updated_at: string;
}

/** O que a prévia mostra e o que vai ao SSW — exatamente (ADR 0041 D7.1). */
export interface OpPrevia {
  op_item_id: string;
  ctrc: string;
  nf: string | null;
  unidade: string | null;
  oc_atual: number | null;
  codigo_oc: number;
  descricao_oc: string;
  texto_ssw: string;
  conta_ssw: string;
}

/** Códigos de erro do ADR 0041 + o de transporte (rede/servidor) do front. */
export type OpErroCodigo =
  | "nao_e_membro_da_operacao"
  | "lancamento_desligado"
  | "tela_desligada"
  | "sem_permissao_de_lancar"
  | "item_fechado"
  | "fora_da_sua_unidade"
  | "assumido_por_outro"
  | "tratativa_aberta_no_relacionamento"
  | "nota_finalizada"
  | "sem_nf_para_tripe"
  | "codigo_proibido"
  | "codigo_nao_permitido"
  | "texto_obrigatorio"
  | "texto_longo"
  | "ja_e_a_ultima_oc"
  | "lancamento_em_andamento"
  | "previa_desatualizada"
  | "sem_sugestao"
  | "nao_e_seu"
  | "ja_saiu_da_fila"
  | "nao_encontrado"
  | "falha_de_comunicacao";

export interface OpFalha {
  ok: false;
  erro: OpErroCodigo | string;
  motivo?: string;
  /** `assumido_por_outro` do op_assumir traz o nome. */
  assumido_por_nome?: string | null;
  /** `previa_desatualizada` traz a prévia nova e o token novo. */
  previa?: OpPrevia;
  confirmacao?: string;
  status?: string;
}

export type OpRespostaPrevia =
  | { ok: true; texto_ssw: string; confirmacao: string; previa: OpPrevia }
  | OpFalha;

export type OpRespostaSolicitar =
  | { ok: true; lancamento_id: string; status: "fila"; previa: OpPrevia }
  | OpFalha;

export type OpRespostaAssumir =
  | { ok: true; op_item_id: string; assumido_por: string; status: StatusItemOp; ja_era_seu?: boolean }
  | OpFalha;

export type OpRespostaCancelar =
  | { ok: true; lancamento_id: string; status: "cancelado" }
  | OpFalha;

export type OpRespostaDetalhe =
  | {
      ok: true;
      item: OpItem;
      descricao_oc: string | null;
      eventos: OpEvento[];
      lancamentos: OpLancamento[];
      codigos_disponiveis: OpCodigo[];
    }
  | OpFalha;
