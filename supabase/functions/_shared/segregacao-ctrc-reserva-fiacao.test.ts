// =============================================================================
// GUARD DA FIAÇÃO da reserva à operadora (Carlos 2026-10-06, INV-169).
//
// A regra pura e a decisão async têm teste próprio (segregacao-ctrc-reserva).
// O que roda em PRODUÇÃO são as duas chamadas: no AGENDADOR (veto-agendamento)
// e no VENCIMENTO (processar-acoes-agendadas). Apagar qualquer uma deixa os
// testes da regra verdes e o robô volta a lançar a 54/59 de extravio da PRATI
// antes da operadora — exatamente o que ela relatou em 06/10. Por isso o guard
// é sobre o CÓDIGO-FONTE, sem comentários (prosa não conta).
//
// Rodar: deno test --allow-read --no-check \
//          supabase/functions/_shared/segregacao-ctrc-reserva-fiacao.test.ts
// =============================================================================
import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

function semComentarios(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const AGENDADOR = semComentarios(Deno.readTextFileSync(new URL("./veto-agendamento.ts", import.meta.url)));
const VENCIMENTO = semComentarios(
  Deno.readTextFileSync(new URL("../processar-acoes-agendadas/index.ts", import.meta.url)),
);

Deno.test("fiação/agendador: importa a decisão da cerca de ./segregacao-ctrc.ts (não reimplementa)", () => {
  assertMatch(AGENDADOR, /avaliarReservaSegregacaoVeto[^;]*from "\.\/segregacao-ctrc\.ts"/s);
  assertMatch(AGENDADOR, /await avaliarReservaSegregacaoVeto\(/);
});

Deno.test("fiação/agendador: o SELECT do card traz as fontes que a regra lê", () => {
  const sel = /\.from\("cards"\)\s*\.select\("([^"]*)"\)\s*\.eq\("id", i\.cardId\)/.exec(AGENDADOR);
  assert(sel, "não achei o SELECT do card no agendador");
  for (const col of ["agent_state", "agente_extravio_status", "cod_ultima_ocorrencia"]) {
    assert(sel![1]!.includes(col), `o SELECT do card no agendador perdeu \`${col}\``);
  }
});

Deno.test("fiação/agendador: o resultado chega na cerca decidirElegibilidadeVeto", () => {
  assertMatch(
    AGENDADOR,
    /segregacaoReservadaAoHumano\s*:\s*reservaSegregacao\.reservado/,
    "sem esta linha a decisão é calculada e jogada fora — o robô agenda como antes",
  );
});

Deno.test("fiação/vencimento: importa e chama a decisão, e DEVOLVE quando reservado", () => {
  assertMatch(VENCIMENTO, /avaliarReservaSegregacaoVeto[^;]*from "\.\.\/_shared\/segregacao-ctrc\.ts"/s);
  assertMatch(
    VENCIMENTO,
    /const reserva = await avaliarReservaSegregacaoVeto\([\s\S]{0,200}?\);\s*if \(reserva\.reservado\) \{\s*await devolver\(/,
    "no vencimento, reservado tem de DEVOLVER (cancelar o agendamento) antes de qualquer execução",
  );
});

Deno.test("fiação/vencimento: a checagem roda ANTES do RPC que executa a ação", () => {
  const iReserva = VENCIMENTO.indexOf("await avaliarReservaSegregacaoVeto(");
  const iExec = VENCIMENTO.indexOf('rpc("auto_aprovar_e_executar_veto"');
  assert(iReserva > 0 && iExec > 0, "trechos não encontrados no processar-acoes-agendadas");
  assert(iReserva < iExec, "a reserva tem de ser checada ANTES de auto_aprovar_e_executar_veto");
});

Deno.test("fiação/vencimento: o SELECT do card atual traz as fontes que a regra lê", () => {
  const sel = /\.select\("(cod_ultima_ocorrencia, aviso_alteracao_oc[^"]*)"\)/.exec(VENCIMENTO);
  assert(sel, "não achei o SELECT do cardAtual no vencimento");
  for (const col of ["agent_state", "agente_extravio_status", "cod_ultima_ocorrencia"]) {
    assert(sel![1]!.includes(col), `o SELECT do cardAtual perdeu \`${col}\``);
  }
});
