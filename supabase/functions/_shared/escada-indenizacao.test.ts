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

// REGRA MUDOU (Caio 21/09, NF 2464262): antes, "e-mail já enviado após a 59"
// era "nada a mudar (aguardar)". Agora esse cenário — cliente respondeu sem
// fechar o dossiê — vira responder_docs_thread (responder a thread pedindo só
// o que falta). O teste antigo foi substituído de propósito.
Deno.test("R4 degrau 2 REVISADO (Caio 21/09): e-mail já enviado após a 59 + dossiê aberto → responder a thread (não mais 'aguardar')", () => {
  const hist = [...HIST_EXTRAVIO, { codigo: 59, instrucao: "RETORNO INDENIZACAO" }];
  const d = decidirDegrauIndenizacao({
    historico: hist, ocCard: 59, ocSugerida: 59,
    dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "responder_docs_thread");
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

// ═══════════════════════════════════════════════════════════════════════════
// Degrau 2b — responder_docs_thread (Caio 21/09, âncora NF 2464262 BLACK &
// DECKER / Ingrid): 59 em curso + já cobramos + cliente respondeu sem fechar
// o dossiê → responder a thread pedindo SÓ o que falta. Nunca relançar.
// ═══════════════════════════════════════════════════════════════════════════

const HIST_59 = [
  { codigo: 59, instrucao: "PENDENCIA DE DOCUMENTACAO" },
  { codigo: 6, instrucao: "EXTRAVIO NA TRANSFERENCIA" },
];

Deno.test("R4 degrau 2b (âncora 2464262): 59 em curso + e-mail já saiu + resposta sem fechar dossiê → responder thread pedindo só o que falta", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_59, ocCard: 59, ocSugerida: 33,
    dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
    romaneioInterno: true,
    faltantes: ["valor dos itens"],
  });
  assertEquals(d?.degrau, "responder_docs_thread");
  const corpo = (d as { corpo_email: string }).corpo_email;
  assertEquals(corpo.includes("valor"), true);
  // NUNCA re-pede o que já chegou nem romaneio de cliente romaneio-interno:
  assertEquals(corpo.includes("descritivo"), false);
  assertEquals(corpo.includes("romaneio"), false);
});

Deno.test("R4 degrau 2b: também dispara quando o LLM insiste na 59 (nunca relançar)", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_59, ocCard: 59, ocSugerida: 59,
    dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
    romaneioInterno: false,
    faltantes: ["romaneio de coleta assinado", "valor dos itens"],
  });
  assertEquals(d?.degrau, "responder_docs_thread");
  const corpo = (d as { corpo_email: string }).corpo_email;
  assertEquals(corpo.includes("romaneio"), true);
  assertEquals(corpo.includes("valor"), true);
});

Deno.test("R4 degrau 2b: dossiê COMPLETO continua indo pra formalizar_33 (não regride)", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_59, ocCard: 59, ocSugerida: 59,
    dossieCompleto: true, houve59NoCiclo: true, emailEnviadoAposUltima59: true,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "formalizar_33");
});

Deno.test("R4 degrau 2 intacto: 59 lançada e e-mail NUNCA saiu → so_email_docs (não o 2b)", () => {
  const d = decidirDegrauIndenizacao({
    historico: HIST_59, ocCard: 59, ocSugerida: 59,
    dossieCompleto: false, houve59NoCiclo: true, emailEnviadoAposUltima59: false,
    romaneioInterno: false,
  });
  assertEquals(d?.degrau, "so_email_docs");
});

Deno.test("corpoEmailDocs sem faltantes: comportamento original intacto (retrocompat)", () => {
  const corpo = corpoEmailDocs({ tipo: "extravio", romaneioInterno: false });
  assertEquals(corpo.includes("romaneio de coleta"), true);
  assertEquals(corpo.includes("descritivo"), true);
  assertEquals(corpo.includes("valor"), true);
});
