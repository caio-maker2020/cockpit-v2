// deno test supabase/functions/_shared/vincular-triador-regras.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  escolherCardParaRun,
  messageIdDoInput,
  nfsDoOutputTriador,
} from "./vincular-triador-regras.ts";

Deno.test("extrai message_id válido do input (elo exato)", () => {
  assertEquals(
    messageIdDoInput({ message_id: "be90a714-b145-43bc-9686-e74c35cb84e8" }),
    "be90a714-b145-43bc-9686-e74c35cb84e8",
  );
  assertEquals(messageIdDoInput({ message_id: "não-uuid" }), null);
  assertEquals(messageIdDoInput(null), null);
});

Deno.test("extrai NFs válidas do output do triador (ignora lixo)", () => {
  assertEquals(nfsDoOutputTriador({ nfs: ["142371", " 99 ", "abc", 135724] }), [
    "142371",
    "135724",
  ]);
  assertEquals(nfsDoOutputTriador({}), []);
  assertEquals(nfsDoOutputTriador(null), []);
});

Deno.test("escolhe o card mais próximo no tempo dentro da janela", () => {
  const t0 = "2026-07-20T12:00:00Z";
  const candidatos = new Map([
    ["100", [
      { id: "longe", created_at: "2026-07-20T17:30:00Z" }, // +5h30
      { id: "perto", created_at: "2026-07-20T12:02:00Z" }, // +2min
    ]],
  ]);
  assertEquals(escolherCardParaRun(["100"], candidatos, t0), "perto");
});

Deno.test("fora da janela de ±6h → não vincula (nada de chute)", () => {
  const t0 = "2026-07-20T12:00:00Z";
  const candidatos = new Map([
    ["100", [{ id: "velho", created_at: "2026-07-19T12:00:00Z" }]], // -24h
  ]);
  assertEquals(escolherCardParaRun(["100"], candidatos, t0), null);
});

Deno.test("card anexado (criado ANTES da classificação) dentro da folga vincula", () => {
  const t0 = "2026-07-20T12:00:00Z";
  const candidatos = new Map([
    ["100", [{ id: "pre-existente", created_at: "2026-07-20T08:00:00Z" }]], // -4h
  ]);
  assertEquals(escolherCardParaRun(["100"], candidatos, t0), "pre-existente");
});

Deno.test("primeira NF sem card não impede a segunda de casar", () => {
  const t0 = "2026-07-20T12:00:00Z";
  const candidatos = new Map([
    ["222", [{ id: "c222", created_at: "2026-07-20T12:10:00Z" }]],
  ]);
  assertEquals(escolherCardParaRun(["111", "222"], candidatos, t0), "c222");
});
