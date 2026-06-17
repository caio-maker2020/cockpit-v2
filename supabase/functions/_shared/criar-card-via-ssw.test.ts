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
    remetente: "",
    destinatario: "",
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

Deno.test("escolherCtrc: vários NORMAIS, remetente+destinatário isola 1 → unico", () => {
  const r = escolherCtrc(
    [
      ctrc({ ctrc: "VG1000006-0", remetente: "DUILIO DE DEUS", destinatario: "SAL EXPRESS SOLUCOES LOG TRANS (C.)" }),
      ctrc({ ctrc: "DIV342570-3", remetente: "OUTRA EMPRESA LTDA", destinatario: "FULANO" }),
      ctrc({ ctrc: "SAA330150-8", remetente: "MAIS UMA SA", destinatario: "BELTRANO" }),
    ],
    // nomes idênticos aos do CTe (ambos vêm do SSW); só diferem por acento/caixa
    { remetente: "Duilio de Deus", destinatario: "SAL EXPRESS SOLUCOES LOG TRANS (C.)" },
  );
  assertEquals(r.tipo, "unico");
  assertEquals(r.ctrc?.ctrc, "VG1000006-0");
});

Deno.test("escolherCtrc: destinatário truncado no SSF casa por prefixo", () => {
  const r = escolherCtrc(
    [
      ctrc({ ctrc: "VG1000006-0", remetente: "DUILIO DE DEUS", destinatario: "FARMACIA SAO JOAO" }),
      ctrc({ ctrc: "DIV342570-3", remetente: "OUTRO", destinatario: "ZZZ" }),
    ],
    { remetente: "DUILIO DE DEUS", destinatario: "FARMACIA SAO JOAO DISTRIBUIDORA LTDA" },
  );
  assertEquals(r.tipo, "unico"); // "FARMACIA SAO JOAO" é prefixo do nome completo
  assertEquals(r.ctrc?.ctrc, "VG1000006-0");
});

Deno.test("escolherCtrc: remetente+destinatário batem em 2 → ainda ambiguo", () => {
  const r = escolherCtrc(
    [
      ctrc({ ctrc: "VG1000006-0", remetente: "DUILIO DE DEUS", destinatario: "CLIENTE X" }),
      ctrc({ ctrc: "DIV342570-3", remetente: "DUILIO DE DEUS", destinatario: "CLIENTE X" }),
    ],
    { remetente: "DUILIO DE DEUS", destinatario: "CLIENTE X" },
  );
  assertEquals(r.tipo, "ambiguo");
});
