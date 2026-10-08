// =============================================================================
// Separação Relacionamento × Operação na TELA (ADR 0041 D2, INV-180).
// Decisão do dono: "Relacionamento não precisa aparecer para a Operação, nem
// vice-versa." Só o gestor vê os dois.
//
// Isto decide só o que a UI mostra; o muro de verdade é a RLS (migs 430/431).
// FAIL-OPEN para o Relacionamento: se `op_minha_sessao` falhar (mig 430 ainda
// não aplicada, rede), a sessão vem null e quem usa o Cockpit hoje continua
// exatamente como está.
// =============================================================================
import type { OpSessao } from "./tipos";

export interface EntradaAreas {
  /** Linha em `operadores` (null = não é do Relacionamento, ou ainda carregando). */
  operador: { papel: string } | null;
  operadorCarregado: boolean;
  sessao: OpSessao | null;
  sessaoCarregada: boolean;
}

export interface Areas {
  /** Ainda não dá para decidir (não redirecionar nem mostrar nada sensível). */
  carregando: boolean;
  /** Ainda não dá para decidir o acesso à Operação (espera a sessão da Operação). */
  carregandoOperacao: boolean;
  ehGestor: boolean;
  ehMembroOp: boolean;
  /** Vê as rotas e menus do Relacionamento (Inbox, cards, extravios…). */
  veRelacionamento: boolean;
  /** Pode abrir /operacao (membro ativo ou gestor). Com a tela desligada a página diz isso. */
  podeAbrirOperacao: boolean;
  /** O item "Operação" aparece no menu: membro/gestor E flags.operacao_tela. */
  menuOperacao: boolean;
  telaLigada: boolean;
}

export function decidirAreas(e: EntradaAreas): Areas {
  const ehMembroOp = !!e.sessao?.membro;
  const ehGestor = e.operador?.papel === "gestor" || !!e.sessao?.eh_gestor;
  const telaLigada = !!e.sessao?.flags?.operacao_tela;
  const estaEmOperadores = e.operador != null;

  // Quem está em `operadores` é do Relacionamento — decide na hora, sem esperar a sessão da Operação.
  const carregando = !estaEmOperadores && (!e.operadorCarregado || !e.sessaoCarregada);

  // Fora de `operadores`: só perde o Relacionamento quem é membro ativo da Operação.
  // Ninguém em nenhuma das duas tabelas segue como hoje (a RLS mostra vazio).
  const veRelacionamento = estaEmOperadores || (!carregando && !ehMembroOp);
  const podeAbrirOperacao = ehMembroOp || ehGestor;

  return {
    carregando,
    carregandoOperacao: !e.sessaoCarregada || !e.operadorCarregado,
    ehGestor,
    ehMembroOp,
    veRelacionamento,
    podeAbrirOperacao,
    menuOperacao: podeAbrirOperacao && telaLigada,
    telaLigada,
  };
}

/** Prefixos das rotas da Operação (o resto do app é Relacionamento). */
export const ROTA_OPERACAO = "/operacao";
