// Guard INV-017: a sugestão do interpretador não pode contradizer as próprias
// pendências. oc=21 (reentrega CONFIRMADA) + pendência aberta = rebaixa pra 54.
//
// Rodar: deno test supabase/functions/_shared/regras-interpretador-resposta.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  reconciliarSugestaoInterpretador,
  type SugestaoInterpretador,
} from "./regras-interpretador-resposta.ts";

function base(over: Partial<SugestaoInterpretador> = {}): SugestaoInterpretador {
  return {
    oc_sugerida: 21,
    confianca: 0.72,
    instrucao_reentrega_sugerida: "",
    pendencias_resposta_cliente: [],
    cliente_autorizou_reentrega_sem_pagar: false,
    ...over,
  };
}

Deno.test("INV-017: oc=21 com pendência e sem aval explícito rebaixa pra 54 (caso NF 16480)", () => {
  const r = reconciliarSugestaoInterpretador(
    base({
      oc_sugerida: 21,
      confianca: 0.72,
      pendencias_resposta_cliente: [
        "Cliente não confirmou novo endereço ou data para a reentrega",
        "Cliente não respondeu sobre a ressalva solicitada anteriormente",
      ],
    }),
  );
  assert(r.rebaixou_oc21_por_pendencia, "deveria rebaixar");
  assertEquals(r.oc_original, 21);
  assertEquals(r.sugestao.oc_sugerida, 54);
  assert(r.sugestao.confianca <= 0.5, "confiança deve ser capada em 0.5");
  assertEquals(r.sugestao.instrucao_reentrega_sugerida, "");
  // pendências PRESERVADAS → banner "responder cliente cobrando" continua
  assertEquals(r.sugestao.pendencias_resposta_cliente.length, 2);
});

Deno.test("oc=21 SEM pendência permanece 21 (reentrega confirmada de fato)", () => {
  const r = reconciliarSugestaoInterpretador(
    base({
      oc_sugerida: 21,
      confianca: 0.9,
      instrucao_reentrega_sugerida: "Novo endereço: Rua X, 123 — receber até 18h",
      pendencias_resposta_cliente: [],
    }),
  );
  assertEquals(r.rebaixou_oc21_por_pendencia, false);
  assertEquals(r.sugestao.oc_sugerida, 21);
  assertEquals(r.sugestao.confianca, 0.9);
  assertEquals(r.sugestao.instrucao_reentrega_sugerida, "Novo endereço: Rua X, 123 — receber até 18h");
});

Deno.test("oc=21 com pendência MAS reentrega-sem-pagar autorizada permanece 21 (feature 2026-05-18)", () => {
  const r = reconciliarSugestaoInterpretador(
    base({
      oc_sugerida: 21,
      pendencias_resposta_cliente: ["Cliente não detalhou o horário preferido"],
      cliente_autorizou_reentrega_sem_pagar: true,
    }),
  );
  assertEquals(r.rebaixou_oc21_por_pendencia, false);
  assertEquals(r.sugestao.oc_sugerida, 21);
});

Deno.test("oc=55 com pendência NÃO é tocada (âncora NF 343885 — autorizou seguir parcial sem romaneio)", () => {
  const r = reconciliarSugestaoInterpretador(
    base({
      oc_sugerida: 55,
      pendencias_resposta_cliente: ["Cliente não anexou romaneio assinado"],
    }),
  );
  assertEquals(r.rebaixou_oc21_por_pendencia, false);
  assertEquals(r.sugestao.oc_sugerida, 55);
});

Deno.test("oc=44 (combo ressarcimento) com pendência NÃO é tocada", () => {
  const r = reconciliarSugestaoInterpretador(
    base({
      oc_sugerida: 44,
      pendencias_resposta_cliente: ["Cliente não confirmou a quantidade exata"],
    }),
  );
  assertEquals(r.rebaixou_oc21_por_pendencia, false);
  assertEquals(r.sugestao.oc_sugerida, 44);
});

Deno.test("preserva campos extras do chamador (motivo etc) via genérico", () => {
  const entrada = { ...base({ oc_sugerida: 21, pendencias_resposta_cliente: ["x não confirmado"] }), motivo: "texto IA" };
  const r = reconciliarSugestaoInterpretador(entrada);
  assertEquals(r.sugestao.oc_sugerida, 54);
  assertEquals((r.sugestao as typeof entrada).motivo, "texto IA");
});
