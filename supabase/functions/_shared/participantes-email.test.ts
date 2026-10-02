// Guard do bloco "quem escreveu e para quem" (Carlos 02/10, NF 1042798 PRATI).
// Sem este bloco o interpretador não sabe que o "@Bruno" do e-mail é COLEGA da
// Ana (mesma empresa) e lê conversa interna do cliente como pedido à Sal.
// Rodar: deno test supabase/functions/_shared/participantes-email.test.ts

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MAX_PARTICIPANTES_POR_LINHA,
  mencoesDoTextoNovo,
  montarBlocoParticipantes,
  papelDoParticipante,
  parseListaEnderecos,
  soMencionaQuemNaoEDaSal,
  textoNovoDaResposta,
} from "./participantes-email.ts";

// Cabeçalhos com a MESMA FORMA dos da NF 1042798 (29/09 16:32): aspas, acento,
// barra, colega no mesmo domínio, Sal e e-mail pessoal. Nomes e e-mails
// FICTÍCIOS (LGPD: o repositório é público).
const FROM_1042798 = "Ana Paula Teste <ana.teste@cliente.example>";
const TO_1042798 =
  'Carla Operadora <carla.operadora@salexpress.com.br>, "Bruno Simões da Silva" <bruno.colega@cliente.example>';
const CC_1042798 =
  'Pedro Externo <pedro.externo.teste@yahoo.com.br>, "Rogério Teste Conceição / Rô" <r.teste@cliente.example>';

Deno.test("parse: nomes com aspas, acento e barra — e-mail em minúsculas", () => {
  assertEquals(parseListaEnderecos(CC_1042798), [
    { nome: "Pedro Externo", email: "pedro.externo.teste@yahoo.com.br" },
    { nome: "Rogério Teste Conceição / Rô", email: "r.teste@cliente.example" },
  ]);
});

Deno.test("parse: vírgula DENTRO das aspas não quebra o endereço", () => {
  assertEquals(parseListaEnderecos('"Souza, Maria" <J@X.com>; Ana <a@y.com.br>'), [
    { nome: "Souza, Maria", email: "j@x.com" },
    { nome: "Ana", email: "a@y.com.br" },
  ]);
});

Deno.test("parse: endereço puro, nome igual ao e-mail, duplicado e lixo", () => {
  assertEquals(
    parseListaEnderecos(
      '"estoque@loja.example" <estoque@loja.example>, solto@cliente.com.br, solto@cliente.com.br, sem-email, ',
    ),
    [
      { nome: null, email: "estoque@loja.example" },
      { nome: null, email: "solto@cliente.com.br" },
    ],
  );
  assertEquals(parseListaEnderecos(null), []);
  assertEquals(parseListaEnderecos("   "), []);
});

Deno.test("parse: raw_payload com forma inesperada (lista/objeto/número) não derruba a leitura", () => {
  for (const x of [["a@b.com"], { email: "a@b.com" }, 42, true]) {
    assertEquals(parseListaEnderecos(x as unknown as string), []);
  }
  assertStringIncludes(
    montarBlocoParticipantes({ from: ["x"] as unknown as string, to: {} as unknown as string }),
    "cabeçalho indisponível",
  );
});

Deno.test("papel: Sal, colega (mesmo domínio e subdomínio) e outra empresa", () => {
  const rem = "ana.teste@cliente.example";
  assertEquals(papelDoParticipante("carla.operadora@salexpress.com.br", rem), "sal_express");
  assertEquals(papelDoParticipante("bruno.colega@cliente.example", rem), "mesma_empresa");
  assertEquals(papelDoParticipante("posvendas@mg.cliente.example", rem), "mesma_empresa");
  assertEquals(papelDoParticipante("pedro.externo.teste@yahoo.com.br", rem), "outra");
});

Deno.test("papel: remetente de e-mail pessoal NÃO torna outro @gmail colega", () => {
  assertEquals(papelDoParticipante("outro@gmail.com", "cliente@gmail.com"), "outra");
  // Sal sempre é Sal, qualquer que seja o remetente
  assertEquals(papelDoParticipante("operador.teste@salexpress.com.br", "cliente@gmail.com"), "sal_express");
});

Deno.test("bloco NF 1042798: o colega aparece como MESMA EMPRESA, a operadora como SAL", () => {
  const bloco = montarBlocoParticipantes({ from: FROM_1042798, to: TO_1042798, cc: CC_1042798 });
  assertStringIncludes(bloco, "- De: Ana Paula Teste <ana.teste@cliente.example>");
  assertStringIncludes(bloco, "Carla Operadora <carla.operadora@salexpress.com.br> [SAL EXPRESS]");
  assertStringIncludes(
    bloco,
    "Bruno Simões da Silva <bruno.colega@cliente.example> [MESMA EMPRESA DO REMETENTE]",
  );
  assertStringIncludes(bloco, "Pedro Externo <pedro.externo.teste@yahoo.com.br> [OUTRA EMPRESA/PESSOA]");
});

Deno.test("bloco: sem from usa o remetente puro; sem nada diz que não veio", () => {
  const b = montarBlocoParticipantes({ remetente: "bruno.colega@cliente.example", to: TO_1042798 });
  assertStringIncludes(b, "- De: bruno.colega@cliente.example");
  assertStringIncludes(b, "[MESMA EMPRESA DO REMETENTE]");
  assertStringIncludes(b, "- Cc: (ninguém)");
  assertStringIncludes(montarBlocoParticipantes({}), "cabeçalho indisponível");
});

Deno.test("bloco: teto por linha não deixa cabeçalho gigante afogar o prompt", () => {
  const muitos = Array.from({ length: MAX_PARTICIPANTES_POR_LINHA + 5 }, (_, k) => `p${k}@cliente.com.br`).join(", ");
  const b = montarBlocoParticipantes({ from: "a@cliente.com.br", to: muitos });
  assertStringIncludes(b, "(+5 outros)");
});

// ── Menções do texto novo (sinal determinístico — segura a 56 no autônomo) ──
// Corpos com a forma dos reais (Outlook, recortados; nomes e e-mails FICTÍCIOS,
// LGPD). Quebra de linha = CRLF do Outlook.
const CRLF = String.fromCharCode(13, 10);
const CORPO_1042798 = [
  "Boa tarde,",
  "",
  "@Bruno<mailto:bruno.colega@cliente.example>, por gentileza, enviar a evidência de erro cliente " +
  "(email do cliente informando que enviou errado o CNPJ da loja / print da conversa) para não gerar RC!",
  "",
  "Não podemos aceitar a imagem abaixo como evidência de erro cliente.",
  "",
  "Aguardo.",
  "",
  "________________________________",
  "De: Carla Operadora <carla.operadora@salexpress.com.br>",
  "@Ana Paula Teste<mailto:ana.teste@cliente.example>, Aguardo a confirmação",
].join(CRLF);
const CORPO_FORTBRAS = [
  "Prezados, Boa tarde!",
  "@Diego<mailto:diego.operador@salexpress.com.br> pode seguir com a entrega parcial.",
  "@Lucas Teste da Silva<mailto:lucas.teste@outra.example> e @Gustavo Lima Teste" +
  "<mailto:gustavo.teste@outra.example> gentileza conduzir o tema.",
].join(CRLF);
const CORPO_XINIC_ASSINATURA = [
  "Diego, bom dia! Por gentileza, seguir com a entrega da carga",
  "Atenciosamente",
  "Rafael ✉<mailto:logistica@loja.example> logistica@loja.example<mailto:logistica@loja.example>",
].join(CRLF);

Deno.test("texto novo: corta o histórico citado (linha ____ / De: / Em ... escreveu:)", () => {
  assertEquals(textoNovoDaResposta(CORPO_1042798).includes("Carla"), false);
  const comEscreveu = ["oi", "Em ter., 29 de set. de 2026 às 16:03, Bruno escreveu:", "@x<mailto:a@b.com>"].join(CRLF);
  assertEquals(textoNovoDaResposta(comEscreveu), "oi");
  assertEquals(textoNovoDaResposta(null), "");
});

Deno.test("menções: só as do texto NOVO; e-mail de assinatura não é menção", () => {
  assertEquals(mencoesDoTextoNovo(CORPO_1042798), ["bruno.colega@cliente.example"]);
  assertEquals(mencoesDoTextoNovo(CORPO_XINIC_ASSINATURA), []);
  assertEquals(mencoesDoTextoNovo(CORPO_FORTBRAS).length, 3);
});

Deno.test("NF 1042798: a analista marca só o colega (mesma empresa) → só menciona quem não é da Sal", () => {
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: CORPO_1042798, operadoraNome: "CARLA" }), true);
});

Deno.test("Fortbras: marca o @Diego da Sal junto com colegas → NÃO dispara", () => {
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: CORPO_FORTBRAS, operadoraNome: "DIEGO" }), false);
});

Deno.test("sem menção (texto comum / assinatura) → NÃO dispara (comportamento de hoje)", () => {
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: CORPO_XINIC_ASSINATURA, operadoraNome: "DIEGO" }), false);
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: "a foto não mostra a recusa", operadoraNome: "CARLA" }), false);
});

Deno.test("fala com a Sal pelo nome da operadora, 'Sal Express' ou 'transportadora' → NÃO dispara", () => {
  const colega = "@Fulano<mailto:fulano@cliente.example> acompanhe.";
  assertEquals(
    soMencionaQuemNaoEDaSal({ conteudo: `Bom dia Beatriz, a foto não mostra a recusa. ${colega}`, operadoraNome: "BEATRIZ" }),
    false,
  );
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: `Pessoal da Sal Express, verifiquem. ${colega}`, operadoraNome: "X" }), false);
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: `A transportadora errou. ${colega}`, operadoraNome: null }), false);
  // nome da operadora como PEDAÇO de outra palavra não conta
  assertEquals(soMencionaQuemNaoEDaSal({ conteudo: `Analisamos. ${colega}`, operadoraNome: "ANA" }), true);
});
