// Guard INV-111 (Caio 26/08, NF 382389): "se não tem evidência, não pode
// sugerir 54+email pra depois ver que não tem evidência e barrar". A supressão
// vale SÓ com ausência PROVADA (ok_sem_btn_foto) nas ocs 10/11/35 em template
// que usa {link_evidencia}; ambíguo/indisponível mantém a opção (caminho
// skip_evidencia do operador — NF 353730).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deveSuprimirSugestaoSemEvidencia } from "./regras-auto-acao.ts";

Deno.test("suprime: oc 11 + template com link + ok_sem_btn_foto (NF 382389)", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(11, true, true, "ok_sem_btn_foto"), true);
});

Deno.test("mantém: ambíguo (foto em outra linha — skip legítimo NF 353730)", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(11, true, true, "ambiguo_foto_em_outra_oc"), false);
});

Deno.test("mantém: scrape indisponível (não se prova ausência)", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(35, true, true, "scrape_indisponivel"), false);
});

Deno.test("mantém: status nunca verificado (null)", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(10, true, true, null), false);
});

Deno.test("mantém: template sem {link_evidencia} (ex.: FALTA_DE_VOLUME)", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(11, true, false, "ok_sem_btn_foto"), false);
});

Deno.test("mantém: oc fora de 10/11/35 (ex.: 49) mesmo sem foto", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(49, true, true, "ok_sem_btn_foto"), false);
});

Deno.test("mantém: proposta sem e-mail nunca é suprimida", () => {
  assertEquals(deveSuprimirSugestaoSemEvidencia(11, false, true, "ok_sem_btn_foto"), false);
});
