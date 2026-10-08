// Guard — evidência da baixa (ADR 0040, INV-177): o worker só manda ao SSW os
// bytes que o motorista declarou (sha256 + mime + assinatura do arquivo), baixados
// do Roteirizador com o token da direção Cockpit → Roteirizador. Fetch falso.
// Rodar: deno test --no-check supabase/functions/_shared/baixa-motorista-evidencia.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { baixarEvidencia, conferirEvidencia, lerEnvEvidencia, sha256Hex } from "./baixa-motorista-evidencia.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7 conteúdo");
const ENV = { baseUrl: "https://ri.test", token: "tok-v1" };

function fetchFalso(resp: () => Response | Promise<Response>, visto: { url?: string; auth?: string | null } = {}): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    visto.url = String(url);
    visto.auth = new Headers(init?.headers).get("authorization");
    return Promise.resolve(resp());
  }) as typeof fetch;
}

Deno.test("env: RI_PONTE_BASE_URL (ou ROTEIRIZADOR_API_URL) + ROTEIRIZADOR_PONTE_TOKEN; nunca o token da v2", () => {
  assertEquals(lerEnvEvidencia({ RI_PONTE_BASE_URL: "https://ri.test/", ROTEIRIZADOR_PONTE_TOKEN: "t" }), { baseUrl: "https://ri.test", token: "t" });
  assertEquals(lerEnvEvidencia({ ROTEIRIZADOR_API_URL: "https://api", ROTEIRIZADOR_PONTE_TOKEN: "t" })?.baseUrl, "https://api");
  assertEquals(lerEnvEvidencia({ RI_PONTE_BASE_URL: "https://ri.test", PONTE_OPERACAO_TOKEN: "t2" }), null);
});

Deno.test("download: URL do contrato, Bearer do token, bytes e content-type", async () => {
  const visto: { url?: string; auth?: string | null } = {};
  const r = await baixarEvidencia("ev_1", ENV, fetchFalso(() => new Response(JPEG, { headers: { "content-type": "image/jpeg; charset=binary" } }), visto));
  assert(r.ok);
  assertEquals(visto.url, "https://ri.test/v3/ponte/evidencias/ev_1");
  assertEquals(visto.auth, "Bearer tok-v1");
  assertEquals(r.contentType, "image/jpeg");
  assertEquals([...r.bytes], [...JPEG]);
});

Deno.test("download: 5xx/429/rede = transitório (tenta depois); 4xx = definitivo; sem env = transitório", async () => {
  const r500 = await baixarEvidencia("e", ENV, fetchFalso(() => new Response("x", { status: 503 })));
  assert(!r500.ok && r500.tipo === "transitorio");
  const r429 = await baixarEvidencia("e", ENV, fetchFalso(() => new Response("x", { status: 429 })));
  assert(!r429.ok && r429.tipo === "transitorio");
  const r404 = await baixarEvidencia("e", ENV, fetchFalso(() => new Response("x", { status: 404 })));
  assert(!r404.ok && r404.tipo === "definitivo");
  const rede = await baixarEvidencia("e", ENV, (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch);
  assert(!rede.ok && rede.tipo === "transitorio");
  const semEnv = await baixarEvidencia("e", null, fetchFalso(() => new Response(JPEG)));
  assert(!semEnv.ok && semEnv.tipo === "transitorio");
});

Deno.test("download: arquivo grande demais é recusado sem ler tudo", async () => {
  const r = await baixarEvidencia("e", ENV, fetchFalso(() => new Response(JPEG, { headers: { "content-length": String(50 * 1024 * 1024) } })));
  assert(!r.ok && r.tipo === "definitivo");
});

Deno.test("conferência: sha256 certo + mime certo + assinatura certa → ok (JPEG e PDF)", async () => {
  assert((await conferirEvidencia({ bytes: JPEG, contentType: "image/jpeg" }, { sha256: await sha256Hex(JPEG), mime: "image/jpeg" })).ok);
  assert((await conferirEvidencia({ bytes: PDF, contentType: "application/pdf" }, { sha256: (await sha256Hex(PDF)).toUpperCase(), mime: "application/pdf" })).ok);
});

Deno.test("conferência: sha256 diferente → recusa (bytes trocados no caminho)", async () => {
  const r = await conferirEvidencia({ bytes: JPEG, contentType: "image/jpeg" }, { sha256: "0".repeat(64), mime: "image/jpeg" });
  assert(!r.ok && /sha256/.test(r.motivo));
});

Deno.test("conferência: mime servido diferente do declarado → recusa", async () => {
  const r = await conferirEvidencia({ bytes: JPEG, contentType: "image/png" }, { sha256: await sha256Hex(JPEG), mime: "image/jpeg" });
  assert(!r.ok && /mime/.test(r.motivo));
});

Deno.test("conferência: bytes que não são do tipo declarado (PDF dizendo JPEG) → recusa", async () => {
  const r = await conferirEvidencia({ bytes: PDF, contentType: "image/jpeg" }, { sha256: await sha256Hex(PDF), mime: "image/jpeg" });
  assert(!r.ok && /não são/.test(r.motivo));
});
