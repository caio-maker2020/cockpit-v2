// Testes do reconciliador da aba EXTRAVIOS via Bastão (INV-017).
// Cobre o que NÃO é coberto por extravio-routing.test.ts: o GATE DE FRESCOR e a
// inferência "NF sumiu do Bastão fresco → RESOLVIDO" — a lógica nova e arriscada.
// Rodar: deno test --allow-net --allow-env supabase/functions/_shared/reconciliar-extravios-bastao.test.ts
//
// Mock de supabase no estilo escopo-relacionamento.test.ts: cada from(table)
// devolve um builder que registra update/insert (table+payload) e é "awaitable"
// resolvendo {error:null}. Os casos testados não disparam proporAutoAcao
// (só aguardando_voce dispara, e a DECISÃO de oc=20 já é coberta no routing test).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CardExtravioParaReconciliar,
  reconciliarExtraviosViaBastao,
} from "./reconciliar-extravios-bastao.ts";
import { type BastaoPendencia } from "./bastao-client.ts";
import { normalizeNf } from "./extravio-enrichment.ts";

interface Call { table: string; op: "update" | "insert"; payload: Record<string, unknown> }

function makeMock(): { supabase: unknown; calls: Call[] } {
  const calls: Call[] = [];
  function builder(table: string): Record<string, unknown> {
    // deno-lint-ignore no-explicit-any
    const b: any = {
      update(payload: Record<string, unknown>) { calls.push({ table, op: "update", payload }); return b; },
      insert(payload: Record<string, unknown>) { calls.push({ table, op: "insert", payload }); return b; },
      eq() { return b; },
      select() { return b; },
      // deno-lint-ignore no-explicit-any
      then(resolve: (v: unknown) => any) { return Promise.resolve({ error: null, data: null }).then(resolve); },
    };
    return b;
  }
  return { supabase: { from: (t: string) => builder(t) }, calls };
}

function card(nf: string, oc = 6): CardExtravioParaReconciliar {
  return { id: `card-${nf}`, nf, ctrc: null, cod_ultima_ocorrencia: oc, bastao_data_ultima_ocorrencia: "2026-06-20", agent_state: {} };
}
function pend(nf: string, oc: number): BastaoPendencia {
  return { nf, cod_ultima_ocorrencia: oc, data_ultima_ocorrencia: "2026-06-22" } as unknown as BastaoPendencia;
}
function mapOf(...ps: BastaoPendencia[]): Map<string, BastaoPendencia> {
  const m = new Map<string, BastaoPendencia>();
  for (const p of ps) m.set(normalizeNf(p.nf)!, p);
  return m;
}

const cardsUpdated = (calls: Call[]) => calls.filter((c) => c.table === "cards" && c.op === "update");
const eventsInserted = (calls: Call[]) => calls.filter((c) => c.table === "card_events" && c.op === "insert");

Deno.test("SEGURANÇA: NF ausente + Bastão NÃO confirmado fresco → sem_acao (NUNCA resolve)", async () => {
  const { supabase, calls } = makeMock();
  // deno-lint-ignore no-explicit-any
  const res = await reconciliarExtraviosViaBastao(supabase as any, [card("111")], mapOf(), { bastaoConfirmadoFresco: false });
  assertEquals(res.relatorio[0].decisao, "sem_acao");
  assertEquals(res.sem_acao, 1);
  assertEquals(res.movidos, 0);
  assertEquals(cardsUpdated(calls).length, 0, "não pode tocar no card sem frescor garantido");
});

Deno.test("NF ausente + Bastão fresco → resolvido_sumiu (RESOLVIDO)", async () => {
  const { supabase, calls } = makeMock();
  // deno-lint-ignore no-explicit-any
  const res = await reconciliarExtraviosViaBastao(supabase as any, [card("222")], mapOf(), { bastaoConfirmadoFresco: true });
  assertEquals(res.relatorio[0].decisao, "resolvido_sumiu");
  assertEquals(res.movidos, 1);
  const upd = cardsUpdated(calls);
  assertEquals(upd.length, 1);
  assertEquals(upd[0].payload.state, "RESOLVIDO");
  assert(eventsInserted(calls).some((e) => (e.payload.event_type ?? (e.payload as Record<string, unknown>)["event_type"]) === "ExtravioFinalizadoBastaoAusente"));
});

Deno.test("NF presente oc 6 → fica (mantido), atualiza data, SEM card_event (sem flood)", async () => {
  const { supabase, calls } = makeMock();
  // deno-lint-ignore no-explicit-any
  const res = await reconciliarExtraviosViaBastao(supabase as any, [card("333", 6)], mapOf(pend("333", 9)), { bastaoConfirmadoFresco: true });
  assertEquals(res.relatorio[0].decisao, "extravio");
  assertEquals(res.mantidos, 1);
  const upd = cardsUpdated(calls);
  assertEquals(upd.length, 1);
  assertEquals(upd[0].payload.cod_ultima_ocorrencia, 9, "segue a oc do Bastão (6→9 ainda é extravio)");
  assertEquals(upd[0].payload.state, undefined, "mantido não muda state");
  assertEquals(eventsInserted(calls).length, 0, "mantido não emite card_event (roda todo ciclo)");
});

Deno.test("NF presente oc 33 (ressarcimento) → TRANSFERIDO + card_event", async () => {
  const { supabase, calls } = makeMock();
  // deno-lint-ignore no-explicit-any
  const res = await reconciliarExtraviosViaBastao(supabase as any, [card("444", 6)], mapOf(pend("444", 33)), { bastaoConfirmadoFresco: true });
  assertEquals(res.relatorio[0].decisao, "transferido");
  assertEquals(res.movidos, 1);
  const upd = cardsUpdated(calls);
  assertEquals(upd[0].payload.state, "TRANSFERIDO");
  assert(eventsInserted(calls).some((e) => e.payload.event_type === "ExtravioReconciliadoViaBastao"));
});

Deno.test("NF presente oc 1 (entregue/finalizadora) presente no Bastão → RESOLVIDO", async () => {
  const { supabase, calls } = makeMock();
  // deno-lint-ignore no-explicit-any
  const res = await reconciliarExtraviosViaBastao(supabase as any, [card("555", 6)], mapOf(pend("555", 1)), { bastaoConfirmadoFresco: true });
  assertEquals(res.relatorio[0].decisao, "resolvido");
  assertEquals(cardsUpdated(calls)[0].payload.state, "RESOLVIDO");
});
