import { describe, expect, it } from "vitest";
import { sanitizeSearch } from "./search";

describe("sanitizeSearch", () => {
  it("remove os chars que quebram o .or() do PostgREST", () => {
    // vírgula e parênteses são os que corrompem a query
    expect(sanitizeSearch("ABC, LTDA")).not.toContain(",");
    expect(sanitizeSearch("FULANO (MG)")).not.toMatch(/[()]/);
    expect(sanitizeSearch("DROGARIA S/A %")).not.toContain("%");
    expect(sanitizeSearch("a\\b")).not.toContain("\\");
  });

  it("preserva texto normal (NF, CTRC, nome)", () => {
    expect(sanitizeSearch("142371")).toBe("142371");
    expect(sanitizeSearch("OVD396328-4")).toBe("OVD396328-4");
    expect(sanitizeSearch("  UNIAO QUIMICA  ")).toBe("UNIAO QUIMICA");
  });

  it("colapsa espaços e faz trim", () => {
    expect(sanitizeSearch("ABC,  LTDA")).toBe("ABC LTDA");
    expect(sanitizeSearch("   ")).toBe("");
  });

  it("um termo hostil não vira filtro extra no or()", () => {
    // se sobrasse vírgula, isto viraria 2 filtros no PostgREST
    const out = sanitizeSearch("x,nf.ilike.*");
    expect(out).not.toContain(",");
    expect(out).not.toContain("(");
  });
});
