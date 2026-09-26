// Guard — regra do bloqueiaEntrega (ADR 0035, D3). Trava a ordem R0..R6, o
// fail-safe (oc desconhecida bloqueia), o motivo legível COM a data da
// tratativa, e que TODO state do CHECK de cards tem resposta definida.
// Rodar: deno test --no-check supabase/functions/_shared/ponte-operacao-bloqueio.test.ts

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirBloqueioEntrega, type EntradaBloqueio } from "./ponte-operacao-bloqueio.ts";

const dic = (codigo: number | null) => {
  const tabela: Record<number, { descricao: string; responsabilidade: string }> = {
    6: { descricao: "Extravio na transferência", responsabilidade: "Perdas" },
    11: { descricao: "Entrega impossibilitada: problemas com endereço", responsabilidade: "Relacionamento" },
    21: { descricao: "Reentrega solicitada pelo cliente", responsabilidade: "Operação" },
    31: { descricao: "Aguardando agendamento", responsabilidade: "Agendamento" },
    44: { descricao: "Retorno de carga", responsabilidade: "Devolução" },
    49: { descricao: "Tratativa de relacionamento", responsabilidade: "Relacionamento" },
    54: { descricao: "Aguardando retorno cliente pagador", responsabilidade: "Cliente" },
    55: { descricao: "Autorizado para seguir pra entrega / entrega parcial", responsabilidade: "Operação" },
  };
  return codigo === null ? null : tabela[codigo] ?? null;
};

const e = (over: Partial<EntradaBloqueio> & { cod?: number | null } = {}): EntradaBloqueio => {
  const cod = over.cod === undefined ? 11 : over.cod;
  return {
    state: "AGUARDANDO_VALIDACAO_HUMANA",
    tipo: null,
    situacao: null,
    aguardandoQuem: null,
    aguardandoDesde: null,
    codUltimaOcorrencia: cod,
    ocDicionario: dic(cod),
    tratativaDesde: "2026-09-20T13:00:00Z",
    ...over,
  };
};

Deno.test("R0: terminal nunca bloqueia (RESOLVIDO, CANCELADO, TRANSFERIDO), mesmo com oc de cliente", () => {
  for (const state of ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"]) {
    const r = decidirBloqueioEntrega(e({ state, cod: 54 }));
    assertEquals([r.bloqueiaEntrega, r.motivoBloqueio, r.regra], [false, null, "R0"]);
  }
});

Deno.test("R1: extravio bloqueia pelo state OU pela oc 6/9/16", () => {
  assertEquals(decidirBloqueioEntrega(e({ state: "EXTRAVIO_MONITORADO", cod: 6 })).regra, "R1");
  const r = decidirBloqueioEntrega(e({ state: "AGUARDANDO_VALIDACAO_HUMANA", cod: 6 }));
  assert(r.bloqueiaEntrega);
  assertEquals(r.regra, "R1");
  assertMatch(r.motivoBloqueio!, /^Extravio em monitoramento \(oc 6 — Extravio na transferência\)/);
});

Deno.test("R2: aguardando cliente bloqueia por state, situacao ou aguardando.quem — e diz desde quando", () => {
  const porState = decidirBloqueioEntrega(e({ state: "AGUARDANDO_CLIENTE", cod: 54, aguardandoDesde: "2026-09-24T12:00:00Z" }));
  assertEquals(porState.regra, "R2");
  assertEquals(
    porState.motivoBloqueio,
    "Aguardando retorno do cliente pagador desde 24/09/2026 (oc 54 — Aguardando retorno cliente pagador). Tratativa aberta em 20/09/2026.",
  );
  assertEquals(decidirBloqueioEntrega(e({ situacao: "aguardando_cliente" })).regra, "R2");
  assertEquals(decidirBloqueioEntrega(e({ aguardandoQuem: "cliente" })).regra, "R2");
});

Deno.test("R2 vem antes de R4: rastreamento esperando o cliente responder ainda bloqueia", () => {
  const r = decidirBloqueioEntrega(e({ state: "AGUARDANDO_CLIENTE", tipo: "rastreamento", cod: 54 }));
  assertEquals([r.bloqueiaEntrega, r.regra], [true, "R2"]);
});

Deno.test("R3: ocorrência sendo lançada agora bloqueia", () => {
  const r = decidirBloqueioEntrega(e({ state: "EXECUTANDO_ACAO", cod: 21 }));
  assertEquals([r.bloqueiaEntrega, r.regra], [true, "R3"]);
});

Deno.test("R4: card de rastreamento (cliente só cobrou a entrega) não bloqueia", () => {
  const r = decidirBloqueioEntrega(e({ tipo: "rastreamento", cod: 11 }));
  assertEquals([r.bloqueiaEntrega, r.motivoBloqueio, r.regra], [false, null, "R4"]);
});

Deno.test("R5: última oc da Operação não bloqueia — inclusive a 21 que o Relacionamento acabou de lançar", () => {
  assertEquals(decidirBloqueioEntrega(e({ state: "ACAO_EXECUTADA", cod: 21 })).regra, "R5");
  assertEquals(decidirBloqueioEntrega(e({ state: "ACAO_EXECUTADA", cod: 21 })).bloqueiaEntrega, false);
  assertEquals(decidirBloqueioEntrega(e({ state: "AGUARDANDO_VALIDACAO_HUMANA", cod: 55 })).bloqueiaEntrega, false);
});

Deno.test("R6: ação lançada que NÃO é da Operação (44 devolução) bloqueia, com motivo de confirmação", () => {
  const r = decidirBloqueioEntrega(e({ state: "ACAO_EXECUTADA", cod: 44 }));
  assertEquals([r.bloqueiaEntrega, r.regra], [true, "R6"]);
  assertMatch(r.motivoBloqueio!, /^Ação do Relacionamento lançada no SSW, aguardando confirmação \(oc 44 — Retorno de carga\)\. Tratativa aberta em 20\/09\/2026\.$/);
});

Deno.test("R6: AVH (operador decidindo) bloqueia e diz que espera o operador", () => {
  const r = decidirBloqueioEntrega(e({ state: "AGUARDANDO_VALIDACAO_HUMANA", cod: 11, aguardandoQuem: "operador", aguardandoDesde: "2026-09-25T11:00:00Z" }));
  assertEquals(
    r.motivoBloqueio,
    "Tratativa aberta no Relacionamento, aguardando decisão do operador desde 25/09/2026 (oc 11 — Entrega impossibilitada: problemas com endereço). Tratativa aberta em 20/09/2026.",
  );
});

Deno.test("R6: agendamento (31) e trilho de veto armado bloqueiam", () => {
  assertEquals(decidirBloqueioEntrega(e({ state: "AGUARDANDO_AGENTE", cod: 31 })).bloqueiaEntrega, true);
  assertMatch(decidirBloqueioEntrega(e({ situacao: "acao_agendada" })).motivoBloqueio!, /trilho de veto/);
});

Deno.test("fail-safe: oc fora do dicionário (ou dicionário indisponível) BLOQUEIA", () => {
  const r = decidirBloqueioEntrega(e({ cod: 59, ocDicionario: null }));
  assertEquals([r.bloqueiaEntrega, r.regra], [true, "R6"]);
  assertMatch(r.motivoBloqueio!, /\(oc 59\)/);
  const semOc = decidirBloqueioEntrega(e({ cod: null, ocDicionario: null }));
  assertEquals(semOc.bloqueiaEntrega, true);
  assertMatch(semOc.motivoBloqueio!, /sem ocorrência registrada/);
});

Deno.test("exemplo do contrato (TRATATIVA_PENDENTE, extravio, aguardando_area_interna, oc 59) bloqueia", () => {
  const r = decidirBloqueioEntrega(e({
    state: "TRATATIVA_PENDENTE", tipo: "extravio", situacao: "aguardando_area_interna", aguardandoQuem: "operacao", cod: 59, ocDicionario: null,
  }));
  assert(r.bloqueiaEntrega);
});

Deno.test("todo state do CHECK de cards tem resposta definida e todo bloqueio tem motivo com a data", () => {
  const states = [
    "RECEBIDO", "EM_TRIAGEM", "AGUARDANDO_VINCULACAO", "AGUARDANDO_CONTEXTO", "AGUARDANDO_AGENTE",
    "EM_EXECUCAO_AUTOMATICA", "AGUARDANDO_VALIDACAO_HUMANA", "EXECUTANDO_ACAO", "ACAO_EXECUTADA",
    "AGUARDANDO_CLIENTE", "AGUARDANDO_TERCEIRO", "BLOQUEADO_POR_ERRO", "ESCALADO_HUMANO", "TRANSFERIDO",
    "TRATATIVA_PENDENTE", "EXTRAVIO_MONITORADO", "RESOLVIDO", "CANCELADO",
  ];
  for (const state of states) {
    for (const cod of [null, 6, 11, 21, 44, 54, 99]) {
      const r = decidirBloqueioEntrega(e({ state, cod }));
      if (r.bloqueiaEntrega) {
        assert(r.motivoBloqueio && r.motivoBloqueio.endsWith("Tratativa aberta em 20/09/2026."), `${state}/${cod}: ${r.motivoBloqueio}`);
      } else {
        assertEquals(r.motivoBloqueio, null, `${state}/${cod}`);
      }
    }
  }
});

Deno.test("sem data de abertura o motivo continua legível (sem 'undefined')", () => {
  const r = decidirBloqueioEntrega(e({ tratativaDesde: null }));
  assert(r.motivoBloqueio!.endsWith(")."));
  assert(!r.motivoBloqueio!.includes("undefined"));
});
