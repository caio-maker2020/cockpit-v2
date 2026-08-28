// INV-004 emendado (Caio 28/08, regra v2 oc43): o Pass A preserva TAMBÉM a
// marca extravio_retomado_pos43 (relógio original do extravio pós-manutenção).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { preservarExtravioParcial } from "./preservar-extravio-parcial.ts";

Deno.test("marca pos43 sobrevive ao snapshot do Bastão", () => {
  const marca = { oc: 6, data_original: "26/08/26 10:36" };
  const out = preservarExtravioParcial({ nf: "1" }, { extravio_retomado_pos43: marca });
  assertEquals(out["extravio_retomado_pos43"], marca);
});

Deno.test("snapshot sem existing → intacto; dossiê parcial continua preservado junto", () => {
  assertEquals(preservarExtravioParcial({ a: 1 }, null)["extravio_retomado_pos43"], undefined);
  const out = preservarExtravioParcial({ a: 1 }, {
    extravio_parcial: { dossie: {} }, extravio_retomado_pos43: { oc: 9 },
  });
  assertEquals((out["extravio_parcial"] as Record<string, unknown>)["dossie"], {});
  assertEquals((out["extravio_retomado_pos43"] as Record<string, unknown>)["oc"], 9);
});
