import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CLIENTES_URL,
  cnpjPagadorDoCard,
  limparNomeSsw,
  montarUrlNumerosCliente,
  normalizarCnpj,
  senhaDashboardClientes,
  termoBuscaCliente,
} from "./dashboard-clientes";

describe("limparNomeSsw — abreviação 15 chars + ' A.' do SSW", () => {
  it("remove o sufixo ' A.' do nome abreviado (caso-âncora NF 2387303)", () => {
    expect(limparNomeSsw("ASTRA S/A. INDU A.")).toBe("ASTRA S/A. INDU");
    expect(limparNomeSsw("ICARO EXPRESS L A.")).toBe("ICARO EXPRESS L");
  });
  it("mantém nome completo e normaliza espaços", () => {
    expect(limparNomeSsw("  WURTH DO BRASIL   PECAS DE FIXAC ")).toBe(
      "WURTH DO BRASIL PECAS DE FIXAC",
    );
    expect(limparNomeSsw("ASTRA S/A. INDUSTRIA E COMERCIO")).toBe(
      "ASTRA S/A. INDUSTRIA E COMERCIO",
    );
  });
  it("vazio/null → ''", () => {
    expect(limparNomeSsw(null)).toBe("");
    expect(limparNomeSsw("   ")).toBe("");
  });
});

describe("normalizarCnpj / cnpjPagadorDoCard", () => {
  it("aceita 14 dígitos com ou sem máscara", () => {
    expect(normalizarCnpj("50949528001232")).toBe("50949528001232");
    expect(normalizarCnpj("50.949.528/0012-32")).toBe("50949528001232");
  });
  it("rejeita CPF, vazio e tipos estranhos", () => {
    expect(normalizarCnpj("12345678901")).toBeNull();
    expect(normalizarCnpj("")).toBeNull();
    expect(normalizarCnpj(null)).toBeNull();
    expect(normalizarCnpj({})).toBeNull();
  });
  it("lê agent_state.cnpj_pagador", () => {
    expect(cnpjPagadorDoCard({ cnpj_pagador: "50949528001232" })).toBe("50949528001232");
    expect(cnpjPagadorDoCard({ cnpj_pagador: null })).toBeNull();
    expect(cnpjPagadorDoCard(null)).toBeNull();
  });
});

describe("termoBuscaCliente", () => {
  it("prefere nome completo da tabela clientes", () => {
    expect(
      termoBuscaCliente({
        nomeCompleto: "ASTRA S/A. INDUSTRIA E COMERCIO",
        nomeCard: "ASTRA S/A. INDU A.",
      }),
    ).toBe("ASTRA S/A. INDUSTRIA E COMERCIO");
  });
  it("cai pro nome do card limpo quando não há nome completo", () => {
    expect(termoBuscaCliente({ nomeCard: "ASTRA S/A. INDU A." })).toBe("ASTRA S/A. INDU");
  });
  it("nunca manda termo abaixo do mínimo do dashboard", () => {
    expect(termoBuscaCliente({ nomeCard: "AB" })).toBe("");
    expect(termoBuscaCliente({})).toBe("");
  });
});

describe("montarUrlNumerosCliente", () => {
  it("monta q + cnpj sobre a URL fixa do dashboard", () => {
    const u = new URL(
      montarUrlNumerosCliente({
        nomeCompleto: "ASTRA S/A. INDUSTRIA E COMERCIO",
        cnpj: "50949528001232",
      }),
    );
    expect(u.origin + u.pathname).toBe(DASHBOARD_CLIENTES_URL);
    expect(u.searchParams.get("q")).toBe("ASTRA S/A. INDUSTRIA E COMERCIO");
    expect(u.searchParams.get("cnpj")).toBe("50949528001232");
  });
  it("sem dados → URL limpa do dashboard (botão nunca quebra)", () => {
    expect(montarUrlNumerosCliente({})).toBe(DASHBOARD_CLIENTES_URL);
  });
  it("omite cnpj inválido mas mantém q", () => {
    const u = new URL(montarUrlNumerosCliente({ nomeCard: "WURTH DO BRASIL", cnpj: "123" }));
    expect(u.searchParams.get("q")).toBe("WURTH DO BRASIL");
    expect(u.searchParams.has("cnpj")).toBe(false);
  });
});

describe("senhaDashboardClientes", () => {
  it("lê da env e ignora vazio", () => {
    expect(senhaDashboardClientes({ VITE_DASHBOARD_CLIENTES_SENHA: " x1 " })).toBe("x1");
    expect(senhaDashboardClientes({ VITE_DASHBOARD_CLIENTES_SENHA: "" })).toBeNull();
    expect(senhaDashboardClientes({})).toBeNull();
  });
});
