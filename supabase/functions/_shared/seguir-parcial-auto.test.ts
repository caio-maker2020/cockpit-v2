// Guard da oc 55 automática (ADR 0025) — clientes com autorização permanente de
// seguir parcial. Se isto regredir, o robô lança 55 em cliente que não autorizou,
// ou lança 55 num EXTRAVIO TOTAL (mandando entregar carga que não existe).
// Ocorrência no SSW não tem desfazer — este arquivo é a rede.
//
// Âncoras reais colhidas na F0 (2026-09-03, 180 dias, os 4 CNPJs do escopo).
// Rodar: deno test --no-check --allow-net --allow-env \
//          supabase/functions/_shared/seguir-parcial-auto.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acharClienteNaWhitelist,
  type ClienteSeguirParcial,
  decidirSeguirParcialAuto,
  lerQtdDaInstrucao,
  normalizarCnpj,
  OCS_NO_ESCOPO,
  temSinalDeExtravioTotal,
  TEXTO_SSW_55,
} from "./seguir-parcial-auto.ts";

const DUILIO_TOTALL = "13309775000195";
const FELIPE_GMI = "04098359000366";
const FORA = "99999999999999";

function wl(
  over: Partial<ClienteSeguirParcial> & { cnpj_pagador: string },
): [string, ClienteSeguirParcial] {
  return [over.cnpj_pagador, {
    ativo: true,
    aplica_oc06: true,
    aplica_oc08: true,
    ...over,
  }];
}

const WHITELIST_ATIVA = new Map<string, ClienteSeguirParcial>([
  wl({ cnpj_pagador: DUILIO_TOTALL }),
  wl({ cnpj_pagador: FELIPE_GMI }),
]);

// ── normalização ────────────────────────────────────────────────────────────

Deno.test("normalizarCnpj: aceita só 14 dígitos, tira máscara, recusa o resto", () => {
  assertEquals(normalizarCnpj("13309775000195"), "13309775000195");
  assertEquals(normalizarCnpj("13.309.775/0001-95"), "13309775000195");
  assertEquals(normalizarCnpj("133097750001"), null); // 12 dígitos
  assertEquals(normalizarCnpj(""), null);
  assertEquals(normalizarCnpj(null), null);
  assertEquals(normalizarCnpj(undefined), null);
});

// ── D2: sinal de extravio total ─────────────────────────────────────────────

Deno.test("D2 cond.1 — palavra TOTAL nos fraseados reais da unidade", () => {
  assertEquals(temSinalDeExtravioTotal("TOTAL", 1), true);
  assertEquals(temSinalDeExtravioTotal("FALTA TOTAL (SSWMOBILE)", 7), true);
  assertEquals(temSinalDeExtravioTotal("EXTRAVIO TOTAL", 5), true);
  assertEquals(temSinalDeExtravioTotal("PERDA TOTAL", 5), true);
});

Deno.test("D2 cond.2 — número igual ao total de volumes é TOTAL disfarçado (âncoras F0)", () => {
  // Os 5 casos reais que a regra literal do briefing classificaria errado.
  assertEquals(temSinalDeExtravioTotal("9", 9), true); // NF 29642
  assertEquals(temSinalDeExtravioTotal("7 (SSWMOBILE)", 7), true); // NF 29405
  assertEquals(temSinalDeExtravioTotal("3", 3), true); // NF 242255
  assertEquals(temSinalDeExtravioTotal("2", 2), true); // NF 199462
  assertEquals(temSinalDeExtravioTotal("1 (SSWMOBILE)", 1), true); // NF 193347
});

Deno.test("D2 — parcial de verdade NÃO é sinal de total (âncoras F0)", () => {
  assertEquals(temSinalDeExtravioTotal("2 (SSWMOBILE)", 9), false); // NF 200776
  assertEquals(temSinalDeExtravioTotal("1 (SSWMOBILE)", 3), false); // NF 196195
  assertEquals(temSinalDeExtravioTotal("3 (SSWMOBILE)", 11), false); // NF 28860
  assertEquals(temSinalDeExtravioTotal("FALTA 1 VL (SSWMOBILE)", 4), false); // NF 116870
  assertEquals(temSinalDeExtravioTotal("FALTAM 2 VL (SSWMOBILE)", 12), false); // NF 116321
});

Deno.test("D3 — instrução ilegível NÃO é sinal de total (vira parcial dentro da whitelist)", () => {
  // Casos reais que o parser atual não lê. Todos parciais de verdade.
  assertEquals(temSinalDeExtravioTotal("1 V", 6), false); // NF 192292
  assertEquals(temSinalDeExtravioTotal("F1 (SSWMOBILE)", 7), false); // NF 114614
  assertEquals(temSinalDeExtravioTotal("", 5), false);
  assertEquals(temSinalDeExtravioTotal(null, 5), false);
});

// ── whitelist ───────────────────────────────────────────────────────────────

Deno.test("whitelist: pagador casa; remetente é fallback; fora da lista não casa", () => {
  const porPagador = acharClienteNaWhitelist(WHITELIST_ATIVA, [DUILIO_TOTALL, null]);
  assertEquals(porPagador.cliente?.cnpj_pagador, DUILIO_TOTALL);

  const porRemetente = acharClienteNaWhitelist(WHITELIST_ATIVA, [FORA, FELIPE_GMI]);
  assertEquals(porRemetente.cliente?.cnpj_pagador, FELIPE_GMI);

  const nenhum = acharClienteNaWhitelist(WHITELIST_ATIVA, [FORA, FORA]);
  assertEquals(nenhum.cliente, null);
  assertEquals("motivo" in nenhum ? nenhum.motivo : null, "cnpj_fora_da_whitelist");

  const semCnpj = acharClienteNaWhitelist(WHITELIST_ATIVA, [null, undefined]);
  assertEquals("motivo" in semCnpj ? semCnpj.motivo : null, "cnpj_ausente");
});

Deno.test("whitelist: cliente presente porém INATIVO não aplica (seed nasce assim)", () => {
  const inativa = new Map([wl({ cnpj_pagador: DUILIO_TOTALL, ativo: false })]);
  const r = acharClienteNaWhitelist(inativa, [DUILIO_TOTALL]);
  assertEquals(r.cliente, null);
  assertEquals("motivo" in r ? r.motivo : null, "cliente_inativo");
});

// ── decisão: caminho feliz ──────────────────────────────────────────────────

Deno.test("oc 06 parcial + cliente autorizado → lança 55", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO_TOTALL,
    instrucao: "2 (SSWMOBILE)",
    qtdVolumesNf: 9,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, true);
  assertEquals(d.aplica === true ? d.oc : null, 6);
  assertEquals(d.aplica === true ? d.texto_ssw : null, TEXTO_SSW_55);
  assertEquals(d.aplica === true ? d.cnpj : null, DUILIO_TOTALL);
});

Deno.test("oc 08 + cliente autorizado → lança 55 sem condição extra", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 8,
    cnpjPagador: FELIPE_GMI,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, true);
  assertEquals(d.aplica === true ? d.oc : null, 8);
});

Deno.test("oc 08 não olha instrução — nem a palavra TOTAL barra a avaria", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 8,
    cnpjPagador: FELIPE_GMI,
    instrucao: "AVARIA TOTAL DA CARGA",
    qtdVolumesNf: 3,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, true);
});

// ── decisão: as cercas ──────────────────────────────────────────────────────

Deno.test("REGRA INVIOLÁVEL: extravio TOTAL nunca vira 55, nem para cliente autorizado", () => {
  for (const [instrucao, vol] of [["TOTAL", 1], ["9", 9], ["FALTA TOTAL", 7]] as const) {
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc: 6,
      cnpjPagador: DUILIO_TOTALL,
      instrucao,
      qtdVolumesNf: vol,
      whitelist: WHITELIST_ATIVA,
    });
    assertEquals(d.aplica, false, `instrucao=${instrucao} vol=${vol} deveria barrar`);
    assertEquals(d.aplica === false ? d.motivo : null, "sinal_de_extravio_total");
  }
});

Deno.test("D2b: quantidade legível mas volumes da NF desconhecidos → fail-closed", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO_TOTALL,
    instrucao: "3",
    qtdVolumesNf: null,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, false);
  assertEquals(d.aplica === false ? d.motivo : null, "volumes_da_nf_desconhecidos");
});

Deno.test("D3: ilegível + volumes desconhecidos ainda assim aplica (nenhum número em jogo)", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO_TOTALL,
    instrucao: "EXTRAVIO NA TRANSFERENCIA",
    qtdVolumesNf: null,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, true);
});

Deno.test("flag master OFF barra tudo — kill-switch sem deploy", () => {
  const d = decidirSeguirParcialAuto({
    flagOn: false,
    oc: 8,
    cnpjPagador: DUILIO_TOTALL,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, false);
  assertEquals(d.aplica === false ? d.motivo : null, "flag_off");
});

Deno.test("INV-141: cliente FORA da whitelist nunca é tocado", () => {
  for (const oc of [6, 8]) {
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc,
      cnpjPagador: FORA,
      instrucao: "1 (SSWMOBILE)",
      qtdVolumesNf: 10,
      whitelist: WHITELIST_ATIVA,
    });
    assertEquals(d.aplica, false, `oc=${oc} de cliente fora da lista não pode aplicar`);
    assertEquals(d.aplica === false ? d.motivo : null, "cnpj_fora_da_whitelist");
  }
});

Deno.test("escopo: 09, 16, 03, 17 e demais ocs ficam de fora (briefing só cita 06 e 08)", () => {
  for (const oc of [3, 9, 10, 16, 17, 19, 35, 49, 54, 55]) {
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc,
      cnpjPagador: DUILIO_TOTALL,
      instrucao: "1",
      qtdVolumesNf: 10,
      whitelist: WHITELIST_ATIVA,
    });
    assertEquals(d.aplica, false, `oc=${oc} não está no escopo`);
    assertEquals(d.aplica === false ? d.motivo : null, "oc_fora_do_escopo");
  }
  assertEquals([...OCS_NO_ESCOPO].sort((a, b) => a - b), [6, 8]);
});

Deno.test("oc nula/indefinida não aplica", () => {
  assertEquals(
    decidirSeguirParcialAuto({
      flagOn: true,
      oc: null,
      cnpjPagador: DUILIO_TOTALL,
      whitelist: WHITELIST_ATIVA,
    }).aplica,
    false,
  );
});

Deno.test("chave por oc: cliente com aplica_oc06=false recebe 55 na 08, não na 06", () => {
  const soAvaria = new Map([wl({ cnpj_pagador: DUILIO_TOTALL, aplica_oc06: false })]);
  const na06 = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO_TOTALL,
    instrucao: "2",
    qtdVolumesNf: 9,
    whitelist: soAvaria,
  });
  assertEquals(na06.aplica, false);
  assertEquals(na06.aplica === false ? na06.motivo : null, "oc_desligada_para_o_cliente");

  const na08 = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 8,
    cnpjPagador: DUILIO_TOTALL,
    whitelist: soAvaria,
  });
  assertEquals(na08.aplica, true);
});

Deno.test("INV-142: whitelist vazia (estado pós-migration) não aplica nada", () => {
  const vazia = new Map<string, ClienteSeguirParcial>();
  for (const oc of [6, 8]) {
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc,
      cnpjPagador: DUILIO_TOTALL,
      instrucao: "1",
      qtdVolumesNf: 9,
      whitelist: vazia,
    });
    assertEquals(d.aplica, false);
  }
});

// ── Ruído removível escondendo o número (furo achado em 2026-09-03) ──────────
// Existiam DOIS níveis de limpeza no repo. `agente-sugere-ocs-padrao` usava o
// forte (`removerMarcadoresSswmobile`, que tira HTML + Protocolo/SEFAZ) e este
// módulo usava o fraco (só SSWMOBILE/GPS). No fraco, um número real escondido
// atrás de ruído vira `null` → o D3 lê como "ilegível" → PARCIAL → lança 55.
// Num extravio TOTAL isso manda a operação entregar carga que não existe.
// Estes testes travam a limpeza forte no caminho da decisão.

Deno.test("ruído HTML não pode esconder extravio TOTAL (NF 1494821: portal devolve tag)", () => {
  // O portal SSW devolve a instrução com comentário + âncora de GPS.
  const comHtml = '9 <!--x--><a href=# class=sra onclick=showMapaVeic(1)><u>GPS</u></a>';
  assertEquals(temSinalDeExtravioTotal(comHtml, 9), true);

  const d = decidirSeguirParcialAuto({
    flagOn: true,
    oc: 6,
    cnpjPagador: DUILIO_TOTALL,
    instrucao: comHtml,
    qtdVolumesNf: 9,
    whitelist: WHITELIST_ATIVA,
  });
  assertEquals(d.aplica, false);
  assertEquals(d.aplica === false && d.motivo, "sinal_de_extravio_total");
});

Deno.test("ruído SEFAZ/Protocolo não pode esconder extravio TOTAL", () => {
  for (const instr of [
    "5 Protocolo: 12345",
    "5 SEFAZ-MG",
    "5 (SSWMOBILE) Protocolo: 999",
  ]) {
    assertEquals(temSinalDeExtravioTotal(instr, 5), true, `deveria ser total: ${instr}`);
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc: 6,
      cnpjPagador: DUILIO_TOTALL,
      instrucao: instr,
      qtdVolumesNf: 5,
      whitelist: WHITELIST_ATIVA,
    });
    assertEquals(d.aplica, false, `não podia lançar 55 em: ${instr}`);
  }
});

Deno.test("limpeza forte NÃO rouba os casos legítimos do D3 (âncoras reais da F0)", () => {
  // Continuam ilegíveis depois da limpeza forte → seguem PARCIAIS → lançam 55.
  const casos: Array<[string, number]> = [
    ["1 V", 6],
    ["F1 (SSWMOBILE)", 7],
    ["1 PROVAVELMENTE ERRO NO CARREGAMENTO OS 2 ESTAVA AQUI NA SEXTA", 2],
  ];
  for (const [instrucao, qtdVolumesNf] of casos) {
    assertEquals(
      temSinalDeExtravioTotal(instrucao, qtdVolumesNf),
      false,
      `não é sinal de total: ${instrucao}`,
    );
    const d = decidirSeguirParcialAuto({
      flagOn: true,
      oc: 6,
      cnpjPagador: DUILIO_TOTALL,
      instrucao,
      qtdVolumesNf,
      whitelist: WHITELIST_ATIVA,
    });
    assertEquals(d.aplica, true, `devia lançar 55 (parcial de verdade): ${instrucao}`);
  }
});

Deno.test("as âncoras de TOTAL da F0 continuam barradas depois da limpeza forte", () => {
  // NF 29642 `9` (9 vol), NF 29405 `7 (SSWMOBILE)` (7 vol), NF 242255 `3` (3 vol),
  // NF 199462 `2` (2 vol), NF 193347 `1 (SSWMOBILE)` (1 vol).
  const ancoras: Array<[string, number]> = [
    ["9", 9],
    ["7 (SSWMOBILE)", 7],
    ["3", 3],
    ["2", 2],
    ["1 (SSWMOBILE)", 1],
  ];
  for (const [instrucao, vol] of ancoras) {
    assertEquals(temSinalDeExtravioTotal(instrucao, vol), true, `âncora total: ${instrucao}`);
  }
});

Deno.test("lerQtdDaInstrucao aceita null/vazio sem explodir", () => {
  assertEquals(lerQtdDaInstrucao(null), null);
  assertEquals(lerQtdDaInstrucao(undefined), null);
  assertEquals(lerQtdDaInstrucao(""), null);
  assertEquals(lerQtdDaInstrucao("   "), null);
  assertEquals(lerQtdDaInstrucao("<!--só ruído-->"), null);
});
