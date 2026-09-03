// =============================================================================
// ACEITAÇÃO — cada teste aqui cita LITERALMENTE uma frase do briefing do Caio
// ("55_EXTRAVIOS E AVARIAS.txt", 03/09) e prova que o código a cumpre.
//
// Diferente de `seguir-parcial-auto.test.ts`, que testa o desenho interno
// (D1..D7, cercas, fail-closed), este arquivo testa o CONTRATO COM O CLIENTE:
// se uma linha daqui cair, a entrega deixou de fazer o que foi pedido.
//
// Rodar: deno test --no-check --allow-net --allow-env \
//          supabase/functions/_shared/seguir-parcial-auto.aceitacao.test.ts
// =============================================================================

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ClienteSeguirParcial,
  decidirSeguirParcialAuto,
  type EntradaSeguirParcial,
  TEXTO_SSW_55,
} from "./seguir-parcial-auto.ts";

// Os 4 CNPJs do briefing, verbatim.
const DUILIO = ["13309775000195"];
const FELIPE = ["04098359000366", "04098359000102", "26013236000156"];
const OS_QUATRO = [...DUILIO, ...FELIPE];

const WL: Map<string, ClienteSeguirParcial> = new Map(
  OS_QUATRO.map((c) => [c, {
    cnpj_pagador: c,
    ativo: true,
    aplica_oc06: true,
    aplica_oc08: true,
  }]),
);

function decidir(over: Partial<EntradaSeguirParcial>) {
  return decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO[0],
    whitelist: WL,
    ...over,
  } as EntradaSeguirParcial);
}

// ── "Toda ocorrência 06 [...] Se não conter extravio total na mensagem que
//     acompanha a ocorrência, será considerado como extravio parcial. A
//     ocorrência 55 deve ser lançada." ──────────────────────────────────────
Deno.test("BRIEFING oc06 item 1 — sem extravio total na mensagem => lança 55", () => {
  // Fraseados reais de parcial. NF com mais volumes do que os faltantes.
  for (const instrucao of ["FALTA 1 VOLUME", "2 VOLUMES", "1 V", "FALTOU 1 CAIXA", ""]) {
    const d = decidir({ oc: 6, instrucao, qtdVolumesNf: 10 });
    assertEquals(d.aplica, true, `devia lançar 55 para: "${instrucao}"`);
    assert(d.aplica === true && d.texto_ssw === TEXTO_SSW_55);
  }
});

// ── "Se a ocorrência 06 constar uma mensagem de extravio total, o processo
//     deve seguir conforme já é previsto (ocorrência 49). Não deve ser
//     lançado a 55." ────────────────────────────────────────────────────────
Deno.test("BRIEFING oc06 item 2 — com extravio total => NÃO lança 55", () => {
  for (const instrucao of ["EXTRAVIO TOTAL", "PERDA TOTAL", "FALTA TOTAL", "TOTAL"]) {
    const d = decidir({ oc: 6, instrucao, qtdVolumesNf: 10 });
    assertEquals(d.aplica, false, `NÃO podia lançar 55 para: "${instrucao}"`);
    assertEquals(d.aplica === false && d.motivo, "sinal_de_extravio_total");
  }
  // E o total escrito como número (D2 cond.2) — a unidade quase sempre faz assim.
  const numerico = decidir({ oc: 6, instrucao: "9", qtdVolumesNf: 9 });
  assertEquals(numerico.aplica, false);
});

// ── "Toda ocorrência 08 - avaria, lançada pela a unidade, deve seguir para
//     analise do cliente. Sendo assim, a ocorrência 55 deve ser lançada." ───
Deno.test("BRIEFING oc08 — TODA avaria lança 55, sem condição extra", () => {
  for (const instrucao of [null, "", "AVARIA", "EXTRAVIO TOTAL", "CAIXA AMASSADA"]) {
    const d = decidir({ oc: 8, instrucao, qtdVolumesNf: null });
    assertEquals(d.aplica, true, `oc 08 devia lançar 55 mesmo com: "${instrucao}"`);
  }
});

// ── "SOMENTE e SOMENTE os clientes dos operadores abaixo terão essa regra." ─
Deno.test("BRIEFING escopo — os 4 CNPJs listados, e SÓ eles", () => {
  for (const cnpj of OS_QUATRO) {
    assertEquals(decidir({ cnpjPagador: cnpj, oc: 8 }).aplica, true, `${cnpj} devia estar no escopo`);
  }
  // Qualquer outro CNPJ, inclusive vizinhos plausíveis, fica de fora.
  for (const fora of [
    "13309775000196", // 1 dígito a mais no fim
    "13309775000185", // 1 dígito trocado no meio
    "04098359000103", // filial vizinha da GMI que NÃO foi listada
    "00000000000000",
  ]) {
    const d = decidir({ cnpjPagador: fora, oc: 8 });
    assertEquals(d.aplica, false, `${fora} NÃO podia estar no escopo`);
    assertEquals(d.aplica === false && d.motivo, "cnpj_fora_da_whitelist");
  }
});

// ── "Não alterar o comportamento dos demais clientes" ──────────────────────
Deno.test("BRIEFING não-regressão — fora da whitelist NADA aplica, em nenhuma oc", () => {
  for (const oc of [3, 6, 8, 9, 13, 16, 17, 44, 49, 54, 55, 59]) {
    for (const instrucao of [null, "FALTA 1 VOLUME", "EXTRAVIO TOTAL", "2"]) {
      const d = decidir({ oc, cnpjPagador: "99999999999999", instrucao, qtdVolumesNf: 5 });
      assertEquals(d.aplica, false, `oc=${oc} instr="${instrucao}" NÃO podia aplicar fora da whitelist`);
    }
  }
});

// ── "Não alterar o fluxo atual de extravio total" ──────────────────────────
Deno.test("BRIEFING extravio total — intocado até DENTRO da whitelist", () => {
  // Mesmo com tudo ligado e cliente autorizado, total nunca vira 55.
  for (const cnpj of OS_QUATRO) {
    const d = decidir({ oc: 6, cnpjPagador: cnpj, instrucao: "EXTRAVIO TOTAL", qtdVolumesNf: 3 });
    assertEquals(d.aplica, false, `${cnpj}: total virou 55 — REGRA INVIOLÁVEL quebrada`);
  }
});

// ── Cenários de EXCEÇÃO (não estavam no briefing; fail-closed por decisão) ──
Deno.test("EXCEÇÃO — entradas degeneradas nunca lançam por acidente", () => {
  const casos: Array<[string, Partial<EntradaSeguirParcial>]> = [
    ["flag mestra OFF", { flagOn: false, oc: 8 }],
    ["whitelist vazia", { oc: 8, whitelist: new Map() }],
    ["cnpj nulo", { oc: 8, cnpjPagador: null }],
    ["cnpj vazio", { oc: 8, cnpjPagador: "" }],
    ["cnpj só espaços", { oc: 8, cnpjPagador: "   " }],
    ["cnpj com letras", { oc: 8, cnpjPagador: "1330977500019X" }],
    ["cnpj curto", { oc: 8, cnpjPagador: "133097750001" }],
    ["oc nula", { oc: null }],
    ["oc indefinida", { oc: undefined }],
    ["oc negativa", { oc: -6 }],
    ["oc zero", { oc: 0 }],
  ];
  for (const [nome, over] of casos) {
    assertEquals(decidir(over).aplica, false, `"${nome}" não podia aplicar`);
  }
});

Deno.test("EXCEÇÃO — volumes da NF degenerados: nunca lança no escuro", () => {
  // Quantidade LEGÍVEL sem referência de total => fail-closed (pode ser total).
  for (const vol of [null, undefined, 0, -1]) {
    const d = decidir({ oc: 6, instrucao: "FALTA 2 VOLUMES", qtdVolumesNf: vol as number });
    assertEquals(d.aplica, false, `volumes=${vol} com qtd legível devia ser fail-closed`);
    assertEquals(d.aplica === false && d.motivo, "volumes_da_nf_desconhecidos");
  }
  // Quantidade ILEGÍVEL: não há número que possa ser o total => parcial (D3).
  const ilegivel = decidir({ oc: 6, instrucao: "SEM INFORMACAO", qtdVolumesNf: null });
  assertEquals(ilegivel.aplica, true);
});

Deno.test("EXCEÇÃO — CNPJ mascarado e sujo casa igual ao limpo", () => {
  for (const mascarado of [
    "13.309.775/0001-95",
    " 13309775000195 ",
    "13309775000195\n",
    "13-309-775-0001-95",
  ]) {
    assertEquals(decidir({ oc: 8, cnpjPagador: mascarado }).aplica, true, `falhou: "${mascarado}"`);
  }
});

Deno.test("EXCEÇÃO — instrução gigante / unicode não quebra nem vira total falso", () => {
  const gigante = "FALTA 1 VOLUME " + "X".repeat(20_000);
  assertEquals(decidir({ oc: 6, instrucao: gigante, qtdVolumesNf: 10 }).aplica, true);
  // "TOTAL" dentro de outra palavra não pode contar (\b protege).
  for (const instr of ["TOTALMENTE AVARIADO", "SUBTOTAL 3", "TOTALIZADOR"]) {
    const d = decidir({ oc: 6, instrucao: instr, qtdVolumesNf: 10 });
    assertEquals(d.aplica, true, `"${instr}" não devia contar como TOTAL`);
  }
  // Acentuação e caixa mista.
  assertEquals(decidir({ oc: 6, instrucao: "Extravio Total", qtdVolumesNf: 10 }).aplica, false);
});

Deno.test("EXCEÇÃO — desligar por oc não vaza para a outra oc", () => {
  const so06 = new Map(WL);
  so06.set(DUILIO[0], { cnpj_pagador: DUILIO[0], ativo: true, aplica_oc06: true, aplica_oc08: false });
  assertEquals(decidir({ oc: 6, instrucao: "FALTA 1", qtdVolumesNf: 9, whitelist: so06 }).aplica, true);
  assertEquals(decidir({ oc: 8, whitelist: so06 }).aplica, false);

  const so08 = new Map(WL);
  so08.set(DUILIO[0], { cnpj_pagador: DUILIO[0], ativo: true, aplica_oc06: false, aplica_oc08: true });
  assertEquals(decidir({ oc: 6, instrucao: "FALTA 1", qtdVolumesNf: 9, whitelist: so08 }).aplica, false);
  assertEquals(decidir({ oc: 8, whitelist: so08 }).aplica, true);
});

Deno.test("EXCEÇÃO — o texto que vai pro SSW é estável e latin-1 safe", () => {
  const d = decidir({ oc: 8 });
  assert(d.aplica === true);
  assertEquals(d.texto_ssw, TEXTO_SSW_55);
  // Portal SSW serve iso-8859-1; texto com multi-byte some silenciosamente.
  assertEquals(/^[\x20-\x7E]+$/.test(d.texto_ssw), true, "texto_ssw tem caractere fora do ASCII imprimível");
  assert(d.texto_ssw.length <= 500, "campo Instrução do portal é maxlength=500");
});
