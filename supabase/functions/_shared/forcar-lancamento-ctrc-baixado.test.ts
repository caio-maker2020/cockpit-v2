// deno test --no-check supabase/functions/_shared/forcar-lancamento-ctrc-baixado.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aplicarForcarCtrcBaixado,
  FORCAR_CTRC_BAIXADO_RESSARC54,
  jaForcaCtrcBaixado,
} from "./forcar-lancamento-ctrc-baixado.ts";

Deno.test("todo NOVO (sem extras) ganha a flag + origem + motivo, preservando args", () => {
  const out = aplicarForcarCtrcBaixado({
    tool: "lancar_ocorrencia",
    acao_key: "lancar_ocorrencia:54",
    args: { codigo_ssw: 54, nf: "5631361", descricao: "X" },
    meta: { origem: "ressarcimento_relancar_54", sem_email_explicito: true },
  });
  const args = out["args"] as Record<string, unknown>;
  const extras = args["extras"] as Record<string, unknown>;
  assertEquals(extras["forcar_lancamento_ctrc_baixado"], true);
  assertEquals(extras["forcar_lancamento_origem"], "ressarcimento_relancar_54");
  assertEquals(extras["forcar_lancamento_motivo"], "round-trip 54->46->49; ressarcimento em aberto");
  // não perde os args originais
  assertEquals(args["codigo_ssw"], 54);
  assertEquals(args["nf"], "5631361");
  // não perde tool/meta
  assertEquals(out["tool"], "lancar_ocorrencia");
  assertEquals((out["meta"] as Record<string, unknown>)["sem_email_explicito"], true);
});

Deno.test("todo REUSADO com extras pré-existentes preserva os outros extras", () => {
  const out = aplicarForcarCtrcBaixado({
    tool: "lancar_ocorrencia",
    args: { codigo_ssw: 54, extras: { skip_evidencia: true, quantidade_volumes: 3 } },
  });
  const extras = (out["args"] as Record<string, unknown>)["extras"] as Record<string, unknown>;
  assertEquals(extras["forcar_lancamento_ctrc_baixado"], true); // adicionada
  assertEquals(extras["skip_evidencia"], true);                  // preservada
  assertEquals(extras["quantidade_volumes"], 3);                 // preservada
});

Deno.test("payload null/sem args → cria args.extras com a flag", () => {
  const out = aplicarForcarCtrcBaixado(null);
  const extras = (out["args"] as Record<string, unknown>)["extras"] as Record<string, unknown>;
  assertEquals(extras["forcar_lancamento_ctrc_baixado"], true);
});

Deno.test("não muta a entrada (cópia defensiva)", () => {
  const input = { tool: "lancar_ocorrencia", args: { codigo_ssw: 54 } };
  aplicarForcarCtrcBaixado(input);
  assertEquals("extras" in (input.args as Record<string, unknown>), false);
});

Deno.test("jaForcaCtrcBaixado detecta corretamente", () => {
  assertEquals(jaForcaCtrcBaixado(null), false);
  assertEquals(jaForcaCtrcBaixado({ args: { codigo_ssw: 54 } }), false);
  assertEquals(jaForcaCtrcBaixado({ args: { extras: { skip_evidencia: true } } }), false);
  assertEquals(jaForcaCtrcBaixado(aplicarForcarCtrcBaixado({ args: { codigo_ssw: 54 } })), true);
});

Deno.test("a constante de força carrega exatamente os 3 campos esperados", () => {
  assertEquals(FORCAR_CTRC_BAIXADO_RESSARC54["forcar_lancamento_ctrc_baixado"], true);
  assertEquals(FORCAR_CTRC_BAIXADO_RESSARC54["forcar_lancamento_origem"], "ressarcimento_relancar_54");
});
