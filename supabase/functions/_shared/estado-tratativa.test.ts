import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  estadoDentroDoTeto,
  estadoParaPrompt,
  hashFontes,
  montarEstado,
  type FontesEstado,
} from "./estado-tratativa.ts";
import { validarSugestaoContraEstado } from "./estado-tratativa-cerca.ts";
import { atribuirCiclo, EVENTOS_ABERTURA_CICLO } from "./ciclos-tratativa.ts";

const base = (over: Partial<FontesEstado> = {}): FontesEstado => ({
  cardState: "AGUARDANDO_VALIDACAO_HUMANA",
  codUltimaOcorrencia: 10,
  clienteRespondeuEm: null,
  historicoSsw: [
    { codigo: 10, instrucao: "RECUSA TOTAL - AVARIA", data: "2026-09-15T13:00:00Z" },
    { codigo: 14, instrucao: "ENTREGA INICIADA", data: "2026-09-15T09:00:00Z" },
  ],
  historicoAtualizadoEm: "2026-09-17T10:00:00Z",
  aberturasCicloIso: ["2026-09-15T13:30:00Z"],
  acoesExecutadas: [],
  ultimoEmailEnviadoEm: null,
  acaoAgendadaPendente: false,
  dossie: null,
  correcoes: [],
  infoExterna: [],
  baseEventId: "ev-1",
  baseEventAt: "2026-09-17T10:00:00Z",
  gatilho: "teste",
  agoraIso: "2026-09-17T12:00:00Z",
  ...over,
});

Deno.test("port dos ciclos é fiel (caso do Caio 25/08: 2 aberturas = ciclo 2)", () => {
  const ab = [Date.parse("2026-09-01"), Date.parse("2026-09-10")];
  assertEquals(atribuirCiclo(ab, [], Date.parse("2026-09-12")).ciclo, 2);
  assertEquals(atribuirCiclo(ab, [], Date.parse("2026-09-05")).ciclo, 1);
  assertEquals(EVENTOS_ABERTURA_CICLO.length, 5);
});

Deno.test("ja_feito_no_ciclo só conta ações DEPOIS da abertura do ciclo atual (classe NF 32346)", () => {
  const f = base({
    aberturasCicloIso: ["2026-07-01T00:00:00Z", "2026-09-15T19:00:00Z"],
    acoesExecutadas: [
      { id: "a1", codigo_oc: 54, iniciado_em: "2026-07-08T10:00:00Z", sucesso: true },  // ciclo 1
      { id: "a2", codigo_oc: 21, iniciado_em: "2026-09-16T10:00:00Z", sucesso: true },  // ciclo 2
    ],
  });
  const e = montarEstado(f, null);
  assertEquals(e.ciclo_atual.n, 2);
  assertEquals(e.ja_feito_no_ciclo.map((a) => a.codigo_oc), [21]);
  assertEquals(e.ciclos_anteriores, [{ n: 1, acoes: [54] }]);
});

Deno.test("rev é monotônica e recompute é idempotente no hash", () => {
  const f = base();
  const e1 = montarEstado(f, null);
  const e2 = montarEstado(f, e1);
  assertEquals(e1.rev, 1);
  assertEquals(e2.rev, 2);
  assertEquals(e1.hash_fontes, e2.hash_fontes);           // mesmas fontes = mesmo hash
  assertEquals(hashFontes(f), e1.hash_fontes);
});

Deno.test("correção do operador remove fato e info externa vira fato fonte operador (D5)", () => {
  const f0 = base({ dossie: { romaneio: true, descricao: false, valor: false, completo: false } });
  const e0 = montarEstado(f0, null);
  const fatoRomaneio = e0.fatos_confirmados.find((x) => x.fato === "doc_romaneio_recebido");
  assert(fatoRomaneio);
  const f1 = base({
    dossie: f0.dossie,
    correcoes: [{ op: "remover_fato", fato_id: fatoRomaneio!.id, em: "2026-09-17T12:30:00Z", por: "operador:isadora" }],
    infoExterna: [{ texto: "cliente ligou e autorizou parcial", por: "operador:julia", em: "2026-09-17T12:31:00Z" }],
  });
  const e1 = montarEstado(f1, e0);
  assert(!e1.fatos_confirmados.some((x) => x.id === fatoRomaneio!.id));
  const info = e1.fatos_confirmados.find((x) => x.fato === "info_externa");
  assertEquals(info?.origem, "operador");
  assertEquals(e1.pendencias_dossie, ["falta_descricao_itens", "falta_valor_itens"]);
});

Deno.test("estado cabe no teto e o bloco de prompt é compacto", () => {
  const e = montarEstado(base(), null);
  assert(estadoDentroDoTeto(e));
  assert(estadoParaPrompt(e).length <= 3200);
});

// ── cerca (porteiro) ──────────────────────────────────────────────────────────
Deno.test("cerca: sem estado = passa (anti-regressão)", () => {
  assertEquals(validarSugestaoContraEstado(null, { acaoKey: "x", codigoOc: 54, enviaEmail: true }).ok, true);
});

Deno.test("cerca: repetiu oc com sucesso no ciclo → bloqueia (INV-094 generalizada)", () => {
  const e = montarEstado(base({
    acoesExecutadas: [{ id: "a9", codigo_oc: 54, iniciado_em: "2026-09-16T10:00:00Z", sucesso: true }],
  }), null);
  const r = validarSugestaoContraEstado(e, { acaoKey: "lancar_oc_e_enviar_email:54", codigoOc: 54, enviaEmail: true });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "repetiu_acao_no_ciclo");
  // oc diferente passa
  assertEquals(validarSugestaoContraEstado(e, { acaoKey: "lancar_ocorrencia:21", codigoOc: 21, enviaEmail: false }).ok, true);
});

Deno.test("cerca: 59+email com dossiê completo → pediu_doc_ja_recebido (classe NF 1508990)", () => {
  const e = montarEstado(base({ dossie: { romaneio: true, descricao: true, valor: true, completo: true } }), null);
  const r = validarSugestaoContraEstado(e, { acaoKey: "lancar_oc_e_enviar_email:59", codigoOc: 59, enviaEmail: true });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "pediu_doc_ja_recebido");
  // com pendência ainda aberta, o pedido é legítimo
  const e2 = montarEstado(base({ dossie: { romaneio: true, descricao: false, valor: false, completo: false } }), null);
  assertEquals(validarSugestaoContraEstado(e2, { acaoKey: "lancar_oc_e_enviar_email:59", codigoOc: 59, enviaEmail: true }).ok, true);
});

Deno.test("cerca: 55 sem reentrega em aberto → bloqueia (R5 generalizada, classe NF 26033)", () => {
  const e = montarEstado(base(), null); // histórico 14→10, sem 21/EMITIDO PARA REENTREGA
  assert(e.alertas.includes("oc55_sem_reentrega_aberta"));
  const r = validarSugestaoContraEstado(e, { acaoKey: "lancar_ocorrencia:55", codigoOc: 55, enviaEmail: false });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.motivo, "oc55_sem_reentrega_aberta");
  // com reentrega em aberto (21 sem andamento depois), 55 passa
  const e2 = montarEstado(base({
    historicoSsw: [
      { codigo: 21, instrucao: "REENTREGA SOLICITADA", data: "2026-09-16T10:00:00Z" },
      { codigo: 10, instrucao: "RECUSA", data: "2026-09-15T13:00:00Z" },
    ],
  }), null);
  assertEquals(validarSugestaoContraEstado(e2, { acaoKey: "lancar_ocorrencia:55", codigoOc: 55, enviaEmail: false }).ok, true);
});
