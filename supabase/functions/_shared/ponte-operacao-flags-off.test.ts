// Guard — COM AS FLAGS DA PONTE v2 DESLIGADAS, NADA MUDA NO QUE RODA HOJE (ADR 0039).
// Mesmo espírito do "prompt idêntico byte a byte" da ADR 0038. Três provas:
//
//   1. SNAPSHOT DO ANTES: os caminhos da ponte v1 (roteador de eventos, sync por
//      cursor, consulta dos agentes e compromisso do executor com flag OFF) rodam
//      sobre fixtures e o resultado é comparado com o JSON capturado rodando o
//      MESMO cenário sobre o código do commit base da v1 (antes da v2; era
//      fbc5e30, hoje 7c4f0cb depois do rebase sobre master 178dcf8).
//   2. PINO DOS ARQUIVOS: executor, envelope do SSW, tripé, cliente SSW, sync da
//      v1, roteador, redator, IA da 49, vinculador, sync-bastao, prompts/ e a
//      mig 414 são BYTE A BYTE os da v1 (commit 7c4f0cb, rebase de fbc5e30 sobre
//      master 178dcf8, mais só a renumeração ADR 0034→0038 / mig 410→414 nos
//      comentários). A v2 não encosta neles.
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

  // sync por cursor, repositório em memória com a PK (evento_id, ctrc) da mig 414
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
  // O rebase sobre master 178dcf8 (7c4f0cb) não mudou nenhum módulo da v1 além de comentários.
  const SNAPSHOT_ANTES = JSON.parse(await Deno.readTextFile(new URL("./ponte-operacao-flags-off.snapshot.json", import.meta.url)));
  const agora = await cenariosV1({
    rotear: rotearAtual, core: coreAtual, client: clientAtual, consulta: consultaAtual, compromisso: compromissoAtual,
  });
  assertEquals(JSON.parse(JSON.stringify(agora)), SNAPSHOT_ANTES);
  // e com a flag OFF os agentes/executor não fazem NENHUMA chamada à ponte: o prompt é o de hoje
  assertEquals(agora.consultaFlagOff, null);
  assertEquals(agora.fetchesComFlagOff, 0);
});

// SHA-256 dos arquivos da v1 rebaseada (7c4f0cb) depois da renumeração (shasum -a 256 <arquivo>).
// Repinado no rebase sobre master 178dcf8: executor, agentes, sync-bastao etc. mudaram no master;
// entre 7c4f0cb e a v2 a única diferença nesses arquivos é ADR 0034→0038 / mig 410→414.
const PINO_BASE_V1: Record<string, string> = {
  "supabase/functions/executor/index.ts": "5a24e616db335c8f06468af60263946d818a0e861d1ed80fd57aab75b7e7bdf8",
  "supabase/functions/sync-roteirizador-ponte/index.ts": "4f8744539348d7b5230b46f1a25141fc8b18d8d810f54d284fda1a0c53f32993",
  "supabase/functions/_shared/sync-roteirizador-ponte-core.ts": "bada375a0325cd31a60b465c3d6af05c6d9ef5bc4fa1a0e9b6935169be334f84",
  "supabase/functions/_shared/roteirizador-eventos-rotear.ts": "149d56e67a32456b13dae0a6a7cdaffa8186650fa7514c3a01cb68e17398beed",
  "supabase/functions/_shared/roteirizador-ponte-client.ts": "a0720d80c658a21b117901ab7b48d938ae12023684df6717d15893a611679dfc",
  "supabase/functions/_shared/consultar-rota-roteirizador.ts": "63a4002233bf52e373cfe58c01dc7c71bf1af5994d91c7f0aed4b934c76bf018",
  "supabase/functions/_shared/compromisso-reentrega-ponte.ts": "7d7b5d47fe4c4c46d901572ff62911a717bea31ec1302304fa32fb7d3fc894e3",
  "supabase/functions/_shared/lancar-ssw-portal.ts": "b5a0c399bdf45bcc9e060b296a5c93972df27259134daeca26ec40c8a91f540b",
  "supabase/functions/_shared/ssw-internal-client.ts": "828ec25afe0b7db8cfc767d73dc55be9af7cc78e9bcc064ddf41df27f0819d44",
  "supabase/functions/_shared/validar-tripe-ssw.ts": "c50e4631b7605aa7dd7e0174920542f72d5e13ee06ebf3e7c33fea34cabd721e",
  "supabase/functions/redator/index.ts": "18853a41e9b886a1db0809ab3e5cfc8afe0e5d2595fb79bb96a04da6b95b0bd5",
  "supabase/functions/_shared/oc49-ia.ts": "1b50507c75dd77050818531ed4a5b2f03f8c1298e61423b19752cb07d25e40a7",
  "supabase/functions/agente-sugere-ocs-padrao/index.ts": "ef48c02dc8ad4744f42cfb6ce17547e0068140b5f25c165c5ee51f5c7f9c7385",
  "supabase/functions/vinculador/index.ts": "78320b9b89473cfbe2b079bc7f5455e1775c1faf8c2cd701729f86435859fe0c",
  "supabase/functions/sync-bastao/index.ts": "361d4def8533925f52828999538e75f078ad3575b70c6c896e9ddec719f3293e",
  "supabase/functions/_shared/bastao-client.ts": "f641be1fb507c6144602fe9310924820f8891f4ce3b749357c9e7d136dfc57a1",
  "supabase/functions/_shared/bastao-rules.ts": "97a6dfe8571ca24301a3294a1a357f20b93540634e76cb8addb7415a3cb0a0fb",
  "supabase/functions/_shared/operador-resolver.ts": "6fb1d624159f406d80589ea6c8129dad66dbb6a573cff9f8f534fe94d760bfb5",
  "supabase/functions/_shared/scan-email-enqueue.ts": "b83c632012b921fdb360da50ecac82fac30198cd441e707f9c9fc0317f051fa2",
  "supabase/functions/_shared/estado-tratativa.ts": "35f1ef56d603b9ed156aa999ffa5bddac3a2e3c609f569151ec5bc1088f007bc",
  "migration/2026-10-07_414_ponte_roteirizador.sql": "b54acf99ac2762f36c464e8df970e7231c8c2dcab8ecd847897d1085d5199009",
};
/** sha256 de "<sha256(arquivo)> <caminho>\n" por arquivo de prompts/, em ordem de nome (LC_ALL=C). */
const PINO_PROMPTS_V1 = "ab04d8690a2853630aa802318c88c8cd40c83cd53d667a8553fd7e960f51b49b";

const RAIZ = new URL("../../../", import.meta.url);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

Deno.test("PINO: executor, envelope SSW, sync da v1, agentes, prompts e mig 414 são byte a byte os de antes", async () => {
  const diferentes: string[] = [];
  for (const [arq, esperado] of Object.entries(PINO_BASE_V1)) {
    const atual = await sha256(await Deno.readFile(new URL(arq, RAIZ)));
    if (atual !== esperado) diferentes.push(arq);
  }
  assertEquals(diferentes, [], "a ponte v2 não pode alterar arquivos que já rodam em produção");

  const nomes: string[] = [];
  for await (const e of Deno.readDir(new URL("prompts/", RAIZ))) if (e.isFile) nomes.push(`prompts/${e.name}`);
  nomes.sort();
  // Prompts NOVOS (não existiam no pino) ficam fora da conta: o pino trava os que já rodam.
  const NOVOS = new Set(["prompts/agente-operacao.md"]); // ADR 0041 D10
  for (let i = nomes.length - 1; i >= 0; i--) if (NOVOS.has(nomes[i]!)) nomes.splice(i, 1);
  let lista = "";
  for (const n of nomes) lista += `${await sha256(await Deno.readFile(new URL(n, RAIZ)))} ${n}\n`;
  assertEquals(await sha256(new TextEncoder().encode(lista)), PINO_PROMPTS_V1, "prompts/ mudou");
});

/** Arquivos da ponte v2 (os únicos que podem importar código da v2). */
function ehDaV2(caminho: string): boolean {
  // ADR 0041 D11: o encaminhamento da Operação É um pedido devolver da ponte. Só o TESTE
  // que trava esse acoplamento pode citar a ponte; nenhuma edge/módulo de produção novo.
  if (caminho.endsWith("/_shared/operacao-encaminhar.test.ts")) return true;
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
