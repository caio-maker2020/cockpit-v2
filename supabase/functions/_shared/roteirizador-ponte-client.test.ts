// Guard — adapter da ponte Roteirizador ↔ Cockpit (ADR 0034).
// Trava: env ausente = desligado sem rede; 200/201/200-repetido; 400 sem retry;
// 503/5xx com retry curto; timeout; corpo fora do contrato; Bearer + URL.
// Rodar: deno test --no-check supabase/functions/_shared/roteirizador-ponte-client.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createRoteirizadorPonteClient,
  readRoteirizadorPonteEnv,
  type RoteirizadorPonteEnv,
} from "./roteirizador-ponte-client.ts";

const ENV: RoteirizadorPonteEnv = { apiUrl: "https://ri.example", token: "tok-123" };

interface Chamada { url: string; init: RequestInit }

function fetchRoteiro(respostas: Array<Response | Error | "pendura">, chamadas: Chamada[]): typeof fetch {
  let i = 0;
  // deno-lint-ignore no-explicit-any
  return ((url: any, init: RequestInit) => {
    chamadas.push({ url: String(url), init });
    const r = respostas[Math.min(i++, respostas.length - 1)];
    if (r === "pendura") {
      return new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    }
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r.clone());
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const semEspera = { sleep: () => Promise.resolve(), backoffBaseMs: 1 };

const NOTA = {
  noPlano: true, ctrc: "VGA123", dataRef: "2026-09-25", rotaNome: "V07", statusAprovacao: "aprovada",
  carro: { indice: 1, perfil: "VAN", placa: "ABC1D23", motorista: "João", telefoneMotorista: null },
  ordem: 4, cidade: "AIURUOCA", statusExecucao: "pendente", motivoExecucao: null,
  fotoEvidenciaUrl: null, decididoEm: null, compromissos: [], linkRastreio: "https://ri/rastreio/t",
};

const COMPROMISSO = {
  ctrc: "VGA123", tipo: "reentrega" as const, data: "2026-09-26", janelaInicio: "09:00",
  janelaFim: "11:00", cardId: "card-77", idempotencyKey: "card-77:reentrega:2026-09-26",
};

Deno.test("env: ausente ou vazia = desligado (null); URL perde a barra final", () => {
  assertEquals(readRoteirizadorPonteEnv({}), null);
  assertEquals(readRoteirizadorPonteEnv({ ROTEIRIZADOR_API_URL: "https://x" }), null);
  assertEquals(readRoteirizadorPonteEnv({ ROTEIRIZADOR_API_URL: " ", ROTEIRIZADOR_PONTE_TOKEN: "t" }), null);
  assertEquals(
    readRoteirizadorPonteEnv({ ROTEIRIZADOR_API_URL: "https://x/", ROTEIRIZADOR_PONTE_TOKEN: "t" }),
    { apiUrl: "https://x", token: "t" },
  );
});

Deno.test("desligado: nenhuma chamada de rede, erro tipado, nunca lança", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({ env: null, fetch: fetchRoteiro([json(200, NOTA)], chamadas) });
  assertEquals(c.ligado, false);
  const r = await c.consultarNota("VGA123");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.erro.tipo, "desligado");
  const e = await c.listarEventos(0);
  assertEquals(e.ok, false);
  assertEquals(chamadas.length, 0);
});

Deno.test("GET /notas/:ctrc 200: URL, Bearer e corpo do contrato", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(200, NOTA)], chamadas) });
  const r = await c.consultarNota(" VGA 123/4 ");
  assert(r.ok);
  assertEquals(chamadas[0]!.url, "https://ri.example/v3/ponte/notas/VGA%20123%2F4");
  assertEquals((chamadas[0]!.init.headers as Record<string, string>)["Authorization"], "Bearer tok-123");
  if (r.ok && r.dados.noPlano) {
    assertEquals(r.dados.carro?.motorista, "João");
    assertEquals(r.dados.linkRastreio, "https://ri/rastreio/t");
  }
});

Deno.test("GET /notas fora do plano: noPlano=false", async () => {
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(200, { noPlano: false })], []) });
  const r = await c.consultarNota("X1");
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.dados.noPlano, false);
    assertEquals(r.dados.compromissos, []);
  }
});

Deno.test("POST /compromissos 201 = criado", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(201, { id: 9 })], chamadas) });
  const r = await c.registrarCompromisso(COMPROMISSO);
  assert(r.ok);
  if (r.ok) assertEquals([r.dados.criado, r.dados.status], [true, 201]);
  assertEquals(chamadas[0]!.init.method, "POST");
  assertEquals(chamadas[0]!.url, "https://ri.example/v3/ponte/compromissos");
  assertEquals(JSON.parse(String(chamadas[0]!.init.body)), COMPROMISSO);
});

Deno.test("POST /compromissos 200 = mesma idempotencyKey (repetido, não duplicou)", async () => {
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(200, { id: 9 })], []) });
  const r = await c.registrarCompromisso(COMPROMISSO);
  assert(r.ok);
  if (r.ok) assertEquals([r.dados.criado, r.dados.status], [false, 200]);
});

Deno.test("POST /compromissos 400 = inválido, SEM retry", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({
    env: ENV, ...semEspera,
    fetch: fetchRoteiro([json(400, { erro: "data inválida" })], chamadas),
  });
  const r = await c.registrarCompromisso(COMPROMISSO);
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.erro.tipo, "invalido");
    assertEquals(r.erro.status, 400);
    assert(r.erro.mensagem.includes("data inválida"));
  }
  assertEquals(chamadas.length, 1);
});

Deno.test("POST sem idempotencyKey: recusado localmente, sem rede", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(201, {})], chamadas) });
  const r = await c.registrarCompromisso({ ...COMPROMISSO, idempotencyKey: "" });
  assertEquals(r.ok, false);
  assertEquals(chamadas.length, 0);
});

Deno.test("401 = nao_autorizado, sem retry", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({ env: ENV, ...semEspera, fetch: fetchRoteiro([json(401, {})], chamadas) });
  const r = await c.consultarNota("X");
  if (!r.ok) assertEquals(r.erro.tipo, "nao_autorizado");
  assertEquals(chamadas.length, 1);
});

Deno.test("503 (ponte sem token no servidor): retry curto e erro indisponivel", async () => {
  const chamadas: Chamada[] = [];
  const esperas: number[] = [];
  const c = createRoteirizadorPonteClient({
    env: ENV, maxTentativas: 3, backoffBaseMs: 10,
    sleep: (ms) => { esperas.push(ms); return Promise.resolve(); },
    fetch: fetchRoteiro([json(503, { erro: "ponte desligada" })], chamadas),
  });
  const r = await c.consultarNota("X");
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.erro.tipo, "indisponivel");
    assertEquals(r.erro.status, 503);
    assertEquals(r.erro.tentativas, 3);
  }
  assertEquals(chamadas.length, 3);
  assertEquals(esperas, [10, 20]); // exponencial
});

Deno.test("5xx transitório seguido de 200: recupera no retry", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({
    env: ENV, ...semEspera,
    fetch: fetchRoteiro([json(502, {}), json(200, NOTA)], chamadas),
  });
  const r = await c.consultarNota("VGA123");
  assert(r.ok);
  assertEquals(chamadas.length, 2);
});

Deno.test("erro de rede: retry e erro tipado rede", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({
    env: ENV, ...semEspera, maxTentativas: 2,
    fetch: fetchRoteiro([new TypeError("connection refused")], chamadas),
  });
  const r = await c.consultarNota("X");
  if (!r.ok) assertEquals(r.erro.tipo, "rede");
  assertEquals(chamadas.length, 2);
});

Deno.test("timeout: aborta a tentativa e devolve erro timeout (sem lançar)", async () => {
  const chamadas: Chamada[] = [];
  const c = createRoteirizadorPonteClient({
    env: ENV, ...semEspera, timeoutMs: 20, maxTentativas: 2,
    fetch: fetchRoteiro(["pendura"], chamadas),
  });
  const r = await c.consultarNota("X");
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.erro.tipo, "timeout");
    assertEquals(r.erro.tentativas, 2);
  }
  assertEquals(chamadas.length, 2);
});

Deno.test("GET /eventos: cursor e limite na query; limite limitado a 200", async () => {
  const chamadas: Chamada[] = [];
  const pagina = {
    desde: 5, proximo: 10,
    eventos: [{ id: 10, tipo: "nota_removida", dataRef: "2026-09-25", rotaNome: "V07", ctrc: "VGA123",
      motivo: "cliente fechado", fotoEvidenciaUrl: null, ator: "João" }],
  };
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(200, pagina)], chamadas) });
  const r = await c.listarEventos(5, 999);
  assert(r.ok);
  assertEquals(chamadas[0]!.url, "https://ri.example/v3/ponte/eventos?desde=5&limite=200");
  if (r.ok) {
    assertEquals(r.dados.proximo, 10);
    assertEquals(r.dados.eventos.length, 1);
  }
});

Deno.test("2xx com corpo fora do contrato = resposta_invalida (não quebra o chamador)", async () => {
  const c = createRoteirizadorPonteClient({ env: ENV, fetch: fetchRoteiro([json(200, { foo: 1 })], []) });
  const r = await c.listarEventos(0);
  if (!r.ok) assertEquals(r.erro.tipo, "resposta_invalida");
  else throw new Error("deveria falhar");
  const c2 = createRoteirizadorPonteClient({
    env: ENV, fetch: fetchRoteiro([new Response("<html>", { status: 200 })], []),
  });
  const r2 = await c2.consultarNota("X");
  if (!r2.ok) assertEquals(r2.erro.tipo, "resposta_invalida");
  else throw new Error("deveria falhar");
});
