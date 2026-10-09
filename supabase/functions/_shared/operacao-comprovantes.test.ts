// Comprovantes da Operação lendo a fonte real (ADR 0042 D6). Sem rede: fetch falso.
// Rodar: deno test --no-check --allow-all supabase/functions/_shared/operacao-comprovantes.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dataIso,
  escopoDaSessao,
  excluidaDaLista,
  filtroUnidades,
  handleComprovantes,
  idadeDesde,
  mapearLinha,
  montarResposta,
  numero,
  PAGINA_COMPROVANTES,
  type DepsComprovantes,
  type LinhaViewPendente,
  type SessaoOpComprovantes,
} from "./operacao-comprovantes.ts";

// 09/10/2026 01:30 em UTC = 08/10 22:30 em São Paulo.
const AGORA = Date.parse("2026-10-09T01:30:00Z");
const ENV = { COMPROVANTES_SUPABASE_URL: "https://fonte.supabase.co/", COMPROVANTES_SUPABASE_ANON_KEY: "anon-x" };

const operador = (unidades: string[], tela = true): SessaoOpComprovantes => ({
  membro: { papel_op: "operador_op", unidades }, eh_gestor: false, eh_supervisor: false, flags: { operacao_tela: tela },
});
const supervisor: SessaoOpComprovantes = { membro: { papel_op: "supervisor_op", unidades: [] }, eh_gestor: false, eh_supervisor: true, flags: { operacao_tela: true } };
const gestor: SessaoOpComprovantes = { membro: null, eh_gestor: true, flags: { operacao_tela: false } };

function linhaView(p: Partial<LinhaViewPendente> = {}): LinhaViewPendente {
  return {
    compr_entrega_escaneado: false, data_escaneamento: null, unidade_receptora: "VGA", nome_base: "VARGINHA", tipo_base: "FILIAL",
    cliente_pagador: "CLIENTE A", descricao_ultima_ocorrencia: "MERCADORIA ENTREGUE", serie_numero_ctrc: "VGA100-1",
    placa_entrega: "abc1d23", valor_frete: "150.50", valor_mercadoria: 1200, data_entrega_realizada: "2026-10-01",
    tipo_do_documento: "CTRC", data_emissao: "2026-09-28", numero_da_nota_fiscal: "123", numero_pacote_arquivo: null,
    idade_pendencia_dias: null, faixa_idade: null, ...p,
  };
}

interface Chamada { url: string; method: string; headers: Record<string, string> }

function fonteFalsa(paginas: LinhaViewPendente[][], total: number | null = 1000) {
  const chamadas: Chamada[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    chamadas.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes("vw_comprovantes_entregues")) {
      if (total == null) return new Response("x", { status: 500 });
      return new Response(null, { status: 200, headers: { "content-range": `*/${total}` } });
    }
    const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
    return new Response(JSON.stringify(paginas[offset / PAGINA_COMPROVANTES] ?? []), { status: 200 });
  }) as typeof fetch;
  return { f, chamadas };
}

function deps(sessao: SessaoOpComprovantes | null, f: typeof fetch, env: Record<string, string> = ENV): DepsComprovantes {
  return { env, fetch: f, agoraMs: () => AGORA, sessao: () => Promise.resolve(sessao) };
}
const req = (auth = "Bearer jwt") => new Request("https://x/functions/v1/comprovantes-operacao", { method: "GET", headers: auth ? { Authorization: auth } : {} });

// ── escopo ───────────────────────────────────────────────────────────────────

Deno.test("escopo: gestor e supervisor veem todas; operador só as dele; sem unidade = vazio, nunca todas", () => {
  assertEquals(escopoDaSessao(gestor), { ok: true, escopo: { todas: true, unidades: [] } });
  assertEquals(escopoDaSessao(supervisor), { ok: true, escopo: { todas: true, unidades: [] } });
  assertEquals(escopoDaSessao(operador([" vga", "POA", "VGA"])), { ok: true, escopo: { todas: false, unidades: ["POA", "VGA"] } });
  assertEquals(escopoDaSessao(operador([])), { ok: true, escopo: { todas: false, unidades: [] } });
  assertEquals(escopoDaSessao({ ...operador(["VGA"]), membro: { papel_op: "gerente_op", unidades: ["VGA"] } }), { ok: true, escopo: { todas: false, unidades: ["VGA"] } });
});

Deno.test("escopo: sem membro, sessão nula ou tela desligada → sem acesso (gestor passa mesmo com a tela desligada)", () => {
  assertEquals(escopoDaSessao(null), { ok: false, erro: "sem_acesso" });
  assertEquals(escopoDaSessao({ membro: null, eh_gestor: false }), { ok: false, erro: "sem_acesso" });
  assertEquals(escopoDaSessao(operador(["VGA"], false)), { ok: false, erro: "tela_desligada" });
  assertEquals(escopoDaSessao({ ...supervisor, flags: { operacao_tela: false } }), { ok: false, erro: "tela_desligada" });
});

Deno.test("filtro de unidade do PostgREST com aspas", () => {
  assertEquals(filtroUnidades(["VGA", "POA"]), 'in.("VGA","POA")');
});

// ── normalização ─────────────────────────────────────────────────────────────

Deno.test("datas: YYYY-MM-DD fica; timestamp com fuso vira o dia de São Paulo; sem fuso fica o dia escrito", () => {
  assertEquals(dataIso("2026-10-01"), "2026-10-01");
  assertEquals(dataIso("2026-10-02T01:00:00Z"), "2026-10-01"); // 22h do dia 1 em SP
  assertEquals(dataIso("2026-10-02T01:00:00+00:00"), "2026-10-01");
  assertEquals(dataIso("2026-10-02 01:00:00"), "2026-10-02");
  assertEquals(dataIso("02/10/2026"), "2026-10-02");
  assertEquals(dataIso(""), null);
  assertEquals(dataIso("lixo"), null);
});

Deno.test("idade: dias corridos até hoje em São Paulo (não em UTC)", () => {
  // Em UTC já é 09/10; em SP ainda é 08/10.
  assertEquals(idadeDesde("2026-10-08", AGORA), 0);
  assertEquals(idadeDesde("2026-10-01", AGORA), 7);
  assertEquals(idadeDesde("2026-10-20", AGORA), 0);
  assertEquals(idadeDesde(null, AGORA), null);
});

Deno.test("número: aceita number, string com ponto e com vírgula", () => {
  assertEquals(numero(10), 10);
  assertEquals(numero("150.50"), 150.5);
  assertEquals(numero("1.234,56"), 1234.56);
  assertEquals(numero(null), null);
  assertEquals(numero("x"), null);
});

Deno.test("mapear: idade da fonte manda; sem ela, calcula pela entrega", () => {
  const a = mapearLinha(linhaView({ idade_pendencia_dias: 12 }), AGORA)!;
  assertEquals(a.idade_dias, 12);
  const b = mapearLinha(linhaView(), AGORA)!;
  assertEquals(b.idade_dias, 7);
  assertEquals(b.placa, "ABC1D23");
  assertEquals(b.valor_frete, 150.5);
  assertEquals(b.base_tipo, "filial");
  assertEquals(b.data_emissao, "2026-09-28");
  assertEquals(mapearLinha(linhaView({ serie_numero_ctrc: null }), AGORA), null);
});

Deno.test("exclusões: CTRC OVD352980-1 e ressarcimento (qualquer caixa)", () => {
  assert(excluidaDaLista({ serie_numero_ctrc: " ovd352980-1 " }));
  assert(excluidaDaLista({ serie_numero_ctrc: "X", descricao_ultima_ocorrencia: "Aguardando ressarcimento" }));
  assert(!excluidaDaLista({ serie_numero_ctrc: "X", descricao_ultima_ocorrencia: null }));
});

Deno.test("montar: exclui, conta exclusões, maior data de escaneamento, e escopo restrito nunca vaza outra unidade", () => {
  const r = montarResposta(
    [
      linhaView({ serie_numero_ctrc: "A-1", data_escaneamento: "2026-10-07T12:00:00-03:00" }),
      linhaView({ serie_numero_ctrc: "OVD352980-1" }),
      linhaView({ serie_numero_ctrc: "B-1", descricao_ultima_ocorrencia: "RESSARCIMENTO" , data_escaneamento: "2026-10-08" }),
      linhaView({ serie_numero_ctrc: "C-1", unidade_receptora: "POA" }),
      linhaView({ serie_numero_ctrc: "A-1", data_escaneamento: "2026-10-05" }),
    ],
    500,
    { todas: false, unidades: ["VGA"] },
    AGORA,
  );
  assertEquals(r.linhas.map((l) => l.ctrc), ["A-1"]);
  assertEquals(r.excluidas, 2);
  assertEquals(r.ultimaAtualizacao, "2026-10-08");
  assertEquals(r.entregues, 500);
});

// ── handler ──────────────────────────────────────────────────────────────────

Deno.test("handler: sem JWT → 401; sem membro → 403; tela desligada → 403", async () => {
  const { f, chamadas } = fonteFalsa([]);
  assertEquals((await handleComprovantes(req(""), deps(supervisor, f))).status, 401);
  const r403 = await handleComprovantes(req(), deps({ membro: null, eh_gestor: false }, f));
  assertEquals(r403.status, 403);
  assertEquals((await r403.json()).erro, "sem_acesso");
  assertEquals((await (await handleComprovantes(req(), deps(operador(["VGA"], false), f))).json()).erro, "tela_desligada");
  assertEquals(chamadas.length, 0);
});

Deno.test("handler: sem credencial da fonte → 503 comprovantes_sem_credencial, sem chamar nada", async () => {
  const { f, chamadas } = fonteFalsa([]);
  const r = await handleComprovantes(req(), deps(supervisor, f, {}));
  assertEquals(r.status, 503);
  assertEquals(await r.json(), { ok: false, erro: "comprovantes_sem_credencial" });
  assertEquals(chamadas.length, 0);
});

Deno.test("handler: operador sem unidade → lista vazia sem perguntar à fonte", async () => {
  const { f, chamadas } = fonteFalsa([[linhaView()]]);
  const r = await handleComprovantes(req(), deps(operador([]), f));
  const b = await r.json();
  assertEquals(r.status, 200);
  assertEquals(b.linhas, []);
  assertEquals(b.entregues, 0);
  assertEquals(chamadas.length, 0);
});

Deno.test("handler: operador → filtro de unidade no servidor, só GET/HEAD, ordem estável, paginação de 1000", async () => {
  const pagina1 = Array.from({ length: PAGINA_COMPROVANTES }, (_, i) => linhaView({ serie_numero_ctrc: `VGA${String(i).padStart(4, "0")}-1` }));
  const pagina2 = [linhaView({ serie_numero_ctrc: "VGA9999-1" })];
  const { f, chamadas } = fonteFalsa([pagina1, pagina2], 4000);
  const r = await handleComprovantes(req(), deps(operador(["VGA"]), f));
  const b = await r.json();
  assertEquals(r.status, 200);
  assertEquals(b.linhas.length, PAGINA_COMPROVANTES + 1);
  assertEquals(b.entregues, 4000);
  assertEquals(b.escopo, { todas: false, unidades: ["VGA"] });
  for (const c of chamadas) {
    assert(c.method === "GET" || c.method === "HEAD", c.method);
    assert(c.url.startsWith("https://fonte.supabase.co/rest/v1/"), c.url);
    assertEquals(new URL(c.url).searchParams.get("unidade_receptora"), 'in.("VGA")');
    assertEquals(c.headers["apikey"], "anon-x");
  }
  const pend = chamadas.filter((c) => c.url.includes("vw_pendencias_comprovante_entrega"));
  assertEquals(pend.map((c) => new URL(c.url).searchParams.get("offset")), ["0", "1000"]);
  assert(pend.every((c) => new URL(c.url).searchParams.get("order") === "serie_numero_ctrc.asc"));
  const cont = chamadas.find((c) => c.url.includes("vw_comprovantes_entregues"))!;
  assertEquals(cont.method, "HEAD");
  assertEquals(cont.headers["Prefer"], "count=exact");
});

Deno.test("handler: supervisor → sem filtro de unidade; contagem que falha vira entregues null (não derruba)", async () => {
  const { f, chamadas } = fonteFalsa([[linhaView(), linhaView({ serie_numero_ctrc: "POA1-1", unidade_receptora: "POA" })]], null);
  const b = await (await handleComprovantes(req(), deps(supervisor, f))).json();
  assertEquals(b.linhas.length, 2);
  assertEquals(b.entregues, null);
  assert(chamadas.every((c) => !new URL(c.url).searchParams.has("unidade_receptora")));
});

Deno.test("handler: fonte com erro → 502 fonte_falhou; sessão que falha → 502", async () => {
  const f = (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
  const r = await handleComprovantes(req(), deps(supervisor, f));
  assertEquals(r.status, 502);
  assertEquals((await r.json()).erro, "fonte_falhou");
  const d = deps(supervisor, f);
  d.sessao = () => Promise.reject(new Error("rpc"));
  assertEquals((await handleComprovantes(req(), d)).status, 502);
});

Deno.test("handler: OPTIONS responde CORS; PUT é recusado", async () => {
  const { f } = fonteFalsa([]);
  assertEquals((await handleComprovantes(new Request("https://x", { method: "OPTIONS" }), deps(supervisor, f))).status, 204);
  assertEquals((await handleComprovantes(new Request("https://x", { method: "PUT", headers: { Authorization: "Bearer j" } }), deps(supervisor, f))).status, 405);
});
