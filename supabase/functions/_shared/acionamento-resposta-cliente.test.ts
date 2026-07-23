// Guard INV-042 — NF 73220 (LARISSA, 2026-07-23): resposta real de cliente
// NUNCA é muda; card terminal REABRE.
// Rodar: deno test supabase/functions/_shared/acionamento-resposta-cliente.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirAcionamentoPorRespostaCliente,
  STATES_TERMINAIS_REABERTOS_POR_RESPOSTA,
} from "./acionamento-resposta-cliente.ts";

Deno.test("AGUARDANDO_CLIENTE / ACAO_EXECUTADA → aciona sem reabrir (comportamento preservado)", () => {
  assertEquals(decidirAcionamentoPorRespostaCliente("AGUARDANDO_CLIENTE", false), {
    acao: "acionar",
    reabre: false,
  });
  assertEquals(decidirAcionamentoPorRespostaCliente("ACAO_EXECUTADA", false), {
    acao: "acionar",
    reabre: false,
  });
});

Deno.test("TRANSFERIDO / RESOLVIDO → REABRE (caso âncora NF 73220: romaneio caiu em card morto)", () => {
  for (const state of STATES_TERMINAIS_REABERTOS_POR_RESPOSTA) {
    assertEquals(decidirAcionamentoPorRespostaCliente(state, false), {
      acao: "acionar",
      reabre: true,
    });
  }
});

Deno.test("AVH: re-resposta (com cliente_respondeu_em) re-aciona; AVH normal ignora (NF 1492103)", () => {
  assertEquals(decidirAcionamentoPorRespostaCliente("AGUARDANDO_VALIDACAO_HUMANA", true), {
    acao: "acionar",
    reabre: false,
  });
  const avhNormal = decidirAcionamentoPorRespostaCliente("AGUARDANDO_VALIDACAO_HUMANA", false);
  assertEquals(avhNormal.acao, "ignorar");
});

Deno.test("EXTRAVIO_MONITORADO / CANCELADO / null → ignora (fora do escopo deliberadamente)", () => {
  assertEquals(decidirAcionamentoPorRespostaCliente("EXTRAVIO_MONITORADO", false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente("CANCELADO", false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente(null, false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente(undefined, false).acao, "ignorar");
});
