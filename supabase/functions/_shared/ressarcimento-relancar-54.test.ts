// Testes do detector de round-trip de ressarcimento "relançar 54".
// Casos-âncora extraídos do histórico SSW real (scan 2026-06-25).
// Rodar: deno test supabase/functions/_shared/ressarcimento-relancar-54.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectarPedirDescricaoValor,
  detectarRessarcimentoRelancar54,
  deveBloquear54PedirDescValor,
  ORIGEM_PEDIR_DESCRICAO_VALOR,
  type OcHistorico,
} from "./ressarcimento-relancar-54.ts";

/** Helper: monta histórico MAIS-RECENTE-PRIMEIRO a partir de tuplas. */
function hist(...ocs: Array<[number | null, string, string?]>): OcHistorico[] {
  return ocs.map(([codigo, instrucao, usuario]) => ({ codigo, instrucao, usuario: usuario ?? null }));
}

// --- Tier A: a 49 manda explicitamente relançar 54 -------------------------

Deno.test("Tier A — NF 775461: 49 'LANCAR 54 NOVAMENTE' ← 46 ← 54", () => {
  const h = hist(
    [49, "LANCAR 54 NOVAMENTE", "lucianaf"],
    [46, "EM ANALISE DE RESSARCIMENTO", "lucianaf"],
    [54, "AGUARDANDO RETORNO DO CLIENTE PAGADOR", "l.silva"],
    [10, "MERCADORIA AVARIADA", "rezeluiz"],
  );
  const r = detectarRessarcimentoRelancar54(h);
  assertEquals(r?.tier, "A");
  assertEquals(r?.mesmaPessoaRessarcimento, true);
});

Deno.test("Tier A — NF 374609: 49 '(LANCAR 54)' mesmo com evento sem código no topo", () => {
  const h = hist(
    [null, "CTRC APONTADO PARA MANIFESTO NA UNIDADE", "anselmo"],
    [49, "AG ROMANEIO / DESCRICAO / VALOR (LANCAR 54)", "lucianaf"],
    [46, "EM ANALISE DE RESSARCIMENTO", "lucianaf"],
    [54, "Aguardando retorno do cliente pagador", "salexpre"],
    [19, "FALTOU 1 VOLUME", "alvemarc"],
    [6, "1 VOL", "jakson"],
  );
  const r = detectarRessarcimentoRelancar54(h);
  assertEquals(r?.tier, "A");
});

Deno.test("Tier A — variações de texto que mandam relançar", () => {
  for (const txt of ["RELANCAR 54", "LANCAR A 54", "FAVOR LANCAR NOVAMENTE A 54", "AG ROMANEIO (LANCAR 54)"]) {
    const h = hist([49, txt, "x"], [46, "EM ANALISE DE RESSARCIMENTO", "x"], [54, "AG CLIENTE", "y"]);
    assertEquals(detectarRessarcimentoRelancar54(h)?.tier, "A", txt);
  }
});

// --- Tier B: round-trip do ressarcimento sem a palavra "54" -----------------

Deno.test("Tier B — 49 da MESMA pessoa pede romaneio/valor sem dizer 54", () => {
  const h = hist(
    [49, "AG ROMANEIO / DESCRICAO E VALOR", "marianab"],
    [46, "EM ANALISE DE RESSARCIMENTO", "marianab"],
    [54, "AGUARDANDO RETORNO DO CLIENTE", "larissag"],
  );
  const r = detectarRessarcimentoRelancar54(h);
  assertEquals(r?.tier, "B");
  assertEquals(r?.mesmaPessoaRessarcimento, true);
});

Deno.test("Tier B vira null quando 46 e 49 são de pessoas DIFERENTES", () => {
  // NF 221990: 49 'ACAREACAO...' por elianag, 46 por marianab → não é o round-trip.
  const h = hist(
    [49, "ACAREACAO NAO ASSINADA DEVIDO A FALTA DE MERCADORIA", "elianag"],
    [46, "EM ANALISE DE RESSARCIMENTO", "marianab"],
    [54, "AGUARDANDO CLIENTE", "x"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

// --- Exclusões (estrutura bate mas NÃO é "relançar 54") ---------------------

Deno.test("null — 49 manda lançar OUTRA oc (NF 2679036: 'LANCAR 56 NOVAMENTE')", () => {
  const h = hist(
    [49, "DESCRICAO, VALOR, LANCAR 56 NOVAMENTE", "marianab"],
    [46, "EM ANALISE DE RESSARCIMENTO", "marianab"],
    [54, "AGUARDANDO CLIENTE", "x"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

Deno.test("null — 49 diz 'OC NAO PROCEDE' (NF 848858)", () => {
  const h = hist(
    [49, "OC NAO PROCEDE, NAO VOLUME PARA DEVOLVER", "leonel.r"],
    [46, "EM ANALISE DE RESSARCIMENTO", "t.darlan"],
    [54, "AGUARDANDO CLIENTE", "x"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

// --- Invariante 54-antes-da-46 (cliente notificado) ------------------------

Deno.test("null — SEM 54 antes da 46 (cliente nunca foi notificado)", () => {
  const h = hist(
    [49, "LANCAR 54 NOVAMENTE", "lucianaf"],
    [46, "EM ANALISE DE RESSARCIMENTO", "lucianaf"],
    [6, "EXTRAVIO 1 VOL", "jakson"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

Deno.test("null — tem 54 mas DEPOIS da 46 (ordem errada, não conta)", () => {
  // 54 mais recente que a 46 → a 54 exigida tem que ser ANTERIOR à 46.
  const h = hist(
    [49, "LANCAR 54 NOVAMENTE", "lucianaf"],
    [54, "AGUARDANDO CLIENTE", "x"],
    [46, "EM ANALISE DE RESSARCIMENTO", "lucianaf"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

// --- Última oc codificada tem que ser a 49 ---------------------------------

Deno.test("null — já veio oc codificada DEPOIS da 49 (caso já andou)", () => {
  const h = hist(
    [54, "AGUARDANDO CLIENTE (relançada)", "larissa"],
    [49, "LANCAR 54 NOVAMENTE", "lucianaf"],
    [46, "EM ANALISE DE RESSARCIMENTO", "lucianaf"],
    [54, "AGUARDANDO CLIENTE", "x"],
  );
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

Deno.test("null — sem 46 no histórico", () => {
  const h = hist([49, "LANCAR 54 NOVAMENTE", "x"], [54, "AG CLIENTE", "y"], [10, "AVARIA", "z"]);
  assertEquals(detectarRessarcimentoRelancar54(h), null);
});

Deno.test("null — histórico vazio", () => {
  assertEquals(detectarRessarcimentoRelancar54([]), null);
});

// --- Sub-caso Tier B-DV (Fase 2, NF 66193): pedir descrição/valor -----------
const dossieRomaneioSo = { romaneio: { presente: true }, descricao: { presente: false }, valor: { presente: false } };
const dossieCompleto = { romaneio: { presente: true }, descricao: { presente: true }, valor: { presente: true } };

Deno.test("Tier B-DV — 49 'FALTA DESCRICAO/VALOR' + dossiê romaneio-only → sugere", () => {
  assert(detectarPedirDescricaoValor("FALTA DESCRICAO DE ITENS E VALOR", dossieRomaneioSo));
  assert(detectarPedirDescricaoValor("Favor enviar valor dos itens", dossieRomaneioSo));
});

Deno.test("Tier B-DV — dossiê COMPLETO → NÃO sugere (já tem tudo)", () => {
  assertEquals(detectarPedirDescricaoValor("FALTA DESCRICAO/VALOR", dossieCompleto), false);
});

Deno.test("Tier B-DV — sem romaneio no dossiê → NÃO sugere (pede pelo fluxo normal)", () => {
  const semRomaneio = { romaneio: { presente: false }, descricao: { presente: false }, valor: { presente: false } };
  assertEquals(detectarPedirDescricaoValor("FALTA DESCRICAO", semRomaneio), false);
});

Deno.test("Tier B-DV — 49 NÃO pede docs (ex.: LANCAR 54) → NÃO é este sub-caso", () => {
  assertEquals(detectarPedirDescricaoValor("LANCAR 54 NOVAMENTE", dossieRomaneioSo), false);
});

Deno.test("Tier B-DV — dossiê null / instrução vazia → false", () => {
  assertEquals(detectarPedirDescricaoValor("FALTA DESCRICAO", null), false);
  assertEquals(detectarPedirDescricaoValor("", dossieRomaneioSo), false);
});

// --- Guard autoritativo do executor: B-DV 54+email nunca vira 54 sem e-mail ---
Deno.test("deveBloquear54PedirDescValor: B-DV SEM destinatário → BLOQUEIA (não lança 54)", () => {
  assert(deveBloquear54PedirDescValor("lancar_oc_e_enviar_email", ORIGEM_PEDIR_DESCRICAO_VALOR, false));
});

Deno.test("deveBloquear54PedirDescValor: B-DV COM destinatário → libera", () => {
  assertEquals(deveBloquear54PedirDescValor("lancar_oc_e_enviar_email", ORIGEM_PEDIR_DESCRICAO_VALOR, true), false);
});

Deno.test("deveBloquear54PedirDescValor: outra origem / outro tool → não bloqueia (só o B-DV)", () => {
  // 54 sem email (tool diferente) não é este guard
  assertEquals(deveBloquear54PedirDescValor("lancar_ocorrencia", ORIGEM_PEDIR_DESCRICAO_VALOR, false), false);
  // 54+email de outra origem (regra normal) não é bloqueado por aqui
  assertEquals(deveBloquear54PedirDescValor("lancar_oc_e_enviar_email", "vinculador_pos_resposta_cliente", false), false);
  assertEquals(deveBloquear54PedirDescValor("lancar_oc_e_enviar_email", undefined, false), false);
});
