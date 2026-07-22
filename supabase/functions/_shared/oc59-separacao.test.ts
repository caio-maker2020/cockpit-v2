// Testes de não-regressão da separação 54/59 (Fase 4, Caio 2026-07-13).
// Cobre: (a) o override de código da oc49 (banner↔todo, idempotência INV-030),
// (b) o roteamento AGUARDANDO_CLIENTE via fonte única OCS_CLIENTE,
// (c) a transição da aba (54/59 mantêm; relacionamento sai; finalizadora resolve).
//
// Rodar: deno test --allow-all --no-check supabase/functions/_shared/oc59-separacao.test.ts
// Em ambiente de teste (sem SUPABASE_URL) os loaders caem no fallback {54,59}.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aplicarOverrideCodigoCliente,
  type PropostaRegra,
} from "./regras-auto-acao.ts";
import {
  ehOcAguardandoCliente,
  OCS_CLIENTE,
  stateFinalAposBastao,
} from "./bastao-rules.ts";
import { decidirTransicaoAguardandoCliente } from "./transicao-aguardando-cliente.ts";
import { classificarOc33 } from "./extravio-parcial-dossie.ts";
import { avaliarGuardOc54SemEmail } from "./guard-oc54-sem-email.ts";
import { OCS_NOTIFICOU_APOS_EXTRAVIO } from "./recusa-por-extravio.ts";
import { decidirReaberturaPorSsw } from "./lag-lancamento-54.ts";

// ---------- (a) override de código da oc49 (aplicarOverrideCodigoCliente) ----------

const REGRA_OC49: PropostaRegra[] = [
  { codigo_ssw_proposto: 21, descricao_todo: "reentrega", descricao_acao: "x" },
  { codigo_ssw_proposto: 54, descricao_todo: "54+email", descricao_acao: "x", enviar_email_template: "FALTA_DE_VOLUME" },
  { codigo_ssw_proposto: 55, descricao_todo: "seguir", descricao_acao: "x" },
  { codigo_ssw_proposto: 44, descricao_todo: "devolver", descricao_acao: "x" },
];

Deno.test("override 59: a proposta 54+email vira 59, as demais ficam intactas", () => {
  const out = aplicarOverrideCodigoCliente(REGRA_OC49, 59);
  assertEquals(out.map((p) => p.codigo_ssw_proposto), [21, 59, 55, 44]);
  // template preservado (só o código muda)
  assertEquals(out[1].enviar_email_template, "FALTA_DE_VOLUME");
});

Deno.test("sem override (null): identidade — extravio parcial / recusa / endereço FICAM 54", () => {
  assertEquals(
    aplicarOverrideCodigoCliente(REGRA_OC49, null).map((p) => p.codigo_ssw_proposto),
    [21, 54, 55, 44],
  );
  assertEquals(
    aplicarOverrideCodigoCliente(REGRA_OC49, undefined).map((p) => p.codigo_ssw_proposto),
    [21, 54, 55, 44],
  );
});

Deno.test("override NÃO toca 54 sem e-mail (só a proposta destacada = 54 com template)", () => {
  const regra: PropostaRegra[] = [
    { codigo_ssw_proposto: 54, descricao_todo: "54 sem email", descricao_acao: "x" }, // sem template
    { codigo_ssw_proposto: 54, descricao_todo: "54+email", descricao_acao: "x", enviar_email_template: "T" },
  ];
  const out = aplicarOverrideCodigoCliente(regra, 59);
  assertEquals(out.map((p) => p.codigo_ssw_proposto), [54, 59]); // só a com email vira 59
});

// ---------- (b) roteamento AGUARDANDO_CLIENTE (fonte única OCS_CLIENTE) ----------

Deno.test("OCS_CLIENTE contém 54 e 59", () => {
  assertEquals(OCS_CLIENTE.has(54), true);
  assertEquals(OCS_CLIENTE.has(59), true);
});

Deno.test("ehOcAguardandoCliente: 54 e 59 true; relacionamento e null false", () => {
  assertEquals(ehOcAguardandoCliente(54), true);
  assertEquals(ehOcAguardandoCliente(59), true);
  assertEquals(ehOcAguardandoCliente(10), false);
  assertEquals(ehOcAguardandoCliente(null), false);
  assertEquals(ehOcAguardandoCliente(undefined), false);
});

Deno.test("stateFinalAposBastao: 59 → AGUARDANDO_CLIENTE (espelho da 54, sem lock)", () => {
  assertEquals(stateFinalAposBastao(59, false), { state: "AGUARDANDO_CLIENTE", lock: false });
  // 54 permanece idêntico (não-regressão)
  assertEquals(stateFinalAposBastao(54, false), { state: "AGUARDANDO_CLIENTE", lock: false });
});

Deno.test("stateFinalAposBastao: NÃO-regressão de outras ocs (finalizadora/relacionamento)", () => {
  assertEquals(stateFinalAposBastao(1, false), { state: "RESOLVIDO", lock: false });
  // oc de relacionamento com regra → AVH+lock (10 tem regra)
  assertEquals(stateFinalAposBastao(10, true), { state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true });
});

// ---------- (c) transição da aba (decidirTransicaoAguardandoCliente) ----------

Deno.test("transição: 54 e 59 MANTÊM na aba; recusa sai; finalizadora resolve", () => {
  assertEquals(decidirTransicaoAguardandoCliente({ ocBastao: 59, ocTracking: null }), { tipo: "manter" });
  assertEquals(decidirTransicaoAguardandoCliente({ ocBastao: 54, ocTracking: null }), { tipo: "manter" });
  assertEquals(
    decidirTransicaoAguardandoCliente({ ocBastao: 10, ocTracking: null }),
    { tipo: "aguardando_voce", oc_nova: 10 },
  );
  assertEquals(
    decidirTransicaoAguardandoCliente({ ocBastao: 1, ocTracking: null }),
    { tipo: "resolvido", oc_final: 1 },
  );
});

// ---------- (d) combo 44+59 NÃO é pego pelo gate da oc 33 (Bloco 5) ----------
// O combo 44+59 é codigo_ssw=59 (indenização aguardando romaneio), NÃO uma oc 33.
// Se classificarOc33 o reconhecesse, o gate do dossiê (extravio parcial)
// bloquearia a ação de devolver+indenizar por "faltar romaneio" — exatamente o
// que o combo existe pra RESOLVER (pedir o romaneio). Guard anti-regressão: se
// alguém adicionar combo_44_59 em TIPOS_OC33/TOOLS_OC33 por engano, isto quebra.

Deno.test("gate oc33: combo 44+59 NÃO é oc 33 (retorna null) — nem no Caso 2", () => {
  const combo4459 = { codigo_ssw: 59, tipo_acao: "combo_44_59", tool: "lancar_combo_44_59" };
  assertEquals(classificarOc33(combo4459, "2"), null);
  assertEquals(classificarOc33(combo4459, "1"), null);
  assertEquals(classificarOc33(combo4459, null), null);
  // shape do payload persistido (args/meta aninhados) — mesma conclusão
  const comboPayload = {
    proposta_payload: { tool: "lancar_combo_44_59", args: { codigo_ssw: 59 }, meta: { tipo_acao: "combo_44_59" } },
  };
  assertEquals(classificarOc33(comboPayload, "2"), null);
});

Deno.test("gate oc33: NÃO-regressão — combo 33+44 e oc33 solo ainda classificam", () => {
  // combo 33+44 no Caso 2 (devolução) = operacional (exige só romaneio)
  assertEquals(
    classificarOc33({ codigo_ssw: 33, tipo_acao: "combo_33_44", tool: "lancar_combo_33_44" }, "2"),
    "operacional",
  );
  // oc 33 solo em qualquer caso = completude (exige as 3 evidências)
  assertEquals(
    classificarOc33({ codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" }, "1"),
    "completude",
  );
});

// ---------- (e) guards da camada de suporte cobrem {54,59} (Bloco 7) ----------
// Helpers runtime que os Blocos 2-6 deixaram 54-only e que tratariam um card 59
// errado. Guards anti-regressão da separação 54/59.

const guardBase = (over: Record<string, unknown> = {}) => ({
  codigoSsw: 59,
  enviarEmail: false,
  skipOc: false,
  tool: "lancar_oc_e_enviar_email",
  skipEmail: false,
  confirmouSemEmailDeliberado: false,
  propostaDestacadaAcao: null as string | null,
  ...over,
});

Deno.test("guard-oc54-sem-email: '59 + e-mail' sem e-mail BLOQUEIA (prong intenção)", () => {
  const r = avaliarGuardOc54SemEmail(guardBase());
  assertEquals(r.bloquear, true);
  assertEquals(r.prong, "intencao_email_no_todo_sem_email_valido");
});

Deno.test("guard-oc54-sem-email: gêmeo '59 sem email' vs recomendação '59+email' BLOQUEIA (acao_key :59)", () => {
  const r = avaliarGuardOc54SemEmail(guardBase({
    tool: "lancar_ocorrencia",
    propostaDestacadaAcao: "lancar_oc_e_enviar_email:59",
  }));
  assertEquals(r.bloquear, true);
  assertEquals(r.prong, "gemeo_sem_email_vs_recomendacao_email");
});

Deno.test("guard-oc54-sem-email: recomendação era :54 mas lançando 59 → NÃO casa (fail-open)", () => {
  const r = avaliarGuardOc54SemEmail(guardBase({
    tool: "lancar_ocorrencia",
    propostaDestacadaAcao: "lancar_oc_e_enviar_email:54",
  }));
  assertEquals(r.bloquear, false); // acao_key é comparada pelo código lançado (59≠54)
});

Deno.test("guard-oc54-sem-email: NÃO-regressão — 54 ainda bloqueia; oc fora de {54,59} não", () => {
  assertEquals(avaliarGuardOc54SemEmail(guardBase({ codigoSsw: 54 })).bloquear, true);
  assertEquals(avaliarGuardOc54SemEmail(guardBase({ codigoSsw: 21 })).bloquear, false);
});

Deno.test("recusa-por-extravio: set 'já notificou após extravio' inclui 59 (e mantém 54)", () => {
  assertEquals(OCS_NOTIFICOU_APOS_EXTRAVIO.has(59), true);
  assertEquals(OCS_NOTIFICOU_APOS_EXTRAVIO.has(54), true);
  assertEquals(OCS_NOTIFICOU_APOS_EXTRAVIO.has(33), false);
});

Deno.test("decidirReaberturaPorSsw: SSW mais recente = 59 → suprimir (defesa 54/59)", () => {
  const ehRelac = (oc: number) => [3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52].includes(oc);
  assertEquals(
    decidirReaberturaPorSsw({ ocSswMaisRecente: 59, ocSswMaisRecenteMs: 1000, ehRelac, ultimoLancamentoCockpitMs: 500 }),
    "suprimir",
  );
  // NÃO-regressão: 54 ainda suprime
  assertEquals(
    decidirReaberturaPorSsw({ ocSswMaisRecente: 54, ocSswMaisRecenteMs: 1000, ehRelac, ultimoLancamentoCockpitMs: 500 }),
    "suprimir",
  );
  // oc de relacionamento (49) lagando ANTES do lançamento de cliente → suprimir (não bounce-back)
  assertEquals(
    decidirReaberturaPorSsw({ ocSswMaisRecente: 49, ocSswMaisRecenteMs: 400, ehRelac, ultimoLancamentoCockpitMs: 500 }),
    "suprimir",
  );
});
