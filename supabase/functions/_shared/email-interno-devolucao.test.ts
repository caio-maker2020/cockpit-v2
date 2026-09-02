// Guard INV-125 (decisão nº 10 do Caio, 01/09): o e-mail ao setor de Devolução
// é mensagem NOVA e SEPARADA, fora da conversa do cliente e fora de
// `cards_emails_outbound`.
//
// Os 3 estragos que este guard impede, todos medidos no código:
//   1. `cobrar-cliente-aguardando` cobra em REPLY do último outbound do card
//      ⇒ a cobrança do CT-e iria pro Leonel;
//   2. o próximo e-mail ao cliente cairia na conversa interna;
//   3. a resposta do Leonel casaria por thread e viraria "CLIENTE RESPONDEU".
//
// Rodar com: deno test --allow-read (o último teste lê o próprio fonte).
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CLAIM_VENCE_MS,
  ehClaimVencido,
  ehEnvioConcluido,
  HEADER_INTERNO,
  montarEmailInternoDevolucao,
  motivoAbortoAnexo,
  motivoAbortoOrdem,
  PREFIXO_CLAIM,
} from "./email-interno-devolucao.ts";

// ---------------------------------------------------------------------------
// Assunto e corpo — não inventar formato: o setor já filtra a caixa por ele
// ---------------------------------------------------------------------------

Deno.test("assunto segue o padrão que a operadora já usa à mão (vídeo, NF 239883)", () => {
  const { subject } = montarEmailInternoDevolucao({ nf: "239883", ctrc: "SSP912725-9" });
  assertEquals(subject, "Devolução - NF 239883");
});

Deno.test("corpo traz NF e o CTRC onde o CT-e foi anexado", () => {
  const { texto } = montarEmailInternoDevolucao({
    nf: "239883",
    ctrc: "SSP912725-9",
    nomeCliente: "AGV LOG SA VINHEDO",
    quantidadeVolumes: 2,
    motivo: "desacordo com o pedido",
    filial: "BHE",
    nomeArquivoCte: "60022.pdf",
  });
  assertStringIncludes(texto, "NF: 239883");
  assertStringIncludes(texto, "CTRC onde o CT-e foi anexado: SSP912725-9");
  assertStringIncludes(texto, "Volumes a devolver: 2");
  assertStringIncludes(texto, "Unidade onde estão os volumes: BHE");
  assertStringIncludes(texto, "60022.pdf");
});

Deno.test("campos ausentes simplesmente não aparecem (sem 'undefined' no corpo)", () => {
  const { texto } = montarEmailInternoDevolucao({ nf: "1", ctrc: "X-1" });
  assertEquals(texto.includes("undefined"), false);
  assertEquals(texto.includes("null"), false);
  assertEquals(texto.includes("Volumes a devolver"), false);
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED do anexo — o coração deste módulo
// ---------------------------------------------------------------------------

const OK = { meta_id: "a1", content_base64: "JVBERi0x", filename: "CTE DEV.pdf" };

Deno.test("anexo correto ⇒ não aborta", () => {
  assertEquals(motivoAbortoAnexo("a1", [OK]), null);
});

Deno.test("ABORTA quando o anexo não carregou — é o caso do 'em anexo' sem anexo", () => {
  // carregarAnexosParaEnvio pula anexo ausente com `continue` SILENCIOSO e
  // devolve []. Sem este aborto o e-mail sai dizendo "em anexo" vazio.
  const m = motivoAbortoAnexo("a1", []);
  assertEquals(m?.startsWith("anexo_nao_carregou:a1"), true);
});

Deno.test("ABORTA quando o ciclo não tem anexo nenhum", () => {
  assertEquals(motivoAbortoAnexo(null, []), "ciclo_sem_cte_anexo_id");
  assertEquals(motivoAbortoAnexo(undefined, [OK]), "ciclo_sem_cte_anexo_id");
});

Deno.test("ABORTA quando veio arquivo TROCADO (id diferente do esperado)", () => {
  const m = motivoAbortoAnexo("a1", [{ ...OK, meta_id: "OUTRO" }]);
  assertEquals(m?.startsWith("anexo_trocado:"), true);
});

Deno.test("ABORTA com conteúdo vazio ou sem nome — nunca manda arquivo inútil", () => {
  assertEquals(motivoAbortoAnexo("a1", [{ ...OK, content_base64: "" }]), "anexo_vazio:a1");
  assertEquals(motivoAbortoAnexo("a1", [{ ...OK, filename: "  " }]), "anexo_sem_nome:a1");
});

Deno.test("ABORTA se vier mais de um arquivo pra um id", () => {
  const m = motivoAbortoAnexo("a1", [OK, { ...OK, filename: "outro.pdf" }]);
  assertEquals(m?.startsWith("anexo_ambiguo:2"), true);
});

// ---------------------------------------------------------------------------
// Ordem do fluxo — espelha o CHECK devcte_email_depois_da_44 da mig 373
// ---------------------------------------------------------------------------

Deno.test("e-mail NUNCA sai antes da oc 44", () => {
  assertEquals(
    motivoAbortoOrdem({ oc44_lancada_em: null, cte_convertido_ok: true }),
    "oc44_ainda_nao_lancada",
  );
});

Deno.test("e-mail NUNCA sai com conversão do CT-e não confirmada (fail-closed, decisão nº 4)", () => {
  for (const v of [null, false, undefined]) {
    assertEquals(
      motivoAbortoOrdem({ oc44_lancada_em: "2026-09-01T12:00:00Z", cte_convertido_ok: v }),
      "conversao_do_cte_nao_confirmada",
    );
  }
});

Deno.test("44 lançada + conversão ok ⇒ liberado", () => {
  assertEquals(
    motivoAbortoOrdem({ oc44_lancada_em: "2026-09-01T12:00:00Z", cte_convertido_ok: true }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Idempotência própria — `verificarEmailJaEnviado` é CEGO aqui, porque procura
// em cards_emails_outbound e este e-mail nunca está lá
// ---------------------------------------------------------------------------

Deno.test("id real do Gmail conta como envio concluído; reivindicação não", () => {
  assertEquals(ehEnvioConcluido("18f2a9c1d3e4b5a6"), true);
  assertEquals(ehEnvioConcluido(`${PREFIXO_CLAIM}2026-09-01T12:00:00.000Z`), false);
  assertEquals(ehEnvioConcluido(null), false);
  assertEquals(ehEnvioConcluido(""), false);
});

Deno.test("reivindicação fresca NÃO vence; velha vence (processo morreu)", () => {
  const agora = Date.parse("2026-09-01T12:00:00.000Z");
  const fresca = `${PREFIXO_CLAIM}${new Date(agora - 60_000).toISOString()}`;
  const velha = `${PREFIXO_CLAIM}${new Date(agora - CLAIM_VENCE_MS - 1000).toISOString()}`;
  assertEquals(ehClaimVencido(fresca, agora), false);
  assertEquals(ehClaimVencido(velha, agora), true);
});

Deno.test("id real nunca é tratado como reivindicação vencida", () => {
  assertEquals(ehClaimVencido("18f2a9c1d3e4b5a6", Date.now()), false);
  assertEquals(ehClaimVencido(null, Date.now()), false);
});

Deno.test("reivindicação malformada é considerada órfã (não trava o ciclo pra sempre)", () => {
  assertEquals(ehClaimVencido(`${PREFIXO_CLAIM}nao-e-data`, Date.now()), true);
});

// ---------------------------------------------------------------------------
// GUARD MECÂNICO do INV-125 — lê o próprio fonte.
// Memória não trava regressão de código; isto trava.
// ---------------------------------------------------------------------------

Deno.test("INV-125: o módulo NUNCA menciona cards_emails_outbound", async () => {
  const fonte = await Deno.readTextFile(
    new URL("./email-interno-devolucao.ts", import.meta.url),
  );
  // O cabeçalho EXPLICA por que não usa a tabela — as menções em comentário são
  // legítimas. O que não pode existir é chamada de verdade.
  const codigo = fonte
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  assertEquals(
    codigo.includes("cards_emails_outbound"),
    false,
    "e-mail interno em cards_emails_outbound = cobrança vai pro Leonel + resposta dele vira 'cliente respondeu'",
  );
});

Deno.test("INV-124: o módulo NUNCA chama finalizarAnexosPosEnvio", async () => {
  const fonte = await Deno.readTextFile(
    new URL("./email-interno-devolucao.ts", import.meta.url),
  );
  const codigo = fonte
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
  assertEquals(
    codigo.includes("finalizarAnexosPosEnvio"),
    false,
    "ela apaga o arquivo do bucket e marca deletado_em — o CT-e é prova fiscal de ciclo aberto",
  );
  assertStringIncludes(codigo, "preservar: true");
});

Deno.test("decisão nº 10: envia com threadId null (conversa NOVA) e header interno", async () => {
  const fonte = await Deno.readTextFile(
    new URL("./email-interno-devolucao.ts", import.meta.url),
  );
  // `threadId: null` é o que faz o Gmail abrir conversa NOVA em vez de responder
  // dentro da thread do cliente.
  assertStringIncludes(fonte, "threadId: null");
  // O header vai pela CONSTANTE, não pelo literal — por isso a busca é pelo
  // identificador. O valor em si é conferido no assert seguinte.
  assertStringIncludes(fonte, "extraHeaders: { [HEADER_INTERNO]");
  assertEquals(HEADER_INTERNO, "X-Cockpit-Interno");
});
