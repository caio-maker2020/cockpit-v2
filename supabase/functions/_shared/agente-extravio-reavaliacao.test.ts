// Guards das regras de reavaliação do agente D+4 (Carlos 2026-09-29, INV-163).
// Âncoras reais: NF 14877 (49 falhou no SSW em 21/09), NF 787209 (novo extravio
// em 23/09 depois da 49 de 16/09), NF 2387808 (49 falhou em 23/09).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dataBrt,
  decidirReavaliacaoAgente,
  ehCicloNovo,
  ehReincidenciaAchouEPerdeu,
  type EstadoReavaliacao,
  MAX_TENTATIVAS_49_POR_CICLO,
  motivoFalhasSsw,
} from "./agente-extravio-reavaliacao.ts";

const base: EstadoReavaliacao = {
  status: "lancou",
  checadoEm: "2026-09-16T11:01:18.825Z",
  dataExtravio: "2026-09-10",
  dataExtravioTratado: null,
  teve49ComSucessoDepois: true,
  ultimaTentativaFalhou: false,
  tentativasNoCiclo: 1,
};

Deno.test("sem marcação → regra de sempre (nada muda pra quem nunca foi marcado)", () => {
  assertEquals(
    decidirReavaliacaoAgente({ ...base, status: null }),
    { tipo: "avaliar_normal", motivo: "sem_marcacao" },
  );
});

Deno.test("marcação nao_rodou/recomendado → ignora (comportamento de antes)", () => {
  assertEquals(decidirReavaliacaoAgente({ ...base, status: "nao_rodou" }).tipo, "ignorar");
  assertEquals(decidirReavaliacaoAgente({ ...base, status: "recomendado" }).tipo, "ignorar");
});

Deno.test("ÂNCORA NF 787209: 49 em 16/09 e novo extravio em 23/09 → ciclo novo", () => {
  assertEquals(
    decidirReavaliacaoAgente({ ...base, dataExtravio: "2026-09-23" }),
    { tipo: "avaliar_normal", motivo: "ciclo_novo" },
  );
});

Deno.test("mesmo ciclo com a 49 já lançada → ignora (nunca relança)", () => {
  assertEquals(decidirReavaliacaoAgente(base).tipo, "ignorar");
});

Deno.test("ÂNCORA NF 14877: 49 falhou no SSW, 1 tentativa → tenta de novo", () => {
  const e = {
    ...base,
    checadoEm: "2026-09-21T11:00:18.830Z",
    dataExtravio: "2026-09-15",
    teve49ComSucessoDepois: false,
    ultimaTentativaFalhou: true,
    tentativasNoCiclo: 1,
  };
  assertEquals(decidirReavaliacaoAgente(e), { tipo: "tentar_de_novo", tentativa: 2 });
});

Deno.test("falhou MAX vezes → para e avisa a operadora (sem loop)", () => {
  const e = {
    ...base,
    dataExtravio: "2026-09-15",
    checadoEm: "2026-09-21T13:00:00Z",
    teve49ComSucessoDepois: false,
    ultimaTentativaFalhou: true,
    tentativasNoCiclo: MAX_TENTATIVAS_49_POR_CICLO,
  };
  assertEquals(decidirReavaliacaoAgente(e), { tipo: "avisar_operadora", tentativas: MAX_TENTATIVAS_49_POR_CICLO });
});

Deno.test("falhou e a nova tentativa DEU CERTO → ignora (nunca uma 49 a mais)", () => {
  const e = { ...base, dataExtravio: "2026-09-15", checadoEm: "2026-09-21T12:00:00Z", teve49ComSucessoDepois: true, ultimaTentativaFalhou: true, tentativasNoCiclo: 2 };
  assertEquals(decidirReavaliacaoAgente(e), { tipo: "ignorar", motivo: "49_ja_lancada_neste_ciclo" });
});

Deno.test("sem sucesso e sem falha registrada (execução em andamento) → ignora", () => {
  const e = { ...base, dataExtravio: "2026-09-15", checadoEm: "2026-09-21T11:00:00Z", teve49ComSucessoDepois: false };
  assertEquals(decidirReavaliacaoAgente(e).tipo, "ignorar");
});

Deno.test("ciclo novo tem precedência sobre falha antiga (nunca lança antes do limiar)", () => {
  const e = { ...base, dataExtravio: "2026-09-23", teve49ComSucessoDepois: false, ultimaTentativaFalhou: true };
  assertEquals(decidirReavaliacaoAgente(e), { tipo: "avaliar_normal", motivo: "ciclo_novo" });
});

Deno.test("ehCicloNovo com data_extravio gravada: só extravio MAIS NOVO conta", () => {
  // 49 imediata da reincidência sai no MESMO dia do extravio → não é ciclo novo.
  assertEquals(ehCicloNovo({ checadoEm: "2026-10-01T12:00:00Z", dataExtravio: "2026-10-01", dataExtravioTratado: "2026-10-01" }), false);
  assertEquals(ehCicloNovo({ checadoEm: "2026-10-01T12:00:00Z", dataExtravio: "2026-10-05", dataExtravioTratado: "2026-10-01" }), true);
  // Bastão atrasado trazendo data mais velha → não é ciclo novo.
  assertEquals(ehCicloNovo({ checadoEm: "2026-10-01T12:00:00Z", dataExtravio: "2026-09-20", dataExtravioTratado: "2026-10-01" }), false);
});

Deno.test("ehCicloNovo em lançamento antigo (sem o campo): extravio do dia da marcação ou depois", () => {
  assertEquals(ehCicloNovo({ checadoEm: "2026-09-16T11:01:00Z", dataExtravio: "2026-09-16", dataExtravioTratado: null }), true);
  assertEquals(ehCicloNovo({ checadoEm: "2026-09-16T11:01:00Z", dataExtravio: "2026-09-15", dataExtravioTratado: null }), false);
  assertEquals(ehCicloNovo({ checadoEm: null, dataExtravio: "2026-09-16", dataExtravioTratado: null }), false);
  assertEquals(ehCicloNovo({ checadoEm: "2026-09-16T11:01:00Z", dataExtravio: null, dataExtravioTratado: null }), false);
});

Deno.test("dataBrt usa -03:00 fixo (01:30Z ainda é o dia anterior em BRT)", () => {
  assertEquals(dataBrt("2026-09-24T01:30:00Z"), "2026-09-23");
  assertEquals(dataBrt("2026-09-24T03:00:00Z"), "2026-09-24");
  assertEquals(dataBrt("lixo"), null);
  assertEquals(dataBrt(null), null);
});

Deno.test("motivoFalhasSsw explica e manda lançar à mão", () => {
  const m = motivoFalhasSsw(3, "buscarNFInterno falhou: http_status=429");
  assertEquals(m.includes("3 vezes"), true);
  assertEquals(m.includes("429"), true);
  assertEquals(m.includes("à mão"), true);
});

// Históricos do SSW como o listarOcorrenciasNF devolve: MAIS NOVO primeiro.
const novoPrimeiro = (cronologico: string) => cronologico.split(" ").map(Number).reverse();

Deno.test("REINCIDÊNCIA — ÂNCORA NF 14877 (real): extravio → 49 → 33 → 20 → nova viagem → extravio", () => {
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 41 5 7 5 7 53 53 31 29 5 7 6 49 33 20 31 29 5 7 6")), true);
});

Deno.test("REINCIDÊNCIA: achou e perdeu de novo, direto e com repetição no fim", () => {
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 7 6 20 55 5 7 6")), true);
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 7 6 20 6 6")), true);
});

Deno.test("NÃO é reincidência: extravio localizado e o card seguiu (última oc não é extravio)", () => {
  // real NF 68702: 6 6 20 55
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 7 6 6 20 55")), false);
});

Deno.test("NÃO é reincidência (decisão do Carlos 29/09): tratado e extraviou de novo, sem 20", () => {
  // caso 787209: extravio → 49 → 56 → extravio
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 7 6 14 49 56 6")), false);
});

Deno.test("NÃO é reincidência: coleta (9) e depois transferência (6), sem 20", () => {
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 9 5 7 6")), false);
});

Deno.test("NÃO é reincidência: dois extravios seguidos são o MESMO episódio", () => {
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 7 6 6")), false);
});

Deno.test("NÃO é reincidência: 20 sem extravio anterior no histórico", () => {
  assertEquals(ehReincidenciaAchouEPerdeu(novoPrimeiro("2 5 20 7 6")), false);
});

Deno.test("reincidência: entradas estranhas não quebram", () => {
  assertEquals(ehReincidenciaAchouEPerdeu([]), false);
  assertEquals(ehReincidenciaAchouEPerdeu([null, undefined]), false);
  assertEquals(ehReincidenciaAchouEPerdeu([6, null, 20, null, 6]), true);
});
