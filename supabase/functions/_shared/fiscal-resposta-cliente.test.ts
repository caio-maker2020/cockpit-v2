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
  const rel = montarRelatorio(caso(), AGORA);
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
