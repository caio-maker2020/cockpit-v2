// =============================================================================
// INV-154 — a oc 33 nunca promete ao SSW um anexo que nao existe.
//
// Quando o texto de descricao/valor passa de 500 chars, prepararTextoOc33 troca
// a instrucao por "... em imagem anexa ... Ressarcimento: ver anexo." e manda
// gerar um JPEG. Essa geracao NUNCA rodou em producao (0 de 183) e depende de
// buscar fonte na internet de dentro da Edge Function. Quando ela falha, o SSW
// recebia um bilhete mandando ver um anexo inexistente.
// Com texto lido de PDF (INV-154) esse caminho deixa de ser raro.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  LIMITE_TEXTO_SSW,
  montarTextoOc33ComOperador,
  prepararTextoOc33,
  promessaImagemOc33,
  trocarPromessaDeImagemPeloTexto,
} from "./extravio-parcial-dossie.ts";

const NF = "431734";
const LONGO = "DINITRATO ISOSSORBIDA 10MG - 12 UN; ".repeat(40); // > 500 chars

Deno.test("INV-154 promessa: a fonte da promessa e UNICA (prepararTextoOc33 usa a mesma)", () => {
  const prep = prepararTextoOc33(LONGO, NF);
  assertEquals(prep.precisaImagem, true);
  assertEquals(prep.instrucao, promessaImagemOc33(NF));
});

Deno.test("INV-154 promessa: sem imagem, a instrucao deixa de prometer anexo", () => {
  const prep = prepararTextoOc33(LONGO, NF);
  const final = trocarPromessaDeImagemPeloTexto(prep.instrucao, NF, prep.textoParaImagem!, LIMITE_TEXTO_SSW);
  assert(!final.includes("ver anexo"), `nao pode prometer anexo — veio: ${final}`);
  assert(!final.includes("imagem anexa"), `nao pode prometer imagem — veio: ${final}`);
  assert(final.includes("DINITRATO ISOSSORBIDA"), "o texto real tem de aparecer");
  assert(final.endsWith("..."), "corte tem de ficar visivel");
  assert(final.length <= LIMITE_TEXTO_SSW);
});

Deno.test("INV-154 promessa: o texto do operador e PRESERVADO, e o do dossie vem NA FRENTE", () => {
  const prep = montarTextoOc33ComOperador("Reversao de perdas iniciada. Cliente notificado.", LONGO, NF);
  assertEquals(prep.precisaImagem, true);
  const final = trocarPromessaDeImagemPeloTexto(prep.instrucao, NF, prep.textoParaImagem!, LIMITE_TEXTO_SSW);
  assert(final.includes("Reversao de perdas iniciada. Cliente notificado."), "o texto do operador nao pode sumir");
  // Carlos 2026-09-16: o dossie vem PRIMEIRO. So os 70 primeiros chegam ao setor.
  assert(final.slice(0, 70).includes("DINITRATO"), `o item tem de estar visivel — o setor le: "${final.slice(0, 70)}"`);
  assert(!final.includes("ver anexo"));
  assert(final.length <= LIMITE_TEXTO_SSW);
});

Deno.test("INV-154 promessa: nao sobra separador solto nem espaco duplo", () => {
  const prep = prepararTextoOc33(LONGO, NF);
  const final = trocarPromessaDeImagemPeloTexto(prep.instrucao, NF, prep.textoParaImagem!, LIMITE_TEXTO_SSW);
  assert(!final.startsWith("|"), `veio: ${final}`);
  assert(!final.trim().endsWith("|"), `veio: ${final}`);
  assert(!final.includes("  "), `espaco duplo quebra thread do Outlook — veio: ${final}`);
});

Deno.test("INV-154 promessa: espaco minusculo — nao inventa corte truncado demais", () => {
  // Operador escreveu quase o limite inteiro: nao ha espaco util pro texto.
  const quaseCheio = "X".repeat(LIMITE_TEXTO_SSW - 10);
  const final = trocarPromessaDeImagemPeloTexto(
    `${quaseCheio} | ${promessaImagemOc33(NF)}`, NF, LONGO, LIMITE_TEXTO_SSW,
  );
  assert(!final.includes("ver anexo"), "a promessa tem de sumir mesmo sem espaco pro texto");
  assert(final.startsWith(quaseCheio.slice(0, 50)), "o texto do operador continua la");
  assert(final.length <= LIMITE_TEXTO_SSW);
});

Deno.test("INV-154 promessa: texto que CABE nao e tocado (nao-regressao)", () => {
  const curto = "Descricao dos itens: Paracetamol 30un | Valor dos itens: R$ 300,00";
  const prep = prepararTextoOc33(curto, NF);
  assertEquals(prep.precisaImagem, false);
  assertEquals(prep.instrucao, curto);
  // e a troca nunca e chamada nesse caminho; se for, nao estraga nada:
  assertEquals(trocarPromessaDeImagemPeloTexto(curto, NF, "", LIMITE_TEXTO_SSW), curto);
});
