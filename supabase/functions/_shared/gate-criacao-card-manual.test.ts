// Guard — NF 22232 (Duílio, 2026-07-27). Propriedade protegida: card manual com
// oc fora de relacionamento SÓ nasce com justificativa explícita; oc de
// relacionamento nunca exige motivo (comportamento de hoje intacto).
//
// Rodar: deno test supabase/functions/_shared/gate-criacao-card-manual.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirGateCriacaoManual, MIN_MOTIVO_FORA_PADRAO } from "./gate-criacao-card-manual.ts";

Deno.test("oc de relacionamento: segue sem exigir motivo (comportamento atual)", () => {
  assertEquals(decidirGateCriacaoManual(true, undefined), { permitido: true, foraDePadrao: false });
  // motivo é ignorado quando a oc já é de relacionamento
  assertEquals(decidirGateCriacaoManual(true, "qualquer coisa aqui"), { permitido: true, foraDePadrao: false });
});

Deno.test("oc fora de relacionamento SEM motivo: recusa (front pede justificativa)", () => {
  assertEquals(decidirGateCriacaoManual(false, undefined), { permitido: false, precisaMotivo: true });
  assertEquals(decidirGateCriacaoManual(false, ""), { permitido: false, precisaMotivo: true });
  assertEquals(decidirGateCriacaoManual(false, "   "), { permitido: false, precisaMotivo: true });
});

Deno.test("oc fora de relacionamento com motivo curto: recusa (não basta 'ok')", () => {
  assertEquals(decidirGateCriacaoManual(false, "ok"), { permitido: false, precisaMotivo: true });
  // exatamente MIN-1 caracteres ainda recusa
  const curto = "a".repeat(MIN_MOTIVO_FORA_PADRAO - 1);
  assertEquals(decidirGateCriacaoManual(false, curto), { permitido: false, precisaMotivo: true });
});

Deno.test("oc fora de relacionamento com motivo explícito: permite fora de padrão + trim", () => {
  const r = decidirGateCriacaoManual(false, "  cliente cancelou o agendamento, precisa devolver  ");
  assertEquals(r, {
    permitido: true,
    foraDePadrao: true,
    motivo: "cliente cancelou o agendamento, precisa devolver",
  });
});

Deno.test("oc fora de relacionamento com motivo exatamente no limite: permite", () => {
  const noLimite = "a".repeat(MIN_MOTIVO_FORA_PADRAO);
  const r = decidirGateCriacaoManual(false, noLimite);
  assertEquals(r.permitido, true);
});
