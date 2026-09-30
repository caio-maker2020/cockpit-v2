// =============================================================================
// Guard da FIAÇÃO do agente D+4 com as regras de reavaliação (INV-163).
// A regra pura mora em agente-extravio-reavaliacao.ts; o que teste de função
// pura NÃO vê é o agente continuar usando ela do jeito certo:
//   - a rodada principal (cards sem marcação) segue IGUAL à de antes;
//   - toda 49 das etapas novas passa pela pré-checagem SSW;
//   - cada tipo de reincidência só LANÇA com a SUA chave ligada, e em
//     observação não toca no card (nem update, nem card_event);
//   - todo lançamento grava a data do extravio tratado (é ela que separa ciclo
//     novo do mesmo ciclo — sem ela a 49 imediata viraria "ciclo novo" e sairia
//     de novo).
// Lê o FONTE sem comentários (apagar código e deixar a prosa não passa).
// =============================================================================
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const bruto = await Deno.readTextFile(new URL("../agente-extravio-d4/index.ts", import.meta.url));
const src = bruto
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

function trecho(inicio: string, fim: string): string {
  const i = src.indexOf(inicio);
  assert(i >= 0, `início não achado: ${inicio}`);
  const j = src.indexOf(fim, i + inicio.length);
  assert(j > i, `fim não achado depois de: ${inicio}`);
  return src.slice(i, j);
}

const scan = trecho("async function runScan(", "\nasync function ");
const reavaliacao = trecho("async function runReavaliacaoMarcados(", "\nasync function ");
const reincidencia = trecho("async function runReincidenciaImediata(", "\nasync function ");

Deno.test("rodada principal: mesmo filtro de antes (sem marcação, a partir do piso)", () => {
  assert(scan.includes('.gte("dias_uteis", MIN_DIA_AUTONOMO_EXTRAVIO)'));
  assert(scan.includes('.is("agente_extravio_status", null)'));
  assert(scan.includes("resolverDiasAutonomoExtravio("));
  assert(scan.includes("elegivelLancamento49Autonomo(card.dias_uteis, limiar)"));
  assert(scan.includes("podeAgenteLancar49PosManutencao(ocReal, anterior)"));
});

Deno.test("rodada principal: não termina mais cedo e chama as etapas novas protegidas", () => {
  assert(!/if \(elegiveis\.length === 0\)\s*\{\s*return json/.test(scan), "early return voltou: etapas novas não rodariam");
  assert(scan.includes('etapaSegura("reavaliacao", () => runReavaliacaoMarcados('));
  assert(scan.includes('etapaSegura("reincidencia", () => runReincidenciaImediata('));
  // as etapas novas vêm DEPOIS do laço principal
  assert(scan.indexOf("for (const card of elegiveis)") < scan.indexOf("runReavaliacaoMarcados("));
});

Deno.test("todo lançamento grava a data do extravio tratado", () => {
  const chamadas = src.match(/await lancar49\(/g)?.length ?? 0;
  const comData = src.match(/await lancar49\([^)]*\{ dataExtravio:/g)?.length ?? 0;
  assertEquals(chamadas, 4, "principal + execute + reavaliação + reincidência (e nenhuma outra)");
  assertEquals(comData, chamadas, "lancar49 sem dataExtravio: o próximo ciclo não saberia o que foi tratado");
  const def = trecho("async function lancar49(", "\nasync function ");
  assert(def.includes("data_extravio: extra.dataExtravio"));
});

Deno.test("reavaliação: decisão pura + pré-checagem SSW antes de lançar", () => {
  assert(reavaliacao.includes("decidirReavaliacaoAgente("));
  assert(reavaliacao.includes('.eq("agente_extravio_status", "lancou")'));
  const pre = reavaliacao.indexOf("podeAgenteLancar49PosManutencao(ocReal, anterior)");
  const lanca = reavaliacao.indexOf("await lancar49(");
  assert(pre > 0 && lanca > pre, "a 49 da reavaliação tem de vir DEPOIS da pré-checagem SSW");
  assert(reavaliacao.includes("if (!autonomo) return res;"), "sem modo autônomo não relança");
  assert(reavaliacao.includes("elegivelLancamento49Autonomo(card.dias_uteis, limiar)"), "ciclo novo respeita o limiar");
});

Deno.test("reincidência: cada tipo só lança com a SUA chave ligada; em observação não toca no card", () => {
  // Duas chaves (Carlos 30/09), cada uma exige o modo autônomo e enabled === true
  // (ausente ou nula = observação).
  assert(/achouEPerdeu: autonomo && flagLigada\(FLAG_REINCIDENCIA_ACHOU_E_PERDEU\)/.test(reincidencia));
  assert(/jaTratado: autonomo && flagLigada\(FLAG_REINCIDENCIA_JA_TRATADO\)/.test(reincidencia));
  assert(reincidencia.includes("f.key === key && f.enabled === true"), "chave só liga com enabled === true");
  // Reincidente = pré-checagem SSW E um dos padrões; lança só se o tipo achado estiver ligado.
  assert(reincidencia.includes("const padrao = classificarReincidencia(codigos);"));
  assert(reincidencia.includes(
    "const reincidente = podeAgenteLancar49PosManutencao(ocReal, anterior) && (padrao.achouEPerdeu || padrao.jaTratado);",
  ));
  assert(reincidencia.includes("const ligado = reincidente && deveLancarReincidencia(padrao, chaves);"));
  const lanca = reincidencia.indexOf("await lancar49(");
  const seLigado = reincidencia.lastIndexOf("if (ligado)", lanca);
  assert(seLigado > 0 && seLigado < lanca, "lancar49 da reincidência fora do if (ligado)");
  assert(!reincidencia.includes('from("card_events").insert'), "observação não grava card_event");
  assert(!/from\("cards"\)\s*\.update/.test(reincidencia), "observação não mexe no card");
  assert(reincidencia.includes('stepName: "reincidencia"'), "observação anota em agent_runs");
  // A observação separa os dois tipos: é com essa lista que se decide ligar cada chave.
  assert(/output: \{[^}]*achou_e_perdeu: padrao\.achouEPerdeu, ja_tratado: padrao\.jaTratado/.test(reincidencia));
});

Deno.test("reincidência espera quando o SSW já foi usado na rodada (o 429 nasceu numa rodada cheia)", () => {
  assert(reincidencia.includes("if (sswOcupado) return"), "sem o adiamento a observação soma leituras na hora cheia");
  assert(scan.includes("const sswOcupado = elegiveis.length > 0"));
  assert(scan.includes("runReincidenciaImediata(supabase, sessao, startedAt, autonomo, sswOcupado)"));
});

Deno.test("eventos novos não começam com 'Acao' (reconciliar_execucoes_presas usa LIKE 'Acao%')", () => {
  const tipos = [...src.matchAll(/event_type: "([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  for (const t of tipos) assert(!t.startsWith("Acao"), `evento ${t} seria lido como execução`);
});
