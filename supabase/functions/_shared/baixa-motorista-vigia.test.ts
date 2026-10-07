// Guard — vigia da fila da baixa do motorista (INV-058 + ADR 0040). Pura, e a
// fiação no health-check (a fila nova não pode nascer sem vigia).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/baixa-motorista-vigia.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { avaliarFilaBaixas, type FatosFilaBaixas } from "./baixa-motorista-vigia.ts";

const fatos = (o: Partial<FatosFilaBaixas> = {}): FatosFilaBaixas => ({
  receberLigado: true, lancarLigado: true, esperandoAntigas: 0, lancandoTravadas: 0, errosRecentes: 0, ...o,
});

Deno.test("flag de receber OFF → nenhum alerta (feature desligada)", () => {
  assertEquals(avaliarFilaBaixas(fatos({ receberLigado: false, esperandoAntigas: 9, errosRecentes: 9 })), []);
});

Deno.test("tudo andando → silêncio", () => {
  assertEquals(avaliarFilaBaixas(fatos()), []);
});

Deno.test("fila parada com lançamento ligado → alerta fila_baixas_parada", () => {
  assertEquals(avaliarFilaBaixas(fatos({ esperandoAntigas: 4 })).map((a) => a.tipo), ["fila_baixas_parada"]);
});

Deno.test("esperando com lançamento desligado → alerta próprio (vão expirar), cooldown maior", () => {
  const a = avaliarFilaBaixas(fatos({ lancarLigado: false, esperandoAntigas: 2 }));
  assertEquals(a.map((x) => x.tipo), ["baixas_esperando_lancamento_desligado"]);
  assertEquals(a[0]!.cooldown_horas, 4);
});

Deno.test("lancando travado e erros recorrentes → alertas (nunca relançar às cegas)", () => {
  const a = avaliarFilaBaixas(fatos({ lancandoTravadas: 1, errosRecentes: 3 }));
  assertEquals(a.map((x) => x.tipo), ["baixas_lancamento_travado", "baixas_em_erro"]);
  assertEquals(avaliarFilaBaixas(fatos({ errosRecentes: 2 })), []);
});

Deno.test("fiação: o health-check roda o vigia da baixa", async () => {
  const src = await Deno.readTextFile(new URL("../health-check/index.ts", import.meta.url));
  assert(src.includes("checkFilaBaixasMotorista(supabase),"));
  assert(src.includes('from "../_shared/baixa-motorista-vigia.ts"'));
});
