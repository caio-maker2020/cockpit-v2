// Guard R3 anti-veto (playbook 02/09): extravio parcial com volumes na mão →
// 54 perguntando (sem autorização) / 55 (com). Âncoras: NFs 5419, 773332,
// 1011929 (LARISSA), 120149, 25021 (ISABELY).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirParcialSemAutorizacao,
  detectarExtravioParcialNoHistorico,
  extrairVolumesFaltantes,
  houve55AposExtravio,
  template54Parcial,
} from "./extravio-parcial-regra.ts";

Deno.test("R3: extrai volumes faltantes dos fraseados reais", () => {
  assertEquals(extrairVolumesFaltantes("FALTA DE 1 VOLUME NA DESCARGA"), 1);
  assertEquals(extrairVolumesFaltantes("2 VOLUMES EXTRAVIADOS NA TRANSFERENCIA"), 2);
  assertEquals(extrairVolumesFaltantes("EXTRAVIO PARCIAL DE 3 VOLUMES"), 3);
  assertEquals(extrairVolumesFaltantes("EXTRAVIO NA TRANSFERENCIA"), null);
});

Deno.test("R3: âncora LARISSA (5419/773332) — extravio parcial + aguardar-59 vira 54 perguntando", () => {
  const historico = [
    { codigo: 2, instrucao: "EMISSAO CTRC" },
    { codigo: 31, instrucao: "EXTRAVIO PARCIAL - FALTA DE 1 VOLUME" },
    { codigo: 59, instrucao: "RETORNO INDENIZACAO" },
  ];
  const d = decidirParcialSemAutorizacao({
    historico, ocCard: 59, ocSugerida: 59, ehParcialSinalExterno: false,
  });
  assertEquals(d?.acao, "54_perguntar");
  assertEquals(d?.volumes_faltantes, 1);
  // template literal do Duilio (p8), com as DUAS saídas
  assertEquals(d?.corpo_email.includes("falta de 1 volume"), true);
  assertEquals(d?.corpo_email.includes("parcial ou devemos devolver"), true);
});

Deno.test("R3: 55 já lançada após o extravio = autorização prévia → NÃO intervém (Duilio p6)", () => {
  const historico = [
    { codigo: 31, instrucao: "EXTRAVIO PARCIAL - FALTA DE 1 VOLUME" },
    { codigo: 55, instrucao: "AUTORIZADO SEGUIR PARCIAL" },
    { codigo: 59, instrucao: "RETORNO INDENIZACAO" },
  ];
  assertEquals(houve55AposExtravio(historico, 0), true);
  assertEquals(
    decidirParcialSemAutorizacao({ historico, ocCard: 59, ocSugerida: 59, ehParcialSinalExterno: false }),
    null,
  );
});

Deno.test("R3: card JÁ em 54 = cliente já perguntado → aguardar é correto (INV-094)", () => {
  const historico = [
    { codigo: 31, instrucao: "FALTA DE 2 VOLUMES" },
    { codigo: 54, instrucao: "AGUARDANDO RETORNO DO CLIENTE PAGADOR" },
  ];
  assertEquals(
    decidirParcialSemAutorizacao({ historico, ocCard: 54, ocSugerida: 54, ehParcialSinalExterno: false }),
    null,
  );
});

Deno.test("R3: LLM sugeriu ação resolutiva (55/44/21/33) → passa intacta", () => {
  const historico = [{ codigo: 31, instrucao: "FALTA DE 1 VOLUME" }];
  for (const oc of [55, 44, 21, 33]) {
    assertEquals(
      decidirParcialSemAutorizacao({ historico, ocCard: 31, ocSugerida: oc, ehParcialSinalExterno: false }),
      null,
    );
  }
});

Deno.test("R3: extravio TOTAL (sem indicação de parcial) → não intervém", () => {
  const historico = [
    { codigo: 6, instrucao: "EXTRAVIO NA TRANSFERENCIA" },
    { codigo: 59, instrucao: "RETORNO INDENIZACAO" },
  ];
  assertEquals(detectarExtravioParcialNoHistorico(historico), null);
  assertEquals(
    decidirParcialSemAutorizacao({ historico, ocCard: 59, ocSugerida: 59, ehParcialSinalExterno: false }),
    null,
  );
});

Deno.test("R3: quantidade indeterminável mas sinal externo (dossiê/LLM) → 54 com texto genérico", () => {
  const d = decidirParcialSemAutorizacao({
    historico: [{ codigo: 59, instrucao: "RETORNO" }],
    ocCard: 59, ocSugerida: 59, ehParcialSinalExterno: true,
  });
  assertEquals(d?.acao, "54_perguntar");
  assertEquals(d?.volumes_faltantes, null);
  assertEquals(d?.corpo_email.includes("parte dos volumes"), true);
});

Deno.test("R3: template com plural", () => {
  assertEquals(template54Parcial(2).includes("falta de 2 volumes"), true);
});
