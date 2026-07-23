// Guard INV-042 — premissa do Caio (2026-07-23, refinada pós-NF 73220):
//   1. resposta + card ATIVO → move (sempre);
//   2. card TRANSFERIDO/RESOLVIDO → anexa SEM mover (tratado não ressuscita);
//   3. card novo criado depois entra na premissa 1.
// Rodar: deno test supabase/functions/_shared/acionamento-resposta-cliente.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirAcionamentoPorRespostaCliente,
  STATES_TERMINAIS_ANEXA_SEM_MOVER,
} from "./acionamento-resposta-cliente.ts";

Deno.test("premissa 1: AGUARDANDO_CLIENTE / ACAO_EXECUTADA → aciona (card ativo SEMPRE se move)", () => {
  assertEquals(decidirAcionamentoPorRespostaCliente("AGUARDANDO_CLIENTE", false).acao, "acionar");
  assertEquals(decidirAcionamentoPorRespostaCliente("ACAO_EXECUTADA", false).acao, "acionar");
});

Deno.test("premissa 2: TRANSFERIDO / RESOLVIDO → anexa SEM mover (NUNCA reabre — tratado não ressuscita)", () => {
  for (const state of STATES_TERMINAIS_ANEXA_SEM_MOVER) {
    const d = decidirAcionamentoPorRespostaCliente(state, false);
    assertEquals(d.acao, "anexar_sem_mover");
  }
  // Regressão da 1ª versão do fix (reabria terminal): garante que 'acionar'
  // NUNCA volte pra esses estados.
  for (const state of STATES_TERMINAIS_ANEXA_SEM_MOVER) {
    if (decidirAcionamentoPorRespostaCliente(state, true).acao === "acionar") {
      throw new Error(`REGRESSÃO: ${state} não pode acionar/reabrir (premissa 2 do Caio)`);
    }
  }
});

Deno.test("AVH: re-resposta (com cliente_respondeu_em) re-aciona; AVH normal ignora (NF 1492103)", () => {
  assertEquals(
    decidirAcionamentoPorRespostaCliente("AGUARDANDO_VALIDACAO_HUMANA", true).acao,
    "acionar",
  );
  assertEquals(
    decidirAcionamentoPorRespostaCliente("AGUARDANDO_VALIDACAO_HUMANA", false).acao,
    "ignorar",
  );
});

Deno.test("EXTRAVIO_MONITORADO / CANCELADO / null → ignora (fora do escopo deliberadamente)", () => {
  assertEquals(decidirAcionamentoPorRespostaCliente("EXTRAVIO_MONITORADO", false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente("CANCELADO", false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente(null, false).acao, "ignorar");
  assertEquals(decidirAcionamentoPorRespostaCliente(undefined, false).acao, "ignorar");
});
