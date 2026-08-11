// Testes do detector "cliente já pediu a devolução por e-mail" (capacidade nova
// da oc 10, learning_log f665c8f2 — Isadora). Guard anti-regressão: o ramo
// oc 10 → 54 tem 805 acertos em produção, então os falsos positivos abaixo
// valem tanto quanto os positivos.
// Rodar: deno test supabase/functions/_shared/email-devolucao-solicitada.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectarDevolucaoNasMensagens,
  detectarDevolucaoSolicitada,
} from "./email-devolucao-solicitada.ts";

// --------------------------- DEVE detectar ---------------------------------

Deno.test("ÂNCORA NF 50540 — e-mail real que o time atendeu com 44", () => {
  const d = detectarDevolucaoSolicitada(
    "Boa tarde. Solicito a devolução dessas NF 50661 / 50660 / 50659 / 50540 / 50539. LOCAL PARA ENTREGA : AV AMERICO VESPUCIO 1260 . Att",
  );
  assert(d.solicitada, "deveria detectar o pedido de devolução");
  assert(d.trecho?.includes("Solicito a devolução"), `trecho inesperado: ${d.trecho}`);
});

Deno.test("formas diretas de autorização", () => {
  const frases = [
    "Pode devolver a mercadoria.",
    "Podem devolver os volumes recusados.",
    "Autorizo a devolução.",
    "Autorizamos a devolução da nota.",
    "Favor devolver ao remetente.",
    "Gentileza proceder com a devolução.",
    "Está liberado para devolução.",
    "Solicitamos a devolução da mercadoria.",
    "Peço a devolução dos volumes.",
    "Prossigam com a devolução.",
  ];
  for (const f of frases) {
    assert(detectarDevolucaoSolicitada(f).solicitada, `deveria detectar: "${f}"`);
  }
});

Deno.test("acento e caixa não atrapalham", () => {
  assert(detectarDevolucaoSolicitada("SOLICITO A DEVOLUÇÃO DA NF").solicitada);
  assert(detectarDevolucaoSolicitada("solicito a devolucao da nf").solicitada);
});

Deno.test("acha a frase mesmo no meio de e-mail longo", () => {
  const d = detectarDevolucaoSolicitada(
    "Prezados, bom dia.\nSegue em anexo o comprovante.\nApós análise interna, autorizo a devolução dos 2 volumes.\nQualquer dúvida estamos à disposição.\nAtt, Financeiro",
  );
  assert(d.solicitada);
  assert(d.trecho?.includes("autorizo a devolução"), `trecho: ${d.trecho}`);
});

// --------------------------- NÃO deve detectar ------------------------------

Deno.test("pergunta não é decisão", () => {
  assertEquals(detectarDevolucaoSolicitada("Podemos devolver essa carga?").solicitada, false);
  assertEquals(detectarDevolucaoSolicitada("Vocês autorizam a devolução?").solicitada, false);
});

Deno.test("ordem dirigida a TERCEIRO não é decisão do pagador", () => {
  assertEquals(
    detectarDevolucaoSolicitada("Favor orientar o cliente a emitir NFD para devolução.").solicitada,
    false,
  );
  assertEquals(
    detectarDevolucaoSolicitada("Orientem o destinatário a solicitar a devolução.").solicitada,
    false,
  );
});

Deno.test("negação nunca vira autorização", () => {
  assertEquals(detectarDevolucaoSolicitada("Não autorizo a devolução.").solicitada, false);
  assertEquals(detectarDevolucaoSolicitada("Não autorizamos a devolução dessa nota.").solicitada, false);
  assertEquals(detectarDevolucaoSolicitada("Segue sem devolução por enquanto.").solicitada, false);
});

Deno.test("adiamento / intenção futura não conta", () => {
  const frases = [
    "Vamos verificar a devolução e retornamos.",
    "Aguardando definição sobre a devolução.",
    "Assim que decidirmos sobre a devolução eu aviso.",
    "Caso seja necessário podemos autorizar a devolução depois.",
    "Estamos verificando a possibilidade de devolução.",
  ];
  for (const f of frases) {
    assertEquals(detectarDevolucaoSolicitada(f).solicitada, false, `NÃO deveria detectar: "${f}"`);
  }
});

Deno.test("relato de fato passado não é comando", () => {
  assertEquals(
    detectarDevolucaoSolicitada("A transportadora devolveu o volume ontem.").solicitada,
    false,
  );
  assertEquals(detectarDevolucaoSolicitada("A carga foi devolvida na semana passada.").solicitada, false);
});

Deno.test("auto-reply institucional não conta", () => {
  assertEquals(
    detectarDevolucaoSolicitada(
      "Mensagem automática: este e-mail é destinado exclusivamente ao setor de devolução.",
    ).solicitada,
    false,
  );
});

Deno.test("entrada vazia / nula é segura", () => {
  for (const v of [null, undefined, "", "   "]) {
    assertEquals(detectarDevolucaoSolicitada(v).solicitada, false);
  }
});

Deno.test("texto sem nada a ver não dispara", () => {
  assertEquals(
    detectarDevolucaoSolicitada("Bom dia, segue o comprovante de entrega assinado. Obrigado.").solicitada,
    false,
  );
});

// --------------------------- varredura de mensagens -------------------------

Deno.test("detectarDevolucaoNasMensagens devolve a primeira detecção com a data", () => {
  const r = detectarDevolucaoNasMensagens([
    { conteudo: "Bom dia, tudo bem?", recebido_em: "2026-08-03T10:00:00Z" },
    { conteudo: "Solicito a devolução da NF 50540.", recebido_em: "2026-08-02T09:00:00Z" },
    { conteudo: "Autorizo a devolução também.", recebido_em: "2026-08-01T08:00:00Z" },
  ]);
  assert(r.solicitada);
  assertEquals(r.recebido_em, "2026-08-02T09:00:00Z");
});

Deno.test("detectarDevolucaoNasMensagens sem detecção devolve vazio", () => {
  const r = detectarDevolucaoNasMensagens([
    { conteudo: "Segue comprovante.", recebido_em: "2026-08-03T10:00:00Z" },
    { conteudo: null, recebido_em: null },
  ]);
  assertEquals(r.solicitada, false);
  assertEquals(r.recebido_em, null);
});
