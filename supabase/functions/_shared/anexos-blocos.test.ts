// =============================================================================
// INV-154 — montagem dos blocos de arquivo que vao ao modelo.
// Banco FALSO: sem rede, sem storage real.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  blocoDoMime,
  bytesParaBase64,
  carregarBlocosDeAnexos,
  rotuloDoArquivo,
} from "./anexos-blocos.ts";

function anexo(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    filename: "NFE-433174 (1).pdf",
    mime_type: "application/pdf",
    size_bytes: 8,
    storage_path: "inbound/card/NFE.pdf",
    message_inbox_id: "msg-0708",
    recebido_em: "2026-08-07T19:36:54.594Z",
    ...over,
  };
}

/** storage falso: mapa de path -> bytes (ou erro). */
function fakeSupabase(mapa: Record<string, Uint8Array | { erro: string } | null>) {
  return {
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => {
          const v = mapa[path];
          if (v == null) return Promise.resolve({ data: null, error: { message: "not found" } });
          if (v instanceof Uint8Array) {
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: { message: v.erro } });
        },
      }),
    },
  };
}

Deno.test("INV-154 blocos: base64 bate com o btoa de referencia", () => {
  const bytes = new TextEncoder().encode("Sal Express");
  assertEquals(bytesParaBase64(bytes), btoa("Sal Express"));
});

Deno.test("INV-154 blocos: base64 aguenta arquivo grande sem estourar a pilha", () => {
  // 300KB: o fromCharCode com o array inteiro quebraria aqui.
  const bytes = new Uint8Array(300 * 1024).fill(65);
  const b64 = bytesParaBase64(bytes);
  assertEquals(b64.length, Math.ceil((300 * 1024) / 3) * 4);
});

Deno.test("INV-154 blocos: PDF vira document NATIVO (sem conversao pra imagem)", () => {
  const b = blocoDoMime("application/pdf", "AAA");
  assertEquals(b?.type, "document");
  assertEquals((b as { source: { media_type: string } }).source.media_type, "application/pdf");
});

Deno.test("INV-154 blocos: JPG e PNG viram image; formato de fora vira null", () => {
  assertEquals(blocoDoMime("image/jpeg", "A")?.type, "image");
  assertEquals(blocoDoMime("image/jpg", "A")?.type, "image");
  assertEquals(blocoDoMime("IMAGE/PNG", "A")?.type, "image");
  assertEquals(blocoDoMime("application/vnd.ms-excel", "A"), null);
  assertEquals(blocoDoMime("", "A"), null);
});

Deno.test("INV-154 blocos: cada arquivo vai precedido do nome LITERAL", async () => {
  const a = anexo();
  const r = await carregarBlocosDeAnexos(
    fakeSupabase({ "inbound/card/NFE.pdf": new TextEncoder().encode("%PDF-1.4") }),
    [a],
  );
  assertEquals(r.abertos.length, 1);
  assertEquals(r.blocos.length, 2, "rotulo + arquivo");
  assertEquals(r.blocos[0], { type: "text", text: rotuloDoArquivo("NFE-433174 (1).pdf") });
  // O nome tem de sair EXATAMENTE como no banco: a validacao deterministica do
  // dossie casa por nome exato e recusa se nao bater.
  assert((r.blocos[0] as { text: string }).text.includes("NFE-433174 (1).pdf"));
  assertEquals(r.blocos[1]!.type, "document");
});

Deno.test("INV-154 blocos: download que falha NAO derruba a leitura", async () => {
  const ok = anexo({ id: "ok", storage_path: "p/ok.pdf" });
  const ruim = anexo({ id: "ruim", filename: "sumiu.pdf", storage_path: "p/sumiu.pdf" });
  const r = await carregarBlocosDeAnexos(
    fakeSupabase({ "p/ok.pdf": new TextEncoder().encode("%PDF"), "p/sumiu.pdf": null }),
    [ruim, ok],
  );
  assertEquals(r.abertos.map((x) => x.id), ["ok"], "o bom tem de passar mesmo com o ruim na lista");
  assertEquals(r.falhas.length, 1);
  assertEquals(r.falhas[0]!.id, "ruim");
  assert(r.falhas[0]!.motivo.startsWith("download:"));
});

Deno.test("INV-154 blocos: arquivo vazio nao vira bloco", async () => {
  const r = await carregarBlocosDeAnexos(
    fakeSupabase({ "p/v.pdf": new Uint8Array(0) }),
    [anexo({ id: "vazio", storage_path: "p/v.pdf" })],
  );
  assertEquals(r.blocos.length, 0);
  assertEquals(r.falhas[0]!.motivo, "arquivo_vazio");
});

Deno.test("INV-154 blocos: excecao no download vira falha, nao explosao", async () => {
  const supabaseQueExplode = {
    storage: { from: () => ({ download: () => { throw new Error("boom"); } }) },
  };
  const r = await carregarBlocosDeAnexos(supabaseQueExplode, [anexo()]);
  assertEquals(r.blocos.length, 0);
  assertEquals(r.falhas[0]!.motivo, "boom");
});

Deno.test("INV-154 blocos: lista vazia devolve vazio", async () => {
  const r = await carregarBlocosDeAnexos(fakeSupabase({}), []);
  assertEquals(r.blocos, []);
  assertEquals(r.abertos, []);
  assertEquals(r.falhas, []);
});
