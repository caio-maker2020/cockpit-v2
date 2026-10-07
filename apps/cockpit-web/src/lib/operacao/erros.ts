// =============================================================================
// Mensagens humanas para os códigos de erro do ADR 0041. A pessoa da Operação
// nunca vê "codigo_nao_permitido": vê o que aconteceu e o que fazer.
// Guard: erros.test.ts confere que TODO código do ADR tem mensagem aqui.
// =============================================================================
import type { OpErroCodigo, OpFalha } from "./tipos";

/** Lista literal do ADR 0041 ("Erros possíveis"), na ordem do documento. */
export const ERROS_ADR_0041: readonly OpErroCodigo[] = [
  "nao_e_membro_da_operacao",
  "lancamento_desligado",
  "tela_desligada",
  "sem_permissao_de_lancar",
  "item_fechado",
  "fora_da_sua_unidade",
  "assumido_por_outro",
  "tratativa_aberta_no_relacionamento",
  "nota_finalizada",
  "sem_nf_para_tripe",
  "codigo_proibido",
  "codigo_nao_permitido",
  "texto_obrigatorio",
  "texto_longo",
  "ja_e_a_ultima_oc",
  "lancamento_em_andamento",
  "previa_desatualizada",
  "sem_sugestao",
  "nao_e_seu",
  "ja_saiu_da_fila",
  "nao_encontrado",
];

const MENSAGENS: Record<OpErroCodigo, string> = {
  nao_e_membro_da_operacao: "Só membros ativos da Operação podem fazer isso.",
  lancamento_desligado: "O lançamento pela Operação está desligado agora. Nada foi enviado ao SSW.",
  tela_desligada: "A tela da Operação está desligada agora.",
  sem_permissao_de_lancar: "Seu acesso é só de leitura: você vê a fila, mas ainda não lança ocorrências.",
  item_fechado: "Este item saiu da fila. A lista foi atualizada.",
  fora_da_sua_unidade: "Este item é de outra unidade.",
  assumido_por_outro: "Outra pessoa já assumiu este item.",
  tratativa_aberta_no_relacionamento:
    "A nota tem tratativa aberta no Relacionamento. A Operação não lança por cima.",
  nota_finalizada: "A nota está finalizada ou em ocorrência documental. Não há o que lançar.",
  sem_nf_para_tripe:
    "O item está sem NF. Sem a NF não dá para conferir CTRC + NF + localização no SSW antes de lançar.",
  codigo_proibido: "A Operação nunca lança este código.",
  codigo_nao_permitido: "Este código não está na lista liberada para a Operação.",
  texto_obrigatorio: "Este código exige o seu texto, com pelo menos 10 caracteres.",
  texto_longo: "O texto passou de 400 caracteres. Encurte e veja a prévia de novo.",
  ja_e_a_ultima_oc: "Esta já é a última ocorrência da nota. Lançar de novo não muda nada.",
  lancamento_em_andamento: "Já existe um lançamento deste item em andamento. Espere ele terminar ou cancele.",
  previa_desatualizada:
    "O que seria lançado mudou desde a prévia. Confira a prévia nova antes de confirmar.",
  sem_sugestao: "Este item não tem mais sugestão.",
  nao_e_seu: "Só quem pediu o lançamento, ou um supervisor, pode cancelar.",
  ja_saiu_da_fila: "O lançamento já saiu da fila e foi para o SSW. Não dá mais para cancelar.",
  nao_encontrado: "Item não encontrado, ou fora do seu acesso.",
  falha_de_comunicacao: "Não deu para falar com o servidor. Nada foi lançado. Tente de novo em instantes.",
};

export function temMensagemOp(codigo: string): codigo is OpErroCodigo {
  return Object.prototype.hasOwnProperty.call(MENSAGENS, codigo);
}

/** Mensagem humana para uma falha de RPC da Operação. Código desconhecido não some calado. */
export function mensagemErroOp(falha: Pick<OpFalha, "erro" | "assumido_por_nome" | "status">): string {
  const { erro } = falha;
  if (erro === "assumido_por_outro" && falha.assumido_por_nome) {
    return `${falha.assumido_por_nome} já assumiu este item.`;
  }
  if (temMensagemOp(erro)) return MENSAGENS[erro];
  return `Não deu para concluir (${erro}). Nada foi lançado.`;
}
