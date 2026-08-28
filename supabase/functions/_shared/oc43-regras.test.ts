// Guard anti-regressão do agente oc 43 (Duílio 2026-07-29, INV-061).
// Trava: whitelist de oc-anterior → 49; resto → 55; sem anterior/oc-mudou → sem_acao.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SswOcorrencia } from "./ssw-internal-client.ts";
import {
  acharOcAnteriorA43,
  bloqueiaPos43,
  decidirOc43DoHistorico,
  montarPropostaOc43,
  ocRealMaisRecente,
  OCS_ANTERIOR_LANCA_49,
  textoInstrucaoOc43,
} from "./oc43-regras.ts";

// helper: monta histórico most-recent-first só com o que importa
function oc(codigo: number | null, descricao = ""): SswOcorrencia {
  return { codigo, descricao, instrucao: "", data: "", filial: null, usuario: null, fotos: [] };
}

Deno.test("whitelist tem exatamente as 15 ocs do Duílio", () => {
  assertEquals(
    [...OCS_ANTERIOR_LANCA_49].sort((a, b) => a - b),
    [3, 6, 8, 9, 10, 11, 13, 16, 17, 18, 19, 20, 23, 31, 35],
  );
});

Deno.test("43 precedida de oc da lista (16 extravio entrega) → lançar 49", () => {
  const d = decidirOc43DoHistorico([oc(43, "MANUTENCAO PERECIVEL"), oc(16, "EXTRAVIO ENTREGA")]);
  assertEquals(d.acao, "lancar_49");
  if (d.acao === "lancar_49") assertEquals(d.ocAnterior, 16);
});

Deno.test("43 precedida de oc FORA da lista (14) → lançar 55", () => {
  const d = decidirOc43DoHistorico([oc(43), oc(14, "ENTREGA INICIADA")]);
  assertEquals(d.acao, "lancar_55");
  if (d.acao === "lancar_55") assertEquals(d.ocAnterior, 14);
});

Deno.test("43 é a primeira ocorrência (nada antes) → sem_acao/sem_oc_anterior", () => {
  const d = decidirOc43DoHistorico([oc(43)]);
  assertEquals(d.acao, "sem_acao");
  if (d.acao === "sem_acao") assertEquals(d.motivo, "sem_oc_anterior");
});

Deno.test("SSW já ENTREGUE (oc 1) depois da 43 → bloqueia (finalizadora)", () => {
  const d = decidirOc43DoHistorico([oc(1, "ENTREGUE"), oc(43), oc(16)]);
  assertEquals(d.acao, "sem_acao");
  if (d.acao === "sem_acao") {
    assertEquals(d.motivo, "oc_pos43_bloqueia");
    assertEquals(d.ocRealSsw, 1);
  }
});

Deno.test("SSW em TRÂNSITO depois da 43 (14 entrega iniciada) → LANÇA pela oc antes da 43", () => {
  // histórico: 14 (mais recente) ← 43 ← 7 (chegada, fora da lista) → deve lançar 55
  const d = decidirOc43DoHistorico([oc(14, "ENTREGA INICIADA"), oc(43), oc(7, "CHEGADA BASE")]);
  assertEquals(d.acao, "lancar_55");
  if (d.acao === "lancar_55") assertEquals(d.ocAnterior, 7);
});

Deno.test("SSW em viagem (5) depois da 43, oc antes ∈ lista (16) → LANÇA 49", () => {
  const d = decidirOc43DoHistorico([oc(5, "INICIO VIAGEM"), oc(43), oc(16, "EXTRAVIO ENTREGA")]);
  assertEquals(d.acao, "lancar_49");
});

Deno.test("SSW virou PROBLEMA depois da 43 (6 extravio) → bloqueia", () => {
  const d = decidirOc43DoHistorico([oc(6, "EXTRAVIO TRANSFERENCIA"), oc(43), oc(7)]);
  assertEquals(d.acao, "sem_acao");
  if (d.acao === "sem_acao") assertEquals(d.motivo, "oc_pos43_bloqueia");
});

Deno.test("bloqueiaPos43: problema e finalizadora bloqueiam; trânsito não", () => {
  assertEquals(bloqueiaPos43(6), true);   // extravio (whitelist)
  assertEquals(bloqueiaPos43(1), true);   // entregue (finalizadora)
  assertEquals(bloqueiaPos43(30), true);  // finalizadora
  assertEquals(bloqueiaPos43(14), false); // entrega iniciada (trânsito)
  assertEquals(bloqueiaPos43(5), false);  // viagem (trânsito)
  assertEquals(bloqueiaPos43(7), false);  // chegada base (trânsito)
});

Deno.test("pula 43s repetidas no topo e pega a oc anterior real", () => {
  // duas 43 seguidas, depois uma 09 (extravio coleta, da lista)
  const anterior = acharOcAnteriorA43([oc(43), oc(43), oc(9, "EXTRAVIO COLETA"), oc(21)]);
  assertEquals(anterior?.codigo, 9);
  const d = decidirOc43DoHistorico([oc(43), oc(43), oc(9), oc(21)]);
  assertEquals(d.acao, "lancar_49");
});

Deno.test("ignora entradas com codigo nulo entre a 43 e a anterior", () => {
  const anterior = acharOcAnteriorA43([oc(43), oc(null, "linha sem codigo"), oc(35, "RECUSA PARCIAL")]);
  assertEquals(anterior?.codigo, 35);
});

Deno.test("sem nenhuma 43 no histórico → sem_oc_43_no_ssw (vazio ou com outras ocs)", () => {
  assertEquals(decidirOc43DoHistorico([]).acao, "sem_acao");
  assertEquals((decidirOc43DoHistorico([]) as { motivo: string }).motivo, "sem_oc_43_no_ssw");
  const semTreze = decidirOc43DoHistorico([oc(21), oc(16)]);
  assertEquals(semTreze.acao, "sem_acao");
  if (semTreze.acao === "sem_acao") assertEquals(semTreze.motivo, "sem_oc_43_no_ssw");
});

Deno.test("ocRealMaisRecente pega a primeira com código não-nulo", () => {
  assertEquals(ocRealMaisRecente([oc(null), oc(43), oc(16)]), 43);
  assertEquals(ocRealMaisRecente([]), null);
});

Deno.test("texto da instrução é factual e cita a oc anterior", () => {
  const t49 = textoInstrucaoOc43("lancar_49", 16, "EXTRAVIO ENTREGA");
  assertEquals(t49.includes("oc 16"), true);
  assertEquals(t49.includes("relacionamento"), true);
  const t55 = textoInstrucaoOc43("lancar_55", 14, "ENTREGA INICIADA");
  assertEquals(t55.includes("seguir com a entrega"), true);
});

Deno.test("payload usa lancar_ocorrencia, código certo e flags internas em extras", () => {
  const p49 = montarPropostaOc43({ codigoSsw: 49, nf: "467507", cnpjRemetente: "123", ocAnterior: 16, ocAnteriorDesc: "EXTRAVIO ENTREGA" });
  assertEquals(p49.tool, "lancar_ocorrencia");
  const a49 = p49.args as Record<string, unknown>;
  assertEquals(a49.codigo_ssw, 49);
  assertEquals(a49.nf, "467507");
  // origem/oc_anterior/acao são flags INTERNAS (não vazam pro SSW — whitelist do executor)
  const extras = a49.extras as Record<string, unknown>;
  assertEquals(extras.origem, "agente-oc43-autonomo");
  assertEquals(extras.oc_anterior, 16);
  // o texto real da oc vai em args.descricao
  assertEquals((a49.descricao as string).includes("relacionamento"), true);

  const p55 = montarPropostaOc43({ codigoSsw: 55, nf: "1", cnpjRemetente: null, ocAnterior: 14, ocAnteriorDesc: "" });
  assertEquals((p55.args as Record<string, unknown>).codigo_ssw, 55);
});

// ── REGRA V2 (Caio 28/08) — INV-120 ─────────────────────────────────────────
import {
  decidirOc43V2,
  SUFIXO_RELANCAMENTO_43,
} from "./oc43-regras.ts";

const o = (codigo: number | null, instrucao = "", data = "27/08/26 12:00", descricao = ""): SswOcorrencia =>
  ({ codigo, descricao, instrucao, data, filial: null, usuario: null, fotos: [] });

Deno.test("v2 ÂNCORA 289700: extravio (6) antes da 43 → EXTRAVIO_MONITORADO com a data ORIGINAL", () => {
  // most-recent-first: 43 ← 43(dup) ← 20 ← 6(26/08 10:36)
  const d = decidirOc43V2([o(43), o(20, "CHEGADA DE PERECIVEL FALTA 01 VOL", "27/08/26 12:15"), o(6, "2", "26/08/26 10:36")]);
  // anterior imediata à 43 é a 20 (relacionamento) — relança a 20!
  if (d.acao !== "relancar") throw new Error("esperava relancar, veio " + d.acao);
  if (d.oc !== 20) throw new Error("esperava oc 20");
});

Deno.test("v2: extravio IMEDIATAMENTE antes da 43 → extravio_monitorado com data original", () => {
  const d = decidirOc43V2([o(43), o(6, "1", "26/08/26 10:36", "EXTRAVIO NA TRANSFERENCIA")]);
  if (d.acao !== "extravio_monitorado") throw new Error("esperava extravio_monitorado, veio " + d.acao);
  if (d.ocExtravio !== 6 || d.dataOriginal !== "26/08/26 10:36") throw new Error("relógio errado");
});

Deno.test("v2 B2: anterior é 49 → relança 49 com a INSTRUÇÃO ORIGINAL (nunca carimbo)", () => {
  const d = decidirOc43V2([o(43), o(49, "3 TENTATIVAS SEM SUCESSO", "27/08/26 13:00")]);
  if (d.acao !== "relancar" || d.oc !== 49) throw new Error("esperava relancar 49");
  if (!d.textoLancamento.startsWith("3 TENTATIVAS SEM SUCESSO")) throw new Error("não herdou instrução");
  if (!d.textoLancamento.endsWith(SUFIXO_RELANCAMENTO_43)) throw new Error("sem sufixo rastreável");
});

Deno.test("v2 B1: anterior 13 ou 31 → relança a mesma", () => {
  for (const oc of [13, 31]) {
    const d = decidirOc43V2([o(43), o(oc, "SEM PREVISAO", "27/08/26 09:00")]);
    if (d.acao !== "relancar" || d.oc !== oc) throw new Error(`esperava relancar ${oc}`);
  }
});

Deno.test("v2 B3: anterior 54/59 → relança (o agente NÃO monta e-mail; texto herdado)", () => {
  const d = decidirOc43V2([o(43), o(54, "AGUARDANDO RETORNO DO CLIENTE PAGADOR", "27/08/26 09:00")]);
  if (d.acao !== "relancar" || d.oc !== 54) throw new Error("esperava relancar 54");
});

Deno.test("v2: anterior operacional (7 chegada) → 55 como hoje", () => {
  const d = decidirOc43V2([o(43), o(7, "Chegada na unidade")]);
  if (d.acao !== "lancar_55") throw new Error("esperava lancar_55, veio " + d.acao);
});

Deno.test("v2: instrução herdada é sanitizada (HTML/comentários fora)", () => {
  const d = decidirOc43V2([o(43), o(10, "<!--CLIENTE RECUSOU (SSWMOBILE) GPS (15m).-->CLIENTE RECUSOU <a href=#>GPS</a>", "27/08/26 09:00")]);
  if (d.acao !== "relancar") throw new Error("esperava relancar");
  if (d.textoLancamento.includes("<") || d.textoLancamento.includes("-->")) throw new Error("HTML vazou: " + d.textoLancamento);
});

Deno.test("v2: guards antigos preservados (sem 43 / pós-43 problema / sem anterior)", () => {
  if (decidirOc43V2([o(10)]).acao !== "sem_acao") throw new Error("sem 43 devia ser sem_acao");
  if (decidirOc43V2([o(10), o(43), o(7)]).acao !== "sem_acao") throw new Error("pós-43 problema devia bloquear");
  if (decidirOc43V2([o(43)]).acao !== "sem_acao") throw new Error("sem anterior devia ser sem_acao");
});
