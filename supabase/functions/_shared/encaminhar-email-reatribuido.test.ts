// Guard anti-regressão da decisão PURA do auto-encaminhamento (mig 302 / Karoline).
// Regra: só encaminha se (flag ligada) E (card tem dono) E (dono ≠ dono da caixa
// que capturou). Qualquer flexibilização aqui muda comportamento em produção.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deveEncaminhar } from "./encaminhar-email-reatribuido.ts";

const LARISSA = "op-larissa";
const KAROLINE = "op-karoline";

Deno.test("reatribuído (dono ≠ quem capturou) + flag on → encaminha", () => {
  assert(deveEncaminhar({ flagAtivo: true, pollingOperadorId: LARISSA, assignedOperadorId: KAROLINE }));
});

Deno.test("flag desligada → NUNCA encaminha", () => {
  assertEquals(
    deveEncaminhar({ flagAtivo: false, pollingOperadorId: LARISSA, assignedOperadorId: KAROLINE }),
    false,
  );
});

Deno.test("card do próprio dono da caixa (não reatribuído) → NÃO encaminha", () => {
  assertEquals(
    deveEncaminhar({ flagAtivo: true, pollingOperadorId: LARISSA, assignedOperadorId: LARISSA }),
    false,
  );
});

Deno.test("card sem dono (null/undefined) → NÃO encaminha (evita mandar pra ninguém)", () => {
  assertEquals(deveEncaminhar({ flagAtivo: true, pollingOperadorId: LARISSA, assignedOperadorId: null }), false);
  assertEquals(deveEncaminhar({ flagAtivo: true, pollingOperadorId: LARISSA, assignedOperadorId: undefined }), false);
});
