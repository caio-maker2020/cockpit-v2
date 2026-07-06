// Testes dos helpers puros de reuso/re-busca de anexo (Fase 2, NF 66193).
// deno test supabase/functions/_shared/reuso-anexo.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { acharAnexoDoDossie, decidirReuploadAnexo } from "./reuso-anexo.ts";

Deno.test("decidirReuploadAnexo: registro ATIVO → pula", () => {
  const r = decidirReuploadAnexo([{ id: "a", deletado_em: null }]);
  assertEquals(r.acao, "pular_ativo");
  assertEquals(r.idAtivo, "a");
});

Deno.test("decidirReuploadAnexo: SÓ deletado → ressuscita (não pula silenciosamente)", () => {
  const r = decidirReuploadAnexo([{ id: "a", deletado_em: "2026-07-01T00:00:00Z" }]);
  assertEquals(r.acao, "ressuscitar");
  assertEquals(r.idAtivo, null);
});

Deno.test("decidirReuploadAnexo: nenhum registro → upload novo", () => {
  assertEquals(decidirReuploadAnexo([]).acao, "upload_novo");
});

Deno.test("decidirReuploadAnexo: ativo + deletado coexistindo → prioriza o ativo", () => {
  const r = decidirReuploadAnexo([
    { id: "velho", deletado_em: "2026-06-01T00:00:00Z" },
    { id: "novo", deletado_em: null },
  ]);
  assertEquals(r.acao, "pular_ativo");
  assertEquals(r.idAtivo, "novo");
});

Deno.test("acharAnexoDoDossie: casa por filename+size+mime; erra → null", () => {
  const disp = [
    { id: "1", filename: "romaneio.pdf", size_bytes: 500, mime_type: "application/pdf" },
    { id: "2", filename: "outro.pdf", size_bytes: 999, mime_type: "application/pdf" },
  ];
  assertEquals(acharAnexoDoDossie(disp, { filename: "romaneio.pdf", size_bytes: 500, mime_type: "application/pdf" })?.id, "1");
  assertEquals(acharAnexoDoDossie(disp, { filename: "ROMANEIO.PDF" })?.id, "1"); // só filename, case-insensitive
  // size errado → não casa (evita arquivo errado)
  assertEquals(acharAnexoDoDossie(disp, { filename: "romaneio.pdf", size_bytes: 123 }), null);
  assertEquals(acharAnexoDoDossie(disp, { filename: "inexistente.pdf" }), null);
  assertEquals(acharAnexoDoDossie(disp, { filename: null }), null);
});
