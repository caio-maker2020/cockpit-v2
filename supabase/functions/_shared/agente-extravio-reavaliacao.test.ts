// Guards das regras de reavaliação do agente D+4 (Carlos 2026-09-29, INV-163).
// Âncoras reais: NF 14877 (49 falhou no SSW em 21/09), NF 787209 (novo extravio
// em 23/09 depois da 49 de 16/09), NF 2387808 (49 falhou em 23/09).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classificarReincidencia,
  dataBrt,
  decidirReavaliacaoAgente,
  deveLancarReincidencia,
  ehCicloNovo,
  ehReincidenciaAchouEPerdeu,
  ehReincidenciaJaTratado,
  type EstadoReavaliacao,
  FLAG_REINCIDENCIA_ACHOU_E_PERDEU,
  FLAG_REINCIDENCIA_JA_TRATADO,
  MAX_TENTATIVAS_49_POR_CICLO,
  motivoFalhasSsw,
  OCS_TRATATIVA_EXTRAVIO,
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

Deno.test("NÃO é 'achou e perdeu': tratado e extraviou de novo, sem 20 (é o tipo 'já tratado', Carlos 30/09)", () => {
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

// ---------------------------------------------------------------------------
// "Já tratado e extraviou de novo" (Carlos 30/09). Âncoras reais: histórico do
// SSW guardado no Cockpit (cards.historico_ssw) em 30/09, cortado no momento em
// que o novo extravio entrou.
// ---------------------------------------------------------------------------

Deno.test("tratativas: exatamente a lista aprovada pelo Carlos (30/09) — a 55 fica fora", () => {
  assertEquals([...OCS_TRATATIVA_EXTRAVIO].sort((a, b) => a - b), [33, 42, 46, 47, 49, 54, 56, 59]);
});

Deno.test("JÁ TRATADO — ÂNCORA NF 756245 (real): extravio → 49 do próprio agente → 59 → a 6 relançada", () => {
  assertEquals(
    classificarReincidencia(novoPrimeiro("2 5 7 5 5 7 5 36 6 6 49 59 6")),
    { achouEPerdeu: false, jaTratado: true },
  );
});

Deno.test("JÁ TRATADO — ÂNCORA NF 383793 (real), nas duas vezes que extraviou de novo", () => {
  const h1 = "2 5 7 5 36 14 51 14 6 13 49 56 41 41 46 56 6";
  assertEquals(classificarReincidencia(novoPrimeiro(h1)), { achouEPerdeu: false, jaTratado: true });
  assertEquals(
    classificarReincidencia(novoPrimeiro(`${h1} 46 49 54 49 56 49 6`)),
    { achouEPerdeu: false, jaTratado: true },
  );
});

Deno.test("JÁ TRATADO — ÂNCORA NF 817275 (real): tratado, viajou e extraviou; depois achou e perdeu também", () => {
  const h1 = "2 5 7 23 6 49 54 46 49 54 41 49 41 49 5 36 6";
  assertEquals(classificarReincidencia(novoPrimeiro(h1)), { achouEPerdeu: false, jaTratado: true });
  assertEquals(
    classificarReincidencia(novoPrimeiro(`${h1} 41 49 33 46 20 54 5 36 6`)),
    { achouEPerdeu: true, jaTratado: true },
  );
});

Deno.test("JÁ TRATADO — tipo da NF 787209: extravio → 49 → 56 → extravio", () => {
  assertEquals(classificarReincidencia(novoPrimeiro("2 5 7 6 14 49 56 6")), { achouEPerdeu: false, jaTratado: true });
});

Deno.test("ÂNCORA NF 14877 (real): é 'achou e perdeu' e 'já tratado' ao mesmo tempo", () => {
  assertEquals(
    classificarReincidencia(novoPrimeiro("2 41 5 7 5 7 53 53 31 29 5 7 6 49 33 20 31 29 5 7 6")),
    { achouEPerdeu: true, jaTratado: true },
  );
});

Deno.test("NÃO é 'já tratado': só movimento da carga entre os extravios (reais NF 808896 e 10856926)", () => {
  assertEquals(classificarReincidencia(novoPrimeiro("2 5 7 5 7 6 5 36 6")), { achouEPerdeu: false, jaTratado: false });
  assertEquals(classificarReincidencia(novoPrimeiro("2 6 5 36 6")), { achouEPerdeu: false, jaTratado: false });
});

Deno.test("NÃO é 'já tratado': coleta (9) → transferência (6) sem tratativa (real NF 2690038)", () => {
  assertEquals(classificarReincidencia(novoPrimeiro("2 9 5 36 6")), { achouEPerdeu: false, jaTratado: false });
});

Deno.test("NÃO é 'já tratado': 06, 06 seguidos são o mesmo extravio", () => {
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 5 7 6 6")), false);
});

Deno.test("a 55 NÃO conta como tratativa; a 54 no mesmo lugar conta (Carlos 30/09)", () => {
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 6 55 5 7 6")), false);
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 6 54 5 7 6")), true);
});

Deno.test("NÃO é 'já tratado': tratativa sem extravio antes dela", () => {
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 49 5 7 6")), false);
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 54 6 6")), false);
});

Deno.test("NÃO é 'já tratado': a última ocorrência não é extravio", () => {
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 6 49 6 49")), false);
  assertEquals(ehReincidenciaJaTratado(novoPrimeiro("2 6 49 6 20")), false);
});

Deno.test("'já tratado': entradas estranhas não quebram", () => {
  assertEquals(ehReincidenciaJaTratado([]), false);
  assertEquals(ehReincidenciaJaTratado([null, undefined]), false);
  assertEquals(ehReincidenciaJaTratado([6, null, 49, null, 6]), true);
});

Deno.test("chaves: nomes exatos e diferentes (o /verify-cockpit e quem liga usam estes nomes)", () => {
  assertEquals(FLAG_REINCIDENCIA_ACHOU_E_PERDEU, "extravios_reincidencia_achou_perdeu_enabled");
  assertEquals(FLAG_REINCIDENCIA_JA_TRATADO, "extravios_reincidencia_ja_tratado_enabled");
});

Deno.test("chaves: cada tipo só lança com a SUA chave (Carlos 30/09)", () => {
  const ap = { achouEPerdeu: true, jaTratado: false };
  const jt = { achouEPerdeu: false, jaTratado: true };
  const os2 = { achouEPerdeu: true, jaTratado: true };
  const nenhum = { achouEPerdeu: false, jaTratado: false };
  // só a chave do "achou e perdeu" ligada
  assertEquals(deveLancarReincidencia(ap, ap), true);
  assertEquals(deveLancarReincidencia(jt, ap), false);
  assertEquals(deveLancarReincidencia(os2, ap), true);
  // só a chave do "já tratado" ligada
  assertEquals(deveLancarReincidencia(ap, jt), false);
  assertEquals(deveLancarReincidencia(jt, jt), true);
  assertEquals(deveLancarReincidencia(os2, jt), true);
  // as duas ligadas
  assertEquals(deveLancarReincidencia(ap, os2), true);
  assertEquals(deveLancarReincidencia(jt, os2), true);
  // nenhuma chave ligada (observação) ou nenhum padrão → nunca lança
  for (const p of [ap, jt, os2, nenhum]) assertEquals(deveLancarReincidencia(p, nenhum), false);
  for (const k of [ap, jt, os2, nenhum]) assertEquals(deveLancarReincidencia(nenhum, k), false);
});

// Todos os históricos possíveis de até 6 ocorrências com os códigos que importam
// (extravio, localizado, tratativa, 55, manutenção e movimento): 299.592 casos.
const EXTRAVIO_T = new Set([6, 9, 16]);
const TRATATIVA_T = new Set([49, 54, 56, 59, 33, 46, 42, 47]);
const ALFABETO = [6, 9, 20, 49, 54, 55, 43, 5];
function* historicosAte(max: number): Generator<number[]> {
  let nivel: number[][] = [[]];
  for (let n = 1; n <= max; n++) {
    const prox: number[][] = [];
    for (const s of nivel) {
      for (const c of ALFABETO) {
        const t = [...s, c];
        if (n < max) prox.push(t);
        yield t;
      }
    }
    nivel = prox;
  }
}
/** A definição do Carlos, ao pé da letra (cronológico): extravio → tratativa → … → extravio atual. */
function definicaoJaTratado(cron: number[]): boolean {
  const n = cron.length;
  if (n === 0 || !EXTRAVIO_T.has(cron[n - 1]!)) return false;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      if (EXTRAVIO_T.has(cron[i]!) && TRATATIVA_T.has(cron[j]!)) return true;
    }
  }
  return false;
}

Deno.test("'já tratado' bate com a definição em TODOS os históricos de até 6 ocorrências", () => {
  let casos = 0;
  for (const cron of historicosAte(6)) {
    casos++;
    const obtido = ehReincidenciaJaTratado([...cron].reverse());
    if (obtido !== definicaoJaTratado(cron)) throw new Error(`divergiu em [${cron.join(" ")}]: ${obtido}`);
  }
  assertEquals(casos, 299_592);
});

Deno.test("NADA REGRIDE: com a chave do 'já tratado' desligada, a decisão é IDÊNTICA à de antes", () => {
  const soAchouEPerdeu = { achouEPerdeu: true, jaTratado: false };
  const asDuas = { achouEPerdeu: true, jaTratado: true };
  const nenhuma = { achouEPerdeu: false, jaTratado: false };
  for (const cron of historicosAte(6)) {
    const hist = [...cron].reverse();
    const antes = ehReincidenciaAchouEPerdeu(hist);
    const p = classificarReincidencia(hist);
    if (deveLancarReincidencia(p, soAchouEPerdeu) !== antes) throw new Error(`mudou em [${cron.join(" ")}]`);
    // a ampliada pega tudo o que a de antes pegava
    if (antes && !deveLancarReincidencia(p, asDuas)) throw new Error(`ampliada perdeu [${cron.join(" ")}]`);
    // observação (nenhuma chave) nunca lança
    if (deveLancarReincidencia(p, nenhuma)) throw new Error(`observação lançaria em [${cron.join(" ")}]`);
  }
});

Deno.test("'06, 06': repetir o extravio atual nunca muda a decisão (é o mesmo extravio)", () => {
  for (const cron of historicosAte(5)) {
    if (!EXTRAVIO_T.has(cron[cron.length - 1]!)) continue;
    const um = classificarReincidencia([...cron].reverse());
    const dois = classificarReincidencia([...cron, 6].reverse());
    if (um.achouEPerdeu !== dois.achouEPerdeu || um.jaTratado !== dois.jaTratado) {
      throw new Error(`repetição mudou [${cron.join(" ")}]`);
    }
  }
});
