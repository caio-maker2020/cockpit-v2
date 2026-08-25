// Guard da onda 2 do veto (25/08): pré-seleção de anexos da 33 pelo AGENTE —
// dossiê manda; heurística de nome é o degrau seguinte; não-suportado NUNCA
// entra (INV-045); nada casável = lista vazia (modal segue como hoje).
// Rodar: deno test supabase/functions/_shared/anexos-33-sugeridos.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { escolherAnexosSugeridos33 } from "./anexos-33-sugeridos.ts";

const ANEXOS = [
  { id: "gif1", message_inbox_id: "m1", filename: "image001.gif", mime_type: "image/gif" },
  { id: "rom1", message_inbox_id: "m1", filename: "ROMANEIO_assinado.pdf", mime_type: "application/pdf" },
  { id: "foto", message_inbox_id: "m2", filename: "foto_carga.jpg", mime_type: "image/jpeg" },
];

Deno.test("dossiê aponta o romaneio → esse anexo, e só ele", () => {
  const r = escolherAnexosSugeridos33(
    { presente: true, filename: "romaneio_assinado.pdf", message_inbox_id: "m1" },
    ANEXOS,
  );
  assertEquals(r.length, 1);
  assertEquals(r[0]!.anexo_id, "rom1");
  assertEquals(r[0]!.motivo, "romaneio_do_dossie");
});

Deno.test("dossiê com inbox divergente não casa → cai na heurística de nome", () => {
  const r = escolherAnexosSugeridos33(
    { presente: true, filename: "romaneio_assinado.pdf", message_inbox_id: "OUTRO" },
    ANEXOS,
  );
  assertEquals(r.length, 1);
  assertEquals(r[0]!.anexo_id, "rom1");
  assertEquals(r[0]!.motivo, "romaneio_por_nome");
});

Deno.test("sem dossiê: heurística romaneio/coleta no nome, só suportados", () => {
  const r = escolherAnexosSugeridos33(null, ANEXOS);
  assertEquals(r.map((s) => s.anexo_id), ["rom1"]);
});

Deno.test("gif de assinatura NUNCA é sugerido, nem com nome de romaneio (INV-045)", () => {
  const r = escolherAnexosSugeridos33(null, [
    { id: "g", filename: "romaneio.gif", mime_type: "image/gif" },
  ]);
  assertEquals(r, []);
});

Deno.test("nada casável → vazio (o modal segue com a pré-seleção padrão)", () => {
  assertEquals(escolherAnexosSugeridos33(null, [ANEXOS[2]!]), []);
  assertEquals(escolherAnexosSugeridos33({ presente: false }, []), []);
});

Deno.test("teto de 3 sugestões", () => {
  const muitos = Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`,
    filename: `romaneio_${i}.pdf`,
    mime_type: "application/pdf",
  }));
  assertEquals(escolherAnexosSugeridos33(null, muitos).length, 3);
});
