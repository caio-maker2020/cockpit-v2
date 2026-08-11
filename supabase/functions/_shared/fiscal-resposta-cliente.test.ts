// Testes do fiscal do INV-066: o relatório que o OPERADOR lê.
// O que estes testes travam: (a) o aviso é por CICLO, não por card — resposta
// nova gera aviso novo; (b) o texto fala a língua da operação (NF, card,
// cliente) e nunca expõe jargão de código; (c) o operador é sempre tranquilizado
// de que nada foi lançado errado no SSW.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CasoFiscal,
  chaveAlerta,
  descreverEspera,
  montarDiagnosticoTecnico,
  montarEmailCorretorTexto,
  montarEmailTexto,
  montarRelatorio,
  montarTitulo,
} from "./fiscal-resposta-cliente.ts";

const AGORA = new Date("2026-08-11T18:00:00Z").getTime();

function caso(over: Partial<CasoFiscal> = {}): CasoFiscal {
  return {
    card_id: "card-abc",
    nf: "306856",
    state: "AGUARDANDO_CLIENTE",
    capturada_em: "2026-08-10T12:26:58Z",
    operador_id: "op-1",
    operador_nome: "FELIPE",
    ...over,
  };
}

Deno.test("chave é por CICLO: resposta nova no mesmo card = aviso novo", () => {
  const c1 = caso();
  const c2 = caso({ capturada_em: "2026-08-11T09:00:00Z" });
  assertEquals(chaveAlerta(c1) === chaveAlerta(c2), false);
  // e o mesmo ciclo nunca vira dois avisos
  assertEquals(chaveAlerta(c1), chaveAlerta(caso()));
});

Deno.test("espera é legível pro humano (horas < 1 dia, dias depois)", () => {
  assertEquals(descreverEspera("2026-08-11T15:00:00Z", AGORA), "3 horas");
  assertEquals(descreverEspera("2026-08-11T17:40:00Z", AGORA), "1 hora");
  assertEquals(descreverEspera("2026-08-10T12:00:00Z", AGORA), "1 dia");
  assertEquals(descreverEspera("2026-06-18T12:00:00Z", AGORA), "54 dias");
});

Deno.test("relatório cita a NF e diz que a mensagem NÃO se perdeu", () => {
  const rel = montarRelatorio(caso(), AGORA);
  assertStringIncludes(rel.sintoma, "306856");
  assertStringIncludes(rel.o_que_aconteceu[0], "não se perdeu");
  assertStringIncludes(rel.qual_card, "306856");
});

Deno.test("relatório tranquiliza: nada foi lançado errado no SSW", () => {
  const rel = montarRelatorio(caso(), AGORA);
  const texto = rel.o_que_aconteceu.join(" ");
  assertStringIncludes(texto, "Nenhuma ocorrência foi lançada no SSW");
});

Deno.test("em AGUARDANDO_CLIENTE explica que o card sumiu da fila", () => {
  const rel = montarRelatorio(caso(), AGORA);
  assertStringIncludes(rel.o_que_aconteceu[1], "AGUARDANDO CLIENTE");
  assertStringIncludes(rel.impacto, "cliente está esperando");
});

Deno.test("em outro estado o texto muda (não mente dizendo que sumiu da fila)", () => {
  const rel = montarRelatorio(caso({ state: "AGUARDANDO_VALIDACAO_HUMANA" }), AGORA);
  assertEquals(rel.o_que_aconteceu[1].includes("AGUARDANDO CLIENTE"), false);
  assertStringIncludes(rel.impacto, "visível");
});

Deno.test("pedido final: verificar e mandar pro corretor de bugs, ou LIDO", () => {
  const rel = montarRelatorio(caso(), AGORA);
  assertStringIncludes(rel.pedido, "corretor oficial");
  assertStringIncludes(rel.pedido, "LIDO");
});

Deno.test("relatório NÃO vaza jargão de código pro operador", () => {
  // Só os campos que o operador LÊ (a conversa no Cockpit e o e-mail dele).
  // `diagnostico_tecnico` viaja no mesmo objeto mas é destinado ao corretor de
  // bugs — a UI não o renderiza, e ele PODE (e deve) ser técnico.
  const { diagnostico_tecnico: _tecnico, ...rel } = montarRelatorio(caso(), AGORA);
  const tudo = JSON.stringify(rel).toLowerCase();
  for (
    const jargao of [
      "vinculador",
      "reconciliador",
      "pgmq",
      "cliente_respondeu_em",
      "inv-066",
      "edge function",
      "null",
    ]
  ) {
    assertEquals(tudo.includes(jargao), false, `vazou jargão: ${jargao}`);
  }
});

Deno.test("título carrega a NF (é o que o operador vê na barra)", () => {
  assertStringIncludes(montarTitulo(caso()), "306856");
  assertStringIncludes(montarTitulo(caso({ nf: null })), "sem NF");
});

Deno.test("e-mail chama o operador pelo primeiro nome e traz o link do card", () => {
  const rel = montarRelatorio(caso(), AGORA);
  const txt = montarEmailTexto(caso(), rel, "https://cockpit.exemplo/cards/card-abc");
  assertStringIncludes(txt, "Oi, FELIPE!");
  assertStringIncludes(txt, "https://cockpit.exemplo/cards/card-abc");
  assertStringIncludes(txt, "O QUE ACONTECEU");
  assertStringIncludes(txt, "POR QUE ACONTECEU");
});

Deno.test("e-mail sem nome do operador não quebra a saudação", () => {
  const c = caso({ operador_nome: null });
  const txt = montarEmailTexto(c, montarRelatorio(c, AGORA), null);
  assertStringIncludes(txt, "Oi!");
});

// ── E-mail ao corretor de bugs (Caio) — separado do e-mail do operador ──────
Deno.test("diagnóstico técnico segue o ritual do projeto", () => {
  const dt = montarDiagnosticoTecnico(caso(), AGORA);
  assertStringIncludes(dt.sintoma_observado, "306856");
  assertStringIncludes(dt.comportamento_esperado, "TODO ciclo");
  assertEquals(dt.evidencias.length > 0, true);
  assertEquals(dt.fix_sugerido.length > 0, true);
  assertEquals(dt.como_validar.length > 0, true);
  assertEquals(dt.onde_olhar.length > 0, true);
});

Deno.test("causa raiz NÃO é afirmada como fato (regra do CLAUDE.md)", () => {
  const dt = montarDiagnosticoTecnico(caso(), AGORA);
  assertStringIncludes(dt.causa_raiz, "Hipótese não confirmada");
});

Deno.test("e-mail ao corretor traz quem reportou, o card e o fix sugerido", () => {
  const c = caso();
  const txt = montarEmailCorretorTexto(
    c,
    montarDiagnosticoTecnico(c, AGORA),
    "conferi e o card não moveu mesmo",
    "https://cockpit.exemplo/cards/card-abc",
  );
  assertStringIncludes(txt, "FELIPE");
  assertStringIncludes(txt, "306856");
  assertStringIncludes(txt, "Observação do operador: conferi");
  assertStringIncludes(txt, "SINTOMA OBSERVADO");
  assertStringIncludes(txt, "CAUSA RAIZ");
  assertStringIncludes(txt, "FIX SUGERIDO");
  assertStringIncludes(txt, "COMO VALIDAR");
  assertStringIncludes(txt, "ONDE OLHAR");
  assertStringIncludes(txt, "https://cockpit.exemplo/cards/card-abc");
});

Deno.test("sem observação do operador o e-mail não fica com linha órfã", () => {
  const c = caso();
  const txt = montarEmailCorretorTexto(c, montarDiagnosticoTecnico(c, AGORA), null, null);
  assertEquals(txt.includes("Observação do operador:"), false);
});

Deno.test("o relatório do operador CARREGA o diagnóstico técnico (pro encaminhamento)", () => {
  const rel = montarRelatorio(caso(), AGORA);
  assertEquals(typeof rel.diagnostico_tecnico?.fix_sugerido?.length, "number");
});

Deno.test("o e-mail do OPERADOR não carrega o diagnóstico técnico", () => {
  const c = caso();
  const txt = montarEmailTexto(c, montarRelatorio(c, AGORA), null).toLowerCase();
  for (const jargao of ["reconciliador", "cliente_respondeu_em", "onde olhar", "supabase/functions"]) {
    assertEquals(txt.includes(jargao), false, `vazou pro operador: ${jargao}`);
  }
});
