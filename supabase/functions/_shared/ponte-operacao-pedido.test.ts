// Guard — pedido da operação (ADR 0039, contrato v2 parte B). Trava:
//   - validação: pessoa identificada obrigatória, automação recusada, texto ≥ 3,
//     devolver = 49, lancar exige código e nunca 49;
//   - respostas: 503 sem PONTE_OPERACAO_TOKEN / flag OFF, 401 token errado,
//     422 inválido, 202 recebido, 200 mesmo pedidoId, 409 mesmo pedidoId com
//     conteúdo diferente (emenda 4);
//   - nf opcional (emenda 1): normalizada, conferida contra a do card,
//     "sem NF para o tripé" no lancar sem card;
//   - token próprio (emenda 5): o ROTEIRIZADOR_PONTE_TOKEN da v1 não autentica;
//   - idempotência: o mesmo pedidoId nunca grava nem vincula duas vezes;
//   - o POST nunca toca SSW nem Bastão (o repositório nem tem esses métodos).
// Rodar: deno test --no-check supabase/functions/_shared/ponte-operacao-pedido.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CardResumo,
  decidirAlvoDoPedido,
  handlePedido,
  hashPedido,
  type NovoPedidoRow,
  type PedidoRow,
  type RepoPedidos,
  validarPedido,
} from "./ponte-operacao-pedido.ts";
import { tokenDaPonte } from "./ponte-operacao-comum.ts";

const TOKEN = "segredo-da-ponte";
const PID = "0b9f7e7a-5b7c-4c2a-9d0e-1a2b3c4d5e6f";

const corpo = (over: Record<string, unknown> = {}) => ({
  pedidoId: PID,
  tipo: "devolver_ao_relacionamento",
  ctrc: " amb638789-6 ",
  texto: "Cliente pediu para segurar, confirmar endereço",
  base: "vga",
  solicitadoPor: { id: "12", nome: "Operador X", email: null },
  criadoEm: "2026-09-26T08:12:00-03:00",
  ...over,
});

function req(metodo: "POST" | "GET", body?: unknown, opts: { token?: string | null; qs?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = opts.token === undefined ? TOKEN : opts.token;
  if (t !== null) headers["Authorization"] = `Bearer ${t}`;
  return new Request(`https://cockpit.test/functions/v1/ponte-pedido-operacao${opts.qs ?? ""}`, {
    method: metodo,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function card(over: Partial<CardResumo> = {}): CardResumo {
  return { id: "card-1", ctrc: "AMB638789-6", nf: "638789", state: "AGUARDANDO_VALIDACAO_HUMANA", cod_ultima_ocorrencia: 11, created_at: "2026-09-20T10:00:00Z", ...over };
}

function repoFalso(opts: {
  flags?: Record<string, boolean>;
  cards?: CardResumo[];
  permitidos?: number[];
  vincularFalha?: boolean;
  conflitoNaInsercao?: boolean;
} = {}) {
  const pedidos = new Map<string, PedidoRow>();
  const chamadas: string[] = [];
  const vinculos: Array<{ pedidoId: string; cardId: string }> = [];
  const repo: RepoPedidos = {
    flagLigada: (k) => { chamadas.push(`flag:${k}`); return Promise.resolve(opts.flags?.[k] ?? false); },
    buscarPedido: (id) => { chamadas.push("buscar"); return Promise.resolve(pedidos.get(id) ?? null); },
    inserirPedido: (p: NovoPedidoRow) => {
      chamadas.push("inserir");
      if (opts.conflitoNaInsercao || pedidos.has(p.pedido_id)) {
        // simula o outro POST que ganhou a corrida
        if (!pedidos.has(p.pedido_id)) pedidos.set(p.pedido_id, linha(p));
        return Promise.resolve("conflito" as const);
      }
      pedidos.set(p.pedido_id, linha(p));
      return Promise.resolve("inserido" as const);
    },
    codigoPermitido: (c) => { chamadas.push(`permitido:${c}`); return Promise.resolve((opts.permitidos ?? []).includes(c)); },
    cardsDoCtrc: (ctrc) => { chamadas.push(`cards:${ctrc}`); return Promise.resolve(opts.cards ?? []); },
    vincularCard: (a) => {
      chamadas.push("vincular");
      if (opts.vincularFalha) return Promise.reject(new Error("rpc caiu"));
      vinculos.push({ pedidoId: a.pedidoId, cardId: a.cardId });
      const p = pedidos.get(a.pedidoId)!;
      p.card_id = a.cardId; p.etapa = "vinculado";
      return Promise.resolve();
    },
  };
  return { repo, pedidos, chamadas, vinculos };
}

function linha(p: NovoPedidoRow): PedidoRow {
  return {
    ...p, recebido_em: "2026-09-26T11:12:01Z", card_id: null, card_criado_pelo_pedido: false, card_event_id: null,
    ocorrencia_lancada: null, acao_ssw_id: null, categoria_erro: null, detalhe: null, executado_em: null,
  };
}

const ligado = { ponte_operacao_pedidos: true };

// ── validação pura ───────────────────────────────────────────────────────────

Deno.test("validar: devolver normaliza CTRC/base, fixa a 49 e guarda quem pediu", () => {
  const v = validarPedido(corpo());
  assert(v.ok);
  assertEquals(v.pedido.ctrc, "AMB638789-6");
  assertEquals(v.pedido.base, "VGA");
  assertEquals(v.pedido.codigoOcorrencia, 49);
  assertEquals(v.pedido.solicitadoPor, { id: "12", nome: "Operador X", email: null });
});

Deno.test("validar: sem solicitadoPor, sem id ou sem nome → recusado", () => {
  for (const sp of [undefined, null, {}, { id: "12" }, { nome: "Operador X" }, { id: "", nome: "Operador X" }, { id: "12", nome: "1" }]) {
    const v = validarPedido(corpo({ solicitadoPor: sp }));
    assert(!v.ok);
    assert(v.motivos.some((m) => m.codigo === "solicitado_por_obrigatorio"), JSON.stringify(sp));
  }
});

Deno.test("validar: identidade de agente/automação é recusada (a ação tem de vir de clique de pessoa)", () => {
  for (const sp of [
    { id: "agente-extravio", nome: "Agente" }, { id: "12", nome: "Robô da rota" }, { id: "system", nome: "Sistema" },
    { id: "12", nome: "IA" }, { id: "cron", nome: "Cron de rota" }, { id: "roteirizador", nome: "Roteirizador" },
  ]) {
    const v = validarPedido(corpo({ solicitadoPor: sp }));
    assert(!v.ok, JSON.stringify(sp));
    assert(v.motivos.some((m) => m.codigo === "solicitado_por_automatico"), JSON.stringify(sp));
  }
  // nome de gente comum que começa parecido não é bloqueado
  assert(validarPedido(corpo({ solicitadoPor: { id: "7", nome: "Iara Souza" } })).ok);
  assert(validarPedido(corpo({ solicitadoPor: { id: "8", nome: "Robson Lima" } })).ok);
});

Deno.test("validar: texto obrigatório com 3+ caracteres e no máximo 400", () => {
  for (const texto of [undefined, "", "  ", "ok", "\u0000\u0001"]) {
    const v = validarPedido(corpo({ texto }));
    assert(!v.ok && v.motivos.some((m) => m.codigo === "texto_curto"), String(texto));
  }
  assert(validarPedido(corpo({ texto: "abc" })).ok);
  const longo = validarPedido(corpo({ texto: "x".repeat(401) }));
  assert(!longo.ok && longo.motivos.some((m) => m.codigo === "texto_longo"));
});

Deno.test("validar: devolver só aceita 49; lancar exige código e nunca 49", () => {
  assert(validarPedido(corpo({ codigoOcorrencia: "49" })).ok);
  const d50 = validarPedido(corpo({ codigoOcorrencia: "50" }));
  assert(!d50.ok && d50.motivos.some((m) => m.codigo === "devolver_so_com_49"));
  const semCod = validarPedido(corpo({ tipo: "lancar_ocorrencia" }));
  assert(!semCod.ok && semCod.motivos.some((m) => m.codigo === "codigo_obrigatorio"));
  const l49 = validarPedido(corpo({ tipo: "lancar_ocorrencia", codigoOcorrencia: 49 }));
  assert(!l49.ok && l49.motivos.some((m) => m.codigo === "codigo_nao_permitido"));
  const l15 = validarPedido(corpo({ tipo: "lancar_ocorrencia", codigoOcorrencia: "15" }));
  assert(l15.ok);
  assertEquals(l15.pedido.codigoOcorrencia, 15);
});

Deno.test("validar: pedidoId, tipo, CTRC, base e criadoEm fora do formato", () => {
  const v = validarPedido({ pedidoId: "123", tipo: "segurar", ctrc: "", texto: "abc", base: "V G A", criadoEm: "ontem", solicitadoPor: { id: "1", nome: "Ana" } });
  assert(!v.ok);
  const codigos = v.motivos.map((m) => m.codigo).sort();
  assertEquals(codigos, ["base_invalida", "criado_em_invalido", "ctrc_invalido", "pedido_id_invalido", "tipo_invalido"]);
});

Deno.test("hash: muda com o conteúdo, não com espaços do CTRC", async () => {
  const a = validarPedido(corpo()); const b = validarPedido(corpo({ ctrc: "AMB638789-6" }));
  const c = validarPedido(corpo({ texto: "outro texto qualquer" }));
  assert(a.ok && b.ok && c.ok);
  assertEquals(await hashPedido(a.pedido), await hashPedido(b.pedido));
  assert((await hashPedido(a.pedido)) !== (await hashPedido(c.pedido)));
});

Deno.test("alvo: devolver usa o card ATIVO; sem ativo o worker acha/cria; entregue → 422", () => {
  const dev = { tipo: "devolver_ao_relacionamento" as const, nf: null };
  assertEquals(decidirAlvoDoPedido(dev, [card()]), { ok: true, alvo: card() });
  assertEquals(decidirAlvoDoPedido(dev, [card({ state: "RESOLVIDO", cod_ultima_ocorrencia: 21 })]), { ok: true, alvo: null });
  const entregue = decidirAlvoDoPedido(dev, [card({ state: "RESOLVIDO", cod_ultima_ocorrencia: 1 })]);
  assert(!entregue.ok && entregue.motivo.codigo === "nota_entregue_ou_baixada");
});

Deno.test("alvo: lancar exige card encerrado (fato da rota não passa por cima de tratativa aberta)", () => {
  const lan = { tipo: "lancar_ocorrencia" as const, nf: null };
  const aberta = decidirAlvoDoPedido(lan, [card()]);
  assert(!aberta.ok && aberta.motivo.codigo === "tratativa_aberta");
  // emenda 1: sem card e sem NF → "sem NF para o tripé"; sem card COM NF → sem_card (lancar não cria card)
  const semNada = decidirAlvoDoPedido(lan, []);
  assert(!semNada.ok && semNada.motivo.codigo === "sem_nf_para_tripe" && semNada.motivo.mensagem === "sem NF para o tripé");
  const semCard = decidirAlvoDoPedido({ ...lan, nf: "638789" }, []);
  assert(!semCard.ok && semCard.motivo.codigo === "sem_card");
  const t = card({ id: "card-t", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 });
  assertEquals(decidirAlvoDoPedido(lan, [t]), { ok: true, alvo: t });
  // card encerrado sem NF: só vai se o pedido trouxer a NF
  const tSemNf = card({ id: "card-t", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21, nf: null });
  const r = decidirAlvoDoPedido(lan, [tSemNf]);
  assert(!r.ok && r.motivo.codigo === "sem_nf_para_tripe");
  assertEquals(decidirAlvoDoPedido({ ...lan, nf: "638789" }, [tSemNf]), { ok: true, alvo: tSemNf });
});

Deno.test("nf (emenda 1): opcional, normalizada, no hash, e conferida contra a NF do card", async () => {
  const v = validarPedido(corpo({ nf: " 000638789 " }));
  assert(v.ok);
  assertEquals(v.pedido.nf, "638789");
  assertEquals((validarPedido(corpo()) as { pedido: { nf: string | null } }).pedido.nf, null);
  for (const nf of ["1/638789", "NF638789", "0000", "1".repeat(13)]) {
    const x = validarPedido(corpo({ nf }));
    assert(!x.ok && x.motivos.some((m) => m.codigo === "nf_invalida"), nf);
  }
  const semNf = validarPedido(corpo());
  assert(v.ok && semNf.ok);
  assert((await hashPedido(v.pedido)) !== (await hashPedido(semNf.pedido)), "a nf faz parte do conteúdo");
  const diverge = decidirAlvoDoPedido({ tipo: "devolver_ao_relacionamento", nf: "111" }, [card({ nf: "0638789" })]);
  assert(!diverge.ok && diverge.motivo.codigo === "nf_diverge");
  assertEquals(decidirAlvoDoPedido({ tipo: "devolver_ao_relacionamento", nf: "638789" }, [card({ nf: "0638789" })]).ok, true);
});

// ── handler: auth, flags, contrato ───────────────────────────────────────────

Deno.test("token próprio: só PONTE_OPERACAO_TOKEN autentica; o da v1 (ROTEIRIZADOR_PONTE_TOKEN) não", () => {
  assertEquals(tokenDaPonte({ PONTE_OPERACAO_TOKEN: "  abc  " }), "abc");
  assertEquals(tokenDaPonte({ ROTEIRIZADOR_PONTE_TOKEN: "v1" }), null);
  assertEquals(tokenDaPonte({ PONTE_OPERACAO_TOKEN: "  ", ROTEIRIZADOR_PONTE_TOKEN: "v1" }), null);
  assertEquals(tokenDaPonte({}), null);
});

Deno.test("sem PONTE_OPERACAO_TOKEN no Cockpit → 503 e o repositório nem é tocado", async () => {
  const f = repoFalso({ flags: ligado });
  const r = await handlePedido(req("POST", corpo()), { token: null, repo: f.repo });
  assertEquals(r.status, 503);
  assertEquals((await r.json()).erro, "ponte_desligada");
  assertEquals(f.chamadas, []);
});

Deno.test("token errado ou ausente → 401 e o repositório nem é tocado", async () => {
  for (const t of ["outro", null]) {
    const f = repoFalso({ flags: ligado });
    const r = await handlePedido(req("POST", corpo(), { token: t }), { token: TOKEN, repo: f.repo });
    assertEquals(r.status, 401);
    assertEquals(f.chamadas, []);
  }
});

Deno.test("flag ponte_operacao_pedidos OFF → 503; só a flag é lida; nada gravado (POST e GET)", async () => {
  const f = repoFalso({ flags: {}, cards: [card()] });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 503);
  assertEquals((await r.json()).flag, "ponte_operacao_pedidos");
  const g = await handlePedido(req("GET", undefined, { qs: `?pedidoId=${PID}` }), { token: TOKEN, repo: f.repo });
  assertEquals(g.status, 503);
  assertEquals(f.chamadas, ["flag:ponte_operacao_pedidos", "flag:ponte_operacao_pedidos"]);
  assertEquals(f.pedidos.size, 0);
});

Deno.test("422 com a lista de motivos e nada gravado", async () => {
  const f = repoFalso({ flags: ligado });
  const r = await handlePedido(req("POST", corpo({ texto: "", solicitadoPor: null })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 422);
  const j = await r.json();
  assertEquals(j.erro, "invalido");
  assertEquals(j.motivos.map((m: { codigo: string }) => m.codigo).sort(), ["solicitado_por_obrigatorio", "texto_curto"]);
  assertEquals(f.pedidos.size, 0);
});

Deno.test("devolver com card ativo → 202 recebido + cardId, 1 gravação, 1 vínculo", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()] });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 202);
  assertEquals(await r.json(), { pedidoId: PID, status: "recebido", cardId: "card-1" });
  assertEquals(f.chamadas.filter((c) => c === "inserir").length, 1);
  assertEquals(f.vinculos, [{ pedidoId: PID, cardId: "card-1" }]);
  const p = f.pedidos.get(PID)!;
  assertEquals([p.ctrc, p.codigo_ocorrencia, p.base, p.solicitado_por_nome, p.status], ["AMB638789-6", 49, "VGA", "Operador X", "recebido"]);
});

Deno.test("IDEMPOTÊNCIA: o mesmo pedidoId devolve 200 com o status e não grava nem vincula de novo", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()] });
  await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  f.pedidos.get(PID)!.status = "executado";
  f.pedidos.get(PID)!.ocorrencia_lancada = 49;
  f.pedidos.get(PID)!.executado_em = "2026-09-26T11:15:00Z";
  const antes = { inserir: f.chamadas.filter((c) => c === "inserir").length, vinculos: f.vinculos.length };
  for (let i = 0; i < 3; i++) {
    const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
    assertEquals(r.status, 200);
    assertEquals(await r.json(), {
      pedidoId: PID, status: "executado", ocorrenciaLancada: "49", cardId: "card-1", detalhe: null, executadoEm: "2026-09-26T08:15:00-03:00",
    });
  }
  assertEquals(f.chamadas.filter((c) => c === "inserir").length, antes.inserir);
  assertEquals(f.vinculos.length, antes.vinculos);
});

Deno.test("IDEMPOTÊNCIA (emenda 4): mesmo pedidoId com conteúdo diferente → 409 com o status do ORIGINAL, sem executar", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()] });
  await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  const inserir = f.chamadas.filter((c) => c === "inserir").length;
  for (const outro of [corpo({ texto: "outra coisa bem diferente" }), corpo({ nf: "638789" }), corpo({ solicitadoPor: { id: "99", nome: "Outra Pessoa" } })]) {
    const r = await handlePedido(req("POST", outro), { token: TOKEN, repo: f.repo });
    assertEquals(r.status, 409);
    const j = await r.json();
    assertEquals(j.erro, "conteudo_divergente");
    assertEquals([j.pedidoId, j.status, j.cardId], [PID, "recebido", "card-1"]);
    assert(!("conteudoDivergente" in j));
  }
  assertEquals(f.chamadas.filter((c) => c === "inserir").length, inserir);
  assertEquals(f.vinculos.length, 1);
  assertEquals(f.pedidos.get(PID)!.texto, "Cliente pediu para segurar, confirmar endereço");
});

Deno.test("nf divergente da do card → 422 nf_diverge e nada gravado", async () => {
  const f = repoFalso({ flags: ligado, cards: [card({ nf: "638789" })] });
  const r = await handlePedido(req("POST", corpo({ nf: "999" })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 422);
  assertEquals((await r.json()).motivos[0].codigo, "nf_diverge");
  assertEquals(f.pedidos.size, 0);
});

Deno.test("nf vem gravada no pedido (para o worker conferir com o Bastão e usar no tripé)", async () => {
  const f = repoFalso({ flags: ligado, cards: [] });
  const r = await handlePedido(req("POST", corpo({ nf: "000638789" })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 202);
  assertEquals(f.pedidos.get(PID)!.nf, "638789");
});

Deno.test("IDEMPOTÊNCIA: corrida de dois POST iguais (conflito na PK) → o perdedor recebe 200", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()], conflitoNaInsercao: true });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 200);
  assertEquals(f.vinculos.length, 0);
});

Deno.test("devolver sem card → 202 com cardId null (o worker acha ou cria depois)", async () => {
  const f = repoFalso({ flags: ligado, cards: [] });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 202);
  assertEquals((await r.json()).cardId, null);
  assertEquals(f.vinculos.length, 0);
  assertEquals(f.pedidos.get(PID)!.etapa, "vincular_card");
});

Deno.test("vínculo falhou no POST → ainda 202 (pedido gravado, o worker retenta)", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()], vincularFalha: true });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 202);
  assertEquals((await r.json()).cardId, null);
  assert(f.pedidos.has(PID));
});

Deno.test("nota ENTREGUE/BAIXADA → 422 e nada gravado", async () => {
  const f = repoFalso({ flags: ligado, cards: [card({ state: "RESOLVIDO", cod_ultima_ocorrencia: 1 })] });
  const r = await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 422);
  assertEquals((await r.json()).motivos[0].codigo, "nota_entregue_ou_baixada");
  assertEquals(f.pedidos.size, 0);
});

Deno.test("lancar_ocorrencia com ponte_operacao_lancar_ssw OFF → 503 e nada gravado", async () => {
  const f = repoFalso({ flags: ligado, cards: [card({ state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 })], permitidos: [15] });
  const r = await handlePedido(req("POST", corpo({ tipo: "lancar_ocorrencia", codigoOcorrencia: "15" })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 503);
  assertEquals((await r.json()).flag, "ponte_operacao_lancar_ssw");
  assertEquals(f.pedidos.size, 0);
});

Deno.test("lancar_ocorrencia: lista VAZIA por padrão → 422 codigo_nao_permitido", async () => {
  const f = repoFalso({ flags: { ...ligado, ponte_operacao_lancar_ssw: true }, cards: [card({ state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 })] });
  const r = await handlePedido(req("POST", corpo({ tipo: "lancar_ocorrencia", codigoOcorrencia: "15" })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 422);
  assertEquals((await r.json()).motivos[0].codigo, "codigo_nao_permitido");
  assertEquals(f.pedidos.size, 0);
});

Deno.test("lancar_ocorrencia com código da lista e card encerrado → 202 no card encerrado", async () => {
  const f = repoFalso({
    flags: { ...ligado, ponte_operacao_lancar_ssw: true },
    cards: [card({ id: "card-t", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 })],
    permitidos: [15],
  });
  const r = await handlePedido(req("POST", corpo({ tipo: "lancar_ocorrencia", codigoOcorrencia: "15" })), { token: TOKEN, repo: f.repo });
  assertEquals(r.status, 202);
  assertEquals((await r.json()).cardId, "card-t");
  assertEquals(f.pedidos.get(PID)!.codigo_ocorrencia, 15);
});

Deno.test("GET: 422 id inválido, 404 desconhecido, 200 com o formato do contrato", async () => {
  const f = repoFalso({ flags: ligado, cards: [card()] });
  assertEquals((await handlePedido(req("GET", undefined, { qs: "?pedidoId=abc" }), { token: TOKEN, repo: f.repo })).status, 422);
  assertEquals((await handlePedido(req("GET", undefined, { qs: `?pedidoId=${PID}` }), { token: TOKEN, repo: f.repo })).status, 404);
  await handlePedido(req("POST", corpo()), { token: TOKEN, repo: f.repo });
  const g = await handlePedido(req("GET", undefined, { qs: `?pedidoId=${PID}` }), { token: TOKEN, repo: f.repo });
  assertEquals(g.status, 200);
  const j = await g.json();
  assertEquals(Object.keys(j).sort(), ["cardId", "detalhe", "executadoEm", "ocorrenciaLancada", "pedidoId", "status"]);
  assertEquals(j.status, "recebido");
});

Deno.test("o POST não tem caminho para SSW nem Bastão (o fonte não importa nada disso)", async () => {
  const fonte = await Deno.readTextFile(new URL("./ponte-operacao-pedido.ts", import.meta.url));
  for (const proibido of ["lancar-ssw-portal", "ssw-internal-client", "bastao-client", "fetch("]) {
    assert(!fonte.includes(proibido), `ponte-operacao-pedido.ts não pode usar ${proibido}`);
  }
});
