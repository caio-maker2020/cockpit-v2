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
  filtrarPropostas44SemCte,
  montarTexto44Cte,
  motivoAbortoLancamento44,
  motivoBloqueio44SemCte,
  TIPOS_ACAO_COM_PERNA_44,
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
  cte_anexos_ssw_ids: ["jpeg-1"],
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

Deno.test("ABORTA com conversão OK mas SEM JPEG registrado (estado incoerente)", () => {
  // O SSW não aceita PDF de forma alguma. Conversão marcada boa e nenhum JPEG
  // guardado é estado impossível — lançar aqui subiria a oc sem documento algum.
  for (const v of [[], null]) {
    assertEquals(
      motivoAbortoLancamento44({
        ...ENTRADA_OK,
        ciclo: { ...CICLO_OK, cte_anexos_ssw_ids: v },
      }),
      "sem_anexo_convertido_para_o_ssw",
    );
  }
});

Deno.test("o PDF ORIGINAL e os JPEGs do SSW são campos DISTINTOS", () => {
  // Confundir os dois manda o documento errado pra cada lado: o setor de
  // Devolução precisa do PDF original (o do SSW sai ilegível na impressão) e o
  // SSW só aceita imagem.
  assertEquals(CICLO_OK.cte_anexo_id === (CICLO_OK.cte_anexos_ssw_ids ?? [])[0], false);
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

// =============================================================================
// R3 — a cerca do menu. O que ela NÃO faz é tão importante quanto o que faz:
// sem ciclo aberto, a lista sai INTACTA (zero efeito nos outros operadores).
// =============================================================================

const MENU_54_COMPLETO = [
  { codigo_ssw: 21 },
  { codigo_ssw: 44 }, // a "pelada" — lançaria devolução SEM o CT-e
  { codigo_ssw: 55 },
  { codigo_ssw: 56 },
  { codigo_ssw: 54, tipo_acao: "relancamento_54" },
  { codigo_ssw: 33, tipo_acao: "combo_33_44" }, // perna 44 embutida, sem imagem
  { codigo_ssw: 33, tipo_acao: "oc33_solo" },
  { codigo_ssw: 59, tipo_acao: "combo_44_59" }, // perna 44 embutida
];

Deno.test("SEM ciclo de CT-e aberto: a lista sai IDÊNTICA (cerca inerte)", () => {
  const r = filtrarPropostas44SemCte(MENU_54_COMPLETO, false);
  assertEquals(r.length, MENU_54_COMPLETO.length);
  assertEquals(r, MENU_54_COMPLETO);
});

Deno.test("COM ciclo aberto: sai a 44 pelada e os dois combos com perna 44", () => {
  const r = filtrarPropostas44SemCte(MENU_54_COMPLETO, true);
  const codigos = r.map((p) => `${p.codigo_ssw}${p.tipo_acao ? ":" + p.tipo_acao : ""}`);
  assertEquals(codigos, ["21", "55", "56", "54:relancamento_54", "33:oc33_solo"]);
});

Deno.test("a oc 33 SOLO PERMANECE — nenhuma capacidade se perde", () => {
  // Indenização + devolução continua possível como DUAS ações: 33 solo (que não
  // carrega perna 44) + esta 44 com CT-e. O que sai é só a forma empacotada,
  // que é justamente a que não sabe anexar o documento.
  const r = filtrarPropostas44SemCte(MENU_54_COMPLETO, true);
  assertEquals(r.some((p) => p.tipo_acao === "oc33_solo"), true);
});

Deno.test("a cerca não confunde 44 pelada com 44 de outro tipo_acao", () => {
  // Uma proposta hipotética com codigo 44 E tipo_acao próprio não é "a pelada".
  // Só sai se estiver na lista explícita de tipos com perna 44.
  const r = filtrarPropostas44SemCte([{ codigo_ssw: 44, tipo_acao: "algo_novo" }], true);
  assertEquals(r.length, 1, "tipo_acao desconhecido não é barrado por adivinhação");
});

Deno.test("os tipos com perna 44 são os medidos no código, não inventados", () => {
  // executor/index.ts:2510 — o combo 33+44 lança a perna 44 com `[]`, comentado
  // literalmente como "oc=44 não leva imagem".
  assertEquals(TIPOS_ACAO_COM_PERNA_44.includes("combo_33_44"), true);
  assertEquals(TIPOS_ACAO_COM_PERNA_44.includes("combo_44_59"), true);
  assertEquals(TIPOS_ACAO_COM_PERNA_44.includes("oc33_solo"), false);
});

Deno.test("a cerca é usada de verdade no menu pós-resposta (não fica órfã)", async () => {
  const src = await Deno.readTextFile(
    new URL("./propostas-pos-resposta-cliente.ts", import.meta.url),
  );
  assertStringIncludes(src, "filtrarPropostas44SemCte(");
  // e o loop tem de iterar a lista FILTRADA, senão a cerca não tem efeito
  assertStringIncludes(src, "for (const p of novasFiltradas)");
  // fail-open no erro de infra: fechar aqui tiraria a devolução de todo mundo
  assertStringIncludes(src, "cicloCteAberto = false");
});

// =============================================================================
// A PAREDE NO ENVELOPE — último recurso, porque a cerca do menu só decide o que
// é CRIADO: um todo de 44 pelada criado ANTES de o CT-e chegar segue aprovável.
// =============================================================================

Deno.test("bloqueia 44 SEM anexo em card com ciclo aberto", () => {
  assertEquals(
    motivoBloqueio44SemCte(44, true, 0),
    "oc44_sem_anexo_em_card_com_ciclo_de_devolucao_aberto",
  );
});

Deno.test("NÃO bloqueia a 44 desta feature (ela sempre leva os JPEGs do CT-e)", () => {
  assertEquals(motivoBloqueio44SemCte(44, true, 1), null);
  assertEquals(motivoBloqueio44SemCte(44, true, 3), null);
});

Deno.test("NÃO bloqueia nada fora do escopo — a parede é cirúrgica", () => {
  // sem ciclo aberto: qualquer 44 passa, como sempre passou
  assertEquals(motivoBloqueio44SemCte(44, false, 0), null);
  // outros códigos NUNCA são tocados, nem com ciclo aberto e sem anexo
  for (const cod of [21, 33, 41, 49, 54, 55, 56, 59]) {
    assertEquals(motivoBloqueio44SemCte(cod, true, 0), null, `oc ${cod} não pode ser barrada aqui`);
  }
});

Deno.test("a parede está ligada no envelope, ANTES do INSERT de idempotência", async () => {
  const src = await Deno.readTextFile(new URL("./lancar-ssw-portal.ts", import.meta.url));
  assertStringIncludes(src, "motivoBloqueio44SemCte(");
  // Ordem: se a recusa consumisse a chave (card_id, codigo_oc, ctrc), o
  // relançamento CORRETO (com o CT-e) cairia em idempotent_skip e a oc nunca
  // sairia. Por isso a parede vem antes.
  const iParede = src.indexOf("motivoBloqueio44SemCte(");
  const iIdem = src.indexOf('.from("acoes_executadas_ssw")');
  assertEquals(iParede > -1 && iIdem > -1 && iParede < iIdem, true, "parede tem de vir ANTES");
  // A consulta só roda pra 44 — os outros lançamentos não pagam nada.
  assertStringIncludes(src, "if (codigoSsw === 44) {");
  // Fail-open: fechar por erro de infra pararia TODA devolução do Cockpit.
  assertStringIncludes(src, "let cicloAberto = false;");
});
