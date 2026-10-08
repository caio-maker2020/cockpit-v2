// Guard — `dataHoraEvento` opcional no `lancarOcorrenciaPortal` (ADR 0040, INV-176).
//
// O arquivo do cliente SSW é dos mais mexidos do repositório e o lançamento do
// Relacionamento passa por ele. Este teste trava as DUAS metades da mudança:
//   1. REGRESSÃO: sem o parâmetro, o submit (act=II3) sai IGUAL ao de antes —
//      data/hora = agora − 3 h − 2 min (Brasília com margem de relógio), e o
//      corpo inteiro é idêntico ao de uma chamada com o mesmo relógio;
//   2. hora real: com o parâmetro, f4/f5 levam a hora do evento; hora futura é
//      limitada a agora − 2 min; data inválida não chega a tocar o SSW.
// Não toca a rede: substitui `globalThis.fetch` e `Date.now`.
// Rodar: deno test --no-check supabase/functions/_shared/ssw-internal-client-data-hora-evento.test.ts

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lancarOcorrenciaPortal, type LancarOcorrenciaPortalOpts, type SswSessao } from "./ssw-internal-client.ts";

const HTML_ACT_O = `<html><body>
  <input type=hidden name=nomeFoto value="/tmp/foto1.jpg">
  <input type=hidden name=extraFoto value="XYZ123">
  <input type=hidden name=tipoFoto value="instr_foto">
</body></html>`;
const DETALHE = { nf: "000000001", seq_ctrc: "9999", familia: "1", html: "" };
// 2026-10-07 15:30:00 UTC = 12:30 em Brasília
const AGORA = Date.UTC(2026, 9, 7, 15, 30, 0);

function sessaoFake(): SswSessao {
  return { cookies: new Map([["ssw_dom", "SEP"]]), criadoEm: AGORA, tokenExpMs: AGORA + 3_600_000 };
}

async function capturar(extra: Partial<LancarOcorrenciaPortalOpts>): Promise<{ body: string; ok: boolean; fetches: number; erro?: string }> {
  const fetchOriginal = globalThis.fetch;
  const nowOriginal = Date.now;
  let body = "";
  let fetches = 0;
  Date.now = () => AGORA;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    fetches++;
    const u = String(url);
    if (u.includes("/bin/ssw0053")) return Promise.resolve(new Response(HTML_ACT_O, { status: 200 }));
    if (u.includes("/bin/ssw0122")) {
      body = String(init?.body ?? "");
      return Promise.resolve(new Response("<!--GoBack-->", { status: 200 }));
    }
    return Promise.reject(new Error(`URL inesperada: ${u}`));
  }) as typeof fetch;
  try {
    const r = await lancarOcorrenciaPortal(sessaoFake(), DETALHE, { codigoSsw: 1, texto: "ENTREGUE A MARIA", ...extra });
    return { body, ok: r.ok, fetches, erro: r.ok ? undefined : r.error };
  } finally {
    globalThis.fetch = fetchOriginal;
    Date.now = nowOriginal;
  }
}

const campo = (body: string, nome: string) => body.split("&").find((p) => p.startsWith(`${nome}=`))?.slice(nome.length + 1);

Deno.test("REGRESSÃO: sem dataHoraEvento, f4/f5 = agora − 3 h − 2 min (comportamento de sempre)", async () => {
  const r = await capturar({});
  assert(r.ok);
  assertEquals(campo(r.body, "f4"), "071026"); // DDMMYY
  assertEquals(campo(r.body, "f5"), "1228"); // 12:30 BRT − 2 min
});

Deno.test("REGRESSÃO: sem o parâmetro o corpo do submit é idêntico ao de 'evento = agora − 2 min'", async () => {
  // Prova que o caminho antigo não mudou: o default é exatamente o limite.
  const sem = await capturar({});
  const limite = await capturar({ dataHoraEvento: new Date(AGORA - 2 * 60_000) });
  assertEquals(sem.body, limite.body);
  assertStringIncludes(sem.body, "act=II3");
  assertStringIncludes(sem.body, "f3=01");
  assertStringIncludes(sem.body, "f8=N");
});

Deno.test("hora real: dataHoraEvento no passado vai em f4/f5 (Brasília)", async () => {
  const r = await capturar({ dataHoraEvento: new Date("2026-10-06T21:05:40-03:00") });
  assert(r.ok);
  assertEquals(campo(r.body, "f4"), "061026");
  assertEquals(campo(r.body, "f5"), "2105");
});

Deno.test("hora nunca futura: evento depois de agora − 2 min é limitado a agora − 2 min", async () => {
  const r = await capturar({ dataHoraEvento: new Date(AGORA + 60 * 60_000) });
  assertEquals(campo(r.body, "f4"), "071026");
  assertEquals(campo(r.body, "f5"), "1228");
});

Deno.test("data inválida: nada é enviado ao SSW (zero fetch)", async () => {
  const r = await capturar({ dataHoraEvento: new Date("não é data") });
  assertEquals(r.ok, false);
  assertEquals(r.fetches, 0);
  assertStringIncludes(r.erro ?? "", "dataHoraEvento inválida");
});
