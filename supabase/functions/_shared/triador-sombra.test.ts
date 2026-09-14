// Guard da sombra Haiku do triador (Caio 15/09): comparação por CONJUNTO.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compararTriagem } from "./triador-sombra.ts";

Deno.test("sombra: iguais (NFs em ordem diferente) → não diverge", () => {
  const d = compararTriagem(
    { tipo: "extravio", risco: "alto", nfs: ["123", "456"], ctrcs: [] },
    { tipo: "extravio", risco: "alto", nfs: ["456", "123"], ctrcs: [] },
  );
  assertEquals(d.diverge, false);
});

Deno.test("sombra: tipo diferente → diverge_tipo", () => {
  const d = compararTriagem(
    { tipo: "devolucao", risco: "baixo", nfs: ["1"], ctrcs: [] },
    { tipo: "reentrega", risco: "baixo", nfs: ["1"], ctrcs: [] },
  );
  assertEquals(d.diverge_tipo, true);
  assertEquals(d.diverge, true);
});

Deno.test("sombra: NF faltando no Haiku → diverge_nfs", () => {
  const d = compararTriagem(
    { tipo: "cobranca", risco: "baixo", nfs: ["123", "456"], ctrcs: [] },
    { tipo: "cobranca", risco: "baixo", nfs: ["123"], ctrcs: [] },
  );
  assertEquals(d.diverge_nfs, true);
});
