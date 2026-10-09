// =============================================================================
// Itens da navegação do header (desktop): QUEM vê O QUÊ, em um lugar só e testado.
// Espelha exatamente as condições do header anterior (rotas, contadores e
// permissões iguais); só a apresentação mudou: trabalho à vista, gestão num menu.
// =============================================================================
export type ChaveContador = "inbox" | "conflitos" | "reentregas";

export interface ItemNav {
  to: string;
  rotulo: string;
  contador?: ChaveContador;
  /** Contador em vermelho (pede ação). */
  critica?: boolean;
  /** Grupo dentro do menu: "gestao" (do gestor) ou "sistema" (o antigo "Mais"). */
  grupo?: "gestao" | "sistema";
}

export interface QuemVe {
  /** veRelacionamento (ADR 0041 D2). */
  rel: boolean;
  /** operadores.papel === 'gestor' (useIsGestor). */
  isGestor: boolean;
  /** Tem linha em `operadores`. */
  temOperador: boolean;
  isAdmin: boolean;
  vePdi: boolean;
  /** areas.menuOperacao. */
  menuOperacao: boolean;
  /** Gestor com o seletor Operação | Relacionamento (substitui a pílula "Operação"). */
  hub: boolean;
}

export interface Navegacao {
  /** À vista (os que não couberem vão para o menu, sem sumir). */
  trabalho: ItemNav[];
  /** No menu "Gestão" (ou "Mais" para quem não é gestor). */
  menu: ItemNav[];
  rotuloMenu: "Gestão" | "Mais";
}

export function itensNavegacao(q: QuemVe): Navegacao {
  const trabalho: ItemNav[] = [];
  const menu: ItemNav[] = [];
  if (q.menuOperacao && !q.hub) trabalho.push({ to: "/operacao", rotulo: "Operação" });
  if (q.rel) {
    trabalho.push(
      { to: "/inbox", rotulo: "Inbox", contador: "inbox" },
      { to: "/conflitos", rotulo: "Conflitos", contador: "conflitos", critica: true },
      { to: "/extravios", rotulo: "Extravios" },
      { to: "/cancelamentos-reentrega", rotulo: "Reentregas", contador: "reentregas", critica: true },
    );
    if (!q.isGestor && q.temOperador) trabalho.push({ to: "/seu-dashboard", rotulo: "Seu Dashboard" });
    if (q.isGestor) {
      menu.push(
        { to: "/gestao-agentes", rotulo: "Gestão Agentes", grupo: "gestao" },
        { to: "/gestao-operadores", rotulo: "Gestão Operadores", grupo: "gestao" },
        { to: "/aprendizado", rotulo: "Aprendizado", grupo: "gestao" },
      );
    }
    if (q.vePdi) menu.push({ to: "/pdi-isadora", rotulo: "Plano de Desenvolvimento", grupo: "gestao" });
    menu.push(
      { to: "/auditoria", rotulo: "Auditoria", grupo: "sistema" },
      { to: "/cadastros", rotulo: "Cadastros", grupo: "sistema" },
      { to: "/configuracoes", rotulo: "Configurações", grupo: "sistema" },
    );
    if (q.isAdmin) menu.push({ to: "/administracao", rotulo: "Administração", grupo: "sistema" });
  }
  return { trabalho, menu, rotuloMenu: q.isGestor ? "Gestão" : "Mais" };
}

/** Rota ativa (mesma regra do NavLink: /inbox exato, o resto por prefixo). */
export function rotaAtiva(to: string, pathname: string): boolean {
  if (to === "/inbox") return pathname === "/inbox";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Overflow: quantos itens de trabalho cabem em `largura`, reservando o botão do menu.
 * Ordem preservada; o que não couber vai para o menu (nunca some).
 */
export function quantosCabem(larguras: readonly number[], largura: number, larguraMenu: number, folga = 4): number {
  let usado = larguraMenu;
  for (let i = 0; i < larguras.length; i++) {
    usado += larguras[i]! + folga;
    if (usado > largura) return i;
  }
  return larguras.length;
}
