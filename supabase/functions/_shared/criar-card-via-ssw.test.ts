// Testes da função pura escolherCtrc (regra de ouro do CTRC).
// Rodar: deno test supabase/functions/_shared/criar-card-via-ssw.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escolherCtrc } from "./criar-card-via-ssw.ts";
import type { CtrcRow } from "./ssw-internal-client.ts";

function ctrc(over: Partial<CtrcRow>): CtrcRow {
  return {
    ctrc: "OVD000000-0",
    tipo: "NORMAL",
    data_emissao: "",
    pagador: "",
    chave_cte: "",
    cancelado: false,
    seq_ctrc: "",
    familia: "",
    ...over,
  };
}

Deno.test("escolherCtrc: 1 CTRC NORMAL ativo → unico", () => {
  const r = escolherCtrc([ctrc({ ctrc: "OVD396328-4", tipo: "NORMAL" })]);
  assertEquals(r.tipo, "unico");
  assertEquals(r.ctrc?.ctrc, "OVD396328-4");
});

Deno.test("escolherCtrc: cancelado é ignorado, sobra 1 normal → unico", () => {
  const r = escolherCtrc([
    ctrc({ ctrc: "OVD399372-8", tipo: "NORMAL", cancelado: true }),
    ctrc({ ctrc: "OVD396328-4", tipo: "NORMAL" }),
  ]);
  assertEquals(r.tipo, "unico");
  assertEquals(r.ctrc?.ctrc, "OVD396328-4");
});

Deno.test("escolherCtrc: todos cancelados → sem_ctrc_ativo", () => {
  const r = escolherCtrc([ctrc({ cancelado: true }), ctrc({ cancelado: true })]);
  assertEquals(r.tipo, "sem_ctrc_ativo");
  assertEquals(r.ctrc, null);
});

Deno.test("escolherCtrc: 2 NORMAIS ativos → ambiguo", () => {
  const r = escolherCtrc([
    ctrc({ ctrc: "OVD396328-4", tipo: "NORMAL" }),
    ctrc({ ctrc: "OVD396329-2", tipo: "NORMAL" }),
  ]);
  assertEquals(r.tipo, "ambiguo");
  assertEquals(r.ctrc, null);
});

Deno.test("escolherCtrc: 1 NORMAL + 1 complementar (tipo vazio) → unico (o normal)", () => {
  const r = escolherCtrc([
    ctrc({ ctrc: "OVD396328-4", tipo: "NORMAL" }),
    ctrc({ ctrc: "OVD396330-9", tipo: "" }),
  ]);
  assertEquals(r.tipo, "unico");
  assertEquals(r.ctrc?.ctrc, "OVD396328-4");
});

Deno.test("escolherCtrc: só 1 ativo não-normal (reversa) → unico com flag", () => {
  const r = escolherCtrc([ctrc({ ctrc: "OVD396331-7", tipo: "REVERSA" })]);
  assertEquals(r.tipo, "unico");
  assertEquals(r.ctrc?.ctrc, "OVD396331-7");
});
