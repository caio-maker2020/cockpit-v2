import { describe, expect, it } from "vitest";
import { decidirAreas } from "./areas";
import type { OpSessao } from "./tipos";

const FLAGS_ON = { operacao_tela: true, operacao_lancar_ssw: false, operacao_fila: true };
const membro = (papel: "operador_op" | "supervisor_op" = "operador_op"): OpSessao => ({
  membro: { id: "m1", nome: "Ana", email: null, papel_op: papel, unidades: ["VGA"], pode_lancar: false },
  eh_gestor: false,
  flags: FLAGS_ON,
});

const base = { operadorCarregado: true, sessaoCarregada: true };

describe("separação Relacionamento × Operação (ADR 0041 D2, INV-180)", () => {
  it("membro só da Operação NÃO vê o Relacionamento e vê a Operação", () => {
    const a = decidirAreas({ ...base, operador: null, sessao: membro() });
    expect(a.veRelacionamento).toBe(false);
    expect(a.podeAbrirOperacao).toBe(true);
    expect(a.menuOperacao).toBe(true);
  });

  it("operador do Relacionamento NÃO vê a Operação", () => {
    const a = decidirAreas({ ...base, operador: { papel: "operador" }, sessao: { membro: null, eh_gestor: false } });
    expect(a.veRelacionamento).toBe(true);
    expect(a.podeAbrirOperacao).toBe(false);
    expect(a.menuOperacao).toBe(false);
  });

  it("gestor vê os dois (menu da Operação só com a tela ligada)", () => {
    const ligado = decidirAreas({ ...base, operador: { papel: "gestor" }, sessao: { membro: null, eh_gestor: true, flags: FLAGS_ON } });
    expect(ligado.veRelacionamento && ligado.podeAbrirOperacao && ligado.menuOperacao).toBe(true);
    const desligado = decidirAreas({
      ...base,
      operador: { papel: "gestor" },
      sessao: { membro: null, eh_gestor: true, flags: { ...FLAGS_ON, operacao_tela: false } },
    });
    expect(desligado.podeAbrirOperacao).toBe(true);
    expect(desligado.menuOperacao).toBe(false);
  });

  it("membro com a tela desligada: sem menu, e mesmo assim não vê o Relacionamento", () => {
    const s = membro();
    s.flags = { ...FLAGS_ON, operacao_tela: false };
    const a = decidirAreas({ ...base, operador: null, sessao: s });
    expect(a.menuOperacao).toBe(false);
    expect(a.veRelacionamento).toBe(false);
  });

  it("FAIL-OPEN: sessão da Operação indisponível (mig 430 não aplicada) → Relacionamento segue como hoje", () => {
    const a = decidirAreas({ ...base, operador: { papel: "operador" }, sessao: null });
    expect(a.veRelacionamento).toBe(true);
    expect(a.podeAbrirOperacao).toBe(false);
    const ninguem = decidirAreas({ ...base, operador: null, sessao: null });
    expect(ninguem.veRelacionamento).toBe(true);
  });

  it("quem está em operadores decide na hora, sem esperar a sessão da Operação", () => {
    const a = decidirAreas({ operador: { papel: "operador" }, operadorCarregado: true, sessao: null, sessaoCarregada: false });
    expect(a.carregando).toBe(false);
    expect(a.veRelacionamento).toBe(true);
    expect(a.carregandoOperacao).toBe(true);
  });

  it("fora de operadores, espera as duas leituras antes de mostrar o Relacionamento", () => {
    const a = decidirAreas({ operador: null, operadorCarregado: true, sessao: null, sessaoCarregada: false });
    expect(a.carregando).toBe(true);
    expect(a.veRelacionamento).toBe(false);
  });
});
