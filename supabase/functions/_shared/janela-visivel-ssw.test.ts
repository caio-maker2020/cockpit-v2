// =============================================================================
// INV-154 — os itens e o VALOR cabem nos 70 caracteres que o setor LE.
//
// A tela 101 do SSW tem dois campos: f6 ("Informacoes complementares", 70) e
// observ ("Instrucao", 500). O Cockpit preenche os DOIS
// (ssw-internal-client.ts:1273-1275), mas a coluna "Instrucao/Complemento" do
// historico — a que o setor que recebe a ocorrencia LE — mostra o f6.
// Validado pelo Caio por print em 12/06 (NF 345834), depois do ajuste de 08/06
// ter escondido o texto do setor por 4 dias.
//
// Logo: tudo que passar do caractere 70 e auditoria, nao e decisao. Os itens e
// o valor TEM de estar na frente.
//
// PROVA DO GUARD: contra o codigo de 15/09 (rotulos longos + operador na
// frente) os testes 1 e 2 FALHAM.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dossieVazio,
  JANELA_VISIVEL_SSW,
  montarTextoDescricaoValor,
  montarTextoOc33ComOperador,
} from "./extravio-parcial-dossie.ts";

const visivel = (s: string) => s.slice(0, JANELA_VISIVEL_SSW);

/** Caso ancora real NF 135724. */
const OPERADOR = "Reversão de perdas iniciada. Cliente notificado.";

Deno.test("INV-154 janela: o VALOR cabe nos 70 que o setor le (ancora NF 135724)", () => {
  const dossie = {
    ...dossieVazio(),
    descricao: { presente: true, fonte: "corpo" as const, texto_bruto: "Cod 7436010015, 75,00 un" },
    valor: { presente: true, fonte: "corpo" as const, texto_bruto: "R$717,07" },
  };
  const r = montarTextoOc33ComOperador(OPERADOR, montarTextoDescricaoValor(dossie), "135724");
  const olho = visivel(r.instrucao);
  assert(olho.includes("7436010015"), `o item tem de estar visivel — o setor le: "${olho}"`);
  assert(olho.includes("R$717,07"), `o VALOR tem de estar visivel — o setor le: "${olho}"`);
});

Deno.test("INV-154 janela: texto lido de anexo tambem cabe, e a procedencia fica no fim", () => {
  const dossie = {
    ...dossieVazio(),
    descricao: {
      presente: true, fonte: "anexo" as const, filename: "NFE-433174 (1).pdf",
      texto_extraido: "DINITRATO ISOSSORBIDA 10MG - 12 UN",
    },
    valor: {
      presente: true, fonte: "anexo" as const, filename: "NFE-433174 (1).pdf",
      texto_extraido: "R$ 1.488,00",
    },
  };
  const t = montarTextoDescricaoValor(dossie);
  const olho = visivel(t);
  assert(olho.includes("DINITRATO"), `item visivel — o setor le: "${olho}"`);
  assert(olho.includes("R$ 1.488,00"), `VALOR visivel — o setor le: "${olho}"`);
  // A procedencia existe, mas FORA da janela: ela e pra auditoria depois.
  assert(t.includes("NFE-433174 (1).pdf"), "a procedencia tem de existir no texto completo");
  assert(!olho.includes("NFE-433174"), "a procedencia NAO pode gastar a janela do setor");
});

Deno.test("INV-154 janela: so um arquivo citado quando os dois textos vieram do mesmo", () => {
  const dossie = {
    ...dossieVazio(),
    descricao: { presente: true, fonte: "anexo" as const, filename: "nota.pdf", texto_extraido: "ITEM A" },
    valor: { presente: true, fonte: "anexo" as const, filename: "nota.pdf", texto_extraido: "R$ 10,00" },
  };
  const t = montarTextoDescricaoValor(dossie);
  assertEquals(t.split("nota.pdf").length - 1, 1, "nao repetir o nome do arquivo");
});

Deno.test("INV-154 janela: texto escrito pelo CLIENTE nao ganha rotulo de procedencia", () => {
  const dossie = {
    ...dossieVazio(),
    descricao: { presente: true, fonte: "corpo" as const, texto_bruto: "Paracetamol 30un", filename: "x.pdf" },
    valor: { presente: true, fonte: "corpo" as const, texto_bruto: "R$ 300,00" },
  };
  const t = montarTextoDescricaoValor(dossie);
  assert(!t.includes("lido de:"), `palavra do cliente nao e transcricao — veio: ${t}`);
});

Deno.test("INV-154 janela: sem dossie, o texto do operador segue intacto (nao-regressao)", () => {
  const r = montarTextoOc33ComOperador(OPERADOR, "", "1");
  assertEquals(r.instrucao, OPERADOR);
  assertEquals(r.precisaImagem, false);
});

Deno.test("INV-154 janela: operador e dossie continuam SOMANDO (guard NF 135724)", () => {
  const dossie = {
    ...dossieVazio(),
    descricao: { presente: true, fonte: "corpo" as const, texto_bruto: "Cod 7436010015, 75,00 un" },
    valor: { presente: true, fonte: "corpo" as const, texto_bruto: "R$717,07" },
  };
  const r = montarTextoOc33ComOperador(OPERADOR, montarTextoDescricaoValor(dossie), "135724");
  assert(r.instrucao.includes("Reversão de perdas iniciada"), "o texto do operador nao pode sumir");
  assert(r.instrucao.includes("R$717,07"));
  assertEquals(r.precisaImagem, false);
});

Deno.test("INV-154 janela: no estouro, quem e cortado e o DOSSIE — o operador sobrevive", () => {
  // Regressao real pega em 16/09: com o dossie na frente, o `.slice(0, 500)`
  // cortava o texto do operador INTEIRO. O guard de 17/07 (NF 135724) existe
  // exatamente pra isso.
  const dossieLongo = "x".repeat(490);
  const r = montarTextoOc33ComOperador("Aprovado pela operadora.", dossieLongo, "99");
  assertEquals(r.precisaImagem, true);
  assertEquals(r.textoParaImagem, dossieLongo, "a imagem leva o texto ORIGINAL inteiro");
  assert(r.instrucao.includes("Aprovado pela operadora."), "o texto do operador nao pode sumir");
  assert(r.instrucao.length <= 500);
});

Deno.test("INV-154 janela: operador enorme nao empurra os itens pra fora da vista", () => {
  const operadorEnorme = "O ".repeat(240).trim(); // ~479 chars
  const dossie = "Itens: PARACETAMOL 500MG 30UN | Valor: R$ 300,00";
  const r = montarTextoOc33ComOperador(operadorEnorme, dossie, "99");
  const olho = r.instrucao.slice(0, JANELA_VISIVEL_SSW);
  assert(olho.includes("PARACETAMOL"), `item visivel mesmo com operador enorme — o setor le: "${olho}"`);
});
