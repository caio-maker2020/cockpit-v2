// deno test --no-check supabase/functions/_shared/validar-tripe-ssw.test.ts
//
// Guard do requisito #6 (Caio 2026-06-30, NF 5631361): a flag
// `permitirLocalizacaoBaixada` (vinda de extras.forcar_lancamento_ctrc_baixado)
// dispensa SÓ a checagem (c) de localização. (a) CTRC e (b) NF seguem
// invioláveis — proteção NF 142371. Estes testes provam que a flag NÃO burla.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validarTripeCtrcNfPagador } from "./validar-tripe-ssw.ts";

/** Monta o HTML do form act=O do portal SSW com os 3 campos que o guard lê. */
function htmlAtoO(opts: { ctrc: string; nf: string; loc: string }): string {
  return (
    `<div class=texto>CTRC:</div>\n<A id="1" href="#" class=baselnk>${opts.ctrc}</A>\n` +
    `<div class=texto>Nota&nbsp;fiscal:</div>\n<div class=data>${opts.nf}</div>\n` +
    `<div class=texto>Localiza&ccedil;&atilde;o&nbsp;&nbsp;atual:</div>\n<div class=data>${opts.loc}</div>`
  );
}

const CTRC = "APO287337-1";
const NF_CARD = "357645";
const NF_SSW = "1/000357645"; // mesma NF, formato do SSW (série/zeros)

Deno.test("localização OK → ok:true (caminho normal)", () => {
  const r = validarTripeCtrcNfPagador({
    cardCtrc: CTRC, cardNf: NF_CARD,
    htmlAtoO: htmlAtoO({ ctrc: CTRC, nf: NF_SSW, loc: "EM ROTA DE ENTREGA" }),
  });
  assertEquals(r.ok, true);
});

Deno.test("CTRC baixado SEM flag → bloqueia (ctrc_finalizado)", () => {
  const r = validarTripeCtrcNfPagador({
    cardCtrc: CTRC, cardNf: NF_CARD,
    htmlAtoO: htmlAtoO({ ctrc: CTRC, nf: NF_SSW, loc: "CTRC ENTREGUE / BAIXADO" }),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "ctrc_finalizado");
});

Deno.test("CTRC baixado COM flag → passa e marca localizacao_forcada", () => {
  const r = validarTripeCtrcNfPagador({
    cardCtrc: CTRC, cardNf: NF_CARD,
    htmlAtoO: htmlAtoO({ ctrc: CTRC, nf: NF_SSW, loc: "CTRC ENTREGUE / BAIXADO" }),
    permitirLocalizacaoBaixada: true,
  });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.localizacao_forcada, true);
    assertEquals(r.localizacao_forcada_keyword, "ENTREGUE");
  }
});

Deno.test("REQ#6: flag NÃO burla CTRC divergente", () => {
  const r = validarTripeCtrcNfPagador({
    cardCtrc: CTRC, cardNf: NF_CARD,
    htmlAtoO: htmlAtoO({ ctrc: "OVD399372-8", nf: NF_SSW, loc: "CTRC ENTREGUE / BAIXADO" }),
    permitirLocalizacaoBaixada: true,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "ctrc_divergente");
});

Deno.test("REQ#6: flag NÃO burla NF divergente", () => {
  const r = validarTripeCtrcNfPagador({
    cardCtrc: CTRC, cardNf: NF_CARD,
    htmlAtoO: htmlAtoO({ ctrc: CTRC, nf: "9/000999999", loc: "CTRC ENTREGUE / BAIXADO" }),
    permitirLocalizacaoBaixada: true,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "nf_divergente");
});
