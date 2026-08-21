// Guard INV-089: as travas duras da autonomia por fatia (rodada 2, 21/08).
// A autonomia NUNCA passa por cima de: oc segura (21/44/54/59), acao_key de
// família completa, regra rastreável.
// Rodar: deno test supabase/functions/_shared/autonomia-fatias.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { montarRegraAutonomia, podeAutoAprovarFatia } from "./autonomia-fatias.ts";

Deno.test("ocs seguras auto-aprovam; 56/41 (input humano) NUNCA", () => {
  assertEquals(podeAutoAprovarFatia(21, "lancar_ocorrencia:21"), true);
  assertEquals(podeAutoAprovarFatia(44, "lancar_oc_e_enviar_email:44"), true);
  assertEquals(podeAutoAprovarFatia(54, "lancar_oc_e_enviar_email:54"), true);
  assertEquals(podeAutoAprovarFatia(59, "lancar_ocorrencia:59"), true);
  assertEquals(podeAutoAprovarFatia(56, "lancar_ocorrencia:56"), false); // input!
  assertEquals(podeAutoAprovarFatia(41, "lancar_ocorrencia:41"), false);
  assertEquals(podeAutoAprovarFatia(null, "lancar_ocorrencia:21"), false);
});

Deno.test("só famílias de ação completas — combos/modais ficam fora", () => {
  assertEquals(podeAutoAprovarFatia(44, "combo_33_44"), false);
  assertEquals(podeAutoAprovarFatia(44, null), false);
  assertEquals(podeAutoAprovarFatia(44, "responder_email"), false);
});

Deno.test("regra rastreável carrega agente + oc geradora + sugestão", () => {
  assertEquals(
    montarRegraAutonomia("agente-sugere-ocs-padrao", 49, 21),
    "fatia_autonoma:agente-sugere-ocs-padrao:oc49->21",
  );
  assertEquals(
    montarRegraAutonomia("agente-oc13-autonomo", null, 54),
    "fatia_autonoma:agente-oc13-autonomo:ocsem->54",
  );
});
