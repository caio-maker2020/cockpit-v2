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
  colapsarEspacos,
  detectarCteDevolucao,
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
  assertEquals(r.sinaisNome.some((s) => s.startsWith("nome_chave_44_digitos")), true);
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

Deno.test("anexo · chave fiscal de 44 dígitos como nome é sinal válido", () => {
  const { sinais } = escolherAnexoCte([
    { filename: "31260802905424001283570020001433931001458830.pdf", mimeType: PDF },
  ]);
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
