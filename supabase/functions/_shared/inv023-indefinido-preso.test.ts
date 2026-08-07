// Guard de não-regressão — monitor INV-023 "card invisível preso em
// INDEFINIDO_RETRY" (alerta zumbi NF 371705, Caio 2026-08-07).
// Rodar: deno test supabase/functions/_shared/inv023-indefinido-preso.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acharIndefinidosPresos,
  EVENTO_ENTRADA_INDEFINIDO,
  EVENTOS_MONITOR_INDEFINIDO,
  EVENTOS_SAIDA_INDEFINIDO,
} from "./inv023-indefinido-preso.ts";

const AGORA = Date.parse("2026-08-07T00:40:00Z"); // hora do email zumbi real
const THRESHOLD = 90;

// helper: eventos chegam do banco ordenados do mais recente pro mais antigo
function ordenar(evs: Array<{ card_id: string; event_type: string; created_at: string }>) {
  return [...evs].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

Deno.test("caso real NF 371705: saiu do limbo pelo SWEEP INV-019 + executor → NÃO alerta", () => {
  const card = "076b318a-132f-4ce4-8b37-19ea76461aa1";
  const eventos = ordenar([
    // 16:31 BRT — entrou no limbo durante a pane l.silva
    { card_id: card, event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:31:17Z" },
    // 17:32 BRT — SWEEP INV-019 escalou pra AGUARDANDO VOCÊ (saída que o monitor não conhecia)
    { card_id: card, event_type: "AguardandoClienteOcMudou", created_at: "2026-08-06T20:32:18Z" },
    // 17:39 BRT — operadora aprovou, oc 56 lançada e confirmada
    { card_id: card, event_type: "StateTransicaoPosSucesso", created_at: "2026-08-06T20:39:07Z" },
    { card_id: card, event_type: "AcaoExecutadaConfirmadaPeloSsw", created_at: "2026-08-06T20:39:11Z" },
  ]);
  assertEquals(acharIndefinidosPresos(eventos, AGORA, THRESHOLD), []);
});

Deno.test("card genuinamente preso (nenhuma saída depois da entrada, >90min) → ALERTA", () => {
  const eventos = ordenar([
    { card_id: "c1", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:31:17Z" },
    // saída ANTIGA (antes da entrada atual) não conta
    { card_id: "c1", event_type: "CardReaberto", created_at: "2026-08-06T10:00:00Z" },
  ]);
  const presos = acharIndefinidosPresos(eventos, AGORA, THRESHOLD);
  assertEquals(presos.length, 1);
  assertEquals(presos[0]!.card_id, "c1");
  assertEquals(presos[0]!.indefinido_desde, "2026-08-06T19:31:17Z");
});

Deno.test("indefinido recente (<90min) ainda não alerta — política de prazo em curso", () => {
  const eventos = [
    { card_id: "c2", event_type: "ReaberturaIndefinida", created_at: new Date(AGORA - 30 * 60000).toISOString() },
  ];
  assertEquals(acharIndefinidosPresos(eventos, AGORA, THRESHOLD), []);
});

Deno.test("CADA evento de saída, individualmente, encerra o alerta", () => {
  for (const saida of EVENTOS_SAIDA_INDEFINIDO) {
    const eventos = ordenar([
      { card_id: "c3", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:31:17Z" },
      { card_id: "c3", event_type: saida, created_at: "2026-08-06T20:00:00Z" },
    ]);
    assertEquals(
      acharIndefinidosPresos(eventos, AGORA, THRESHOLD),
      [],
      `evento de saída "${saida}" deveria encerrar o alerta`,
    );
  }
});

Deno.test("re-entrada DEPOIS de uma saída volta a alertar (ordem importa)", () => {
  const eventos = ordenar([
    { card_id: "c4", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T15:00:00Z" },
    { card_id: "c4", event_type: "AguardandoClienteOcMudou", created_at: "2026-08-06T16:00:00Z" },
    { card_id: "c4", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:31:17Z" },
  ]);
  const presos = acharIndefinidosPresos(eventos, AGORA, THRESHOLD);
  assertEquals(presos.length, 1);
  assertEquals(presos[0]!.indefinido_desde, "2026-08-06T19:31:17Z");
});

Deno.test("múltiplos cards independentes: só o preso alerta", () => {
  const eventos = ordenar([
    { card_id: "preso", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:00:00Z" },
    { card_id: "resolvido", event_type: "ReaberturaIndefinida", created_at: "2026-08-06T19:00:00Z" },
    { card_id: "resolvido", event_type: "ExecucaoReconciliada", created_at: "2026-08-06T19:30:00Z" },
  ]);
  const presos = acharIndefinidosPresos(eventos, AGORA, THRESHOLD);
  assertEquals(presos.map((p) => p.card_id), ["preso"]);
});

Deno.test("lista do monitor = entrada + todas as saídas (sem duplicata)", () => {
  assertEquals(EVENTOS_MONITOR_INDEFINIDO.length, 1 + EVENTOS_SAIDA_INDEFINIDO.length);
  assertEquals(new Set(EVENTOS_MONITOR_INDEFINIDO).size, EVENTOS_MONITOR_INDEFINIDO.length);
  assertEquals(EVENTOS_MONITOR_INDEFINIDO.includes(EVENTO_ENTRADA_INDEFINIDO), true);
  // BastaoCardAtualizado NUNCA pode entrar na lista de saída: dispara a cada
  // sync mesmo sem mudança de estado e silenciaria cards genuinamente presos.
  assertEquals((EVENTOS_SAIDA_INDEFINIDO as readonly string[]).includes("BastaoCardAtualizado"), false);
});
