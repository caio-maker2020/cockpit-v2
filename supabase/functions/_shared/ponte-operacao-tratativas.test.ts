// Guard — ponte-tratativas (ADR 0039, contrato v2 parte A). Trava:
//   - 503 sem token / flag OFF (sem SELECT de negócio), 401 token errado;
//   - limite de 1000, CTRC normalizado, deduplicado, só por CTRC (nunca NF);
//   - card ativo vence o terminal; sem card → semCard;
//   - resposta com EXATAMENTE as chaves do contrato;
//   - LEITURA PURA: o repositório de leitura não tem nenhum método de escrita
//     e o fonte das duas camadas não chama insert/update/upsert/delete/rpc.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/ponte-operacao-tratativas.test.ts

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CardTratativaRow,
  escolherCardPorCtrc,
  handleTratativas,
  lerCtrcsDoCorpo,
  type OcDicionario,
  type RepoTratativas,
} from "./ponte-operacao-tratativas.ts";

const TOKEN = "segredo-da-ponte";
const AGORA = new Date("2026-09-26T11:10:00Z");

const row = (over: Partial<CardTratativaRow> = {}): CardTratativaRow => ({
  id: "card-1", ctrc: "AMB638789-6", state: "AGUARDANDO_CLIENTE", tipo: "extravio", responsavel_relacionamento: "FELIPE",
  cod_ultima_ocorrencia: 54, created_at: "2026-09-20T13:00:00Z", updated_at: "2026-09-25T20:02:00Z",
  situacao: "aguardando_cliente", aguardando: { quem: "cliente", o_que: "retorno", desde: "2026-09-24T12:00:00Z" }, ...over,
});

const DIC = new Map<number, OcDicionario>([
  [54, { descricao: "Aguardando retorno cliente pagador", responsabilidade: "Cliente" }],
  [21, { descricao: "Reentrega solicitada pelo cliente", responsabilidade: "Operação" }],
]);

function repoFalso(opts: { flag?: boolean; rows?: CardTratativaRow[] } = {}) {
  const chamadas: string[] = [];
  const consultados: string[][] = [];
  const repo: RepoTratativas = {
    flagLigada: (k) => { chamadas.push(`flag:${k}`); return Promise.resolve(opts.flag ?? false); },
    cardsPorCtrcs: (c) => { chamadas.push("cards"); consultados.push(c); return Promise.resolve((opts.rows ?? []).filter((r) => c.includes(r.ctrc ?? ""))); },
    dicionario: () => { chamadas.push("dicionario"); return Promise.resolve(DIC); },
  };
  return { repo, chamadas, consultados };
}

const req = (body: unknown, token: string | null = TOKEN, method = "POST") =>
  new Request("https://cockpit.test/functions/v1/ponte-tratativas", {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });

Deno.test("sem token configurado → 503; token errado → 401; nenhum acesso ao banco", async () => {
  const f = repoFalso({ flag: true });
  assertEquals((await handleTratativas(req({ ctrcs: [] }), { token: null, appUrl: null, repo: f.repo })).status, 503);
  assertEquals((await handleTratativas(req({ ctrcs: [] }, "errado"), { token: TOKEN, appUrl: null, repo: f.repo })).status, 401);
  assertEquals((await handleTratativas(req({ ctrcs: [] }, null), { token: TOKEN, appUrl: null, repo: f.repo })).status, 401);
  assertEquals(f.chamadas, []);
});

Deno.test("flag ponte_operacao_leitura OFF → 503; só a flag é lida", async () => {
  const f = repoFalso({ flag: false, rows: [row()] });
  const r = await handleTratativas(req({ ctrcs: ["AMB638789-6"] }), { token: TOKEN, appUrl: null, repo: f.repo });
  assertEquals(r.status, 503);
  assertEquals((await r.json()).flag, "ponte_operacao_leitura");
  assertEquals(f.chamadas, ["flag:ponte_operacao_leitura"]);
});

Deno.test("corpo: lista obrigatória, até 1000; normaliza, deduplica e separa inválidos", () => {
  assertEquals(lerCtrcsDoCorpo({}).ok, false);
  assertEquals(lerCtrcsDoCorpo({ ctrcs: "AMB1-1" }).ok, false);
  const mil = Array.from({ length: 1000 }, (_, i) => `AMB${i}-1`);
  assert(lerCtrcsDoCorpo({ ctrcs: mil }).ok);
  const r = lerCtrcsDoCorpo({ ctrcs: [...mil, "AMB9999-1"] });
  assert(!r.ok && /1000/.test(r.motivo));
  const n = lerCtrcsDoCorpo({ ctrcs: [" amb638789-6", "AMB638789-6 ", "ssp920764-3", "x", 42, "", "com espaço 1"] });
  assert(n.ok);
  assertEquals(n.ctrcs, ["AMB638789-6", "SSP920764-3"]);
  assertEquals(n.invalidos, ["X", "COM ESPAÇO 1"]);
});

Deno.test("1001 CTRCs → 422 e nenhuma consulta a cards", async () => {
  const f = repoFalso({ flag: true });
  const r = await handleTratativas(req({ ctrcs: Array.from({ length: 1001 }, (_, i) => `A${i}-1`) }), { token: TOKEN, appUrl: null, repo: f.repo });
  assertEquals(r.status, 422);
  assertEquals(f.chamadas, ["flag:ponte_operacao_leitura"]);
});

Deno.test("escolha: ativo mais recente vence; terminal só quando não há ativo", () => {
  const m = escolherCardPorCtrc([
    row({ id: "velho-ativo", state: "AGUARDANDO_VALIDACAO_HUMANA", created_at: "2026-09-01T00:00:00Z" }),
    row({ id: "novo-terminal", state: "RESOLVIDO", created_at: "2026-09-10T00:00:00Z" }),
    row({ id: "so-terminal", ctrc: "SSP1-1", state: "TRANSFERIDO", created_at: "2026-09-02T00:00:00Z" }),
    row({ id: "so-terminal-velho", ctrc: "SSP1-1", state: "RESOLVIDO", created_at: "2026-08-02T00:00:00Z" }),
  ]);
  assertEquals(m.get("AMB638789-6")!.id, "velho-ativo");
  assertEquals(m.get("SSP1-1")!.id, "so-terminal");
});

Deno.test("resposta: exatamente as chaves do contrato, datas em -03:00, semCard e bloqueio com motivo e data", async () => {
  const f = repoFalso({ flag: true, rows: [row()] });
  const r = await handleTratativas(req({ ctrcs: ["amb638789-6", "SSP920764-3", "??"] }), {
    token: TOKEN, appUrl: "https://cockpit.salexpress.com.br/", repo: f.repo, agora: () => AGORA,
  });
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(Object.keys(j).sort(), ["geradoEm", "semCard", "tratativas"]);
  assertEquals(j.geradoEm, "2026-09-26T08:10:00-03:00");
  assertEquals(j.semCard, ["SSP920764-3", "??"]);
  assertEquals(j.tratativas.length, 1);
  const t = j.tratativas[0];
  assertEquals(Object.keys(t).sort(), [
    "aguardando", "atualizadoEm", "bloqueiaEntrega", "cardId", "ctrc", "estado", "linkCard", "motivoBloqueio",
    "responsavel", "situacao", "tipo", "tratativaDesde", "ultimaOcorrencia",
  ]);
  assertEquals(t.ctrc, "AMB638789-6");
  assertEquals(t.estado, "AGUARDANDO_CLIENTE");
  assertEquals(t.aguardando, "cliente");
  assertEquals(t.ultimaOcorrencia, "54");
  assertEquals(t.atualizadoEm, "2026-09-25T17:02:00-03:00");
  // emenda 3: a data da tratativa em campo próprio (ISO) E no texto do motivo
  assertEquals(t.tratativaDesde, "2026-09-20T10:00:00-03:00");
  assertEquals(t.bloqueiaEntrega, true);
  assertMatch(t.motivoBloqueio, /Aguardando retorno do cliente pagador desde 24\/09\/2026.*Tratativa aberta em 20\/09\/2026\./);
  assertEquals(t.linkCard, "https://cockpit.salexpress.com.br/cards/card-1");
  // busca SÓ pelo CTRC normalizado — nunca por NF
  assertEquals(f.consultados, [["AMB638789-6", "SSP920764-3"]]);
});

Deno.test("sem memória do card (situacao/aguardando nulos) e sem COCKPIT_APP_URL: continua respondendo", async () => {
  const f = repoFalso({ flag: true, rows: [row({ state: "ACAO_EXECUTADA", cod_ultima_ocorrencia: 21, situacao: null, aguardando: null })] });
  const j = await (await handleTratativas(req({ ctrcs: ["AMB638789-6"] }), { token: TOKEN, appUrl: null, repo: f.repo, agora: () => AGORA })).json();
  const t = j.tratativas[0];
  assertEquals([t.situacao, t.aguardando, t.linkCard, t.bloqueiaEntrega, t.motivoBloqueio], [null, null, null, false, null]);
});

Deno.test("lista vazia → 200 sem consultar cards", async () => {
  const f = repoFalso({ flag: true });
  const r = await handleTratativas(req({ ctrcs: [] }), { token: TOKEN, appUrl: null, repo: f.repo, agora: () => AGORA });
  assertEquals(r.status, 200);
  assertEquals(f.chamadas, ["flag:ponte_operacao_leitura"]);
});

Deno.test("erro no banco → 500 JSON (nunca lança para o Deno.serve)", async () => {
  const repo: RepoTratativas = {
    flagLigada: () => Promise.resolve(true),
    cardsPorCtrcs: () => Promise.reject(new Error("timeout")),
    dicionario: () => Promise.resolve(DIC),
  };
  const r = await handleTratativas(req({ ctrcs: ["AMB638789-6"] }), { token: TOKEN, appUrl: null, repo });
  assertEquals(r.status, 500);
  assertEquals((await r.json()).erro, "falha_interna");
});

Deno.test("LEITURA PURA: nem o núcleo, nem a edge, nem o repositório de leitura escrevem", async () => {
  const ler = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const nucleo = await ler("./ponte-operacao-tratativas.ts");
  const edge = await ler("../ponte-tratativas/index.ts");
  const repo = await ler("./ponte-operacao-repo.ts");
  const ini = repo.indexOf("export function criarRepoTratativas");
  const fim = repo.indexOf("// ── pedidos", ini);
  assert(ini > 0 && fim > ini, "bloco criarRepoTratativas não encontrado");
  const blocoLeitura = repo.slice(ini, fim);
  for (const [nome, src] of [["núcleo", nucleo], ["edge", edge], ["repo de leitura", blocoLeitura]] as const) {
    for (const w of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      assert(!src.includes(w), `${nome} de ponte-tratativas não pode chamar ${w}`);
    }
  }
  // o tipo do repositório de leitura só tem leituras
  assertMatch(nucleo, /export interface RepoTratativas \{\s*flagLigada[^}]*cardsPorCtrcs[^}]*dicionario[^}]*\}/);
});
