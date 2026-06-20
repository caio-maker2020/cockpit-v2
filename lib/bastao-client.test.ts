// Testes do fetchPendenciasByNfs (lookup em lote por NF — Pass B watermark).
// Rodar: deno test supabase/functions/_shared/bastao-client.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createBastaoClient } from "./bastao-client.ts";

function mockFetch(captured: string[], rows: unknown[] = []) {
  // deno-lint-ignore no-explicit-any
  return ((url: any) => {
    captured.push(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
      json: () => Promise.resolve(rows),
      headers: { get: () => null },
      // deno-lint-ignore no-explicit-any
    } as any);
    // deno-lint-ignore no-explicit-any
  }) as any;
}

function client(captured: string[], rows: unknown[] = []) {
  return createBastaoClient({
    env: { url: "https://bastao.example", apiKey: "k" },
    fetch: mockFetch(captured, rows),
  });
}

Deno.test("fetchPendenciasByNfs: lista vazia → não chama o Bastão", async () => {
  const cap: string[] = [];
  const r = await client(cap).fetchPendenciasByNfs([]);
  assertEquals(r.length, 0);
  assertEquals(cap.length, 0);
});

Deno.test("fetchPendenciasByNfs: gera AS DUAS formas (norm + padded 9) por NF", async () => {
  const cap: string[] = [];
  await client(cap).fetchPendenciasByNfs(["69866"]);
  assertEquals(cap.length, 1);
  const url = decodeURIComponent(cap[0]!);
  assert(url.includes("in.("), "deve usar nf=in.(...)");
  assert(url.includes("69866"), "forma normalizada");
  assert(url.includes("000069866"), "forma padded 9 dígitos");
});

Deno.test("fetchPendenciasByNfs: NF já com zeros à esquerda é normalizada (sem duplicar consulta)", async () => {
  const cap: string[] = [];
  await client(cap).fetchPendenciasByNfs(["000069866"]);
  assertEquals(cap.length, 1);
  const url = decodeURIComponent(cap[0]!);
  assert(url.includes("69866") && url.includes("000069866"));
});

Deno.test("fetchPendenciasByNfs: chunk de 50 → 60 NFs = 2 requests", async () => {
  const cap: string[] = [];
  const nfs = Array.from({ length: 60 }, (_, i) => String(100000 + i));
  await client(cap).fetchPendenciasByNfs(nfs);
  assertEquals(cap.length, 2);
});

Deno.test("fetchPendenciasByNfs: agrega as rows de todos os chunks", async () => {
  const cap: string[] = [];
  const rows = [{ nf: "1", id: "a" }, { nf: "2", id: "b" }];
  const nfs = Array.from({ length: 80 }, (_, i) => String(200000 + i));
  const r = await client(cap, rows).fetchPendenciasByNfs(nfs);
  // 80 NFs / chunk 50 = 2 requests; cada um devolve `rows` (2) → 4 no total
  assertEquals(cap.length, 2);
  assertEquals(r.length, 4);
});
