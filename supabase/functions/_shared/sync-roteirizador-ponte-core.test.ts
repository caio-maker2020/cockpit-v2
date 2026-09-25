// Guard — sync da ponte do Roteirizador (ADR 0034): cursor + idempotência.
// Repositório em memória reproduz a PK (evento_id, ctrc) da mig 410: reprocessar
// a mesma página (cursor não avançou, crash, ponte repetiu) NÃO duplica card_event.
// Rodar: deno test --no-check supabase/functions/_shared/sync-roteirizador-ponte-core.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type RepoPonte, sincronizarEventosPonte } from "./sync-roteirizador-ponte-core.ts";
import type { LinhaEvento } from "./roteirizador-eventos-rotear.ts";
import {
  createRoteirizadorPonteClient,
  type EventoPonte,
} from "./roteirizador-ponte-client.ts";

function repoMemoria(cards: Record<string, string>, opts: { falharEvento?: number } = {}) {
  const linhas = new Map<string, LinhaEvento>();
  const cardEvents: Array<{ card_id: string; event_type: string; evento_id: number }> = [];
  const estado = { cursor: 0, erros: [] as string[], gravacoesCursor: 0 };
  const repo: RepoPonte = {
    lerCursor: () => Promise.resolve(estado.cursor),
    gravarCursor: (p) => { estado.cursor = p; estado.gravacoesCursor++; return Promise.resolve(); },
    registrarErro: (m) => { estado.erros.push(m); return Promise.resolve(); },
    cardsAtivosPorCtrc: (ctrcs) =>
      Promise.resolve(new Map(ctrcs.filter((c) => cards[c]).map((c) => [c, cards[c]!]))),
    registrarLinha: (l) => {
      if (opts.falharEvento === l.eventoId) return Promise.reject(new Error("banco caiu"));
      const k = `${l.eventoId}|${l.ctrc}`;
      if (linhas.has(k)) return Promise.resolve("repetido");
      linhas.set(k, l);
      if (l.cardId && l.cardEventType) {
        cardEvents.push({ card_id: l.cardId, event_type: l.cardEventType, evento_id: l.eventoId });
      }
      return Promise.resolve(l.situacao);
    },
    anexarPendentes: () => Promise.resolve(0),
  };
  return { repo, linhas, cardEvents, estado, opts };
}

/** Ponte falsa: eventos por id, pagina por `desde`/`limite` como o contrato. */
function ponteFalsa(eventos: EventoPonte[], opts: { ignorarCursor?: boolean } = {}) {
  const pedidos: number[] = [];
  const fetchFake = ((url: string) => {
    const u = new URL(String(url));
    const desde = Number(u.searchParams.get("desde"));
    const limite = Number(u.searchParams.get("limite"));
    pedidos.push(desde);
    const base = opts.ignorarCursor ? 0 : desde;
    const pagina = eventos.filter((e) => e.id > base).slice(0, limite);
    const proximo = pagina.length ? pagina[pagina.length - 1]!.id : desde;
    return Promise.resolve(new Response(JSON.stringify({ desde, proximo, eventos: pagina }), { status: 200 }));
  }) as unknown as typeof fetch;
  const client = createRoteirizadorPonteClient({
    env: { apiUrl: "https://ri", token: "t" }, fetch: fetchFake, sleep: () => Promise.resolve(),
  });
  return { client, pedidos };
}

const ev = (id: number, over: Partial<EventoPonte> = {}): EventoPonte => ({
  id, tipo: "nota_removida", dataRef: "2026-09-25", rotaNome: "V07", ctrc: `C${id}-1`,
  motivo: "cliente fechado", fotoEvidenciaUrl: null, ator: "João", ...over,
});

Deno.test("cursor: pagina até esgotar e grava o último proximo", async () => {
  const { client, pedidos } = ponteFalsa([ev(1), ev(2), ev(3), ev(4), ev(5)]);
  const { repo, estado } = repoMemoria({});
  const r = await sincronizarEventosPonte(client, repo, { limite: 2 });
  assertEquals(pedidos, [0, 2, 4, 5]);
  assertEquals(estado.cursor, 5);
  assertEquals([r.cursor_inicial, r.cursor_final, r.eventos], [0, 5, 5]);
  assertEquals(r.erro, null);
});

Deno.test("cursor: próxima rodada parte de onde parou (não repete eventos)", async () => {
  const { client, pedidos } = ponteFalsa([ev(1), ev(2)]);
  const m = repoMemoria({});
  await sincronizarEventosPonte(client, m.repo);
  pedidos.length = 0;
  const r = await sincronizarEventosPonte(client, m.repo);
  assertEquals(pedidos, [2]);
  assertEquals(r.eventos, 0);
});

Deno.test("idempotência: reprocessar a MESMA página não duplica card_event", async () => {
  const eventos = [ev(1, { ctrc: "AMB1-1" }), ev(2, { tipo: "rota_aprovada", ctrc: null, ctrcs: ["AMB1-1", "BHZ2-2"], motivo: null })];
  const m = repoMemoria({ "AMB1-1": "card-a", "BHZ2-2": "card-b" });
  const p1 = ponteFalsa(eventos);
  const r1 = await sincronizarEventosPonte(p1.client, m.repo);
  assertEquals(m.cardEvents.length, 3);
  assertEquals(r1.aplicados, 3);
  // Ponte que ignora o cursor (ou cursor perdido): devolve tudo de novo.
  m.estado.cursor = 0;
  const p2 = ponteFalsa(eventos, { ignorarCursor: true });
  const r2 = await sincronizarEventosPonte(p2.client, m.repo, { maxPaginas: 1 });
  assertEquals(m.cardEvents.length, 3);
  assertEquals(r2.repetidos, 3);
  assertEquals(r2.aplicados, 0);
});

Deno.test("falha de gravação: cursor NÃO avança e o erro fica registrado", async () => {
  const { client } = ponteFalsa([ev(1), ev(2), ev(3)]);
  const m = repoMemoria({}, { falharEvento: 2 });
  const r = await sincronizarEventosPonte(client, m.repo);
  assertEquals(m.estado.cursor, 0);
  assertEquals(m.estado.gravacoesCursor, 0);
  assertEquals(r.erro?.includes("evento 2"), true);
  assertEquals(m.estado.erros.length, 1);
  // Rodada seguinte, banco de volta: reprocessa a página inteira; o que já
  // tinha gravado volta 'repetido', o que falhou grava agora, cursor avança.
  delete m.opts.falharEvento;
  const r2 = await sincronizarEventosPonte(client, m.repo);
  assertEquals(r2.repetidos, 2);
  assertEquals(r2.aguardando_card, 1);
  assertEquals(m.estado.cursor, 3);
  assertEquals(m.linhas.size, 3);
});

Deno.test("ponte fora (503): não mexe no cursor, registra erro, nunca lança", async () => {
  const client = createRoteirizadorPonteClient({
    env: { apiUrl: "https://ri", token: "t" }, sleep: () => Promise.resolve(), maxTentativas: 2,
    fetch: (() => Promise.resolve(new Response("{}", { status: 503 }))) as unknown as typeof fetch,
  });
  const m = repoMemoria({});
  const r = await sincronizarEventosPonte(client, m.repo);
  assertEquals(m.estado.cursor, 0);
  assertEquals(r.erro?.startsWith("indisponivel"), true);
  assertEquals(m.estado.erros.length, 1);
});

Deno.test("roteamento no sync: alerta sem card espera; contexto sem card não gera nada", async () => {
  const { client } = ponteFalsa([
    ev(1, { ctrc: "SEMCARD-1" }),
    ev(2, { tipo: "nota_seguida", ctrc: "SEMCARD-2", motivo: null }),
    ev(3, { ctrc: "COMCARD-3" }),
  ]);
  const m = repoMemoria({ "COMCARD-3": "card-3" });
  const r = await sincronizarEventosPonte(client, m.repo);
  assertEquals([r.aguardando_card, r.sem_card, r.aplicados], [1, 1, 1]);
  assertEquals(m.cardEvents, [{ card_id: "card-3", event_type: "RoteirizadorAlertaRota", evento_id: 3 }]);
});
