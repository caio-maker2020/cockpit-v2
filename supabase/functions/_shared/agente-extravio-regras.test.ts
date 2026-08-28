// Testes da regra de segurança do agente de extravio (INV-020): só lança a 49 se
// a última oc real no SSW ainda for de extravio (6/9/16). Trava a regressão do
// "lançar 49 em cima de algo já lançado".
// Rodar: deno test supabase/functions/_shared/agente-extravio-regras.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EXTRAVIO_OCS, montarPropostaLancar49, podeAgenteLancar49 } from "./agente-extravio-regras.ts";

Deno.test("EXTRAVIO_OCS é exatamente {6,9,16}", () => {
  assertEquals([...EXTRAVIO_OCS].sort((a, b) => a - b), [6, 9, 16]);
});

Deno.test("pode lançar 49 SE última oc SSW ∈ {6,9,16}", () => {
  for (const oc of [6, 9, 16]) assert(podeAgenteLancar49(oc), `oc ${oc} deveria poder lançar`);
});

Deno.test("NÃO pode lançar 49 se já tem oc pós-extravio (localizado/relac/finalizadora/outro)", () => {
  // 20=localizado, 49=relac, 1/30/32=finalizadora, 33=ressarcimento, 54=cliente, 5/14=operação
  for (const oc of [1, 5, 14, 20, 30, 32, 33, 44, 49, 54, 55, 56]) {
    assertEquals(podeAgenteLancar49(oc), false, `oc ${oc} NÃO deveria poder lançar`);
  }
});

Deno.test("SSW indisponível / sem oc (null/undefined) → NÃO lança (na dúvida não age)", () => {
  assertEquals(podeAgenteLancar49(null), false);
  assertEquals(podeAgenteLancar49(undefined), false);
});

// === Proposta lancar_49 recriada on-demand (Caio 2026-06-26, NF 2053248) ===
Deno.test("montarPropostaLancar49: NUNCA envia e-mail (cliente já notificado) + oc 49 + PRAZO DE PERDAS", () => {
  const p = montarPropostaLancar49("2053248", "02513526000281");
  assertEquals(p.args.codigo_ssw, 49);
  assertEquals(p.args.extras.enviar_email, false); // inviolável: não duplica e-mail
  assertEquals(p.args.descricao, "PRAZO DE PERDAS EXPIRADO");
  assertEquals(p.meta.acao, "lancar_49");
  assertEquals(p.meta.modo, "sem_email");
  assertEquals(p.meta.origem, "extravio_cockpit");
  assertEquals(p.meta.recriada_pelo_agente, true);
  assertEquals(p.args.nf, "2053248");
  assertEquals(p.args.cnpj_remetente, "02513526000281");
});

Deno.test("montarPropostaLancar49: cnpj null não quebra (executor resolve via agent_state)", () => {
  const p = montarPropostaLancar49("123", null);
  assertEquals(p.args.cnpj_remetente, null);
  assertEquals(p.args.extras.enviar_email, false);
});

// v2 oc43 B4 (Caio 28/08): 43 pós-extravio é LIMPO pro D4
import { podeAgenteLancar49PosManutencao } from "./agente-extravio-regras.ts";
Deno.test("43 com extravio imediatamente antes → limpo; 43 com outra antes → não", () => {
  if (!podeAgenteLancar49PosManutencao(43, 6)) throw new Error("43 pós-6 devia ser limpo");
  if (!podeAgenteLancar49PosManutencao(43, 9)) throw new Error("43 pós-9 devia ser limpo");
  if (podeAgenteLancar49PosManutencao(43, 10)) throw new Error("43 pós-10 NÃO é limpo pro D4");
  if (podeAgenteLancar49PosManutencao(43, null)) throw new Error("43 sem anterior não é limpo");
  if (!podeAgenteLancar49PosManutencao(6, null)) throw new Error("6 direto segue limpo");
});
