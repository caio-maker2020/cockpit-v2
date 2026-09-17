// =============================================================================
// INV-155 — guard da confirmacao da operadora (pop-up da oc 33).
//
// Prova o que o Carlos fixou em 2026-09-16 e, principalmente, o que ele NAO
// pediu: o pop-up nao toca em romaneio, nao vale para o combo 33+44, nao
// aparece em card sem anexo e nao libera lancamento autonomo.
//
// Roda sem banco e sem rede:
//   deno test --no-check --allow-all supabase/functions/_shared/oc33-confirmacao-operador.test.ts
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirGateOc33,
  dossieVazio,
  type DossieExtravioParcial,
  JANELA_VISIVEL_SSW,
  mergeEvidencia,
  montarEvidenciasRecebidas,
  montarTextoDescricaoValor,
} from "./extravio-parcial-dossie.ts";
import {
  type ConfirmacaoOperador,
  decidirPerguntaOc33,
  evidenciasDaConfirmacao,
  LIMITE_DESCRICAO_CONFIRMACAO,
  PISO_TEXTO_CONFIRMACAO,
  previaTextoDoSetor,
  validarConfirmacao,
} from "./oc33-confirmacao-operador.ts";

const AGORA = "2026-09-16T12:00:00.000Z";
const OPERADORA = "op-karoline";

/** Dossie do caso-ancora NF 431734: romaneio OK, descricao e valor faltando. */
function dossieNF431734(): DossieExtravioParcial {
  return {
    ...dossieVazio(),
    romaneio: { presente: true, fonte: "anexo", filename: "Minuta.pdf" },
  };
}

const conf = (over: Partial<ConfirmacaoOperador> = {}): ConfirmacaoOperador => ({
  confirmou: true,
  descricao: "DINITRATO ISOSSORBIDA 10MG - 12 UN",
  valor: "R$ 1.488,00",
  operador_id: OPERADORA,
  visto_em: AGORA,
  ...over,
});

// ---------------------------------------------------------------------------
// Quando o pop-up PODE aparecer
// ---------------------------------------------------------------------------

Deno.test("INV-155 pergunta: caso-ancora NF 431734 — pergunta descricao E valor", () => {
  const d = decidirPerguntaOc33({
    natureza: "completude",
    bloqueada: true,
    dossie: dossieNF431734(),
    temAnexoNoCard: true,
  });
  assertEquals(d.perguntar, true);
  assertEquals(d.alvos, ["descricao", "valor"]);
  assertEquals(d.rotulos, ["descrição dos itens", "valor dos itens"]);
  assertEquals(d.motivo, null);
});

Deno.test("INV-155 pergunta: so o que falta entra nos alvos", () => {
  const dossie = { ...dossieNF431734(), valor: { presente: true, fonte: "corpo" as const, texto_bruto: "R$ 300,00" } };
  const d = decidirPerguntaOc33({ natureza: "completude", bloqueada: true, dossie, temAnexoNoCard: true });
  assertEquals(d.alvos, ["descricao"]);
});

// ---------------------------------------------------------------------------
// Quando o pop-up NAO pode aparecer — os limites que o Carlos fixou
// ---------------------------------------------------------------------------

Deno.test("INV-155 limite: SEM ROMANEIO nunca pergunta — o SSW reverte a 33 (NF 660746)", () => {
  const d = decidirPerguntaOc33({
    natureza: "completude",
    bloqueada: true,
    dossie: dossieVazio(), // romaneio ausente
    temAnexoNoCard: true,
  });
  assertEquals(d.perguntar, false);
  assertEquals(d.motivo, "falta_romaneio");
  assertEquals(d.alvos, []);
});

Deno.test("INV-155 limite: combo 33+44 (operacional) esta FORA desta rodada", () => {
  const d = decidirPerguntaOc33({
    natureza: "operacional",
    bloqueada: true,
    dossie: dossieNF431734(),
    temAnexoNoCard: true,
  });
  assertEquals(d.perguntar, false);
  assertEquals(d.motivo, "natureza_operacional");
});

Deno.test("INV-155 limite: card SEM ANEXO nao pergunta — fluxo segue como hoje", () => {
  const d = decidirPerguntaOc33({
    natureza: "completude",
    bloqueada: true,
    dossie: dossieNF431734(),
    temAnexoNoCard: false,
  });
  assertEquals(d.perguntar, false);
  assertEquals(d.motivo, "card_sem_anexo");
});

Deno.test("INV-155 limite: carimbo ausente/false nao pergunta (a parede ja deixa passar)", () => {
  for (const bloqueada of [false, undefined as unknown as boolean]) {
    const d = decidirPerguntaOc33({
      natureza: "completude",
      bloqueada,
      dossie: dossieNF431734(),
      temAnexoNoCard: true,
    });
    assertEquals(d.perguntar, false, `bloqueada=${bloqueada}`);
    assertEquals(d.motivo, "nao_bloqueada");
  }
});

Deno.test("INV-155 limite: card sem dossie (extravio total / card comum) nao pergunta", () => {
  const d = decidirPerguntaOc33({ natureza: "completude", bloqueada: true, dossie: null, temAnexoNoCard: true });
  assertEquals(d.perguntar, false);
  assertEquals(d.motivo, "sem_dossie");
});

Deno.test("INV-155 limite: dossie completo nao pergunta", () => {
  const dossie: DossieExtravioParcial = {
    ...dossieVazio(),
    romaneio: { presente: true },
    descricao: { presente: true },
    valor: { presente: true },
    completo: true,
  };
  const d = decidirPerguntaOc33({ natureza: "completude", bloqueada: true, dossie, temAnexoNoCard: true });
  assertEquals(d.motivo, "nada_faltando");
});

// ---------------------------------------------------------------------------
// O que o SIM precisa trazer
// ---------------------------------------------------------------------------

Deno.test("INV-155 validacao: NAO nao libera nada", () => {
  const v = validarConfirmacao(conf({ confirmou: false }), ["descricao", "valor"]);
  assertEquals(v.ok, false);
  assertEquals(evidenciasDaConfirmacao(v, conf({ confirmou: false })), {});
});

Deno.test("INV-155 validacao: SIM em branco NAO vale — Carlos escolheu a opcao (a), ela digita", () => {
  for (const texto of ["", "   ", "x", "ab"]) {
    const c = conf({ descricao: texto });
    const v = validarConfirmacao(c, ["descricao"]);
    assertEquals(v.ok, false, `deveria reprovar: ${JSON.stringify(texto)}`);
    assert(v.erros[0]!.includes("descrição dos itens"));
    assertEquals(evidenciasDaConfirmacao(v, c), {}, "nada pode entrar no dossie");
  }
  // o piso e exatamente PISO_TEXTO_CONFIRMACAO, nao um a mais
  const noPiso = conf({ descricao: "a".repeat(PISO_TEXTO_CONFIRMACAO) });
  assertEquals(validarConfirmacao(noPiso, ["descricao"]).ok, true);
});

Deno.test("INV-155 validacao: so os alvos FALTANTES sao exigidos e gravados", () => {
  // valor ja esta no dossie => nao se pede, nao se grava (nao sobrescreve).
  const c = conf({ valor: "ignorado" });
  const v = validarConfirmacao(c, ["descricao"]);
  assertEquals(v.ok, true);
  assertEquals(v.valor, null);
  const ev = evidenciasDaConfirmacao(v, c);
  assertEquals(Object.keys(ev), ["descricao"]);
});

Deno.test("INV-155 validacao: quebra de linha e espaco duplo sao normalizados", () => {
  // Espaco duplo racha thread no Outlook e o SSW e latin-1: nada de \n indo pro texto.
  const c = conf({ descricao: "  DINITRATO   10MG\n\n12 UN  " });
  const v = validarConfirmacao(c, ["descricao"]);
  assertEquals(v.descricao, "DINITRATO 10MG 12 UN");
});

Deno.test("INV-155 validacao: texto gigante e cortado no teto, nao rejeitado", () => {
  const c = conf({ descricao: "A".repeat(500) });
  const v = validarConfirmacao(c, ["descricao"]);
  assertEquals(v.ok, true);
  assertEquals(v.descricao!.length, LIMITE_DESCRICAO_CONFIRMACAO);
});

// ---------------------------------------------------------------------------
// O que a confirmacao vira no dossie
// ---------------------------------------------------------------------------

Deno.test("INV-155 dossie: a confirmacao marca a PROCEDENCIA e destrava o carimbo", () => {
  const dossie = dossieNF431734();
  assertEquals(decidirGateOc33("completude", dossie).bloqueada, true);

  const c = conf();
  const depois = mergeEvidencia(dossie, evidenciasDaConfirmacao(validarConfirmacao(c, ["descricao", "valor"]), c));

  assertEquals(depois.descricao.presente, true);
  assertEquals(depois.descricao.fonte, "operador");
  assertEquals(depois.descricao.operador_id, OPERADORA);
  assertEquals(depois.descricao.visto_em, AGORA);
  assertEquals(depois.descricao.texto_bruto, "DINITRATO ISOSSORBIDA 10MG - 12 UN");
  assertEquals(depois.completo, true);

  const gate = decidirGateOc33("completude", depois);
  assertEquals(gate.bloqueada, false);
  assertEquals(gate.faltando, []);
});

Deno.test("INV-155 dossie: NAO usa texto_extraido — senao o SSW ganharia 'lido de:' sem arquivo", () => {
  const c = conf();
  const ev = evidenciasDaConfirmacao(validarConfirmacao(c, ["descricao", "valor"]), c);
  assertEquals((ev.descricao as Record<string, unknown>)["texto_extraido"], undefined);
  assertEquals((ev.descricao as Record<string, unknown>)["filename"], undefined);
  const depois = mergeEvidencia(dossieNF431734(), ev);
  assert(!montarTextoDescricaoValor(depois).includes("lido de:"), montarTextoDescricaoValor(depois));
});

Deno.test("INV-155 dossie: romaneio NUNCA e tocado pela confirmacao", () => {
  const c = conf();
  const ev = evidenciasDaConfirmacao(validarConfirmacao(c, ["descricao", "valor"]), c) as Record<string, unknown>;
  assertEquals(ev["romaneio"], undefined);
  // e um card sem romaneio continua bloqueado mesmo se alguem forcar a chamada
  const depois = mergeEvidencia(dossieVazio(), ev as never);
  assertEquals(decidirGateOc33("completude", depois).bloqueada, true);
});

// ---------------------------------------------------------------------------
// A cerca contra o modelo
// ---------------------------------------------------------------------------

Deno.test("INV-155 cerca: o LLM NAO consegue se declarar confirmado por operadora", () => {
  const ev = montarEvidenciasRecebidas(
    {
      descricao: { fonte: "operador" as never, trecho_verbatim: "inventado", anexo_filename: null },
      valor: { fonte: "operador" as never, trecho_verbatim: "inventado", anexo_filename: null },
    },
    [],
    "corpo do e-mail sem nada disso",
    { message_inbox_id: "m1", gmail_message_id: "g1", gmail_thread_id: null, operador_id: null, visto_em: AGORA },
  );
  assertEquals(ev, {}, "fonte 'operador' so pode sair de oc33-confirmacao-operador.ts");
});

// ---------------------------------------------------------------------------
// A previa do que o setor le
// ---------------------------------------------------------------------------

Deno.test("INV-155 previa: usa o MESMO caminho do texto real do SSW", () => {
  const dossie = dossieNF431734();
  const c = conf();
  const v = validarConfirmacao(c, ["descricao", "valor"]);
  const p = previaTextoDoSetor(dossie, v, c);

  const real = montarTextoDescricaoValor(mergeEvidencia(dossie, evidenciasDaConfirmacao(v, c)));
  assertEquals(p.texto, real, "previa e texto real nao podem divergir");
  assertEquals(p.texto, "Itens: DINITRATO ISOSSORBIDA 10MG - 12 UN | Valor: R$ 1.488,00");
  assertEquals(p.cortado, false, "o caso-ancora TEM de caber na janela do setor");
  assertEquals(p.janela, p.texto);
});

Deno.test("INV-155 previa: acusa o corte quando passa da janela de 70", () => {
  const c = conf({ descricao: "A".repeat(LIMITE_DESCRICAO_CONFIRMACAO) });
  const v = validarConfirmacao(c, ["descricao", "valor"]);
  const p = previaTextoDoSetor(dossieNF431734(), v, c);
  assertEquals(p.cortado, true);
  assertEquals(p.janela.length, JANELA_VISIVEL_SSW);
});
