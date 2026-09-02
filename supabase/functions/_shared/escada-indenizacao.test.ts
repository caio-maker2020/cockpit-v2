// Guard R4 anti-veto (playbook 02/09): a escada da indenização.
// Âncoras: NFs 51096 (56→59+docs), 67975 (aguardar→só e-mail), 1508990
// (59 de novo→33). Docs da lista do Duilio (p9); romaneio-interno (p13).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  corpoEmailDocs,
  decidirDegrauIndenizacao,
  ehCasoAvaria,
  ehContextoIndenizacao,
} from "./escada-indenizacao.ts";

const HIST_EXTRAVIO = [
  { codigo: 2, instrucao: "EMISSAO CTRC" },
  { codigo: 6, instrucao: "EXTRAVIO NA TRANSFERENCIA" },
];

Deno.test("R4 degrau 1 (âncora 51096): faltante sem 59 + fluxo indo pra 56 → 59+e-mail docs", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_EXTRAVIO, ocCard: 6, ocSugerida: 56,
    dossieCompleto: false, houve59NoCiclo: false, emailEnviadoAposUltima59: null,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "pedir_docs_59");
  const corpo = (d as { corpo_email: string }).corpo_email;
  assertEquals(corpo.includes("romaneio de coleta"), true);
  assertEquals(corpo.includes("descritivo"), true);
  assertEquals(corpo.includes("valor"), true);
});

Deno.test("R4 degrau 2 (âncora 67975): 59 lançada SEM e-mail + re-aguardar → só o e-mail", () => {
  const hist = [...HIST_EXTRAVIO, { codigo: 59, instrucao: "RETORNO INDENIZACAO" }];
  const d = decidirDegrauIndenizacao({
    historico: hist, ocCard: 59, ocSugerida: 59,
    dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: false,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "so_email_docs");
});

Deno.test("R4 degrau 2: e-mail JÁ enviado após a 59 → nada a mudar (aguardar ok)", () => {
  const hist = [...HIST_EXTRAVIO, { codigo: 59, instrucao: "RETORNO INDENIZACAO" }];
  assertEquals(
    decidirDegrauIndenizacao({
      historico: hist, ocCard: 59, ocSugerida: 59,
      dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
      romaneioInterno: false,
    }),
    null,
  );
});

Deno.test("R4 degrau 3 (âncora 1508990): dossiê completo + destino 59 → formalizar 33", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_EXTRAVIO, ocCard: 49, ocSugerida: 59,
    dossieCompleto: true, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "formalizar_33");
});

Deno.test("R4: avaria pede imagem; extravio não (Duilio p9)", () => {
  assertEquals(corpoEmailDocs({ tipo: "avaria", romaneioInterno: false }).includes("imagem da avaria"), true);
  assertEquals(corpoEmailDocs({ tipo: "extravio", romaneioInterno: false }).includes("imagem"), false);
  assertEquals(ehCasoAvaria([{ codigo: 8, instrucao: "CAIXA AMASSADA" }]), true);
  assertEquals(ehCasoAvaria(HIST_EXTRAVIO), false);
});

Deno.test("R4: romaneio-interno (PRATI/Würth/B&D) — e-mail NÃO pede romaneio (p13)", () => {
  const corpo = corpoEmailDocs({ tipo: "extravio", romaneioInterno: true });
  assertEquals(corpo.includes("romaneio"), false);
  assertEquals(corpo.includes("descritivo"), true);
});

Deno.test("R4: fora do contexto de indenização → null", () => {
  assertEquals(ehContextoIndenizacao([{ codigo: 10 }], 10), false);
  assertEquals(
    decidirDegrauIndenizacao({
      historico: [{ codigo: 10, instrucao: "RECUSA" }], ocCard: 10, ocSugerida: 56,
      dossieCompleto: false, houve59NoCiclo: false, emailEnviadoAposUltima59: null,
      romaneioInterno: false,
    }),
    null,
  );
});
