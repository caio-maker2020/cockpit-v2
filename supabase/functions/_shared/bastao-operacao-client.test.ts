// Guard — leitura da fila da Operação no Bastão (ADR 0041 D4). fetch FALSO.
// Rodar: deno test --no-check --allow-env supabase/functions/_shared/bastao-operacao-client.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createBastaoOperacaoClient, filtroOperacao, PAGINA_BASTAO } from "./bastao-operacao-client.ts";

const ENV = { url: "https://bastao.example", apiKey: "k" };

Deno.test("filtro: responsavel_atual=operacao OU (vazio E oc da Operação) — a hierarquia do state_pelo_bastao", () => {
  assertEquals(filtroOperacao([36, 13, 13, -1]), "(responsavel_atual.eq.operacao,and(responsavel_atual.is.null,cod_ultima_ocorrencia.in.(13,36)))");
  assertEquals(filtroOperacao([]), "(responsavel_atual.eq.operacao)");
});

Deno.test("pagina por Range até o fim; é o MESMO BastaoClient com um método a mais", async () => {
  const urls: string[] = [];
  const ranges: string[] = [];
  const fake = ((url: string, init: RequestInit) => {
    urls.push(url);
    ranges.push((init.headers as Record<string, string>).Range);
    const pagina = ranges.length === 1 ? PAGINA_BASTAO : 5;
    const corpo = Array.from({ length: pagina }, (_, i) => ({ id: `${ranges.length}-${i}`, ctrc: "X" }));
    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200, headers: { "content-range": `0-0/${PAGINA_BASTAO + 5}` } }));
  }) as unknown as typeof fetch;
  const c = createBastaoOperacaoClient({ env: ENV, fetch: fake });
  const r = await c.fetchPendenciasDaOperacao({ codigosOperacao: [13] });
  assertEquals([r.completo, r.pendencias.length, r.erro], [true, PAGINA_BASTAO + 5, null]);
  assertEquals(ranges, [`0-${PAGINA_BASTAO - 1}`, `${PAGINA_BASTAO}-${2 * PAGINA_BASTAO - 1}`]);
  assert(urls[0]!.startsWith("https://bastao.example/rest/v1/pendencias?"));
  assert(typeof c.fetchPendenciaByCtrc === "function" && typeof c.fetchPendenciasDoCockpit === "function");
});

Deno.test("falha no meio → completo=false (o materializador não encerra nada por 'sumiu')", async () => {
  let n = 0;
  const fake = (() => {
    n++;
    if (n === 1) return Promise.resolve(new Response(JSON.stringify(Array.from({ length: PAGINA_BASTAO }, () => ({ id: "x" }))), { status: 200 }));
    return Promise.resolve(new Response("boom", { status: 503 }));
  }) as unknown as typeof fetch;
  const r = await createBastaoOperacaoClient({ env: ENV, fetch: fake }).fetchPendenciasDaOperacao({ codigosOperacao: [13] });
  assertEquals([r.completo, r.pendencias.length], [false, PAGINA_BASTAO]);
  assert(r.erro?.includes("503"));
});
