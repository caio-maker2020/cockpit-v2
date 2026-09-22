// =============================================================================
// Guard de nao-regressao do SUBMIT da segregacao (Caio 2026-09-21).
//
// A cerca (`segregacao-ctrc.ts`) ja tem teste proprio: ela decide SE pode.
// Este aqui testa o outro lado, que nenhum teste cobria: o que sai no BODY do
// POST act=II3 pro portal SSW. Sem isto, trocar `f8` por `f11` num refactor
// passaria verde — e o efeito seria responder um Fale Conosco indevido E nao
// segregar (falha silenciosa com cara de sucesso).
//
// Nao toca a rede: substitui `globalThis.fetch` e captura o corpo do submit.
// =============================================================================
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lancarOcorrenciaPortal, type SswSessao } from "./ssw-internal-client.ts";

// HTML minimo do act=O: precisa de `extraFoto`, senao a funcao aborta antes.
const HTML_ACT_O = `<html><body>
  <input type=hidden name=nomeFoto value="/tmp/foto1.jpg">
  <input type=hidden name=extraFoto value="XYZ123">
  <input type=hidden name=tipoFoto value="instr_foto">
</body></html>`;

function sessaoFake(): SswSessao {
  return {
    cookies: new Map([["ssw_dom", "SEP"], ["JSESSIONID", "abc"]]),
    criadoEm: Date.now(),
    tokenExpMs: Date.now() + 3_600_000,
  };
}

const DETALHE = { nf: "000000001", seq_ctrc: "9999", familia: "1", html: "" };

/** Roda o lancamento com fetch mockado e devolve o body do submit (act=II3). */
async function capturarSubmit(
  segregarCtrc: boolean | undefined,
): Promise<{ body: string; ok: boolean }> {
  const fetchOriginal = globalThis.fetch;
  let bodyII3 = "";
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/bin/ssw0053")) {
      return Promise.resolve(new Response(HTML_ACT_O, { status: 200 }));
    }
    if (u.includes("/bin/ssw0122")) {
      bodyII3 = String(init?.body ?? "");
      return Promise.resolve(new Response("<!--GoBack-->", { status: 200 }));
    }
    return Promise.reject(new Error(`URL inesperada no teste: ${u}`));
  }) as typeof fetch;
  try {
    const r = await lancarOcorrenciaPortal(sessaoFake(), DETALHE, {
      codigoSsw: 54,
      texto: "CLIENTE NOTIFICADO",
      ...(segregarCtrc === undefined ? {} : { segregarCtrc }),
    });
    return { body: bodyII3, ok: r.ok };
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

Deno.test("marcada: o submit leva f8=S (Segregar CTRC)", async () => {
  const { body, ok } = await capturarSubmit(true);
  assertEquals(ok, true, "o submit deveria ter sido aceito no mock");
  assertStringIncludes(body, "f8=S");
});

Deno.test("NAO marcada: o submit leva f8=N — comportamento historico", async () => {
  const { body } = await capturarSubmit(false);
  assertStringIncludes(body, "f8=N");
});

Deno.test("omitida: default e f8=N (fail-closed)", async () => {
  const { body } = await capturarSubmit(undefined);
  assertStringIncludes(body, "f8=N");
});

Deno.test("f11 (Resposta a um Fale Conosco) fica N mesmo segregando", async () => {
  // f8 e f11 sao os DOIS campos S/N da tela 101. Trocar um pelo outro responde
  // um Fale Conosco ao cliente e nao segrega nada.
  const { body } = await capturarSubmit(true);
  assertStringIncludes(body, "f11=N");
  assertEquals(body.includes("f11=S"), false, "f11 NUNCA pode sair como S");
});

Deno.test("segregar nao contamina o texto da ocorrencia", async () => {
  // `segregar_ctrc` e flag de CONTROLE: fora da whitelist EXTRAS_PRA_DESCRICAO_SSW.
  // O texto que chega ao SSW tem de ser o mesmo com ou sem a marcacao.
  const comSegregacao = await capturarSubmit(true);
  const semSegregacao = await capturarSubmit(false);
  const soTexto = (b: string) =>
    b.split("&").filter((p) => p.startsWith("f6=") || p.startsWith("observ=")).join("&");
  assertEquals(soTexto(comSegregacao.body), soTexto(semSegregacao.body));
  assertEquals(comSegregacao.body.toLowerCase().includes("segregar_ctrc"), false);
});
