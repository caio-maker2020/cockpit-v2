// Guard — COM AS FLAGS DA PONTE v2 DESLIGADAS, NADA MUDA NO QUE RODA HOJE (ADR 0035).
// Mesmo espírito do "prompt idêntico byte a byte" da ADR 0034. Três provas:
//
//   1. SNAPSHOT DO ANTES: os caminhos da ponte v1 (roteador de eventos, sync por
//      cursor, consulta dos agentes e compromisso do executor com flag OFF) rodam
//      sobre fixtures e o resultado é comparado com o JSON capturado rodando o
//      MESMO cenário sobre o código do commit base fbc5e30 (antes da v2).
//   2. PINO DOS ARQUIVOS: executor, envelope do SSW, tripé, cliente SSW, sync da
//      v1, roteador, redator, IA da 49, vinculador, sync-bastao, prompts/ e a
//      mig 410 são BYTE A BYTE os do commit fbc5e30. A v2 não encosta neles.
//      (Se outro PR mudar um deles de propósito, atualize o pino e diga por quê:
//      o pino existe para provar que a ponte v2 não tocou no que já roda.)
//   3. ISOLAMENTO: nenhuma função existente importa código da v2 — com as flags
//      OFF (ou sem deploy), o código novo é inalcançável a partir do que existe.
//
// As edges novas com flag OFF respondem 503 sem gravar nada: ver
// ponte-operacao-tratativas.test.ts, ponte-operacao-pedido.test.ts e
// ponte-operacao-worker.test.ts ("FLAGS OFF").
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/ponte-operacao-flags-off.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as rotearAtual from "./roteirizador-eventos-rotear.ts";
import * as coreAtual from "./sync-roteirizador-ponte-core.ts";
import * as clientAtual from "./roteirizador-ponte-client.ts";
import * as consultaAtual from "./consultar-rota-roteirizador.ts";
import * as compromissoAtual from "./compromisso-reentrega-ponte.ts";
import type { EventoPonte } from "./roteirizador-ponte-client.ts";
import type { LinhaEvento } from "./roteirizador-eventos-rotear.ts";

export interface ModsV1 {
  rotear: typeof rotearAtual;
  core: typeof coreAtual;
  client: typeof clientAtual;
  consulta: typeof consultaAtual;
  compromisso: typeof compromissoAtual;
}

/** Cenário fixo da ponte v1. Exportado para o gerador do snapshot rodar o MESMO cenário no código base. */
export async function cenariosV1(m: ModsV1): Promise<Record<string, unknown>> {
  const ev = (o: Partial<EventoPonte> & { id: number; tipo: string }): EventoPonte => ({
    dataRef: "2026-09-25", rotaNome: "V07", ctrc: null, motivo: null, fotoEvidenciaUrl: null, ator: "João", ...o,
  });
  const eventos: EventoPonte[] = [
    ev({ id: 1, tipo: "nota_removida", ctrc: "AMB1-1", motivo: "cliente fechado", fotoEvidenciaUrl: "https://f/1.jpg" }),
    ev({ id: 2, tipo: "nota_removida", ctrc: "AMB2-2", motivo: "endereço não existe" }),
    ev({ id: 3, tipo: "nota_nao_coube", ctrc: "AMB1-1" }),
    ev({ id: 4, tipo: "rota_aprovada", ctrcs: ["amb1-1", "AMB3-3", " AMB1-1 "] }),
    ev({ id: 5, tipo: "nota_seguida", ctrc: "AMB3-3" }),
    ev({ id: 6, tipo: "nota_fora_da_doca", ctrc: "AMB4-4", motivo: "doca cheia" }),
    ev({ id: 7, tipo: "tipo_que_nao_existe", ctrc: "AMB1-1", motivo: "x" }),
    ev({ id: 8, tipo: "nota_removida", motivo: "sem ctrc" }),
  ];
  const cards = new Map([["AMB1-1", "card-1"], ["AMB3-3", "card-3"]]);
  const out: Record<string, unknown> = {};
  out.classificacao = eventos.map((e) => m.rotear.classificarEvento(e));
  out.ctrcs = eventos.map((e) => m.rotear.ctrcsDoEvento(e));
  out.rotas = eventos.map((e) => m.rotear.rotearEvento(e, cards));
  out.cursor = ([[0, 5, true], [5, 3, true], [5, 9, false], [5, Number.NaN, true]] as const)
    .map(([a, p, t]) => m.rotear.proximoCursor(a, { proximo: p }, t));

  // sync por cursor, repositório em memória com a PK (evento_id, ctrc) da mig 410
  const linhas = new Map<string, LinhaEvento>();
  const cardEvents: Array<{ card_id: string; event_type: string; evento_id: number }> = [];
  let cursor = 0;
  const repo = {
    lerCursor: () => Promise.resolve(cursor),
    gravarCursor: (p: number) => { cursor = p; return Promise.resolve(); },
    registrarErro: () => Promise.resolve(),
    cardsAtivosPorCtrc: (cs: string[]) => Promise.resolve(new Map(cs.filter((c) => cards.has(c)).map((c) => [c, cards.get(c)!]))),
    registrarLinha: (l: LinhaEvento) => {
      const k = `${l.eventoId}|${l.ctrc}`;
      if (linhas.has(k)) return Promise.resolve("repetido");
      linhas.set(k, l);
      if (l.cardId && l.cardEventType) cardEvents.push({ card_id: l.cardId, event_type: l.cardEventType, evento_id: l.eventoId });
      return Promise.resolve(l.situacao);
    },
    anexarPendentes: () => Promise.resolve(0),
  };
  let fetches = 0;
  const fetchFake = ((url: string) => {
    fetches++;
    const u = new URL(String(url));
    if (u.pathname.endsWith("/eventos")) {
      const desde = Number(u.searchParams.get("desde"));
      const limite = Number(u.searchParams.get("limite"));
      const pagina = eventos.filter((e) => e.id > desde).slice(0, limite);
      const proximo = pagina.length ? pagina[pagina.length - 1]!.id : desde;
      return Promise.resolve(new Response(JSON.stringify({ desde, proximo, eventos: pagina }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ noPlano: false, compromissos: [] }), { status: 200 }));
  }) as unknown as typeof fetch;
  const client = m.client.createRoteirizadorPonteClient({
    env: { apiUrl: "https://ri", token: "t" }, fetch: fetchFake, sleep: () => Promise.resolve(),
  });
  const resumo1 = await m.core.sincronizarEventosPonte(client, repo, { limite: 3 });
  cursor = 0; // reprocessar tudo: idempotência da PK
  const resumo2 = await m.core.sincronizarEventosPonte(client, repo, { limite: 3 });
  out.sync = { resumo1, resumo2, cardEvents, cursor, fetchesSync: fetches };

  // flag OFF nos agentes (redator / IA da 49) e no executor (compromisso da 21)
  const supaFlagOff = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { enabled: false }, error: null }) }) }) }),
  } as unknown as Parameters<typeof m.consulta.consultarRotaRoteirizador>[0];
  fetches = 0;
  out.consultaFlagOff = await m.consulta.consultarRotaRoteirizador(supaFlagOff, { id: "c", ctrc: "AMB1-1" }, { client, agente: "t" });
  out.compromissoFlagOff = await m.compromisso.enviarCompromissoReentregaSeCombinado(
    supaFlagOff,
    { cardId: "c", ctrc: "AMB1-1", codigoSsw: 21, extras: { data_reentrega: "2026-09-30" } },
    { client },
  );
  out.fetchesComFlagOff = fetches;
  return out;
}

Deno.test("SNAPSHOT: ponte v1 (roteador, sync, consulta e compromisso com flag OFF) igual ao de antes da v2", async () => {
  // Capturado rodando cenariosV1() sobre o código de fbc5e30 (git archive → módulos de antes da v2).
  const SNAPSHOT_ANTES = JSON.parse(await Deno.readTextFile(new URL("./ponte-operacao-flags-off.snapshot.json", import.meta.url)));
  const agora = await cenariosV1({
    rotear: rotearAtual, core: coreAtual, client: clientAtual, consulta: consultaAtual, compromisso: compromissoAtual,
  });
  assertEquals(JSON.parse(JSON.stringify(agora)), SNAPSHOT_ANTES);
  // e com a flag OFF os agentes/executor não fazem NENHUMA chamada à ponte: o prompt é o de hoje
  assertEquals(agora.consultaFlagOff, null);
  assertEquals(agora.fetchesComFlagOff, 0);
});

// SHA-256 dos arquivos no commit base fbc5e30 (git show fbc5e30:<arquivo> | shasum -a 256).
const PINO_BASE_FBC5E30: Record<string, string> = {
  "supabase/functions/executor/index.ts": "e70c809f1d671a6cbbae1cf4f08f1e80806445e58de6a57240be360c5b363258",
  "supabase/functions/sync-roteirizador-ponte/index.ts": "a57f93427e071e5d83d0ba6e797b6f9f340fe2d90ee0fb067537181a54108565",
  "supabase/functions/_shared/sync-roteirizador-ponte-core.ts": "216fed5bd40fe89f4d35af3c75473befc744a54fe83925bca9ede104bfd8a817",
  "supabase/functions/_shared/roteirizador-eventos-rotear.ts": "82d9e7ed9b2c22552710399386bf03bbcc3e3a7642bfd55b477eaedca5174846",
  "supabase/functions/_shared/roteirizador-ponte-client.ts": "211da1d51e773c263eb31b002c8cf240304165a06218d108940ea207551248f0",
  "supabase/functions/_shared/consultar-rota-roteirizador.ts": "08ec19dc11f82270471eafbe4a77b76ca9e5259c7ab36c3c29ecab22dfef8a81",
  "supabase/functions/_shared/compromisso-reentrega-ponte.ts": "c9301f09a954a96b308cda7157f531ab904ea5bf214556510006e0a3b010f8e7",
  "supabase/functions/_shared/lancar-ssw-portal.ts": "b5a0c399bdf45bcc9e060b296a5c93972df27259134daeca26ec40c8a91f540b",
  "supabase/functions/_shared/ssw-internal-client.ts": "828ec25afe0b7db8cfc767d73dc55be9af7cc78e9bcc064ddf41df27f0819d44",
  "supabase/functions/_shared/validar-tripe-ssw.ts": "c50e4631b7605aa7dd7e0174920542f72d5e13ee06ebf3e7c33fea34cabd721e",
  "supabase/functions/redator/index.ts": "d44ff3bdbd8c0c59f0fa73c11620f625f4e2f0a1c93781eb83cef14e2a6a00a9",
  "supabase/functions/_shared/oc49-ia.ts": "ec785f9f1cfbe7b3eafee96e767efd0755563aff911cdc29d1338746af1c8472",
  "supabase/functions/agente-sugere-ocs-padrao/index.ts": "ed84ac27f4f5100a56544465fe8a3f8e1d2a4fd889775d78332287eafbf6fb02",
  "supabase/functions/vinculador/index.ts": "78320b9b89473cfbe2b079bc7f5455e1775c1faf8c2cd701729f86435859fe0c",
  "supabase/functions/sync-bastao/index.ts": "56a596db7926717b550b25389263155d1a5dfd22a925a3c9ca93e478c4ed4e0e",
  "supabase/functions/_shared/bastao-client.ts": "f641be1fb507c6144602fe9310924820f8891f4ce3b749357c9e7d136dfc57a1",
  "supabase/functions/_shared/bastao-rules.ts": "97a6dfe8571ca24301a3294a1a357f20b93540634e76cb8addb7415a3cb0a0fb",
  "supabase/functions/_shared/operador-resolver.ts": "6fb1d624159f406d80589ea6c8129dad66dbb6a573cff9f8f534fe94d760bfb5",
  "supabase/functions/_shared/scan-email-enqueue.ts": "b83c632012b921fdb360da50ecac82fac30198cd441e707f9c9fc0317f051fa2",
  "supabase/functions/_shared/estado-tratativa.ts": "35f1ef56d603b9ed156aa999ffa5bddac3a2e3c609f569151ec5bc1088f007bc",
  "migration/2026-09-24_410_ponte_roteirizador.sql": "42aea8c52206984e40945772d34a51c661cc0592f307680fccc19a3856e42645",
};
/** sha256 de "<sha256(arquivo)> <caminho>\n" por arquivo de prompts/, em ordem de nome (LC_ALL=C). */
const PINO_PROMPTS_FBC5E30 = "ab04d8690a2853630aa802318c88c8cd40c83cd53d667a8553fd7e960f51b49b";

const RAIZ = new URL("../../../", import.meta.url);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

Deno.test("PINO: executor, envelope SSW, sync da v1, agentes, prompts e mig 410 são byte a byte os de antes", async () => {
  const diferentes: string[] = [];
  for (const [arq, esperado] of Object.entries(PINO_BASE_FBC5E30)) {
    const atual = await sha256(await Deno.readFile(new URL(arq, RAIZ)));
    if (atual !== esperado) diferentes.push(arq);
  }
  assertEquals(diferentes, [], "a ponte v2 não pode alterar arquivos que já rodam em produção");

  const nomes: string[] = [];
  for await (const e of Deno.readDir(new URL("prompts/", RAIZ))) if (e.isFile) nomes.push(`prompts/${e.name}`);
  nomes.sort();
  let lista = "";
  for (const n of nomes) lista += `${await sha256(await Deno.readFile(new URL(n, RAIZ)))} ${n}\n`;
  assertEquals(await sha256(new TextEncoder().encode(lista)), PINO_PROMPTS_FBC5E30, "prompts/ mudou");
});

/** Arquivos da ponte v2 (os únicos que podem importar código da v2). */
function ehDaV2(caminho: string): boolean {
  return caminho.includes("ponte-operacao") || caminho.includes("/ponte-tratativas/") ||
    caminho.includes("/ponte-pedido-operacao/") || caminho.includes("/processar-pedidos-operacao/");
}

async function* arquivosTs(dir: URL, rel = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const r = `${rel}${e.name}`;
    if (e.isDirectory) yield* arquivosTs(new URL(`${e.name}/`, dir), `${r}/`);
    else if (e.isFile && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) yield r;
  }
}

Deno.test("ISOLAMENTO: nenhuma função existente importa a ponte v2 (código novo inalcançável com tudo OFF)", async () => {
  const base = new URL("supabase/functions/", RAIZ);
  const violacoes: string[] = [];
  let vistos = 0;
  for await (const rel of arquivosTs(base)) {
    const caminho = `supabase/functions/${rel}`;
    if (ehDaV2(`/${caminho}`)) continue;
    vistos++;
    const src = await Deno.readTextFile(new URL(rel, base));
    if (/from\s+["'][^"']*ponte-operacao[^"']*["']|import\(\s*["'][^"']*ponte-operacao/.test(src)) violacoes.push(caminho);
    if (/ponte_operacao_(leitura|pedidos|lancar_ssw)|ponte_operacao_pedidos|ponte_operacao_codigos_permitidos/.test(src)) {
      violacoes.push(`${caminho} (cita flag/tabela da v2)`);
    }
  }
  assert(vistos > 100, `varredura suspeita: só ${vistos} arquivos`);
  assertEquals(violacoes, []);
});
