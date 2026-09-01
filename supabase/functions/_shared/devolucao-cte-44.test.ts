// Guards da parede do lançamento da oc 44 com CT-e (ADR 0018, INV-126).
// Cada teste aqui corresponde a um caminho pelo qual o sistema perderia
// documento fiscal parecendo ter dado certo.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BASE_DESCRICAO_44_CTE,
  type CicloDevolucaoCte,
  CODIGO_SSW_44,
  ehSkipIdempotente,
  type EntradaLancamento44,
  montarTexto44Cte,
  motivoAbortoLancamento44,
  TOOL_44_DEVOLUCAO_CTE,
} from "./devolucao-cte-44.ts";
import { SSW_F6_MAXLEN, SSW_OBSERV_MAXLEN } from "./descricao-ssw.ts";

// Caso-âncora do vídeo: AGV LOG SA VINHEDO, NF 239883, CTRC SSP912725-9, 2 VOL.
const CICLO_OK: CicloDevolucaoCte = {
  id: "ciclo-1",
  nf: "239883",
  ctrc_origem: "SSP912725-9",
  cte_anexo_id: "anexo-1",
  cte_convertido_ok: true,
  oc44_lancada_em: null,
  encerrado_em: null,
};

const ENTRADA_OK: EntradaLancamento44 = {
  ciclo: CICLO_OK,
  card: { nf: "239883", ctrc: "SSP912725-9" },
  emEscopo: true,
  extras: { quantidade_volumes: 2, motivo: "desacordo com o pedido", filial: "BHE" },
  imagensCarregadas: 1,
};

Deno.test("caminho felizmente completo ⇒ libera o lançamento", () => {
  assertEquals(motivoAbortoLancamento44(ENTRADA_OK), null);
});

// --- as duas regras que a decisão nº 3 e nº 4 tornaram invioláveis -----------

Deno.test("ABORTA sem CT-e anexado (decisão nº 3: não há devolução sem CT-e)", () => {
  const m = motivoAbortoLancamento44({ ...ENTRADA_OK, ciclo: { ...CICLO_OK, cte_anexo_id: null } });
  assertEquals(m, "sem_cte_anexado");
});

Deno.test("ABORTA com conversão do CT-e não confirmada (decisão nº 4, fail-closed)", () => {
  for (const v of [false, null]) {
    const m = motivoAbortoLancamento44({
      ...ENTRADA_OK,
      ciclo: { ...CICLO_OK, cte_convertido_ok: v },
    });
    assertEquals(m, "conversao_do_cte_nao_confirmada", `cte_convertido_ok=${v} deveria abortar`);
  }
});

Deno.test("ABORTA quando NENHUMA imagem foi carregada — é o 'em anexo' sem anexo", () => {
  // carregarAnexosParaEnvio pula anexo ausente com `continue` SILENCIOSO e
  // devolve []. Sem este aborto a 44 é lançada sem o documento e o card sai do
  // painel (TRANSFERIDO), tornando a perda invisível.
  const m = motivoAbortoLancamento44({ ...ENTRADA_OK, imagensCarregadas: 0 });
  assertEquals(m, "nenhuma_imagem_carregada_para_o_ssw");
});

// --- escopo -----------------------------------------------------------------

Deno.test("ABORTA fora do escopo (carteira de outro operador nunca é atingida)", () => {
  assertEquals(
    motivoAbortoLancamento44({ ...ENTRADA_OK, emEscopo: false }),
    "fora_do_escopo_devolucao_cte",
  );
});

// --- a troca de CTRC, que é o caminho NORMAL da devolução (ADR 0006) --------

Deno.test("ABORTA quando o CTRC do card divergiu do ciclo (devolução gera CTRC novo)", () => {
  const m = motivoAbortoLancamento44({
    ...ENTRADA_OK,
    card: { nf: "239883", ctrc: "SSP999999-9" },
  });
  assertEquals(m?.startsWith("ctrc_do_card_diverge_do_ciclo:"), true);
  // A mensagem tem de mostrar OS DOIS valores — é o que a Maria usa pra decidir.
  assertStringIncludes(m ?? "", "card=SSP999999-9");
  assertStringIncludes(m ?? "", "ciclo=SSP912725-9");
});

Deno.test("divergência de CTRC é só de conteúdo, não de caixa/espaço", () => {
  assertEquals(
    motivoAbortoLancamento44({ ...ENTRADA_OK, card: { nf: "239883", ctrc: " ssp912725-9 " } }),
    null,
    "normalização (trim+upper) não pode virar divergência falsa",
  );
});

Deno.test("ABORTA quando a NF do card divergiu do ciclo", () => {
  const m = motivoAbortoLancamento44({ ...ENTRADA_OK, card: { nf: "111", ctrc: "SSP912725-9" } });
  assertEquals(m?.startsWith("nf_do_card_diverge_do_ciclo:"), true);
});

// --- idempotência: a 2ª entrega do PGMQ não pode lançar de novo -------------

Deno.test("oc 44 já lançada ⇒ SKIP idempotente, não erro", () => {
  const m = motivoAbortoLancamento44({
    ...ENTRADA_OK,
    ciclo: { ...CICLO_OK, oc44_lancada_em: "2026-09-01T12:00:00Z" },
  });
  assertEquals(ehSkipIdempotente(m), true);
  assertStringIncludes(m ?? "", "oc44_ja_lancada_em");
});

Deno.test("idempotência é checada ANTES do escopo e do anexo", () => {
  // Cenário real do retry: o anexo já foi apagado e o cliente já saiu da
  // carteira, mas a oc FOI lançada. Isso é skip, não erro — reverter o card
  // aqui criaria alarme falso sobre uma ação que deu certo.
  const m = motivoAbortoLancamento44({
    ...ENTRADA_OK,
    emEscopo: false,
    imagensCarregadas: 0,
    ciclo: {
      ...CICLO_OK,
      oc44_lancada_em: "2026-09-01T12:00:00Z",
      cte_anexo_id: null,
      cte_convertido_ok: null,
    },
  });
  assertEquals(ehSkipIdempotente(m), true);
});

Deno.test("skip só vale pro prefixo certo (erro nunca é confundido com skip)", () => {
  assertEquals(ehSkipIdempotente("sem_cte_anexado"), false);
  assertEquals(ehSkipIdempotente(null), false);
});

// --- campos obrigatórios (NF 59299) ----------------------------------------

Deno.test("ABORTA sem volumes/motivo — o setor de Devolução não trata sem isso", () => {
  assertEquals(
    motivoAbortoLancamento44({ ...ENTRADA_OK, extras: { filial: "BHE" } }),
    "campos_obrigatorios_ausentes:quantidade_volumes,motivo",
  );
  assertEquals(
    motivoAbortoLancamento44({ ...ENTRADA_OK, extras: null }),
    "campos_obrigatorios_ausentes:quantidade_volumes,motivo",
  );
});

Deno.test("ciclo ausente ⇒ aborta (nunca lança 'no escuro')", () => {
  assertEquals(
    motivoAbortoLancamento44({ ...ENTRADA_OK, ciclo: null }),
    "ciclo_de_devolucao_nao_encontrado",
  );
});

Deno.test("ciclo encerrado ⇒ aborta", () => {
  const m = motivoAbortoLancamento44({
    ...ENTRADA_OK,
    ciclo: { ...CICLO_OK, encerrado_em: "2026-09-01T10:00:00Z" },
  });
  assertEquals(m?.startsWith("ciclo_encerrado_em:"), true);
});

// --- texto do SSW: o que o SETOR lê nos primeiros 70 chars ------------------

Deno.test("extras vêm ANTES da base — sobrevivem ao corte de 70 chars (NF 59299)", () => {
  const t = montarTexto44Cte(ENTRADA_OK.extras);
  const f6 = t.slice(0, SSW_F6_MAXLEN);
  assertStringIncludes(f6, "Volumes: 2");
  assertStringIncludes(f6, "Motivo: desacordo");
  // e a base íntegra continua no campo longo
  assertStringIncludes(t, BASE_DESCRICAO_44_CTE);
  assertEquals(t.length <= SSW_OBSERV_MAXLEN, true);
});

Deno.test("o texto diz que o CT-e está anexado — é a diferença que o setor precisa ver", () => {
  assertStringIncludes(montarTexto44Cte(ENTRADA_OK.extras).toLowerCase(), "ct-e");
});

Deno.test("flag interna NUNCA vaza pro texto do SSW (whitelist, NF 2161614)", () => {
  const t = montarTexto44Cte({
    quantidade_volumes: 2,
    motivo: "avaria",
    validar_evidencia: false,
    responder_thread_cliente: { algo: 1 },
    devolucao_cte_id: "ciclo-1",
  });
  assertEquals(t.includes("validar_evidencia"), false);
  assertEquals(t.includes("[object Object]"), false);
  assertEquals(t.includes("responder_thread"), false);
  assertEquals(t.includes("ciclo-1"), false);
});

// --- identidade da tool ----------------------------------------------------

Deno.test("R3: a tool é PRÓPRIA, distinta de lancar_ocorrencia:44", () => {
  // A UNIQUE de todos é (card_id, tool, codigo_ssw): se o nome fosse
  // "lancar_ocorrencia", a 44 pelada e a 44 com CT-e não poderiam coexistir —
  // ou pior, aprovar a pelada lançaria 44 SEM CT-e no mesmo card.
  assertEquals(TOOL_44_DEVOLUCAO_CTE, "lancar_44_devolucao_cte");
  // cast: sem ele o TS estreita pro literal e acusa comparação sem interseção —
  // mas a intenção aqui é justamente documentar que os dois nomes DIFEREM.
  assertEquals((TOOL_44_DEVOLUCAO_CTE as string) === "lancar_ocorrencia", false);
  assertEquals(CODIGO_SSW_44, 44);
});

// =============================================================================
// GUARDS MECÂNICOS DO HANDLER no executor. Ele não tem como ser testado por
// unidade aqui (depende de Supabase, PGMQ e do portal SSW), então o que se trava
// é o FONTE — as três propriedades que, se caírem, perdem documento fiscal em
// silêncio. Rodar com --allow-read.
// =============================================================================

const EXECUTOR = new URL("../executor/index.ts", import.meta.url);

/** Recorta só o corpo de `processarLancar44DevolucaoCte`. */
async function fonteDoHandler(): Promise<string> {
  const src = await Deno.readTextFile(EXECUTOR);
  const i = src.indexOf("async function processarLancar44DevolucaoCte");
  if (i < 0) throw new Error("handler processarLancar44DevolucaoCte não existe no executor");
  const j = src.indexOf("\nasync function ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

Deno.test("o executor DESPACHA a tool pro handler próprio", async () => {
  const src = await Deno.readTextFile(EXECUTOR);
  assertStringIncludes(src, "TOOL_44_DEVOLUCAO_CTE");
  assertStringIncludes(src, "await processarLancar44DevolucaoCte(");
  // Import do módulo puro: a decisão NÃO pode ser reescrita dentro do executor.
  assertStringIncludes(src, 'from "../_shared/devolucao-cte-44.ts"');
});

Deno.test("INV-124: o handler NUNCA apaga o CT-e do bucket, e o preserva ANTES de lançar", async () => {
  const h = await fonteDoHandler();
  assertEquals(
    h.includes("finalizarAnexosPosEnvio"),
    false,
    "ela apaga o arquivo do bucket e marca deletado_em — o CT-e é prova fiscal de ciclo ABERTO, " +
      "e o e-mail ao setor de Devolução manda o PDF ORIGINAL depois",
  );
  assertStringIncludes(h, "preservar: true");
  // preservar tem de vir ANTES do lançamento: se marcasse depois e o processo
  // morresse no meio, o arquivo ficaria desprotegido na janela em que a oc já existe.
  const iPreservar = h.indexOf("preservar: true");
  const iLancar = h.indexOf("lancarOcViaEnvelope");
  assertEquals(iPreservar > -1 && iLancar > -1 && iPreservar < iLancar, true);
});

Deno.test("INV-126: lança pelo ENVELOPE, nunca o portal cru", async () => {
  const h = await fonteDoHandler();
  assertStringIncludes(h, "lancarOcViaEnvelope");
  // O envelope é o único ponto com idempotência em acoes_executadas_ssw e com o
  // guard do tripé CTRC/NF/localização rodando ANTES do submit.
  assertEquals(h.includes("lancarOcorrenciaPortal"), false, "portal cru fura o guard do tripé");
  assertEquals(
    h.includes("aplicarForcarCtrcBaixado"),
    false,
    "forçar CTRC baixado aqui contraria a REGRA CRÍTICA do projeto",
  );
});

Deno.test("a decisão de lançar vem da PAREDE, não de ifs soltos no executor", async () => {
  const h = await fonteDoHandler();
  assertStringIncludes(h, "motivoAbortoLancamento44(");
  assertStringIncludes(h, "ehSkipIdempotente(");
  // O texto do SSW também: whitelist de extras não se reimplementa (NF 2161614).
  assertStringIncludes(h, "montarTexto44Cte(");
});

Deno.test("o escopo é avaliado no BANCO (fonte única), não recalculado no executor", async () => {
  const h = await fonteDoHandler();
  assertStringIncludes(h, "devolucao_cte_em_escopo");
  // Nenhum CNPJ literal — a cerca é a carteira, nunca lista em código (INV-075).
  assertEquals(/['"]\d{14}['"]/.test(h), false, "CNPJ hardcoded no handler");
});

Deno.test("flag OFF ⇒ não lança (fail-closed no degrau)", async () => {
  const h = await fonteDoHandler();
  assertStringIncludes(h, "devolucao_cte_maria_enabled");
  assertStringIncludes(h, "flag_desligada");
});
