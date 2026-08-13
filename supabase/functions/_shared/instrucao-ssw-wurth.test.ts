// Guard do corte de 70 chars do SSW (Caio 2026-08-13, print da oc 21 truncada).
// Fixtures espelham a ESTRUTURA das Obs reais da intranet Würth — nomes,
// telefones e locais são SINTÉTICOS (repo público, sem PII).
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  comprimirInstrucaoWurth,
  normalizarObs,
  SSW_INSTRUCAO_MAXLEN,
} from "./instrucao-ssw-wurth.ts";

// Estruturas reais (conteúdo trocado): horário+assinatura / contato+tel+ref /
// horário curto / referência longa / referência curta.
const OBS = {
  horarioAssinatura: "GENTILEZA REAPRESENTAR EM HORáRIO COMERCIAL EXCETO ALMOçO. ATT MARIA EXEMPLO",
  contatoTelRef:
    "PESSOA A SER CONTATADA NA EMPRESA: FULANO Nº TELEFONE FIXO PARA CONTATO : 31 44445555 " +
    "HORáRIO DE RECEBIMENTO: COMERCIAL ( NãO FECHA PARA ALMOçO) PONTO DE REFERêNCIA: DO LADO DA PADARIA CENTRAL. CICLANA",
  horarioCurto: "REENTREGAR EM HORáRIO COMERCIAL - EVITAR ALMOçO - CICLANA",
  // Comprimento espelha o caso real que pegou o bug (referência ~100 chars):
  // com fixture curto o teste passava e o dado real virava só a assinatura.
  refLonga:
    "BOA TARDE! SEGUE O PONTO DE REFERêNCIA COMO SOLICITADO! PONTO DE REFERêNCIA : ANTIGO TREVO DA RODOVIA " +
    "SENTIDO A CIDADE DE EXEMPLOPOLIS , 200 METROS A FRENTE AO LADO DA LOJA MODELO DE EXEMPLO. CICLANA",
  refCurta: "BOM DIA. POR GENTILEZA REENTREGAR MERCADORIA, PONTO REFERêNCIA NA RUA DO MERCADO MODELO. OBRIGADO. CICLANA",
};

// ── INVARIANTE: nada passa de 70 (o que passa, a Operação não lê) ─────────────
Deno.test("INVARIANTE: toda saída cabe nos 70 chars do campo f6", () => {
  for (const [nome, obs] of Object.entries(OBS)) {
    const out = comprimirInstrucaoWurth(obs);
    assert(
      out.length <= SSW_INSTRUCAO_MAXLEN,
      `${nome} estourou: ${out.length} chars — "${out}"`,
    );
  }
});

Deno.test("o boilerplate óbvio NUNCA entra (a linha do SSW já diz 21 - REENTREGA)", () => {
  for (const obs of Object.values(OBS)) {
    const out = comprimirInstrucaoWurth(obs);
    assertEquals(/REENTREGA AUTORIZADA|VIA INTRANET|CLIENTE AUTORIZOU/.test(out), false, out);
  }
});

Deno.test("saudação e cortesia viram espaço (eram elas que comiam o orçamento)", () => {
  const out = comprimirInstrucaoWurth(OBS.refLonga);
  assertEquals(/BOA TARDE|OBRIGAD|GENTILEZA|COMO SOLICITADO/.test(out), false, out);
});

// ── o que IMPORTA sobrevive ──────────────────────────────────────────────────
Deno.test("contato+telefone+horário+referência: o essencial cabe junto", () => {
  const out = comprimirInstrucaoWurth(OBS.contatoTelRef);
  assertStringIncludes(out, "PADARIA CENTRAL"); // onde
  assertStringIncludes(out, "31 44445555"); // quem chamar
  assert(out.length <= SSW_INSTRUCAO_MAXLEN);
});

Deno.test("referência curta sobrevive inteira", () => {
  const out = comprimirInstrucaoWurth(OBS.refCurta);
  assertStringIncludes(out, "RUA DO MERCADO MODELO");
});

Deno.test("janela de horário é preservada de forma abreviada", () => {
  const out = comprimirInstrucaoWurth(OBS.horarioCurto);
  assertStringIncludes(out, "HOR COML");
  assertStringIncludes(out, "S/ ALMOCO");
});

Deno.test("assinatura entra só se sobrar espaço (nunca no lugar do essencial)", () => {
  const out = comprimirInstrucaoWurth(OBS.horarioAssinatura);
  assertStringIncludes(out, "HOR COML");
  assertStringIncludes(out, "MARIA EXEMPLO");
});

// Regressão real (Caio 2026-08-13): a referência longa era DESCARTADA por não
// caber e o SSW recebia só a assinatura ("BERENICE"). O dado que guia o
// motorista tem que entrar, nem que seja cortado.
Deno.test("referência longa entra CORTADA — nunca é trocada pela assinatura", () => {
  const out = comprimirInstrucaoWurth(OBS.refLonga);
  assertStringIncludes(out, "REF");
  assertStringIncludes(out, "TREVO"); // o começo da referência sobrevive
  assert(out.length >= 40, `resumo curto demais (perdeu a referência): "${out}"`);
  assertEquals(/^CICLANA$/.test(out), false, "virou só a assinatura");
});

Deno.test("referência LONGA: corta na palavra, nunca no meio dela", () => {
  const out = comprimirInstrucaoWurth(OBS.refLonga);
  assert(out.length <= SSW_INSTRUCAO_MAXLEN);
  assertEquals(out.endsWith(" "), false);
  // não pode terminar com pedaço de palavra cortada do fixture
  assertEquals(/\bMODEL$|\bEXEMPLOPOL$|\bADIANT$/.test(out), false, out);
});

// ── robustez ─────────────────────────────────────────────────────────────────
Deno.test("Obs vazia/nula → string vazia (nunca lança)", () => {
  assertEquals(comprimirInstrucaoWurth(null), "");
  assertEquals(comprimirInstrucaoWurth(""), "");
  assertEquals(comprimirInstrucaoWurth("   "), "");
});

Deno.test("Obs sem estrutura reconhecível → texto limpo, cortado na palavra", () => {
  const out = comprimirInstrucaoWurth("CLIENTE PEDIU PRA TENTAR DE NOVO NA SEGUNDA DE MANHA CEDO POR CAUSA DO ESTOQUE LOTADO");
  assert(out.length <= SSW_INSTRUCAO_MAXLEN);
  assertStringIncludes(out, "SEGUNDA");
});

Deno.test("acento some e vira caixa alta (latin-1 safe pro submit do portal)", () => {
  assertEquals(normalizarObs("HORáRIO COMERCIAL ALMOçO"), "HORARIO COMERCIAL ALMOCO");
  const out = comprimirInstrucaoWurth(OBS.horarioCurto);
  assertEquals(/[áàâãéêíóôõúüç]/i.test(out), false, out);
});

Deno.test("já comprimido não muda de novo (estável / idempotente)", () => {
  const uma = comprimirInstrucaoWurth(OBS.contatoTelRef);
  const duas = comprimirInstrucaoWurth(uma);
  assert(duas.length <= SSW_INSTRUCAO_MAXLEN);
  assertStringIncludes(duas, "31 44445555");
});
