// Rodada 8 (op_itens 09/10: 96,7 % "aguardar"): (1) regra aprendida com unidade casa pela unidade da
// OCORRÊNCIA (Bastão unidade_atual) — a de visibilidade vinha NULL em 100 % dos itens porque a
// op_regra_unidade_por_oc está vazia, e as 116 regras com unidade nunca casavam; (2) teto de idade
// `dias_parado_max`: um "aguardar" aprendido de notas recém-paradas não vale para nota parada há 30 dias.
// Equivalência: regra sem teto e item sem unidade_ocorrencia decidem EXATAMENTE como antes.
// Rodar: deno test --no-check supabase/functions/_shared/operacao-sugestao-teto-unidade.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  compilarRegrasAprendidas,
  dentroDoTeto,
  especificidadeRegra,
  estadoCasa,
  problemaRegraAprendida,
  type RegraAprendidaOperacao,
  regraAprendidaDeLinha,
  sugerirPorRegraAprendida,
  unidadeDaRegra,
} from "./operacao-sugestao.ts";

const AGORA = Date.parse("2026-10-09T12:00:00Z");
const dia = (n: number) => new Date(Date.parse("2026-10-09T00:00:00Z") - n * 86_400_000).toISOString();
const R = (o: Partial<RegraAprendidaOperacao> & { estado?: Partial<RegraAprendidaOperacao["estado"]> }): RegraAprendidaOperacao => ({
  id: o.id ?? "r", acao: o.acao ?? "aguardar", codigo: o.codigo ?? null, texto: o.texto ?? "segue sozinha",
  confianca: o.confianca ?? 0.95, casos: o.casos ?? 1000, base_regra: "teste",
  estado: { oc: 7, ...(o.estado ?? {}) },
});
const sug = (regras: RegraAprendidaOperacao[], item: Record<string, unknown>) =>
  sugerirPorRegraAprendida({
    item: { cod_ultima_ocorrencia: 7, data_ultima_ocorrencia: dia(0), unidade: null, ...item } as never,
    regras, codigosLancaveisAtivos: new Set([38, 15, 29]), agoraMs: AGORA,
  });

Deno.test("unidade da regra: a da ocorrência vence; sem ela, a de visibilidade (equivalência)", () => {
  assertEquals(unidadeDaRegra({ unidade: null, unidade_ocorrencia: " aip " }), "AIP");
  assertEquals(unidadeDaRegra({ unidade: "VGA", unidade_ocorrencia: "AIP" }), "AIP");
  assertEquals(unidadeDaRegra({ unidade: "VGA" }), "VGA");
  assertEquals(unidadeDaRegra({ unidade: "VGA", unidade_ocorrencia: null }), "VGA");
  assertEquals(unidadeDaRegra({ unidade: null }), null);
});

Deno.test("regra com unidade casa pela unidade_atual mesmo com op_itens.unidade NULL (o caso de 09/10)", () => {
  const regras = [R({ id: "geral" }), R({ id: "aip", acao: "lancar_ocorrencia", codigo: 38, texto: "chegou ao destino", estado: { unidade: "AIP" } })];
  assertEquals(sug(regras, {})?.regra_id, "geral");
  assertEquals(sug(regras, { unidade_ocorrencia: "AIP" })?.regra_id, "aip");
  assertEquals(sug(regras, { unidade_ocorrencia: "BHE" })?.regra_id, "geral");
  assert(estadoCasa(regras[1]!, { cod_ultima_ocorrencia: 7, data_ultima_ocorrencia: dia(0), unidade: null, unidade_ocorrencia: "AIP" }, AGORA));
});

Deno.test("teto de idade: dias inteiros desde a data da oc; sem data não casa; sem teto casa sempre", () => {
  assert(dentroDoTeto(null, null));
  assert(dentroDoTeto(undefined, 9999));
  assert(!dentroDoTeto(3, null));
  assert(dentroDoTeto(3, 3 * 24 + 23));
  assert(!dentroDoTeto(3, 4 * 24));
});

Deno.test("aguardar com teto: nota velha cai na próxima regra (ou em nenhuma → agente)", () => {
  const regras = [
    R({ id: "ag", estado: { dias_parado_max: 3 } }),
    R({ id: "velha", acao: "lancar_ocorrencia", codigo: 29, texto: "parada, cobrar", estado: { dias_parado_min: 7 } }),
  ];
  assertEquals(sug(regras, { data_ultima_ocorrencia: dia(1) })?.regra_id, "ag");
  assertEquals(sug(regras, { data_ultima_ocorrencia: dia(3) })?.regra_id, "ag");
  assertEquals(sug(regras, { data_ultima_ocorrencia: dia(5) }), null); // entre o teto e o piso: sem regra → agente
  assertEquals(sug(regras, { data_ultima_ocorrencia: dia(30) })?.regra_id, "velha");
  // o mesmo pela função não compilada
  assert(!estadoCasa(regras[0]!, { cod_ultima_ocorrencia: 7, data_ultima_ocorrencia: dia(30), unidade: null }, AGORA));
});

Deno.test("equivalência: regras sem teto decidem igual ao código anterior em todas as idades", () => {
  const regras = [R({ id: "ag" }), R({ id: "d7", acao: "lancar_ocorrencia", codigo: 29, texto: "parada, cobrar", estado: { dias_parado_min: 7 } })];
  for (const d of [0, 1, 3, 6, 7, 30, 120]) {
    assertEquals(sug(regras, { data_ultima_ocorrencia: dia(d) })?.regra_id, d >= 7 ? "d7" : "ag");
  }
  assertEquals(especificidadeRegra(R({})), 0);
  assertEquals(especificidadeRegra(R({ estado: { dias_parado_max: 3 } })), 1);
});

Deno.test("validação do teto e leitura da linha (coluna ausente = sem teto)", () => {
  assertEquals(problemaRegraAprendida(R({ estado: { dias_parado_max: 3 } })), null);
  assert(problemaRegraAprendida(R({ estado: { dias_parado_max: 0 } }))?.includes("dias_parado_max"));
  assert(problemaRegraAprendida(R({ estado: { dias_parado_max: 2.5 } }))?.includes("dias_parado_max"));
  assert(problemaRegraAprendida(R({ estado: { dias_parado_min: 7, dias_parado_max: 3 } }))?.includes("menor"));
  const base = { id: "x", estado_oc: 7, acao: "aguardar", codigo: null, texto: "segue", confianca: 0.9, casos: 10, base_regra: "b", ativo: true };
  assertEquals(regraAprendidaDeLinha(base).estado.dias_parado_max, null);
  assertEquals(regraAprendidaDeLinha({ ...base, estado_dias_parado_max: 4 }).estado.dias_parado_max, 4);
  assertEquals(compilarRegrasAprendidas([regraAprendidaDeLinha({ ...base, estado_dias_parado_max: 4 })]).porOc.get(7)?.length, 1);
});
