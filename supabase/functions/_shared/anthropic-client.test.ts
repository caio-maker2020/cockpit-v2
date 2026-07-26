// Testes do wrapper Anthropic — foco na TELEMETRIA por attempt:
//  - sucesso → 1 registro attempt=1 status=success (tokens + request_id)
//  - retry de JSON (completeJson) → 2 registros (attempt 1 e 2), custo NÃO escondido
//  - erro HTTP → registro status=error attempt=1 tokens 0, e a chamada lança
// fetch é injetado (fake) — sem rede.
// Rodar: deno test supabase/functions/_shared/anthropic-client.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type AnthropicUsageRecord, createAnthropicClient } from "./anthropic-client.ts";

function anthropicResp(
  text: string,
  opts: { status?: number; inTok?: number; outTok?: number; reqId?: string } = {},
): Response {
  const body = JSON.stringify({
    content: [{ type: "text", text }],
    usage: { input_tokens: opts.inTok ?? 10, output_tokens: opts.outTok ?? 5 },
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
  });
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "request-id": opts.reqId ?? "req_x" },
  });
}

function errResp(status: number): Response {
  return new Response("upstream error", { status, headers: { "request-id": "req_err" } });
}

function fakeFetch(queue: Response[]): typeof fetch {
  let i = 0;
  return ((_input: string | URL | Request, _init?: RequestInit) => {
    const r = queue[i] ?? queue[queue.length - 1];
    i++;
    return Promise.resolve(r!);
  }) as unknown as typeof fetch;
}

Deno.test("complete: sucesso → 1 registro attempt=1 success com tokens e request_id", async () => {
  const recs: AnthropicUsageRecord[] = [];
  const client = createAnthropicClient({
    env: { apiKey: "k" },
    fetch: fakeFetch([anthropicResp("ok", { inTok: 12, outTok: 7, reqId: "req_a" })]),
    onUsage: (r) => { recs.push(r); },
  });
  const res = await client.complete({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 50,
    meta: { functionName: "teste" },
  });
  assertEquals(res.text, "ok");
  assertEquals(recs.length, 1);
  assertEquals(recs[0]!.attempt, 1);
  assertEquals(recs[0]!.status, "success");
  assertEquals(recs[0]!.inputTokens, 12);
  assertEquals(recs[0]!.outputTokens, 7);
  assertEquals(recs[0]!.requestId, "req_a");
  assertEquals(recs[0]!.functionName, "teste");
});

Deno.test("completeJson: retry de JSON conta como attempt SEPARADO (1 e 2)", async () => {
  const recs: AnthropicUsageRecord[] = [];
  const client = createAnthropicClient({
    env: { apiKey: "k" },
    fetch: fakeFetch([
      anthropicResp("isto não é json"), // attempt 1 → tryParseJson falha
      anthropicResp('{"ok": true}'), //    attempt 2 → parseia
    ]),
    onUsage: (r) => { recs.push(r); },
  });
  const out = await client.completeJson<{ ok: boolean }>({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 50,
  });
  assertEquals(out.ok, true);
  assertEquals(recs.length, 2);
  assertEquals(recs.map((r) => r.attempt), [1, 2]);
  assertEquals(recs.every((r) => r.status === "success"), true);
});

Deno.test("complete: erro HTTP → registro status=error attempt=1 tokens 0 + lança", async () => {
  const recs: AnthropicUsageRecord[] = [];
  const client = createAnthropicClient({
    env: { apiKey: "k" },
    fetch: fakeFetch([errResp(500)]),
    onUsage: (r) => { recs.push(r); },
  });
  let threw = false;
  try {
    await client.complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(recs.length, 1);
  assertEquals(recs[0]!.status, "error");
  assertEquals(recs[0]!.attempt, 1);
  assertEquals(recs[0]!.inputTokens, 0);
  assertEquals(recs[0]!.outputTokens, 0);
});

// =============================================================================
// INV-055 — resposta CORTADA por max_tokens (incidente 26/07, NF 164346):
// o retry tem que REMOVER A CAUSA (teto maior), e leitura parcial vale mais
// que devolver nada e deixar o card órfão.
// =============================================================================

import { repararJsonTruncado } from "./anthropic-client.ts";

function respTruncada(text: string, outTok = 700): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 8000, output_tokens: outTok },
      model: "claude-sonnet-4-6",
      stop_reason: "max_tokens",
    }),
    { status: 200, headers: { "request-id": "req_trunc" } },
  );
}

Deno.test("repararJsonTruncado: fecha JSON cortado no meio de string", () => {
  const cortado = '{"oc_sugerida": 33, "confianca": 0.82, "motivo": "Extravio total confirm';
  const reparado = repararJsonTruncado(cortado);
  const obj = JSON.parse(reparado!);
  assertEquals(obj.oc_sugerida, 33);
  assertEquals(obj.confianca, 0.82);
});

Deno.test("repararJsonTruncado: descarta chave sem valor e mantém o resto", () => {
  const cortado = '{"oc_sugerida": 54, "confianca": 0.4, "pendencias_resposta_cliente":';
  const obj = JSON.parse(repararJsonTruncado(cortado)!);
  assertEquals(obj.oc_sugerida, 54);
  assertEquals(obj.pendencias_resposta_cliente, undefined);
});

Deno.test("repararJsonTruncado: array cortado mantém itens completos", () => {
  const cortado = '{"oc": 21, "pend": ["falta data", "falta ender';
  const obj = JSON.parse(repararJsonTruncado(cortado)!);
  assertEquals(obj.oc, 21);
  assertEquals(obj.pend, ["falta data"]);
});

Deno.test("repararJsonTruncado: sem nada aproveitável devolve null", () => {
  assertEquals(repararJsonTruncado("desculpe, não consigo responder"), null);
});

Deno.test("completeJson: truncou → 2ª tentativa vai com teto MAIOR (não repete o corte)", async () => {
  const corpos: string[] = [];
  const fetchSpy = ((_u: string | URL | Request, init?: RequestInit) => {
    corpos.push(String(init?.body ?? ""));
    return Promise.resolve(
      corpos.length === 1
        ? respTruncada('{"oc_sugerida": 33, "confianca": 0.82, "motivo": "cortad')
        : anthropicResp('{"oc_sugerida":33,"confianca":0.82,"motivo":"ok"}'),
    );
  }) as unknown as typeof fetch;

  const client = createAnthropicClient({ env: { apiKey: "k" }, fetch: fetchSpy });
  const out = await client.completeJson<{ oc_sugerida: number; motivo: string }>({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "x" }],
    maxTokens: 700,
  });
  assertEquals(out.motivo, "ok"); // veio da 2ª, completa
  assertEquals(JSON.parse(corpos[0]!).max_tokens, 700);
  assertEquals(JSON.parse(corpos[1]!).max_tokens, 1400); // dobrou = removeu a causa
});

Deno.test("completeJson: cortou nas DUAS → entrega leitura parcial avisando (card nunca fica órfão)", async () => {
  const client = createAnthropicClient({
    env: { apiKey: "k" },
    fetch: fakeFetch([
      respTruncada('{"oc_sugerida": 33, "confianca": 0.82, "motivo": "Extravio total confirm'),
      respTruncada('{"oc_sugerida": 33, "confianca": 0.82, "motivo": "Extravio total confirmado mas ainda cort'),
    ]),
  });
  const avisos: Array<{ attempt: number; stopReason: string | null }> = [];
  const out = await client.completeJson<{ oc_sugerida: number; confianca: number }>({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "x" }],
    maxTokens: 700,
    onJsonReparado: (i) => avisos.push(i),
  });
  assertEquals(out.oc_sugerida, 33);
  assertEquals(avisos.length, 1);
  assertEquals(avisos[0]!.stopReason, "max_tokens");
});
