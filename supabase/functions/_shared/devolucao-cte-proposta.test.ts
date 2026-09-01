// Guards da decisão "o que fazer quando o detector reconhece um CT-e".
// O que estes testes protegem, acima de tudo: modo SOMBRA e nível B **não podem
// abrir ciclo**, porque abrir ciclo muda o menu da operadora (a cerca do R3
// reage a "ciclo aberto"). Sombra que altera menu deixou de ser observação.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirAcaoProposta,
  descricaoTodo44Cte,
  type EntradaDecisaoProposta,
  montarPropostaPayload44,
} from "./devolucao-cte-proposta.ts";
import { CODIGO_SSW_44, TOOL_44_DEVOLUCAO_CTE } from "./devolucao-cte-44.ts";

const BASE: EntradaDecisaoProposta = {
  nivel: "A",
  emEscopo: true,
  flagShadow: false,
  flagEnabled: true,
  jaExisteTodoAtivo: false,
  cicloJaTemCte: false,
};

// --- a cerca de escopo vem antes de tudo ------------------------------------

Deno.test("fora do escopo: nada acontece, em NENHUM modo", () => {
  for (const [shadow, enabled] of [[false, false], [true, false], [false, true], [true, true]]) {
    const d = decidirAcaoProposta({
      ...BASE,
      emEscopo: false,
      flagShadow: shadow!,
      flagEnabled: enabled!,
    });
    assertEquals(d.acao, "nada");
    assertEquals(d.motivo, "fora_do_escopo");
    assertEquals(d.abreCiclo, false);
  }
});

Deno.test("sem detecção: nada", () => {
  const d = decidirAcaoProposta({ ...BASE, nivel: null });
  assertEquals(d.acao, "nada");
  assertEquals(d.motivo, "sem_deteccao");
});

// --- os degraus --------------------------------------------------------------

Deno.test("degraus 0-2 (as duas flags OFF): nada, nem sombra", () => {
  const d = decidirAcaoProposta({ ...BASE, flagShadow: false, flagEnabled: false });
  assertEquals(d.acao, "nada");
  assertEquals(d.motivo, "flags_desligadas");
});

Deno.test("SOMBRA nunca abre ciclo — se abrisse, mudaria o menu de card real", () => {
  for (const nivel of ["A", "B"] as const) {
    const d = decidirAcaoProposta({ ...BASE, nivel, flagShadow: true, flagEnabled: false });
    assertEquals(d.acao, "sombra");
    assertEquals(d.abreCiclo, false, "sombra que abre ciclo deixa de ser observação");
    assertStringIncludes(d.motivo, `nivel_${nivel}`);
  }
});

Deno.test("enabled VENCE shadow (o degrau 4 substitui o 3, não soma)", () => {
  const d = decidirAcaoProposta({ ...BASE, flagShadow: true, flagEnabled: true });
  assertEquals(d.acao, "propor");
});

// --- decisão nº 9: nível B só sinaliza --------------------------------------

Deno.test("nível B SINALIZA e NÃO abre ciclo (decisão nº 9)", () => {
  const d = decidirAcaoProposta({ ...BASE, nivel: "B" });
  assertEquals(d.acao, "sinalizar");
  assertEquals(
    d.abreCiclo,
    false,
    "abrir ciclo tiraria a 44 pelada e os combos do menu com base em prova INDIRETA",
  );
});

Deno.test("nível B não vira proposta nem com a feature ligada", () => {
  const d = decidirAcaoProposta({ ...BASE, nivel: "B", flagEnabled: true, flagShadow: true });
  assertEquals(d.acao === "propor", false);
});

// --- nível A + ligado = o caminho que age ----------------------------------

Deno.test("nível A com a feature ligada: propõe e abre ciclo", () => {
  const d = decidirAcaoProposta(BASE);
  assertEquals(d.acao, "propor");
  assertEquals(d.abreCiclo, true);
  assertEquals(d.motivo, "nivel_a_prova_na_propria_mensagem");
});

Deno.test("idempotência: proposta ativa já existe ⇒ nada", () => {
  const d = decidirAcaoProposta({ ...BASE, jaExisteTodoAtivo: true });
  assertEquals(d.acao, "nada");
  assertEquals(d.motivo, "proposta_ativa_ja_existe");
  assertEquals(d.abreCiclo, false);
});

Deno.test("idempotência: ciclo já registrou o CT-e ⇒ nada (detector redispara na thread)", () => {
  const d = decidirAcaoProposta({ ...BASE, cicloJaTemCte: true });
  assertEquals(d.acao, "nada");
  assertEquals(d.motivo, "ciclo_ja_tem_cte_registrado");
});

Deno.test("SÓ o caminho 'propor' abre ciclo — varredura de todas as combinações", () => {
  for (const nivel of [null, "A", "B"] as const) {
    for (const emEscopo of [true, false]) {
      for (const flagShadow of [true, false]) {
        for (const flagEnabled of [true, false]) {
          for (const jaTodo of [true, false]) {
            for (const jaCte of [true, false]) {
              const d = decidirAcaoProposta({
                nivel,
                emEscopo,
                flagShadow,
                flagEnabled,
                jaExisteTodoAtivo: jaTodo,
                cicloJaTemCte: jaCte,
              });
              assertEquals(
                d.abreCiclo,
                d.acao === "propor",
                `abreCiclo divergiu da ação (${d.acao}) em ${
                  JSON.stringify({ nivel, emEscopo, flagShadow, flagEnabled, jaTodo, jaCte })
                }`,
              );
            }
          }
        }
      }
    }
  }
});

// --- payload da proposta ---------------------------------------------------

Deno.test("payload carrega a tool, o código e o ID DO CICLO (o handler exige)", () => {
  const p = montarPropostaPayload44({
    cicloId: "ciclo-1",
    nf: "239883",
    nomeArquivoCte: "60022.pdf",
  });
  assertEquals(p["tool"], TOOL_44_DEVOLUCAO_CTE);
  const args = p["args"] as Record<string, unknown>;
  assertEquals(args["codigo_ssw"], CODIGO_SSW_44);
  assertEquals(args["devolucao_cte_id"], "ciclo-1");
  assertEquals(args["nf"], "239883");
});

Deno.test("R19: acao_key SEMPRE carimbada (sem ela a cerca do veto compara NaN)", () => {
  const p = montarPropostaPayload44({ cicloId: "c", nf: "1", nomeArquivoCte: null });
  assertEquals(p["acao_key"], "lancar_44_devolucao_cte:44");
});

Deno.test("volumes do CTRC entram como PREFILL; motivo e filial NÃO são inventados", () => {
  const p = montarPropostaPayload44({
    cicloId: "c",
    nf: "1",
    nomeArquivoCte: null,
    quantidadeVolumes: 2,
  });
  const extras = (p["args"] as Record<string, unknown>)["extras"] as Record<string, unknown>;
  assertEquals(extras["quantidade_volumes"], "2");
  assertEquals("motivo" in extras, false, "motivo não se lê no PDF — não se inventa");
  assertEquals("filial" in extras, false);
});

Deno.test("volume ausente/zero/negativo não vira prefill falso", () => {
  for (const v of [null, undefined, 0, -1]) {
    const p = montarPropostaPayload44({
      cicloId: "c",
      nf: "1",
      nomeArquivoCte: null,
      quantidadeVolumes: v as number | null,
    });
    const extras = (p["args"] as Record<string, unknown>)["extras"] as Record<string, unknown>;
    assertEquals("quantidade_volumes" in extras, false, `volumes=${v} não pode virar prefill`);
  }
});

Deno.test("a descrição do todo diz o nome do arquivo (a operadora confere na lista)", () => {
  assertStringIncludes(descricaoTodo44Cte("CTE DEV. NF 195392.pdf"), "CTE DEV. NF 195392.pdf");
  // sem nome, não vira "undefined" nem parêntese vazio
  const semNome = descricaoTodo44Cte(null);
  assertEquals(semNome.includes("undefined"), false);
  assertEquals(semNome.includes("()"), false);
});

// =============================================================================
// GUARDS MECÂNICOS DA FIAÇÃO. O acionador depende de Supabase e do Gmail, então
// o que se trava aqui é o FONTE — cada propriedade abaixo, se cair, engole um
// CT-e em silêncio. Rodar com --allow-read.
// =============================================================================

const ACIONAR = new URL("./devolucao-cte-acionar.ts", import.meta.url);
const POLL = new URL("../gmail-poll-inbox/index.ts", import.meta.url);

Deno.test("R2: o detector é disparado por ANEXO SALVO, não por mensagem", async () => {
  const poll = await Deno.readTextFile(POLL);
  assertStringIncludes(poll, "acionarDeteccaoCteDevolucao({");
  // A chamada tem de vir DEPOIS do loop que salva os anexos, senão `anexosSalvos`
  // está vazio e o caso Ícaro (thread nova de 1 msg) é perdido.
  const iSalvos = poll.indexOf("anexosSalvos.push({");
  const iChamada = poll.indexOf("acionarDeteccaoCteDevolucao({");
  assertEquals(iSalvos > -1 && iChamada > iSalvos, true, "acionamento antes de salvar = anexo perdido");
});

Deno.test("INV-131: o acionador NÃO olha cards.state (roda em card TRANSFERIDO)", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  // A oc 56 (pedido de NFD) manda o card pra TRANSFERIDO e a espera dura
  // semanas. Exigir card ativo engoliria o CT-e que chega no meio.
  assertEquals(/\bstate\b\s*[:=]/.test(src), false, "não pode condicionar a cards.state");
  assertEquals(src.includes('"state"'), false);
  assertStringIncludes(src, "INV-131");
});

Deno.test("a feature desligada custa UMA leitura de flags e sai", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  const iFlags = src.indexOf('.in("key", ["devolucao_cte_shadow"');
  const iCard = src.indexOf('.from("cards")');
  const iRpc = src.indexOf("devolucao_cte_em_escopo");
  assertEquals(iFlags > -1 && iFlags < iCard, true, "flags têm de ser lidas ANTES do card");
  assertEquals(iFlags < iRpc, true, "flags antes da RPC de escopo");
  assertStringIncludes(src, 'return NADA("flags_desligadas")');
});

Deno.test("erro NUNCA derruba a captura de e-mail do cliente", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  assertStringIncludes(src, "catch (e)");
  assertStringIncludes(src, 'return NADA("erro_engolido")');
});

Deno.test("anexo ambíguo NÃO vira proposta — a operadora decide", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  assertStringIncludes(src, "DevolucaoCteAnexoAmbiguo");
  assertStringIncludes(src, 'return NADA("anexo_ambiguo_operadora_decide")');
});

Deno.test("o ciclo é chaveado por (nf, ctrc_origem), nunca por card_id (R6/ADR 0006)", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  // A devolução gera CTRC novo e o card muda; a chave do ciclo tem de sobreviver.
  assertStringIncludes(src, 'onConflict: "nf,ctrc_origem"');
});

Deno.test("o upsert do ciclo só acontece no caminho 'propor'", async () => {
  const src = await Deno.readTextFile(ACIONAR);
  const iGuarda = src.indexOf('if (decisao.acao !== "propor")');
  const iUpsert = src.indexOf(".upsert(");
  assertEquals(
    iGuarda > -1 && iUpsert > iGuarda,
    true,
    "abrir ciclo em sombra/nível B mudaria o menu da operadora — deixa de ser observação",
  );
});
