// Guard — roteamento dos eventos da ponte do Roteirizador (ADR 0034).
// Trava: removida/nao_coube COM motivo = alerta; sem motivo e demais = contexto;
// tipo desconhecido = ignorado; sem card ativo o alerta espera e o contexto não;
// NUNCA há decisão de criar card; cursor nunca anda pra trás nem com falha.
// Rodar: deno test --no-check supabase/functions/_shared/roteirizador-eventos-rotear.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classificarEvento,
  ctrcsDoEvento,
  EVENTO_CARD_ALERTA,
  EVENTO_CARD_CONTEXTO,
  proximoCursor,
  rotearEvento,
} from "./roteirizador-eventos-rotear.ts";
import type { EventoPonte } from "./roteirizador-ponte-client.ts";

const ev = (over: Partial<EventoPonte>): EventoPonte => ({
  id: 10, tipo: "nota_removida", dataRef: "2026-09-25", rotaNome: "V07", ctrc: "VGA123",
  motivo: "cliente fechado", fotoEvidenciaUrl: null, ator: "João", ...over,
});

Deno.test("classificação: alerta só com motivo em removida/nao_coube", () => {
  assertEquals(classificarEvento(ev({})), "alerta");
  assertEquals(classificarEvento(ev({ tipo: "nota_nao_coube", motivo: "carro cheio" })), "alerta");
  assertEquals(classificarEvento(ev({ motivo: null })), "contexto");
  assertEquals(classificarEvento(ev({ motivo: "   " })), "contexto");
  assertEquals(classificarEvento(ev({ tipo: "rota_aprovada", motivo: "x" })), "contexto");
  assertEquals(classificarEvento(ev({ tipo: "nota_seguida" })), "contexto");
  assertEquals(classificarEvento(ev({ tipo: "nota_fora_da_doca", motivo: "x" })), "contexto");
  assertEquals(classificarEvento(ev({ tipo: "tipo_novo_que_nao_existe" })), "ignorado");
});

Deno.test("ctrcs: rota_aprovada usa ctrcs (dedupe + upper/trim); demais usam ctrc", () => {
  assertEquals(ctrcsDoEvento(ev({ tipo: "rota_aprovada", ctrc: null, ctrcs: [" amb1-1", "AMB1-1", "BHZ2-2", ""] })), ["AMB1-1", "BHZ2-2"]);
  assertEquals(ctrcsDoEvento(ev({ ctrc: " vga123 " })), ["VGA123"]);
  assertEquals(ctrcsDoEvento(ev({ ctrc: null })), []);
});

Deno.test("alerta + card ativo → card_event RoteirizadorAlertaRota no card", () => {
  const [l] = rotearEvento(ev({}), new Map([["VGA123", "card-1"]]));
  assertEquals(l!.situacao, "aplicado");
  assertEquals(l!.cardId, "card-1");
  assertEquals(l!.cardEventType, EVENTO_CARD_ALERTA);
  assertEquals(l!.cardEventPayload?.["motivo"], "cliente fechado");
  assertEquals(l!.cardEventPayload?.["evento_id"], 10);
  assertEquals(l!.cardEventPayload?.["origem"], "ponte_roteirizador");
});

Deno.test("alerta SEM card ativo → aguardando_card (payload guardado), nunca cria card", () => {
  const [l] = rotearEvento(ev({}), new Map());
  assertEquals(l!.situacao, "aguardando_card");
  assertEquals(l!.cardId, null);
  assertEquals(l!.cardEventType, null);
  assertEquals(l!.cardEventPayload?.["tipo"], "nota_removida");
});

Deno.test("contexto: com card → RoteirizadorContextoRota; sem card → sem_card (nada guardado)", () => {
  const rota = ev({ id: 11, tipo: "rota_aprovada", ctrc: null, ctrcs: ["A1-1", "B2-2"], motivo: null });
  const linhas = rotearEvento(rota, new Map([["A1-1", "card-a"]]));
  assertEquals(linhas.length, 2);
  assertEquals(linhas[0]!.cardEventType, EVENTO_CARD_CONTEXTO);
  assertEquals(linhas[0]!.cardEventPayload?.["total_notas_na_rota"], 2);
  assertEquals(linhas[1]!.situacao, "sem_card");
  assertEquals(linhas[1]!.cardEventPayload, null);
});

Deno.test("ignorado: tipo desconhecido ou evento sem CTRC vira 1 linha ignorada", () => {
  const [a] = rotearEvento(ev({ tipo: "xpto" }), new Map([["VGA123", "card-1"]]));
  assertEquals([a!.situacao, a!.cardEventType], ["ignorado", null]);
  const [b] = rotearEvento(ev({ ctrc: null }), new Map());
  assertEquals([b!.situacao, b!.ctrc], ["ignorado", ""]);
});

Deno.test("cursor: avança só com tudo gravado; nunca retrocede", () => {
  assertEquals(proximoCursor(5, { proximo: 10 }, true), 10);
  assertEquals(proximoCursor(5, { proximo: 10 }, false), 5);
  assertEquals(proximoCursor(5, { proximo: 3 }, true), 5);
  assertEquals(proximoCursor(5, { proximo: Number.NaN }, true), 5);
});
