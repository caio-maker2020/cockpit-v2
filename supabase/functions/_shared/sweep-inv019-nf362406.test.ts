// =============================================================================
// GUARD ANTI-REGRESSÃO — sweep INV-019 não pode pular por SNAPSHOT (NF 362406).
//
// Caio 2026-07-06: o sweep selfHealAguardandoClienteOcRelacionamento (sync-bastao)
// tinha 2 guards legados DEPOIS do discriminador autoritativo `naoRebaixarComDesempateSsw`:
//   (#2) `bastao_oc_no_lancamento === cod_ultima_ocorrencia → continue` (SEM escape 24h)
//   (#3) janela de 60min por `acao_executada_em`.
// O guard #2 prendia o card PRA SEMPRE quando uma oc de relacionamento NOVA coincidia
// em NÚMERO com a oc que o Bastão mostrava no último lançamento do Cockpit, MESMO
// quando a DATA já provava ser oc nova. Divergência com o watchdog (que não tem esse
// guard) → INV-019 preso + alerta eterno.
//
// Caso-âncora NF 362406 (oc=49, LARISSA): operadora lançou 54 em 07-02; o Bastão
// trouxe um 49 NOVO datado 07-03 (round-trip ressarcimento). bastao_oc_no_lancamento
// era 49 (Bastão mostrava 49 no lançamento) == cod_ultima_ocorrencia 49 → guard #2
// pulava. Mas 07-03 > 07-02 ⟹ classificarPorData = "nova" ⟹ o sweep TEM que MOVER.
//
// Este teste trava a RAIZ: o discriminador por DATA (autoridade que sobrou) decide
// "mover" no caso-âncora, independentemente de qualquer coincidência de snapshot.
// =============================================================================
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classificarPorData } from "./lag-lancamento-54.ts";

Deno.test("NF 362406: oc 49 nova (07-03) POSTERIOR ao último 54 (07-02) => 'nova' => sweep MOVE", () => {
  // A coincidência bastao_oc_no_lancamento(49)===cod_ultima_ocorrencia(49) NÃO
  // pode mais suprimir: a decisão é só por DATA/SSW (guard #1), e a data manda MOVER.
  assertEquals(classificarPorData("2026-07-03", "2026-07-02"), "nova");
});

Deno.test("lag legítimo preservado: oc do Bastão ANTERIOR ao 54 => 'lag' => FICA (NF 175621)", () => {
  assertEquals(classificarPorData("2026-06-23", "2026-06-24"), "lag");
});

Deno.test("mesmo dia continua ambíguo => desempate por SSW por hora (NF 346778)", () => {
  assertEquals(classificarPorData("2026-07-02", "2026-07-02"), "ambiguo");
});

Deno.test("sem lançamento de 54 do Cockpit => 'nova' (não há lag de 54 a respeitar)", () => {
  assertEquals(classificarPorData("2026-07-03", null), "nova");
});
