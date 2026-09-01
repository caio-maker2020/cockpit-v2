// Guard INV-123 (decisões do Caio 01/09): detector do CT-e de devolução da
// MARIA EDUARDA. Calibrado em e-mails REAIS — 3 threads exportadas do Gmail
// (Dellas NF 195392, Ícaro NF 10570314, AGV NF 8590) + a do vídeo (AGV NF
// 239883). Não inventar fraseado: se aparecer forma nova em produção, entra
// aqui como caso ANTES de mexer nas regex.
//
// A regra que este teste protege (decisão nº 9): nível A monta a proposta de
// oc 44; nível B APENAS sinaliza. Rebaixar um caso B pra A é dar autonomia com
// evidência indireta — foi o que a revisão adversarial apontou como caminho de
// 44 indevida no SSW.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  apenasFalaNova,
  chaveFiscalDoNome,
  colapsarEspacos,
  detectarCteDevolucao,
  MODELO_CTE,
  MODELO_NFE,
  ehRemetenteQueDispara,
  escolherAnexoCte,
  normalizar,
  temFraseDeEntrega,
  temPedidoDeDevolucao,
} from "./devolucao-cte-detector.ts";

const PDF = "application/pdf";

// ---------------------------------------------------------------------------
// NÍVEL A — a frase de entrega está na PRÓPRIA mensagem do anexo
// ---------------------------------------------------------------------------

Deno.test("A · Dellas NF 195392 (real): 'Em anexo Cte de devolução'", () => {
  const r = detectarCteDevolucao({
    assunto: "Recusa Total — NF 195392",
    remetente: "fernanda.ramos@dellasmg.com.br",
    corpo:
      "Boa tarde Maria Eduarda,\nFavor prosseguir com a devolução, retornar com as mercadorias para a Dellas Contagem.\nEm anexo Cte de devolução.\nRessalva do cliente:",
    anexos: [{ filename: "CTE DEV. NF 195392.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, 0);
});

Deno.test("A · Ícaro NF 10570314 (real, thread NOVA de 1 msg): 'Segue CTE de devolução'", () => {
  const r = detectarCteDevolucao({
    assunto: "NF 10570314",
    remetente: "andre@icaroexpress.com",
    corpo:
      "Boa tarde Maria,\nSeguir com devolução da NF em assunto, foi recusada pelo cliente. Segue CTE de devolução.\nAtt,",
    anexos: [{ filename: "dacte-55657992.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, 0);
});

Deno.test("A · vídeo AGV NF 239883 (real): 'Segue Cte de devolução.'", () => {
  const r = detectarCteDevolucao({
    assunto: "RE: Recusa Total - NF 239883 — AGV LOG SA VINHEDO",
    remetente: "geovana.ribeiro@agv.com.br",
    corpo: "Bom dia,\nMaria Eduarda Ferreira\nSegue Cte de devolução.\nGeovana Ribeiro",
    anexos: [{ filename: "60022.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, 0);
});

// --- Regressões achadas na OBSERVAÇÃO do histórico real (01/09) -------------
// Modo sombra sobre 7.258 e-mails inbound / 1.128 conversas. Estes 2 casos
// eram FALSO NEGATIVO: CT-e de devolução real que o detector ignorava com
// motivo `pdf_sem_evidencia_de_devolucao`. Duas causas independentes.

Deno.test("A · regressão FN-1: frase QUEBRADA em duas linhas ('Segue Cte de\\ndevolução')", () => {
  // Real, Dellas 26/08, anexo `CTE DEV. NF 196128.pdf`. O corpo do Gmail vem
  // quebrado em ~78 colunas e a quebra caiu entre "de" e "devolução"; as
  // janelas `[^.\n!?]{0,40}` não atravessam \n. Corrigido por colapsarEspacos.
  const r = detectarCteDevolucao({
    assunto: "Re: Recusa por falta de volumes — NF 196128 — LOCMINAS TRANSP B.",
    remetente: "fernanda.ramos@dellasmg.com.br",
    corpo:
      "Boa tarde !\n\n@Maria Eduarda Ferreira <maria.ferreira@salexpress.com.br>  Segue Cte de\ndevolução .\n\n[image: image.png]\n",
    anexos: [{ filename: "CTE DEV. NF 196128.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "A", "quebra de linha no meio da frase não pode cegar o detector");
  assertEquals(r.idxAnexo, 0);
});

Deno.test("A · regressão FN-2: ordem 'devolução … segue anexo CT-e'", () => {
  // Real, AGV 31/08, anexo `60113.pdf`. Falhava mesmo sem quebra de linha:
  // "devolu" vem ANTES do verbo e do CT-e. Corrigido por RE_ENTREGA_CTE_DEVOLU_PRIMEIRO.
  const r = detectarCteDevolucao({
    assunto: "RE: Recusa Total — NF 461274 — AGV LOG SA VINHEDO",
    remetente: "diogo.moreira@agv.com.br",
    corpo:
      "Olá, bom dia!\n\n@Maria Eduarda<mailto:maria.ferreira@salexpress.com.br>\nSeguiremos com devolução, segue anexo CT-e, poderiam nos informar previsão de retorno, por favor?\n",
    anexos: [{ filename: "60113.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, 0);
});

Deno.test("A · variantes de fraseado medidas no histórico real", () => {
  for (
    const t of [
      "segue ct-e de devolucao da nf 40120.", // AGV 14/07
      "segue ct-e para retorno da devolucao.", // AGV 17/08
      "segue cte devolucao referente a nf 21263.", // AGV 28/08
      "segue cte devolucao, em anexo.", // AGV 10/08
      "segue cte para devolucao.", // AGV 28/08
      "segue cte, favor priorizar devolucao.", // Bomi 27/08
      "seguiremos com devolucao, segue anexo ct-e", // AGV 31/08 (FN-2)
      "segue cte de devolucao .", // Dellas 26/08 (FN-1, já colapsado)
    ]
  ) {
    assertEquals(temFraseDeEntrega(t), true, `deveria reconhecer: ${t}`);
  }
});

Deno.test("NEG · o interrogativo NÃO virou A com o padrão novo (fim de frase corta)", () => {
  // A janela não atravessa '.', então "…processos de devolução. Por gentileza,
  // poderiam emitir o CT-e de Devolução abaixo?" continua sendo PEDIDO.
  const t =
    "por gentileza, seguir com os processos de devolucao. por gentileza, poderiam emitir o ct-e de devolucao abaixo? 5853456.";
  assertEquals(temFraseDeEntrega(t), false);
  assertEquals(temPedidoDeDevolucao(t), true);
});

Deno.test("colapsarEspacos junta a frase sem juntar frases distintas", () => {
  assertEquals(colapsarEspacos("segue cte de\ndevolucao"), "segue cte de devolucao");
  // ponto preservado: continua separando as duas orações
  assertEquals(colapsarEspacos("devolucao.\npoderiam emitir o cte?"), "devolucao. poderiam emitir o cte?");
});

// ---------------------------------------------------------------------------
// NÍVEL B — prova indireta. Só sinaliza; NUNCA monta ação.
// ---------------------------------------------------------------------------

Deno.test("B · AGV NF 8590 (real): msg do anexo diz só 'Segue,'; prova 8 msgs antes", () => {
  const r = detectarCteDevolucao(
    {
      assunto: "Atualização NF 8590",
      remetente: "edson.filho@agv.com.br",
      corpo: "Bom dia!\n@Gabriel\nSegue,\nEdson Filho",
      anexos: [
        { filename: "31260802905424001283570020001433931001458830.pdf", mimeType: PDF },
      ],
    },
    [
      "Prezados, boa tarde! @Maria, poderia nos atualizar sobre a NF em assunto?",
      "@CSE.Ourofino, mercadoria recusada, estamos em contato com o DT.",
      "Boa tarde! @Maria Eduarda Ferreira, devolução autorizada, quando podem devolver? N° do Pré Cte 145883",
      "Boa tarde! gentileza emitir o pré: 145883",
    ],
  );
  assertEquals(r.nivel, "B", "AGV é B: a mensagem do anexo não diz que o anexo é o CT-e");
  assertEquals(r.idxAnexo, 0);
  // O nome do arquivo é uma chave fiscal de 44 dígitos — único sinal disponível.
  // E o modelo dela é 57, então o sinal já vem qualificado como CT-e.
  assertEquals(r.sinaisNome.some((s) => s.startsWith("chave44_modelo57_cte")), true);
});

Deno.test("B · 'poderiam emitir o CT-e de Devolução?' COM PDF anexo — pedido, não entrega", () => {
  const r = detectarCteDevolucao({
    assunto: "NF 239883",
    remetente: "leticya.rodrigues@agv.com.br",
    corpo:
      "Bom dia,\nPor gentileza, seguir com os processos de devolução.\nPor gentileza, poderiam emitir o CT-e de Devolução abaixo?\n5853456.",
    anexos: [{ filename: "planilha-pedido.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "B", "interrogativo pedindo que NÓS emitamos nunca pode ser A");
});

Deno.test("B · pedido na própria msg + PDF, sem dizer que o anexo é o CT-e", () => {
  const r = detectarCteDevolucao({
    assunto: "NF 195392",
    remetente: "fernanda.ramos@dellasmg.com.br",
    corpo: "Boa tarde! Favor prosseguir com a devolução, retornar com as mercadorias.",
    anexos: [{ filename: "documento.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, "B");
});

// ---------------------------------------------------------------------------
// NEGATIVOS — fail-closed
// ---------------------------------------------------------------------------

Deno.test("NEG · remetente interno @salexpress.com.br nunca dispara", () => {
  const r = detectarCteDevolucao({
    remetente: "maria.ferreira@salexpress.com.br",
    corpo: "Em anexo Cte de devolução.",
    anexos: [{ filename: "CTE DEV.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, null);
  assertEquals(r.motivos[0]?.startsWith("remetente_nao_dispara"), true);
});

Deno.test("NEG · domínio SSW e prefixo de robô nunca disparam", () => {
  assertEquals(ehRemetenteQueDispara("sswemail@ssw.inf.br"), false);
  assertEquals(ehRemetenteQueDispara("noreply@agv.com.br"), false);
  assertEquals(ehRemetenteQueDispara("notificacao@icaroexpress.com"), false);
  assertEquals(ehRemetenteQueDispara("fernanda.ramos@dellasmg.com.br"), true);
});

Deno.test("NEG · linha CITADA ('> Em anexo Cte de devolução') não dispara", () => {
  const r = detectarCteDevolucao({
    remetente: "fernanda.ramos@dellasmg.com.br",
    corpo: "Obrigada!\n> Em anexo Cte de devolução.\n> Favor prosseguir com a devolução",
    anexos: [{ filename: "comprovante.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, null);
});

Deno.test("NEG · bloco de encaminhamento (De:/Enviado:/Assunto:) é cortado", () => {
  const r = detectarCteDevolucao({
    remetente: "ana.santos@agv.com.br",
    corpo:
      "Prezados, bom dia!\nPSC.\nDe: Fernanda Ramos <fernanda.ramos@dellasmg.com.br>\nEnviado: 11 de agosto de 2026 15:04\nAssunto: RE: NF 195392\nEm anexo Cte de devolução.",
    anexos: [{ filename: "planilha.pdf", mimeType: PDF }],
  });
  assertEquals(r.nivel, null);
});

Deno.test("NEG · anexo JPEG (foto de avaria real da thread AGV) não é candidato", () => {
  const r = detectarCteDevolucao({
    remetente: "ana.santos@agv.com.br",
    corpo: "Boa tarde. Conforme relato do DT houve um volume avariado, segue em anexo a imagem.",
    anexos: [{ filename: "WhatsApp Image 2026-07-30 at 12.46.20.jpeg", mimeType: "image/jpeg" }],
  });
  assertEquals(r.nivel, null);
  assertEquals(r.motivos.includes("sem_anexo_pdf"), true);
});

Deno.test("NEG · PDF sem nenhuma evidência de devolução", () => {
  const r = detectarCteDevolucao(
    {
      remetente: "ana.santos@agv.com.br",
      corpo: "Boa tarde! Segue comprovante de entrega assinado.",
      anexos: [{ filename: "comprovante.pdf", mimeType: PDF }],
    },
    ["Poderia nos atualizar sobre a NF em assunto?"],
  );
  assertEquals(r.nivel, null);
});

// ---------------------------------------------------------------------------
// Escolha do anexo — nunca adivinhar
// ---------------------------------------------------------------------------

Deno.test("anexo · 2 PDFs com sinal nos DOIS nomes = ambíguo, a Maria escolhe", () => {
  const r = detectarCteDevolucao({
    remetente: "fernanda.ramos@dellasmg.com.br",
    corpo: "Segue CTE de devolução.",
    anexos: [
      { filename: "CTE DEV 1.pdf", mimeType: PDF },
      { filename: "CTE DEV 2.pdf", mimeType: PDF },
    ],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, null, "ambíguo tem de devolver null, nunca o primeiro por sorte");
});

Deno.test("anexo · 2 PDFs, só 1 com sinal de nome = escolhe o com sinal", () => {
  const { idx } = escolherAnexoCte([
    { filename: "assinatura.pdf", mimeType: PDF },
    { filename: "dacte-999.pdf", mimeType: PDF },
  ]);
  assertEquals(idx, 1);
});

// ---------------------------------------------------------------------------
// Chave fiscal: o MODELO distingue CT-e (57) de NFD (55) — determinístico.
// Amostras REAIS de NFD que o Caio mandou em 2026-09-01, com a chave lida
// DENTRO do PDF. Todas as três são NF-e modelo 55 com DV válido.
// ---------------------------------------------------------------------------

const NFD_PORT = "32260708228010000433550020001869001877093887"; // 186900.pdf
const NFD_RACOES = "31260703785317000179550010003864291104170942"; // LAMINA_PROTOCOLO…
const NFD_GREENCARE = "35260736940761000170550010000093061869782350"; // NFD_09306…
const CTE_AGV = "35260702905424010355570010000005721000748309"; // real, caixa da Maria

Deno.test("chave · as 3 NFD reais são modelo 55, o CT-e real é 57", () => {
  for (const [nome, ch] of [
    ["NFD PORT->LEXMARK", NFD_PORT],
    ["NFD RACOES->OUROFINO", NFD_RACOES],
    ["NFD GREENCARE->DROGARIA ARAUJO", NFD_GREENCARE],
  ] as const) {
    const r = chaveFiscalDoNome(`${ch}.pdf`);
    assertEquals(r?.modelo, MODELO_NFE, `${nome} deveria ser NF-e (DV precisa fechar)`);
  }
  assertEquals(chaveFiscalDoNome(`${CTE_AGV}.pdf`)?.modelo, MODELO_CTE);
});

Deno.test("chave · DV inválido não é usado pra decidir modelo (fail-closed)", () => {
  // mesma chave da NFD com o último dígito trocado
  const quebrada = NFD_GREENCARE.slice(0, 43) + (NFD_GREENCARE[43] === "0" ? "1" : "0");
  assertEquals(chaveFiscalDoNome(`${quebrada}.pdf`), null);
});

Deno.test("anexo · NFD sozinha NUNCA é escolhida como o CT-e", () => {
  // Anexar a NFD no lugar do CT-e é subir documento fiscal errado no SSW.
  const { idx, sinais } = escolherAnexoCte([
    { filename: `${NFD_GREENCARE}.pdf`, mimeType: PDF },
  ]);
  assertEquals(idx, null);
  assertEquals(sinais.some((s) => s.includes("modelo55_nfe_nao_e_cte")), true);
});

Deno.test("anexo · CT-e (57) + NFD (55) juntos: escolhe o 57 sem hesitar", () => {
  // Medido no histórico: NFD chega junto com o CT-e (29/07 e 17/08).
  const { idx } = escolherAnexoCte([
    { filename: `${NFD_GREENCARE}.pdf`, mimeType: PDF },
    { filename: `${CTE_AGV}.pdf`, mimeType: PDF },
  ]);
  assertEquals(idx, 1);
});

Deno.test("anexo · o único AMBÍGUO do histórico agora resolve pelo modelo", () => {
  // 14/07, gleicia.silva@agv.com.br: 3 PDFs, dois com sinal de PALAVRA no nome
  // (a chave 57 e "NF devolução Pearson") ⇒ antes devolvia null.
  const r = detectarCteDevolucao({
    assunto: "RE: Pedido de: COOPERATIVA MISTA DOS PRODUTORES RUR NF 74665",
    remetente: "gleicia.silva@agv.com.br",
    corpo: "Segue Ct-e de devolução da NF 40120. Por gentileza confirmar.",
    anexos: [
      { filename: `${CTE_AGV}.pdf`, mimeType: PDF },
      { filename: "NF devolução Pearson (1).pdf", mimeType: PDF },
      { filename: "ressalva.pdf", mimeType: PDF },
    ],
  });
  assertEquals(r.nivel, "A");
  assertEquals(r.idxAnexo, 0, "a chave modelo 57 vence o sinal de palavra");
});

Deno.test("anexo · dois CT-e (57) na mesma mensagem = ambíguo, a Maria escolhe", () => {
  const { idx } = escolherAnexoCte([
    { filename: `${CTE_AGV}.pdf`, mimeType: PDF },
    { filename: "35260802905424001879570010000600821058612812.pdf", mimeType: PDF },
  ]);
  assertEquals(idx, null);
});

Deno.test("anexo · nome enganoso NÃO manda: LAMINA_PROTOCOLO… é NFD, não folheto", () => {
  // Caso real: o nome sugere folheto de marketing e o conteúdo é DANFE de
  // devolução. Prova de que nome de arquivo não é critério.
  const nomeEnganoso =
    "374479af-94c4-4ed5-b016-df73b0cac499-2026. LAMINA_PROTOCOLO_LEITEIRO_COMERCIAL_A4_0426_OF03_ID3298 (1).pdf";
  const { idx } = escolherAnexoCte([
    { filename: nomeEnganoso, mimeType: PDF },
    { filename: `${CTE_AGV}.pdf`, mimeType: PDF },
  ]);
  assertEquals(idx, 1, "a chave 57 decide; o nome sem chave não entra na disputa");
});

Deno.test("anexo · chave de 44 dígitos com DV válido vira sinal QUALIFICADO pelo modelo", () => {
  const { idx, sinais } = escolherAnexoCte([
    { filename: "31260802905424001283570020001433931001458830.pdf", mimeType: PDF },
  ]);
  assertEquals(idx, 0);
  assertEquals(sinais.some((s) => s.startsWith("chave44_modelo57_cte")), true);
});

Deno.test("anexo · 44 dígitos com DV QUEBRADO cai no sinal genérico (não decide modelo)", () => {
  // Comportamento antigo preservado pra chave malformada: sinal genérico, sem
  // afirmar modelo nenhum. Fail-closed: não inventa que é CT-e nem que é NF-e.
  const base = "31260802905424001283570020001433931001458830";
  const quebrada = base.slice(0, 43) + (base[43] === "0" ? "1" : "0");
  const { idx, sinais } = escolherAnexoCte([{ filename: `${quebrada}.pdf`, mimeType: PDF }]);
  assertEquals(idx, 0);
  assertEquals(sinais.some((s) => s.startsWith("nome_chave_44_digitos")), true);
});

// ---------------------------------------------------------------------------
// Funções puras auxiliares
// ---------------------------------------------------------------------------

Deno.test("normalizar tira acento e caixa", () => {
  assertEquals(normalizar("DEVOLUÇÃO Ct-E"), "devolucao ct-e");
});

Deno.test("apenasFalaNova corta citação e encaminhamento", () => {
  assertEquals(apenasFalaNova("ok\n> citado\nDe: x"), "ok");
});

Deno.test("fraseados reais de ENTREGA são reconhecidos", () => {
  for (
    const t of [
      "em anexo cte de devolucao.",
      "segue cte de devolucao.",
      "segue ct-e de devolucao",
      "segue em anexo o cte de devolucao",
      "cte de devolucao em anexo",
    ]
  ) {
    assertEquals(temFraseDeEntrega(t), true, `deveria reconhecer: ${t}`);
  }
});

Deno.test("fraseados reais de PEDIDO são reconhecidos", () => {
  for (
    const t of [
      "favor prosseguir com a devolucao",
      "seguir com devolucao da nf em assunto",
      "seguir com os processos de devolucao",
      "devolucao autorizada, quando podem devolver?",
      "retornar com as mercadorias para a dellas contagem",
    ]
  ) {
    assertEquals(temPedidoDeDevolucao(t), true, `deveria reconhecer: ${t}`);
  }
});
