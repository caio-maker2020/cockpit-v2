// Guard anti-regressão do INV-fila (fix 2026-07-16, fila saturada por
// cobranca_email eternas). Rodar: deno test supabase/functions/_shared/fila-acoes-agendadas.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirProximoPassoFalhaCobranca,
  MAX_TENTATIVAS_COBRANCA,
  violaInvFila,
} from "./fila-acoes-agendadas.ts";

Deno.test("INV-fila: falha NUNCA devolve 'manter pendente onde está'", () => {
  for (let t = 0; t < MAX_TENTATIVAS_COBRANCA + 2; t++) {
    const passo = decidirProximoPassoFalhaCobranca(t);
    if (passo.acao === "reagendar") {
      assert(passo.delayHoras > 0, "reagendamento tem que avançar executar_em pro futuro");
    } else {
      assertEquals(passo.acao, "falha_definitiva");
    }
  }
});

Deno.test("1ª falha reagenda +24h e registra o evento CobrancaAdiadaSem*", () => {
  const passo = decidirProximoPassoFalhaCobranca(0);
  assertEquals(passo, {
    acao: "reagendar",
    novaTentativa: 1,
    delayHoras: 24,
    registrarEvento: true,
  });
});

Deno.test("falhas seguintes reagendam SEM re-gravar evento (anti-spam ~19k/dia)", () => {
  const passo = decidirProximoPassoFalhaCobranca(1);
  assert(passo.acao === "reagendar" && passo.registrarEvento === false);
});

Deno.test(`teto de ${MAX_TENTATIVAS_COBRANCA} tentativas encerra como falha definitiva (cancelado + alerta)`, () => {
  const passo = decidirProximoPassoFalhaCobranca(MAX_TENTATIVAS_COBRANCA - 1);
  assertEquals(passo, { acao: "falha_definitiva", tentativasTotais: MAX_TENTATIVAS_COBRANCA });
});

Deno.test("violaInvFila detecta a pendência eterna (comportamento antigo do handler)", () => {
  const antes = { status: "pendente", executar_em: "2026-07-10T12:00:00Z" };
  // Comportamento antigo: throw mantinha pendente com o MESMO executar_em → viola
  assert(violaInvFila(antes, antes));
  // Reagendada pro futuro → ok
  assert(!violaInvFila(antes, { status: "pendente", executar_em: "2026-07-11T12:00:00Z" }));
  // Saiu de pendente (precisa_acao / processado / cancelado) → ok
  assert(!violaInvFila(antes, { status: "precisa_acao", executar_em: antes.executar_em }));
});
