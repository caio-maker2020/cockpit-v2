// Guard da onda 2 do veto (25/08): a 56 nasce com o texto GERADO pelo agente
// nos três canais (args.descricao pro SSW, args.extras.texto_descricao pro
// prefill do painel, meta pra auditoria) — e o input humano continua vencendo
// por construção. NF âncora: 234381 (etapa 1 — 56 apurar).
// Rodar: deno test supabase/functions/_shared/texto-56-sugerido.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirTexto56, enxertarTexto56, ORIGEM_TEXTO_56 } from "./texto-56-sugerido.ts";

Deno.test("decidirTexto56: só decisão final 56 com texto preenchido", () => {
  assertEquals(decidirTexto56({ oc_sugerida: 56, texto_56_sugerido: "Cliente questiona a foto" }), "Cliente questiona a foto");
  assertEquals(decidirTexto56({ oc_sugerida: 54, texto_56_sugerido: "x" }), null);
  assertEquals(decidirTexto56({ oc_sugerida: 56, texto_56_sugerido: "  " }), null);
  assertEquals(decidirTexto56({ oc_sugerida: 56 }), null);
  assertEquals(decidirTexto56(null), null);
});

Deno.test("enxertarTexto56 preenche os 3 canais e preserva o resto do payload", () => {
  const original = {
    tool: "lancar_ocorrencia",
    args: { codigo_ssw: 56, nf: "234381", extras: { outra_chave: true } },
    meta: { origem: "vinculador_pos_resposta_cliente" },
    rationale: "existente",
  };
  const texto = "Cliente questiona a evidência de entrega — foto não mostra a recusa. Verificar com a equipe.";
  const novo = enxertarTexto56(original, texto) as any;
  // canal SSW (qualquer caminho de aprovação, inclusive o veto)
  assertEquals(typeof novo.args.descricao, "string");
  assertEquals(novo.args.descricao.includes("FOTO NAO MOSTRA A RECUSA"), true);
  // canal prefill do painel (mesmo campo da oc 55 — "o que ela vê é o que sobe")
  assertEquals(novo.args.extras.texto_descricao, novo.args.descricao);
  assertEquals(novo.args.extras.outra_chave, true); // extras antigos preservados
  // auditoria
  assertEquals(novo.meta.origem_instrucao, ORIGEM_TEXTO_56);
  assertEquals(novo.meta.texto_56_original_ia, texto);
  assertEquals(novo.meta.origem, "vinculador_pos_resposta_cliente");
  // intocados
  assertEquals(novo.args.codigo_ssw, 56);
  assertEquals(novo.rationale, "existente");
});

Deno.test("normalização SSW: caixa alta ASCII (latin-1 seguro), sem estourar 500", () => {
  const novo = enxertarTexto56({ args: { codigo_ssw: 56 } }, "ação já verificada — cliente contesta") as any;
  assertEquals(/^[\x20-\x7E]*$/.test(novo.args.descricao), true);
  assertEquals(novo.args.descricao, novo.args.descricao.toUpperCase());
  const longo = "A".repeat(600);
  const n2 = enxertarTexto56({ args: {} }, longo) as any;
  assertEquals(n2.args.descricao.length <= 500, true);
});
