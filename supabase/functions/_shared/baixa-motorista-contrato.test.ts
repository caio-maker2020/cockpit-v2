// Guard — contrato da baixa do motorista (ADR 0040, INV-174). Trava:
//   - respostas: 503 sem PONTE_OPERACAO_TOKEN / flag OFF, 401 token errado,
//     422 mérito (código fora da lista, nf/ctrc inválidos, ocorridoEm no futuro…),
//     202 recebido, 200 mesmo baixaId, 409 mesmo baixaId com outro conteúdo;
//   - idempotência: o mesmo baixaId nunca grava duas vezes (inclusive na corrida);
//   - a 01 é implícita da entrega e nunca vale para insucesso; insucesso só da lista;
//   - GET ?ids= devolve o status do contrato (lancando sai como na_fila);
//   - prazo = fim do dia seguinte ao ocorrido (São Paulo);
//   - o POST nunca toca SSW, Bastão nem Roteirizador (o repositório nem tem esses métodos).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/baixa-motorista-contrato.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BaixaRow,
  handleBaixa,
  hashBaixa,
  type NovaBaixaRow,
  prazoDaBaixa,
  type RepoRecepcao,
  validarBaixa,
} from "./baixa-motorista-contrato.ts";

const TOKEN = "segredo-da-ponte";
const BID = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const AGORA = Date.parse("2026-10-07T15:00:00Z"); // 12:00 em São Paulo
const SHA = "a".repeat(64);

const corpo = (over: Record<string, unknown> = {}) => ({
  baixaId: BID,
  tipo: "entrega",
  codigoOcorrencia: "01",
  ctrc: " vga123456-7 ",
  nf: "000638789",
  ocorridoEm: "2026-10-07T11:40:00-03:00",
  recebidoEm: "2026-10-07T11:41:10-03:00",
  recebedor: { nome: "Maria Souza", documento: "123.456.789-00" },
  geo: { lat: -21.5512, lng: -45.4321, precisaoM: 12 },
  evidencias: [{ id: "ev_1", sha256: SHA, mime: "image/jpeg" }],
  motorista: { id: "m-77", nome: "João Motorista" },
  rota: { sugestaoId: "sug-9", rotaId: "V07", veiculoIndice: 2, placa: "abc1d23" },
  base: "vga",
  ...over,
});

function req(metodo: "POST" | "GET" | "PUT", body?: unknown, opts: { token?: string | null; qs?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = opts.token === undefined ? TOKEN : opts.token;
  if (t !== null) headers["Authorization"] = `Bearer ${t}`;
  return new Request(`https://cockpit.test/functions/v1/ponte-baixa-entrega${opts.qs ?? ""}`, {
    method: metodo,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

class RepoFalso implements RepoRecepcao {
  flags: Record<string, boolean> = { baixa_motorista_receber: true };
  permitidos = new Set<number>();
  linhas = new Map<string, BaixaRow>();
  insercoes = 0;
  /** Simula a corrida: outro POST inseriu a mesma baixa entre o buscar e o inserir. */
  corrida: NovaBaixaRow | null = null;
  chamadas: string[] = [];

  flagLigada(k: string) { this.chamadas.push(`flag:${k}`); return Promise.resolve(this.flags[k] ?? false); }
  buscar(id: string) { this.chamadas.push("buscar"); return Promise.resolve(this.linhas.get(id) ?? null); }
  buscarVarias(ids: string[]) { return Promise.resolve(ids.map((i) => this.linhas.get(i)).filter((x): x is BaixaRow => !!x)); }
  codigoInsucessoPermitido(c: number) { this.chamadas.push(`codigo:${c}`); return Promise.resolve(this.permitidos.has(c)); }
  inserir(row: NovaBaixaRow) {
    this.chamadas.push("inserir");
    if (this.corrida) {
      this.guardar(this.corrida);
      this.corrida = null;
    }
    if (this.linhas.has(row.baixa_id)) return Promise.resolve("conflito" as const);
    this.insercoes++;
    this.guardar(row);
    return Promise.resolve("inserido" as const);
  }
  guardar(row: NovaBaixaRow) {
    this.linhas.set(row.baixa_id, {
      ...row, seq: this.linhas.size + 1, recebido_em: new Date(AGORA).toISOString(), status_em: new Date(AGORA).toISOString(),
      tentativas: 0, reservado_em: null, ultima_categoria: null, ultima_falha_em: null, categoria: null, motivo: null,
      protocolo: null, canal: null, finalizado_em: null,
    });
  }
}

const deps = (repo: RepoFalso, token: string | null = TOKEN) => ({ token, repo, agora: () => new Date(AGORA) });

Deno.test("503: sem PONTE_OPERACAO_TOKEN no Cockpit → nada é lido nem gravado", async () => {
  const repo = new RepoFalso();
  const r = await handleBaixa(req("POST", corpo()), deps(repo, null));
  assertEquals(r.status, 503);
  assertEquals(repo.chamadas, []);
});

Deno.test("401: token errado ou ausente", async () => {
  const repo = new RepoFalso();
  assertEquals((await handleBaixa(req("POST", corpo(), { token: "outro" }), deps(repo))).status, 401);
  assertEquals((await handleBaixa(req("POST", corpo(), { token: null }), deps(repo))).status, 401);
  assertEquals(repo.chamadas, []);
});

Deno.test("503: flag baixa_motorista_receber OFF → só lê a flag (POST e GET)", async () => {
  const repo = new RepoFalso();
  repo.flags.baixa_motorista_receber = false;
  const r = await handleBaixa(req("POST", corpo()), deps(repo));
  assertEquals(r.status, 503);
  assertEquals((await r.json()).flag, "baixa_motorista_receber");
  assertEquals((await handleBaixa(req("GET", undefined, { qs: `?ids=${BID}` }), deps(repo))).status, 503);
  assertEquals(repo.chamadas, ["flag:baixa_motorista_receber", "flag:baixa_motorista_receber"]);
  assertEquals(repo.insercoes, 0);
});

Deno.test("202: entrega válida → registrada como recebido, CTRC/NF/base normalizados, prazo D+1", async () => {
  const repo = new RepoFalso();
  const r = await handleBaixa(req("POST", corpo()), deps(repo));
  assertEquals(r.status, 202);
  assertEquals(await r.json(), { baixaId: BID, status: "recebido" });
  const l = repo.linhas.get(BID)!;
  assertEquals([l.ctrc, l.nf, l.base, l.codigo_ocorrencia, l.status], ["VGA123456-7", "638789", "VGA", 1, "recebido"]);
  assertEquals(l.rota_placa, "ABC1D23");
  assertEquals(l.evidencia_sha256, SHA);
  assertEquals(l.ocorrido_em, "2026-10-07T14:40:00.000Z");
  assertEquals(l.prazo_em, "2026-10-09T02:59:59.999Z"); // 08/10 23:59:59.999 em São Paulo
  // a entrega nunca consulta a lista de insucesso
  assert(!repo.chamadas.some((c) => c.startsWith("codigo:")));
});

Deno.test("200: mesmo baixaId com o mesmo conteúdo → status atual, nada gravado de novo", async () => {
  const repo = new RepoFalso();
  await handleBaixa(req("POST", corpo()), deps(repo));
  repo.linhas.get(BID)!.status = "lancando";
  const r = await handleBaixa(req("POST", corpo({ ctrc: "VGA123456-7", nf: "638789" })), deps(repo));
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals([j.baixaId, j.status], [BID, "na_fila"]);
  assertEquals(repo.insercoes, 1);
});

Deno.test("409: mesmo baixaId com conteúdo diferente → status do original, nada executado", async () => {
  const repo = new RepoFalso();
  await handleBaixa(req("POST", corpo()), deps(repo));
  const r = await handleBaixa(req("POST", corpo({ recebedor: { nome: "Outra Pessoa", documento: null } })), deps(repo));
  assertEquals(r.status, 409);
  const j = await r.json();
  assertEquals([j.erro, j.status], ["conteudo_divergente", "recebido"]);
  assertEquals(repo.insercoes, 1);
});

Deno.test("corrida: dois POST iguais ao mesmo tempo → um insere, o outro recebe 200 (ou 409 se divergente)", async () => {
  const repo = new RepoFalso();
  const v = validarBaixa(corpo(), AGORA);
  assert(v.ok);
  const { linhaDaBaixa } = await import("./baixa-motorista-contrato.ts");
  repo.corrida = linhaDaBaixa(v.baixa, await hashBaixa(v.baixa));
  const r = await handleBaixa(req("POST", corpo()), deps(repo));
  assertEquals(r.status, 200);
  assertEquals(repo.insercoes, 0);
  const repo2 = new RepoFalso();
  repo2.corrida = linhaDaBaixa(v.baixa, "hash-de-outro-conteudo");
  assertEquals((await handleBaixa(req("POST", corpo()), deps(repo2))).status, 409);
});

Deno.test("422: ocorridoEm no futuro (além de 10 min de relógio, contrato v3) — o SSW não aceita hora futura", async () => {
  const repo = new RepoFalso();
  const r = await handleBaixa(req("POST", corpo({ ocorridoEm: "2026-10-07T12:10:01-03:00" })), deps(repo));
  assertEquals(r.status, 422);
  const j = await r.json();
  assert(j.motivos.some((m: { codigo: string }) => m.codigo === "ocorrido_em_futuro"));
  assertEquals(repo.insercoes, 0);
  // 10 min adiantado é relógio de celular, passa (o envelope limita a hora ao gravar no SSW)
  assertEquals((await handleBaixa(req("POST", corpo({ ocorridoEm: "2026-10-07T12:10:00-03:00", recebidoEm: "2026-10-07T12:01:00-03:00" })), deps(repo))).status, 202);
});

Deno.test("422: hora sem fuso é ambígua → recusada", () => {
  const v = validarBaixa(corpo({ ocorridoEm: "2026-10-07T11:40:00" }), AGORA);
  assert(!v.ok && v.motivos.some((m) => m.codigo === "ocorrido_em_invalido"));
});

Deno.test("422: nf obrigatória e numérica; ctrc no formato", () => {
  for (const nf of [undefined, null, "", "12a45", "0000"]) {
    const v = validarBaixa(corpo({ nf }), AGORA);
    assert(!v.ok && v.motivos.some((m) => m.codigo === "nf_invalida"), `nf=${nf}`);
  }
  for (const ctrc of [undefined, "", "#$%", "A"]) {
    const v = validarBaixa(corpo({ ctrc }), AGORA);
    assert(!v.ok && v.motivos.some((m) => m.codigo === "ctrc_invalido"), `ctrc=${ctrc}`);
  }
});

Deno.test("422: entrega só com 01; insucesso nunca com 01", () => {
  const e = validarBaixa(corpo({ codigoOcorrencia: "18" }), AGORA);
  assert(!e.ok && e.motivos.some((m) => m.codigo === "entrega_so_com_01"));
  const i = validarBaixa(corpo({ tipo: "insucesso", codigoOcorrencia: "01" }), AGORA);
  assert(!i.ok && i.motivos.some((m) => m.codigo === "insucesso_nao_e_01"));
  const ok = validarBaixa(corpo({ codigoOcorrencia: 1 }), AGORA);
  assert(ok.ok && ok.baixa.codigoOcorrencia === 1);
});

Deno.test("422: insucesso com código fora da lista fechada (vazia por padrão) → nada gravado", async () => {
  const repo = new RepoFalso();
  const r = await handleBaixa(req("POST", corpo({ tipo: "insucesso", codigoOcorrencia: "18", recebedor: null })), deps(repo));
  assertEquals(r.status, 422);
  const j = await r.json();
  assertEquals(j.motivos[0].codigo, "codigo_nao_permitido");
  assertEquals(repo.insercoes, 0);
  repo.permitidos.add(18);
  assertEquals((await handleBaixa(req("POST", corpo({ tipo: "insucesso", codigoOcorrencia: "18", recebedor: null })), deps(repo))).status, 202);
});

Deno.test("422: evidências — no máximo 1, sha256 de 64 hex, mime JPEG ou PDF", () => {
  const dupla = validarBaixa(corpo({ evidencias: [{ id: "a", sha256: SHA, mime: "image/jpeg" }, { id: "b", sha256: SHA, mime: "image/jpeg" }] }), AGORA);
  assert(!dupla.ok && dupla.motivos.some((m) => m.codigo === "evidencias_demais"));
  const sha = validarBaixa(corpo({ evidencias: [{ id: "a", sha256: "xyz", mime: "image/jpeg" }] }), AGORA);
  assert(!sha.ok && sha.motivos.some((m) => m.codigo === "evidencias_invalidas"));
  const png = validarBaixa(corpo({ evidencias: [{ id: "a", sha256: SHA, mime: "image/png" }] }), AGORA);
  assert(!png.ok && png.motivos.some((m) => m.codigo === "evidencia_mime"));
  const id = validarBaixa(corpo({ evidencias: [{ id: "../../etc", sha256: SHA, mime: "image/jpeg" }] }), AGORA);
  assert(!id.ok);
  const sem = validarBaixa(corpo({ evidencias: [] }), AGORA);
  assert(sem.ok && sem.baixa.evidencias.length === 0);
});

Deno.test("contrato v3: null em geo.precisaoM, rota.veiculoIndice e base; motorista.id qualquer texto (\"usuario:7\")", async () => {
  const v = validarBaixa(corpo({
    geo: { lat: -21.5, lng: -45.4, precisaoM: null },
    rota: { sugestaoId: 140, rotaId: 900, veiculoIndice: null, placa: null },
    base: null,
    motorista: { id: "usuario:7", nome: "Gestora da Base" },
  }), AGORA);
  assert(v.ok, JSON.stringify(!v.ok && v.motivos));
  assertEquals([v.baixa.geo?.precisaoM, v.baixa.rota.veiculoIndice, v.baixa.base, v.baixa.motorista.id], [null, null, null, "usuario:7"]);
  const repo = new RepoFalso();
  assertEquals((await handleBaixa(req("POST", corpo({ base: null, rota: { sugestaoId: 1, rotaId: 2, veiculoIndice: null, placa: null } })), deps(repo))).status, 202);
  assertEquals(repo.linhas.get(BID)!.base, null);
  const vazio = validarBaixa(corpo({ motorista: { id: "", nome: "João" } }), AGORA);
  assert(!vazio.ok && vazio.motivos.some((m) => m.codigo === "motorista_obrigatorio"));
});

Deno.test("texto (aditivo v3): opcional, até 200, sanitizado para latin-1, guardado e no hash", async () => {
  const v = validarBaixa(corpo({ tipo: "insucesso", codigoOcorrencia: "18", recebedor: null, texto: "  Portão fechado — ninguém atendeu “3x” 🚚 " }), AGORA);
  assert(v.ok);
  assertEquals(v.baixa.texto, 'Portão fechado - ninguém atendeu "3x" ?');
  const longo = validarBaixa(corpo({ texto: "x".repeat(201) }), AGORA);
  assert(!longo.ok && longo.motivos.some((m) => m.codigo === "texto_longo"));
  const naoString = validarBaixa(corpo({ texto: 5 }), AGORA);
  assert(!naoString.ok && naoString.motivos.some((m) => m.codigo === "texto_invalido"));
  const vazio = validarBaixa(corpo({ texto: "   " }), AGORA);
  assert(vazio.ok && vazio.baixa.texto === null);
  const repo = new RepoFalso();
  repo.permitidos.add(18);
  const ins = corpo({ tipo: "insucesso", codigoOcorrencia: "18", recebedor: null, texto: "Portão fechado" });
  assertEquals((await handleBaixa(req("POST", ins), deps(repo))).status, 202);
  assertEquals(repo.linhas.get(BID)!.texto, "Portão fechado");
  // texto diferente com o mesmo baixaId = outro conteúdo
  assertEquals((await handleBaixa(req("POST", { ...ins, texto: "Cliente ausente" }), deps(repo))).status, 409);
  assertEquals((await handleBaixa(req("POST", ins), deps(repo))).status, 200);
});

Deno.test("422: motorista e rota obrigatórios; automação recusada; recebedor e geo podem ser null", () => {
  const semMot = validarBaixa(corpo({ motorista: null }), AGORA);
  assert(!semMot.ok && semMot.motivos.some((m) => m.codigo === "motorista_obrigatorio"));
  const robo = validarBaixa(corpo({ motorista: { id: "7", nome: "Robô de baixa" } }), AGORA);
  assert(!robo.ok && robo.motivos.some((m) => m.codigo === "motorista_automatico"));
  const rota = validarBaixa(corpo({ rota: { sugestaoId: "s", rotaId: "r", veiculoIndice: -1, placa: null } }), AGORA);
  assert(!rota.ok && rota.motivos.some((m) => m.codigo === "rota_invalida"));
  const nulos = validarBaixa(corpo({ recebedor: null, geo: null, rota: { sugestaoId: 1, rotaId: 2, veiculoIndice: 0, placa: null } }), AGORA);
  assert(nulos.ok && nulos.baixa.recebedor === null && nulos.baixa.geo === null);
  const geo = validarBaixa(corpo({ geo: { lat: 200, lng: 0, precisaoM: 5 } }), AGORA);
  assert(!geo.ok && geo.motivos.some((m) => m.codigo === "geo_invalido"));
});

Deno.test("hash: cobre o conteúdo menos baixaId e recebidoEm (contrato v3) e não depende de espaços/caixa", async () => {
  const a = validarBaixa(corpo(), AGORA);
  const b = validarBaixa(corpo({ ctrc: "VGA123456-7", base: "VGA", nf: "638789", recebidoEm: "2026-10-07T11:50:00-03:00" }), AGORA);
  const c = validarBaixa(corpo({ geo: { lat: -21.5512, lng: -45.4321, precisaoM: 13 } }), AGORA);
  assert(a.ok && b.ok && c.ok);
  assertEquals(await hashBaixa(a.baixa), await hashBaixa(b.baixa));
  assert((await hashBaixa(a.baixa)) !== (await hashBaixa(c.baixa)));
});

Deno.test("prazo: fim do dia seguinte em São Paulo, inclusive perto da meia-noite", () => {
  assertEquals(prazoDaBaixa("2026-10-07T02:30:00Z"), "2026-10-08T02:59:59.999Z"); // 06/10 23:30 SP → 07/10 23:59:59.999 SP
  assertEquals(prazoDaBaixa("2026-10-07T03:00:00Z"), "2026-10-09T02:59:59.999Z"); // 07/10 00:00 SP → 08/10
});

Deno.test("GET ?ids=: {baixas:[{baixaId,status,statusEm,executadoEm,motivo}]}; desconhecidos fora; lancando = na_fila", async () => {
  const repo = new RepoFalso();
  await handleBaixa(req("POST", corpo()), deps(repo));
  Object.assign(repo.linhas.get(BID)!, { status: "lancando" });
  const outro = "11111111-2222-4333-8444-555555555555";
  const r = await handleBaixa(req("GET", undefined, { qs: `?ids=${BID},${outro}` }), deps(repo));
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.baixas.length, 1);
  assertEquals(j.baixas[0], { baixaId: BID, status: "na_fila", statusEm: "2026-10-07T12:00:00-03:00", executadoEm: null, motivo: null });
  Object.assign(repo.linhas.get(BID)!, { status: "executado", status_em: "2026-10-07T15:20:00Z", finalizado_em: "2026-10-07T15:20:00Z" });
  const j2 = await (await handleBaixa(req("GET", undefined, { qs: `?ids=${BID}` }), deps(repo))).json();
  assertEquals([j2.baixas[0].status, j2.baixas[0].executadoEm], ["executado", "2026-10-07T12:20:00-03:00"]);
  Object.assign(repo.linhas.get(BID)!, { status: "recusado", motivo: "tripé" });
  const j3 = await (await handleBaixa(req("GET", undefined, { qs: `?ids=${BID}` }), deps(repo))).json();
  assertEquals([j3.baixas[0].status, j3.baixas[0].executadoEm, j3.baixas[0].motivo], ["recusado", null, "tripé"]);
  assertEquals((await handleBaixa(req("GET", undefined, { qs: "?ids=nao-e-uuid" }), deps(repo))).status, 422);
  assertEquals((await handleBaixa(req("GET", undefined, { qs: "" }), deps(repo))).status, 422);
});

Deno.test("405 para outro método (depois da auth)", async () => {
  assertEquals((await handleBaixa(req("PUT", corpo()), deps(new RepoFalso()))).status, 405);
  assertEquals((await handleBaixa(req("PUT", corpo(), { token: "x" }), deps(new RepoFalso()))).status, 401);
});

Deno.test("o POST nunca fala com SSW, Bastão nem Roteirizador (imports do contrato e da edge)", async () => {
  const fontes = [
    await Deno.readTextFile(new URL("./baixa-motorista-contrato.ts", import.meta.url)),
    await Deno.readTextFile(new URL("../ponte-baixa-entrega/index.ts", import.meta.url)),
  ];
  for (const src of fontes) {
    assertEquals(/ssw-internal-client|ssw-client|lancar-ssw|bastao-client|baixa-motorista-evidencia|fetch\(/.test(src), false);
  }
});
