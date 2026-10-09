// INV-191 (Carlos 2026-10-09, NF 387252) — o diagnóstico só OBSERVA.
// Dados FICTÍCIOS (repo público): o formato imita o e-mail da âncora — descrição
// do item no corpo, quebrada em duas linhas, e o valor numa linha própria.
// Rodar: deno test --no-check --allow-all supabase/functions/_shared/diagnostico-evidencias-dossie.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  diagnosticarEvidenciasLlm,
  TETO_TEXTO_DIAGNOSTICO,
} from "./diagnostico-evidencias-dossie.ts";
import {
  montarEvidenciasRecebidas,
  type AnexoInbound,
  type EvidenciaLlmRaw,
} from "./extravio-parcial-dossie.ts";

const CORPO =
  "Boa tarde,\r\n\r\nSegue em anexo o romaneio de coleta.\r\n" +
  " - Descrição do item faltante: PRODUTO EXEMPLO (C1) 50MG CAPSULA MARCA\r\n" +
  "FICTICIA PORT.000/00\r\n" +
  " - Custo:123,45\r\n" +
  " - Lote: 0000\r\n";

const ANEXOS: AnexoInbound[] = [
  { filename: "romaneio exemplo.pdf", mime_type: "application/pdf", size_bytes: 1000 },
  { filename: "nota.pdf", mime_type: "application/pdf", size_bytes: 500 },
];

const REF = {
  message_inbox_id: "msg-1",
  gmail_message_id: "gm-1",
  gmail_thread_id: "th-1",
  visto_em: "2026-10-06T17:58:00Z",
};

const OPTS = { exato: false, idMensagemAtual: "msg-1" };

type Llm = { romaneio?: EvidenciaLlmRaw; descricao?: EvidenciaLlmRaw; valor?: EvidenciaLlmRaw };

/** Roda a prova de verdade e o diagnóstico, do jeito que o interpretador faz. */
function rodar(llm: Llm | null) {
  const recebidas = montarEvidenciasRecebidas(llm, ANEXOS, CORPO, REF, OPTS);
  const diag = diagnosticarEvidenciasLlm(llm, recebidas, ANEXOS, CORPO, OPTS);
  return { recebidas, diag };
}

Deno.test("descrição copiada literal (juntando as linhas): aceita, e o diagnóstico concorda", () => {
  const { recebidas, diag } = rodar({
    romaneio: { fonte: "anexo", anexo_filename: "romaneio exemplo.pdf" },
    descricao: {
      fonte: "corpo",
      trecho_verbatim: "PRODUTO EXEMPLO (C1) 50MG CAPSULA MARCA FICTICIA PORT.000/00",
    },
    valor: { fonte: "corpo", trecho_verbatim: "Custo:123,45" },
  });
  assert(recebidas.descricao, "a prova aceita: quebra de linha vira espaço");
  assertEquals(diag.descricao.aceita, true);
  assertEquals(diag.descricao.trecho_no_corpo, true);
  assertEquals(diag.descricao.palavras_no_corpo, "8/8");
  assertEquals(diag.romaneio.anexo_casou, true);
});

Deno.test("descrição REESCRITA pelo modelo: recusada, e o diagnóstico mostra que quase tudo estava lá", () => {
  // O caso que não dava pra provar na 387252: o modelo "arruma" o texto.
  const { recebidas, diag } = rodar({
    descricao: { fonte: "corpo", trecho_verbatim: "Produto Exemplo 50mg cápsula, marca fictícia" },
    valor: { fonte: "corpo", trecho_verbatim: "Custo:123,45" },
  });
  assertEquals(recebidas.descricao, undefined);
  assertEquals(diag.descricao.modelo_informou, true);
  assertEquals(diag.descricao.aceita, false);
  assertEquals(diag.descricao.trecho_no_corpo, false);
  // 4 de 6 palavras batem ("cápsula"/"fictícia" com acento não batem): reescrita, não invenção.
  assertEquals(diag.descricao.palavras_no_corpo, "4/6");
  assertEquals(diag.valor.aceita, true);
});

Deno.test("descrição OMITIDA pelo modelo: o diagnóstico diz que ele não informou", () => {
  const { diag } = rodar({ valor: { fonte: "corpo", trecho_verbatim: "Custo:123,45" } });
  assertEquals(diag.modelo_devolveu_bloco, true);
  assertEquals(diag.descricao.modelo_informou, false);
  assertEquals(diag.descricao.modelo, null);
  assertEquals(diag.descricao.aceita, false);
  assertEquals(diag.valor.aceita, true);
});

Deno.test("descrição inventada: quase nenhuma palavra no corpo", () => {
  const { diag } = rodar({ descricao: { fonte: "corpo", trecho_verbatim: "parafuso sextavado galvanizado" } });
  assertEquals(diag.descricao.trecho_no_corpo, false);
  assertEquals(diag.descricao.palavras_no_corpo, "0/3");
});

Deno.test("anexo citado que não existe: anexo_casou=false e não aceita", () => {
  const { diag } = rodar({ descricao: { fonte: "anexo", anexo_filename: "planilha_itens.xlsx" } });
  assertEquals(diag.descricao.anexo_casou, false);
  assertEquals(diag.descricao.aceita, false);
});

Deno.test("trecho curto demais: marcado como curto (piso anti-trivial da prova)", () => {
  const { diag } = rodar({ valor: { fonte: "corpo", trecho_verbatim: "R$" } });
  assertEquals(diag.valor.trecho_curto, true);
  assertEquals(diag.valor.aceita, false);
});

Deno.test("modelo sem o bloco de evidências: tudo 'não informou', nada quebra", () => {
  const { diag } = rodar(null);
  assertEquals(diag.modelo_devolveu_bloco, false);
  for (const k of ["romaneio", "descricao", "valor"] as const) {
    assertEquals(diag[k].modelo_informou, false);
    assertEquals(diag[k].aceita, false);
  }
  assertEquals(diag.corpo_chars, CORPO.length);
});

Deno.test("texto do cliente vai CORTADO no teto", () => {
  const longo = "X".repeat(TETO_TEXTO_DIAGNOSTICO + 300);
  const { diag } = rodar({ descricao: { fonte: "corpo", trecho_verbatim: longo, anexo_filename: longo } });
  assertEquals(diag.descricao.modelo?.trecho?.length, TETO_TEXTO_DIAGNOSTICO);
  assertEquals(diag.descricao.modelo?.anexo_filename?.length, TETO_TEXTO_DIAGNOSTICO);
});

Deno.test("entrada estranha do modelo (números, null) não lança", () => {
  const estranho = {
    descricao: { fonte: 7, trecho_verbatim: null, anexo_filename: 123 },
    valor: "texto solto",
  } as unknown as Llm;
  const d = diagnosticarEvidenciasLlm(estranho, {}, ANEXOS, CORPO, OPTS);
  assertEquals(d.descricao.modelo_informou, true);
  assertEquals(d.descricao.modelo?.fonte, null);
  assertEquals(d.descricao.trecho_no_corpo, null);
  assertEquals(d.valor.modelo_informou, false);
});

Deno.test("SÓ OBSERVA: não altera o que o modelo devolveu nem o que a prova aceitou", () => {
  const llm: Llm = {
    romaneio: { fonte: "anexo", anexo_filename: "romaneio exemplo.pdf" },
    descricao: { fonte: "corpo", trecho_verbatim: "Produto Exemplo 50mg" },
    valor: { fonte: "corpo", trecho_verbatim: "Custo:123,45" },
  };
  const llmAntes = structuredClone(llm);
  const recebidas = montarEvidenciasRecebidas(llm, ANEXOS, CORPO, REF, OPTS);
  const recebidasAntes = structuredClone(recebidas);
  diagnosticarEvidenciasLlm(llm, recebidas, ANEXOS, CORPO, OPTS);
  assertEquals(llm, llmAntes);
  assertEquals(recebidas, recebidasAntes);
  // E a prova, rodada de novo depois do diagnóstico, dá o MESMO resultado.
  assertEquals(montarEvidenciasRecebidas(llm, ANEXOS, CORPO, REF, OPTS), recebidas);
});

Deno.test("fiação no interpretador: mesma régua da prova, dentro de try/catch, no evento existente", async () => {
  const src = await Deno.readTextFile(
    new URL("../interpretador-resposta-cliente/index.ts", import.meta.url),
  );
  // A prova e o diagnóstico recebem o MESMO objeto de opções.
  assert(src.includes("const optsProvaEvidencias = { exato: anexosAbertos.length > 0, idMensagemAtual: body.message_id };"));
  assert(/montarEvidenciasRecebidas\([\s\S]{0,900}?optsProvaEvidencias,\s*\);/.test(src));
  // Falha no diagnóstico nunca derruba a leitura.
  const i = src.indexOf("diagnosticoEvidencias = diagnosticarEvidenciasLlm(");
  assert(i > 0);
  assert(src.lastIndexOf("try {", i) > src.lastIndexOf("optsProvaEvidencias,", i));
  // O evento antigo continua com o campo de sempre, e ganha o diagnóstico.
  assert(src.includes("evidencias_recebidas_nesta_resposta: Object.keys(recebidas),"));
  assert(src.includes("diagnostico_evidencias: diagnosticoEvidencias,"));
});
