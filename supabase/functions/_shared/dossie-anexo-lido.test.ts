// =============================================================================
// INV-154 (Carlos 2026-09-15, ancora NF 431734) — o agente LE o conteudo do
// anexo do cliente, enxerga anexo de mensagem ANTERIOR do card, e o que ele le
// CHEGA no campo Instrucao do SSW.
//
// ANTES deste guard: interpretador-resposta-cliente/index.ts:334-342 entregava
// ao modelo so "filename, mime_type, size_bytes" (o CONTEUDO nunca era lido) e
// filtrava .eq("message_inbox_id", body.message_id) — anexo de mensagem
// anterior era invisivel. Resultado: descricao/valor so eram reconhecidos
// quando ESCRITOS NO CORPO; dentro de um arquivo ficavam ausentes, o dossie
// ficava incompleto, o to-do nascia com gate_oc33.bloqueada=true e a trava da
// RPC aprovar_e_executar recusava a oc 33.
//
// Ancora: NF 431734 — o PDF "NFE-433174 (1).pdf" (a NF de ressarcimento, tem o
// valor) chegou em 2026-08-07; a resposta reprocessada em 2026-09-10 so trouxe
// PNGs; o dossie segue com valor.presente=false ate hoje.
//
// PROVA DO GUARD (obrigatoria — teste que passa nos dois lados nao trava nada):
//   git stash && deno test --no-check --allow-all \
//     supabase/functions/_shared/dossie-anexo-lido.test.ts
//   ESPERADO NA MASTER: os testes 1, 2, 4 e 5 FALHAM. O 3 e o 6 sao de
//   compatibilidade e podem passar dos dois lados.
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  avaliarDossie,
  dossieVazio,
  mergeEvidencia,
  montarEvidenciasRecebidas,
  montarTextoDescricaoValor,
  ROTULO_EVIDENCIA,
} from "./extravio-parcial-dossie.ts";

/** O PDF que chegou em 07/08 e carrega o valor (vivo no balde, 105023 bytes). */
const PDF_ANTIGO = {
  filename: "NFE-433174 (1).pdf",
  mime_type: "application/pdf",
  size_bytes: 105023,
  message_inbox_id: "903c4a4f-bcce-4466-b7cf-1c381af6f214",
  gmail_message_id: "gmail-07-08",
  gmail_thread_id: "thread-431734",
  operador_id: "op-que-recebeu-07-08",
  visto_em: "2026-08-07T19:36:54.594Z",
};

/** A mensagem que esta sendo lida AGORA (reprocessada em 10/09, so PNG). */
const REF_ATUAL = {
  message_inbox_id: "979f5606-7e8a-4399-873b-5fea28f3a584",
  gmail_message_id: "gmail-10-09",
  gmail_thread_id: "thread-431734",
  operador_id: "op-que-recebeu-10-09",
  visto_em: "2026-09-10T20:51:30.204Z",
};

const OPTS_ATUAIS = { exato: true, idMensagemAtual: REF_ATUAL.message_inbox_id };

Deno.test("INV-154 (1): evidencia de anexo ANTIGO carrega a procedencia DELE", () => {
  const r = montarEvidenciasRecebidas(
    { valor: { fonte: "anexo", anexo_filename: "NFE-433174 (1).pdf", texto_extraido: "R$ 1.488,00" } },
    [PDF_ANTIGO],
    "",
    REF_ATUAL,
    OPTS_ATUAIS,
  );
  assert(r.valor != null, "o anexo antigo tem de virar evidencia");
  // Sem isto, a re-busca do documento no Gmail vai para o e-mail e a CAIXA
  // errados (executor resolve o binario por message_inbox_id + operador).
  assertEquals(r.valor!.message_inbox_id, PDF_ANTIGO.message_inbox_id);
  assertEquals(r.valor!.gmail_message_id, PDF_ANTIGO.gmail_message_id);
  assertEquals(r.valor!.operador_id, PDF_ANTIGO.operador_id);
  assertEquals(r.valor!.visto_em, PDF_ANTIGO.visto_em);
});

Deno.test("INV-154 (2): o texto lido no arquivo CHEGA na Instrucao do SSW", () => {
  const ev = montarEvidenciasRecebidas(
    {
      descricao: {
        fonte: "anexo",
        anexo_filename: "NFE-433174 (1).pdf",
        texto_extraido: "DINITRATO ISOSSORBIDA 10MG - 12 UN",
      },
      valor: {
        fonte: "anexo",
        anexo_filename: "NFE-433174 (1).pdf",
        texto_extraido: "R$ 1.488,00",
      },
    },
    [PDF_ANTIGO],
    "",
    REF_ATUAL,
    OPTS_ATUAIS,
  );
  const t = montarTextoDescricaoValor(mergeEvidencia(dossieVazio(), ev));
  assert(t.includes("DINITRATO ISOSSORBIDA 10MG"), `descricao tem de ir no texto — veio: ${JSON.stringify(t)}`);
  assert(t.includes("R$ 1.488,00"), `valor tem de ir no texto — veio: ${JSON.stringify(t)}`);
  assert(t.includes("NFE-433174 (1).pdf"), `o texto tem de dizer de qual anexo foi lido — veio: ${JSON.stringify(t)}`);
});

Deno.test("INV-154 (3): compatibilidade — anexo sem procedencia cai no ref atual", () => {
  // Protege os testes que ja existem, que passam anexos com so 3 campos.
  const r = montarEvidenciasRecebidas(
    { descricao: { fonte: "anexo", anexo_filename: "itens.pdf" } },
    [{ filename: "itens.pdf", mime_type: "application/pdf", size_bytes: 500 }],
    "",
    REF_ATUAL,
  );
  assert(r.descricao != null);
  assertEquals(r.descricao!.message_inbox_id, REF_ATUAL.message_inbox_id);
  assertEquals(r.descricao!.operador_id, REF_ATUAL.operador_id);
  assert(
    !("texto_extraido" in (r.descricao as Record<string, unknown>)),
    "sem transcricao, a chave NAO pode existir — mergeEvidencia faz spread e a chave com undefined apagaria texto ja gravado",
  );
});

Deno.test("INV-154 (4): romaneio NAO pode vir de mensagem anterior", () => {
  // O romaneio historico e territorio exclusivo do caminho deterministico
  // (montarSeedRomaneio, seed_romaneio_v2_enabled em medicao de sombra desde
  // 04/09). Se a leitura de arquivo marcar romaneio, ela vence o seed no merge
  // final e 11 dias de medicao viram lixo.
  const r = montarEvidenciasRecebidas(
    { romaneio: { fonte: "anexo", anexo_filename: "NFE-433174 (1).pdf" } },
    [PDF_ANTIGO],
    "",
    REF_ATUAL,
    OPTS_ATUAIS,
  );
  assertEquals(r.romaneio, undefined, "romaneio de mensagem anterior nao pode virar evidencia");
});

Deno.test("INV-154 (5): nome de arquivo ambiguo e RECUSADO", () => {
  // Medido em 15/09: 608 grupos (card, filename) tem o mesmo nome em mais de
  // uma mensagem, atingindo 201 dos 514 cards com anexo. Sem esta recusa, a
  // evidencia e gravada apontando para o arquivo errado — e evidencia gravada
  // NUNCA e desfeita (mergeEvidencia e monotonico).
  const a1 = { ...PDF_ANTIGO, message_inbox_id: "msg-A" };
  const a2 = { ...PDF_ANTIGO, message_inbox_id: "msg-B", gmail_message_id: "gmail-B" };
  const r = montarEvidenciasRecebidas(
    { valor: { fonte: "anexo", anexo_filename: "NFE-433174 (1).pdf", texto_extraido: "R$ 1.488,00" } },
    [a1, a2],
    "",
    REF_ATUAL,
    OPTS_ATUAIS,
  );
  assertEquals(r.valor, undefined, "nome ambiguo nao pode gerar evidencia");
});

Deno.test("INV-154 (6): o dossie da NF 431734 fecha com a leitura do PDF antigo", () => {
  const antes = {
    ...dossieVazio(),
    romaneio: { presente: true },
    descricao: {
      presente: true,
      fonte: "corpo" as const,
      texto_bruto: "O item extraviado, se trata: DINITRATO ISOSSORBIDA 10MG",
    },
  };
  assertEquals(avaliarDossie(antes).faltando, [ROTULO_EVIDENCIA.valor]);

  const recebidas = montarEvidenciasRecebidas(
    { valor: { fonte: "anexo", anexo_filename: "NFE-433174 (1).pdf", texto_extraido: "R$ 1.488,00" } },
    [PDF_ANTIGO],
    "",
    REF_ATUAL,
    OPTS_ATUAIS,
  );
  const depois = mergeEvidencia(antes, recebidas);
  assertEquals(avaliarDossie(depois).faltando, []);
  assertEquals(depois.completo, true);
  assertEquals(depois.valor.message_inbox_id, PDF_ANTIGO.message_inbox_id);
});
