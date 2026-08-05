// Guard: menu pós-resposta mantém/revive o 59+email de indenização em extravio
// TOTAL escalado (Larissa 2026-08-05, NF 1102187). INV-062.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ehExtravioTotalPorTodos59,
  escolher59IndenizacaoParaReviver,
} from "./propostas-pos-resposta-cliente.ts";

Deno.test("ehExtravioTotal: true só quando há todo 59+template de total", () => {
  assertEquals(ehExtravioTotalPorTodos59([]), false); // card normal → inerte
  assertEquals(ehExtravioTotalPorTodos59([{ id: "a", status: "cancelado" }]), true);
  assertEquals(ehExtravioTotalPorTodos59([{ id: "a", status: "pendente" }]), true);
});

Deno.test("reviver: escolhe o cancelado mais recente quando não há ativo", () => {
  // ordem: mais recente primeiro (query .order desc)
  const id = escolher59IndenizacaoParaReviver([
    { id: "novo", status: "cancelado" },
    { id: "velho", status: "cancelado" },
  ]);
  assertEquals(id, "novo");
});

Deno.test("reviver: NÃO revive se já há pendente (evita violar índice único)", () => {
  assertEquals(
    escolher59IndenizacaoParaReviver([
      { id: "p", status: "pendente" },
      { id: "c", status: "cancelado" },
    ]),
    null,
  );
});

Deno.test("reviver: NÃO revive se já há aprovado", () => {
  assertEquals(
    escolher59IndenizacaoParaReviver([{ id: "a", status: "aprovado" }]),
    null,
  );
});

Deno.test("reviver: nada a fazer sem todos 59 de total", () => {
  assertEquals(escolher59IndenizacaoParaReviver([]), null);
});
