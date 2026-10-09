// Quem via cada item no header ANTES do redesenho continua vendo (à vista ou no menu),
// e quem não via continua sem ver. A tabela abaixo é a regra do header anterior.
import { describe, expect, it } from "vitest";
import { itensNavegacao, quantosCabem, rotaAtiva, type QuemVe } from "./navegacao";

const base: QuemVe = { rel: false, isGestor: false, temOperador: false, isAdmin: false, vePdi: false, menuOperacao: false, hub: false };
const rotas = (q: Partial<QuemVe>) => {
  const n = itensNavegacao({ ...base, ...q });
  return { trabalho: n.trabalho.map((i) => i.to), menu: n.menu.map((i) => i.to), todas: [...n.trabalho, ...n.menu].map((i) => i.to).sort(), rotulo: n.rotuloMenu };
};
const REL_TODOS = ["/inbox", "/conflitos", "/extravios", "/cancelamentos-reentrega", "/auditoria", "/cadastros", "/configuracoes"];
const GESTAO = ["/gestao-agentes", "/gestao-operadores", "/aprendizado"];

describe("visibilidade igual à de antes", () => {
  it("operador do Relacionamento: trabalho + Seu Dashboard + o antigo Mais; nada de gestão", () => {
    const r = rotas({ rel: true, temOperador: true });
    expect(r.todas).toEqual([...REL_TODOS, "/seu-dashboard"].sort());
    expect(r.trabalho).toEqual(["/inbox", "/conflitos", "/extravios", "/cancelamentos-reentrega", "/seu-dashboard"]);
    expect(r.menu).toEqual(["/auditoria", "/cadastros", "/configuracoes"]);
    expect(r.rotulo).toBe("Mais");
    for (const g of [...GESTAO, "/administracao", "/pdi-isadora", "/operacao"]) expect(r.todas).not.toContain(g);
  });
  it("gestor: trabalho à vista, gestão no menu 'Gestão', sem Seu Dashboard", () => {
    const r = rotas({ rel: true, temOperador: true, isGestor: true });
    expect(r.trabalho).toEqual(["/inbox", "/conflitos", "/extravios", "/cancelamentos-reentrega"]);
    expect(r.menu).toEqual([...GESTAO, "/auditoria", "/cadastros", "/configuracoes"]);
    expect(r.rotulo).toBe("Gestão");
    expect(r.todas).not.toContain("/seu-dashboard");
    expect(r.todas).not.toContain("/administracao");
  });
  it("admin (Caio): tudo, com Administração e PDI", () => {
    const r = rotas({ rel: true, temOperador: true, isGestor: true, isAdmin: true, vePdi: true });
    expect(r.menu).toEqual([...GESTAO, "/pdi-isadora", "/auditoria", "/cadastros", "/configuracoes", "/administracao"]);
  });
  it("Isadora (PDI, não gestora): vê o Plano de Desenvolvimento", () => {
    const r = rotas({ rel: true, temOperador: true, vePdi: true });
    expect(r.menu).toContain("/pdi-isadora");
    for (const g of GESTAO) expect(r.todas).not.toContain(g);
  });
  it("membro só da Operação: só a Operação, nenhum item do Relacionamento", () => {
    const r = rotas({ menuOperacao: true });
    expect(r.todas).toEqual(["/operacao"]);
  });
  it("membro da Operação com a tela desligada: nada", () => {
    expect(rotas({}).todas).toEqual([]);
  });
  it("gestor com o seletor de área: a pílula Operação sai (o seletor a substitui)", () => {
    expect(rotas({ rel: true, isGestor: true, temOperador: true, menuOperacao: true, hub: true }).todas).not.toContain("/operacao");
    expect(rotas({ rel: true, isGestor: true, temOperador: true, menuOperacao: true, hub: false }).trabalho[0]).toBe("/operacao");
  });
  it("contadores nas mesmas abas de antes", () => {
    const n = itensNavegacao({ ...base, rel: true, temOperador: true });
    const c = Object.fromEntries(n.trabalho.filter((i) => i.contador).map((i) => [i.to, i.contador]));
    expect(c).toEqual({ "/inbox": "inbox", "/conflitos": "conflitos", "/cancelamentos-reentrega": "reentregas" });
  });
});

describe("overflow e rota ativa", () => {
  it("quantosCabem respeita a ordem e reserva o menu", () => {
    expect(quantosCabem([80, 90, 100], 1000, 80)).toBe(3);
    expect(quantosCabem([80, 90, 100], 200, 80)).toBe(1);
    expect(quantosCabem([80, 90, 100], 50, 80)).toBe(0);
  });
  it("rotaAtiva: Inbox exato, o resto por prefixo", () => {
    expect(rotaAtiva("/inbox", "/inbox")).toBe(true);
    expect(rotaAtiva("/inbox", "/inbox/x")).toBe(false);
    expect(rotaAtiva("/cancelamentos-reentrega", "/cancelamentos-reentrega/12")).toBe(true);
    expect(rotaAtiva("/cadastros", "/cadastrosx")).toBe(false);
  });
});
