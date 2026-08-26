// Guard da metrificação do corpo sugerido (onda 2 do veto, 25/08):
// whitespace não é edição; conteúdo é. Sem sugestão = não metrifica.
import { describe, expect, it } from "vitest";
import { medirAlteracaoCorpoIa } from "./corpoEmailIa";

describe("medirAlteracaoCorpoIa", () => {
  it("sem corpo sugerido → usado=false (nada a metrificar)", () => {
    expect(medirAlteracaoCorpoIa(null, "qualquer")).toEqual({ usado: false, alterado: false });
    expect(medirAlteracaoCorpoIa("  ", "x")).toEqual({ usado: false, alterado: false });
  });

  it("corpo idêntico ou só reformatado (espaços/quebras) → alterado=false", () => {
    expect(medirAlteracaoCorpoIa("Olá,\n\nsegue a NF.", "Olá,\n\nsegue a NF.")).toEqual({ usado: true, alterado: false });
    expect(medirAlteracaoCorpoIa("Olá,  segue a NF.", "Olá,\nsegue   a NF.")).toEqual({ usado: true, alterado: false });
  });

  it("qualquer mudança de conteúdo → alterado=true", () => {
    expect(medirAlteracaoCorpoIa("Olá, segue a NF.", "Olá, segue a NF 123.").alterado).toBe(true);
    expect(medirAlteracaoCorpoIa("Podemos reentregar?", "Podemos devolver?").alterado).toBe(true);
  });
});
