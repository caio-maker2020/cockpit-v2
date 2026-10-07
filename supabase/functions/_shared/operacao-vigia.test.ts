// Guard — vigia da fila da Operação no health-check (ADR 0041; INV-058; INV-186).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/operacao-vigia.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { alertasVigiaOperacao, type ResumoVigiaOperacao } from "./operacao-vigia.ts";

const AGORA = Date.parse("2026-10-07T12:00:00Z");
const zero: ResumoVigiaOperacao = {
  flag_fila: false, flag_lancar: false, fila_parada_30min: 0, lancando_travado: 0, lancado_sem_confirmar_6h: 0,
  nao_confirmados_24h: 0, erros_24h: 0, sessao_invalida_24h: 0, ultima_materializacao_ok: null, itens_abertos: 0,
};

Deno.test("flags OFF ou RPC ausente: nenhum alerta (inerte)", () => {
  assertEquals(alertasVigiaOperacao(null, AGORA), []);
  assertEquals(alertasVigiaOperacao({ ...zero, fila_parada_30min: 9, nao_confirmados_24h: 9 }, AGORA), []);
});

Deno.test("flag de lançamento ON: fila parada, travado, sem confirmação, não confirmado e login recusado alertam", () => {
  const tipos = alertasVigiaOperacao({
    ...zero, flag_lancar: true, fila_parada_30min: 1, lancando_travado: 1, lancado_sem_confirmar_6h: 1,
    nao_confirmados_24h: 1, sessao_invalida_24h: 1,
  }, AGORA).map((a) => a.tipo);
  assertEquals(tipos, ["operacao_fila_ssw_parada", "operacao_lancamento_travado", "operacao_sem_confirmacao", "operacao_nao_confirmado", "operacao_erros_lancamento"]);
  assertEquals(alertasVigiaOperacao({ ...zero, flag_lancar: true, erros_24h: 2 }, AGORA), []);
});

Deno.test("flag da fila ON: materializador sem rodada OK há 45+ min alerta; recente não", () => {
  assertEquals(alertasVigiaOperacao({ ...zero, flag_fila: true, ultima_materializacao_ok: null }, AGORA)[0]?.tipo, "operacao_materializacao_atrasada");
  assertEquals(alertasVigiaOperacao({ ...zero, flag_fila: true, ultima_materializacao_ok: "2026-10-07T11:50:00Z" }, AGORA), []);
});

Deno.test("health-check chama o vigia da Operação (fila de trabalho tem vigia, INV-058)", async () => {
  const hc = await Deno.readTextFile(new URL("../health-check/index.ts", import.meta.url));
  assert(hc.includes("checkOperacaoFila(supabase)"));
  assert(hc.includes('s.rpc("op_vigia_resumo")'));
});
