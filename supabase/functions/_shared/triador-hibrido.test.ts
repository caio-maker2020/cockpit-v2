import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { precisaArbitroSonnet, TRIADOR_HIBRIDO_MODEL_TRIAGEM } from "./triador-hibrido.ts";

Deno.test("reentrega exige o árbitro Sonnet (único rótulo que arma ação)", () => {
  assertEquals(precisaArbitroSonnet("reentrega"), true);
});

Deno.test("qualquer outro rótulo NÃO chama o Sonnet (é onde mora a economia)", () => {
  for (const t of ["devolucao", "extravio", "cobranca", "avaria", "rastreamento", "outros", "inversao", "", null, undefined]) {
    assertEquals(precisaArbitroSonnet(t as string), false, `tipo=${t}`);
  }
});

Deno.test("modelo do porteiro é o Haiku 4.5", () => {
  assertEquals(TRIADOR_HIBRIDO_MODEL_TRIAGEM, "claude-haiku-4-5");
});
