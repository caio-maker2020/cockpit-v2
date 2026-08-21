// Guard INV-088: o teto silencioso de 1000 do PostgREST nunca mais corta dado.
import { describe, expect, it } from "vitest";
import { paginarTudo, PAGINA_SUPABASE } from "./supaPaginate";

describe("paginarTudo", () => {
  it("pagina até a página incompleta (2500 linhas → 3 páginas)", async () => {
    const total = 2500;
    const chamadas: Array<[number, number]> = [];
    const r = await paginarTudo(async (from, to) => {
      chamadas.push([from, to]);
      return Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i);
    });
    expect(r).toHaveLength(2500);
    expect(chamadas).toHaveLength(3);
    expect(chamadas[0]).toEqual([0, PAGINA_SUPABASE - 1]);
  });

  it("para na primeira página quando vem menos de 1000", async () => {
    let n = 0;
    const r = await paginarTudo(async () => { n++; return [1, 2, 3]; });
    expect(r).toEqual([1, 2, 3]);
    expect(n).toBe(1);
  });
});
