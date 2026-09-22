import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { montarCcResposta } from "./cc-resposta.ts";

const base = {
  toResposta: "backoffice.transportes@wurth.com.br",
  emailsOperadora: ["ingrid.alves@salexpress.com.br", null],
};

Deno.test("caso âncora NF 691977: operadora marca um contato e o Jackson do cliente NÃO some (união)", () => {
  const cc = montarCcResposta({
    ...base,
    ccExplicito: ["comprador.cadastrado@wurth.com.br"],
    rawTo: "Jackson <jackson@wurth.com.br>, ingrid.alves@salexpress.com.br",
    rawCc: "",
  });
  assertEquals(cc, ["jackson@wurth.com.br", "comprador.cadastrado@wurth.com.br"]);
});

Deno.test("sem contato marcado: deriva To+Cc do cliente (regra DURAFA preservada)", () => {
  const cc = montarCcResposta({
    ...base,
    ccExplicito: [],
    rawTo: "ingrid.alves@salexpress.com.br",
    rawCc: "transporte@isapa.com.br, Fulano <fulano@isapa.com.br>",
  });
  assertEquals(cc, ["transporte@isapa.com.br", "fulano@isapa.com.br"]);
});

Deno.test("dedup + nunca copia o TO nem a operadora", () => {
  const cc = montarCcResposta({
    ...base,
    ccExplicito: ["JACKSON@wurth.com.br", "backoffice.transportes@wurth.com.br"],
    rawTo: "jackson@wurth.com.br",
    rawCc: "jackson@wurth.com.br, ingrid.alves@salexpress.com.br",
  });
  assertEquals(cc, ["jackson@wurth.com.br"]);
});

Deno.test("inbound sem headers (raw vazio): sobram só os marcados", () => {
  const cc = montarCcResposta({ ...base, ccExplicito: ["a@b.com"], rawTo: null, rawCc: null });
  assertEquals(cc, ["a@b.com"]);
});
