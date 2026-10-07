import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROS_ADR_0041, mensagemErroOp, temMensagemOp } from "./erros";

describe("mensagens humanas dos erros da Operação", () => {
  it("todo código de erro do ADR 0041 tem mensagem própria", () => {
    for (const e of ERROS_ADR_0041) {
      expect(temMensagemOp(e), e).toBe(true);
      const m = mensagemErroOp({ erro: e });
      expect(m, e).not.toContain("_");
      expect(m.length, e).toBeGreaterThan(15);
    }
  });

  it("a lista bate com a do ADR (se o ADR ganhar um erro, este teste avisa)", () => {
    const adr = readFileSync(resolve(__dirname, "../../../../../docs/decisions/0041-operacao-no-cockpit.md"), "utf8");
    const trecho = adr.slice(adr.indexOf("Erros possíveis"), adr.indexOf("## Como ligar"));
    const doAdr = [...trecho.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((c) => c !== "erro");
    expect(new Set(doAdr)).toEqual(new Set(ERROS_ADR_0041));
  });

  it("assumido_por_outro diz quem", () => {
    expect(mensagemErroOp({ erro: "assumido_por_outro", assumido_por_nome: "Rafael" })).toBe("Rafael já assumiu este item.");
  });

  it("código desconhecido não some calado", () => {
    expect(mensagemErroOp({ erro: "algo_novo" })).toContain("algo_novo");
  });
});
