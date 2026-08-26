// Guard da janela de veto (INV pendente de número — etapa A do plano 25/08):
// 60 minutos ÚTEIS respeitam expediente 08:00–17:30 BRT, fim de semana e
// feriado. Se este cálculo regredir, ação autônoma executa em hora morta
// (ninguém olhando) — exatamente o que a janela de veto existe pra impedir.
// Rodar: deno test supabase/functions/_shared/minutos-uteis.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adicionarMinutosUteis, chaveDataBRT, ehDiaUtil } from "./minutos-uteis.ts";

const SEM_FERIADO: ReadonlySet<string> = new Set();
// feriado real: 07/09/2026 (Independência) cai numa segunda-feira
const FERIADOS: ReadonlySet<string> = new Set(["2026-09-07"]);

// util: instante BRT → Date UTC (BRT fixo -03:00)
const brt = (iso: string) => new Date(`${iso}-03:00`);

Deno.test("dia comum: 10:00 + 60min = 11:00 do mesmo dia", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T10:00:00"), 60, SEM_FERIADO).toISOString(),
    brt("2026-08-25T11:00:00").toISOString(),
  );
});

Deno.test("corte das 17h (Caio 26/08): nasceu 17:10 sexta → NÃO fraciona; janela inteira segunda 08:00→09:00", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-28T17:10:00"), 60, SEM_FERIADO).toISOString(),
    brt("2026-08-31T09:00:00").toISOString(),
  );
});

Deno.test("corte das 17h é exato: 17:00 já vai pro dia seguinte; 16:59 ainda fraciona", () => {
  // 17:00 em ponto → dia seguinte 08:00 + 60 = 09:00
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T17:00:00"), 60, SEM_FERIADO).toISOString(),
    brt("2026-08-26T09:00:00").toISOString(),
  );
  // 16:59 → 31min até 17:30 + 29min no dia seguinte = 08:29
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T16:59:00"), 60, SEM_FERIADO).toISOString(),
    brt("2026-08-26T08:29:00").toISOString(),
  );
});

Deno.test("início no sábado: relógio só começa segunda 08:00", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-29T11:00:00"), 60, SEM_FERIADO).toISOString(),
    brt("2026-08-31T09:00:00").toISOString(),
  );
});

Deno.test("feriado na virada: sexta 16:50 + 60min pula 07/09 (Independência, segunda) = terça 08:20", () => {
  // 40min sexta (16:50→17:30) + pula fds + feriado → 20min na terça
  assertEquals(
    adicionarMinutosUteis(brt("2026-09-04T16:50:00"), 60, FERIADOS).toISOString(),
    brt("2026-09-08T08:20:00").toISOString(),
  );
  // nascida no corte (17:00) → janela inteira na terça 08:00→09:00
  assertEquals(
    adicionarMinutosUteis(brt("2026-09-04T17:00:00"), 60, FERIADOS).toISOString(),
    brt("2026-09-08T09:00:00").toISOString(),
  );
});

Deno.test("antes das 08:00: relógio começa às 08:00 do próprio dia", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T07:30:00"), 10, SEM_FERIADO).toISOString(),
    brt("2026-08-25T08:10:00").toISOString(),
  );
});

Deno.test("exatamente às 17:30: já é fora do expediente — vai pro dia seguinte", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T17:30:00"), 15, SEM_FERIADO).toISOString(),
    brt("2026-08-26T08:15:00").toISOString(),
  );
});

Deno.test("0 minutos fora do expediente: normaliza pro primeiro instante útil", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-29T11:00:00"), 0, SEM_FERIADO).toISOString(),
    brt("2026-08-31T08:00:00").toISOString(),
  );
});

Deno.test("janela maior que um dia útil: 600min de terça 09:00 = quarta 09:30 (510 terça + 90 quarta)", () => {
  assertEquals(
    adicionarMinutosUteis(brt("2026-08-25T09:00:00"), 600, SEM_FERIADO).toISOString(),
    brt("2026-08-26T09:30:00").toISOString(),
  );
});

Deno.test("entrada inválida explode em vez de agendar silenciosamente errado", () => {
  assertThrows(() => adicionarMinutosUteis(new Date("lixo"), 60, SEM_FERIADO));
  assertThrows(() => adicionarMinutosUteis(brt("2026-08-25T10:00:00"), -5, SEM_FERIADO));
});

Deno.test("chaveDataBRT usa o dia BRT, não o UTC (23:00 BRT já é o dia seguinte em UTC)", () => {
  assertEquals(chaveDataBRT(brt("2026-08-25T23:00:00")), "2026-08-25");
  assertEquals(ehDiaUtil(brt("2026-09-07T10:00:00"), FERIADOS), false);
});
