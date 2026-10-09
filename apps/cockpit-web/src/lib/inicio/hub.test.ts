// Quem cai onde ao entrar. A garantia central: operador do Relacionamento e membro
// só da Operação continuam exatamente onde iam antes do hub.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { decidirAreas, type EntradaAreas } from "@/lib/operacao/areas";
import { areaDaRota, areaDestaque, gravarUltimaArea, lerUltimaArea, rotaInicial, veHub } from "./hub";
import type { OpSessao } from "@/lib/operacao/tipos";

const sessao = (p: Partial<OpSessao>): OpSessao => ({ membro: null, eh_gestor: false, eh_supervisor: false, flags: { operacao_tela: true }, ...p }) as OpSessao;
const membro = { nome: "Ana", papel_op: "operador_op", unidades: ["VGA"] } as unknown as OpSessao["membro"];
const entrada = (p: Partial<EntradaAreas>): EntradaAreas => ({ operador: null, operadorCarregado: true, sessao: null, sessaoCarregada: true, ...p });
const rota = (p: Partial<EntradaAreas>) => rotaInicial(decidirAreas(entrada(p)));

describe("rotaInicial — nada muda para quem não é gestor", () => {
  it("operador do Relacionamento vai para o Inbox (sem esperar a sessão da Operação)", () => {
    expect(rota({ operador: { papel: "operador" }, sessaoCarregada: false })).toBe("/inbox");
    expect(rota({ operador: { papel: "operador" } })).toBe("/inbox");
    expect(veHub(decidirAreas(entrada({ operador: { papel: "operador" } })))).toBe(false);
  });
  it("supervisor do Relacionamento (não gestor) também vai para o Inbox", () => {
    expect(rota({ operador: { papel: "supervisor" } })).toBe("/inbox");
  });
  it("membro só da Operação vai para /operacao", () => {
    expect(rota({ sessao: sessao({ membro }) })).toBe("/operacao");
    expect(veHub(decidirAreas(entrada({ sessao: sessao({ membro }) })))).toBe(false);
  });
  it("membro da Operação enquanto a sessão carrega: espera (não mostra o Inbox)", () => {
    expect(rota({ sessaoCarregada: false })).toBeNull();
  });
  it("ninguém em nenhuma tabela segue para o Inbox, como hoje", () => {
    expect(rota({})).toBe("/inbox");
  });
  it("operador do Relacionamento que também é membro da Operação continua no Inbox", () => {
    expect(rota({ operador: { papel: "operador" }, sessao: sessao({ membro }) })).toBe("/inbox");
  });
});

describe("rotaInicial — gestor vai para o hub", () => {
  it("gestor em operadores", () => {
    expect(rota({ operador: { papel: "gestor" }, sessaoCarregada: false })).toBe("/inicio");
  });
  it("gestor que também é membro da Operação", () => {
    expect(rota({ operador: { papel: "gestor" }, sessao: sessao({ membro }) })).toBe("/inicio");
  });
  it("gestor só pela sessão da Operação (eh_gestor)", () => {
    expect(rota({ sessao: sessao({ eh_gestor: true }) })).toBe("/inicio");
  });
  it("demonstração sempre abre o hub", () => {
    expect(rotaInicial(decidirAreas(entrada({ sessao: sessao({ membro }) })), true)).toBe("/inicio");
  });
});

describe("areaDestaque", () => {
  const ambas = { relacionamento: true, operacao: true };
  it("a área com mais coisa pedindo o gestor ganha", () => {
    expect(areaDestaque({ relacionamento: 3, operacao: 9 }, ambas, "relacionamento")).toBe("operacao");
    expect(areaDestaque({ relacionamento: 12, operacao: 9 }, ambas, "operacao")).toBe("relacionamento");
  });
  it("sem os dois números (ou empate), vale a última usada; sem ela, Relacionamento", () => {
    expect(areaDestaque({ relacionamento: null, operacao: 9 }, ambas, "relacionamento")).toBe("relacionamento");
    expect(areaDestaque({ relacionamento: 4, operacao: 4 }, ambas, "operacao")).toBe("operacao");
    expect(areaDestaque({ relacionamento: null, operacao: null }, ambas, null)).toBe("relacionamento");
  });
  it("quem só vê uma área tem só ela", () => {
    expect(areaDestaque({ relacionamento: 0, operacao: 50 }, { relacionamento: true, operacao: false }, null)).toBe("relacionamento");
    expect(areaDestaque({ relacionamento: 50, operacao: 0 }, { relacionamento: false, operacao: true }, null)).toBe("operacao");
  });
});

describe("última área (localStorage)", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), clear: () => m.clear() });
  });
  it("grava e lê; valor estranho vira null", () => {
    expect(lerUltimaArea()).toBeNull();
    gravarUltimaArea("operacao");
    expect(lerUltimaArea()).toBe("operacao");
    window.localStorage.setItem("cockpit.inicio.ultimaArea.v1", "xyz");
    expect(lerUltimaArea()).toBeNull();
  });
  it("areaDaRota", () => {
    expect(areaDaRota("/operacao")).toBe("operacao");
    expect(areaDaRota("/operacao/abc")).toBe("operacao");
    expect(areaDaRota("/operacaox")).toBe("relacionamento");
    expect(areaDaRota("/cards/1")).toBe("relacionamento");
    expect(areaDaRota("/inicio")).toBeNull();
  });
});
