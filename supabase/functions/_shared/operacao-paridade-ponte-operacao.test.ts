// Guard — a Operação usa os MESMOS parâmetros de vazão da ponte da operação (ADR 0039 D5 /
// ADR 0041 D7): a conta ai.salex é uma só (INV-159). Se alguém mexer num lado, este teste
// obriga a mexer no outro (ou a justificar no ADR).
// (O nome do arquivo contém "ponte-operacao" de propósito: ele é o ÚNICO arquivo da
// Operação que importa código da ponte v2, e o teste de isolamento da ponte o reconhece.)
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-paridade-ponte-operacao.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as ponte from "./ponte-operacao-worker.ts";
import * as op from "./operacao-comum.ts";

Deno.test("vazão, janela, quarentena, TTL e travado iguais aos da ponte", () => {
  assertEquals(op.LIMITE_SSW_POR_MINUTO, ponte.LIMITE_SSW_POR_MINUTO);
  assertEquals(op.TETO_SSW_POR_MINUTO, ponte.TETO_SSW_POR_MINUTO);
  assertEquals(op.JANELA_VAZAO_SEGUNDOS, ponte.JANELA_VAZAO_SEGUNDOS);
  assertEquals(op.QUARENTENA_LOGIN_MIN, ponte.QUARENTENA_LOGIN_MIN);
  assertEquals(op.TTL_LANCAMENTO_HORAS, ponte.TTL_PEDIDO_HORAS);
  assertEquals(op.LANCAMENTO_TRAVADO_MIN, ponte.LANCAMENTO_TRAVADO_MIN);
  for (const caso of [
    { limitePorMinuto: 2, reservadosNaJanela: 0, emQuarentena: false },
    { limitePorMinuto: 9, reservadosNaJanela: 1, emQuarentena: false },
    { limitePorMinuto: 3, reservadosNaJanela: 0, emQuarentena: true },
    { limitePorMinuto: -1, reservadosNaJanela: 0, emQuarentena: false },
  ]) assertEquals(op.vagasDeLancamentoOp(caso), ponte.vagasDeLancamento(caso));
});

Deno.test("as duas RPCs de reserva usam o MESMO advisory lock e o teto 3 no SQL", async () => {
  const m415 = await Deno.readTextFile(new URL("../../../migration/2026-10-07_415_ponte_operacao.sql", import.meta.url));
  const m430 = await Deno.readTextFile(new URL("../../../migration/2026-10-07_430_operacao_fila_e_lancamentos.sql", import.meta.url));
  const lock = "pg_advisory_xact_lock(hashtext('ponte_operacao_ssw_vazao'))";
  const teto = "least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3)";
  for (const s of [m415, m430]) {
    assertEquals(s.includes(lock), true);
    assertEquals(s.includes(teto), true);
  }
});
