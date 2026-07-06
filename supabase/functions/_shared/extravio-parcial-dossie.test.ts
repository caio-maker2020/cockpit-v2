// Testes do dossiê + gate da oc 33 no extravio parcial.
// Caio 2026-07-01 (NF 66193 INOVAMED / Larissa). Rodar:
//   deno test supabase/functions/_shared/extravio-parcial-dossie.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acharAnexoInbound,
  aplicarGateOc33Parcial,
  avaliarDossie,
  classificarOc33,
  corpoContemTrecho,
  decidirAcaoRomaneioCompletude,
  decidirGateOc33,
  detectarRomaneioNoHistorico,
  deveProcessarDossie,
  dossieVazio,
  ehExtravioParcial,
  lerExtravioParcial,
  marcarDossie,
  mergeEvidencia,
  mesclarExtravioParcial,
  montarEvidenciasRecebidas,
  montarSeedRomaneio,
  montarTextoDescricaoValor,
  NOTA_ROMANEIO_PROCESSUAL,
  prepararTextoOc33,
  romaneioAceitoPorRessarcimento,
  ROTULO_EVIDENCIA,
  type AnexoHistorico,
  type MensagemHistorico,
  type OcHistSsw,
} from "./extravio-parcial-dossie.ts";

const REF = { message_inbox_id: "m1", gmail_message_id: "g1", visto_em: "2026-07-01T00:00:00Z" };

// ---------------------------------------------------------------------------
// avaliarDossie — 0/1/2/3 evidências
// ---------------------------------------------------------------------------
Deno.test("avaliarDossie: 0 evidências → incompleto, faltam as 3 na ordem", () => {
  const av = avaliarDossie(dossieVazio());
  assertEquals(av.completo, false);
  assertEquals(av.faltando, [
    ROTULO_EVIDENCIA.romaneio,
    ROTULO_EVIDENCIA.descricao,
    ROTULO_EVIDENCIA.valor,
  ]);
});

Deno.test("avaliarDossie: só romaneio → faltam descrição e valor", () => {
  const d = mergeEvidencia(dossieVazio(), { romaneio: { filename: "romaneio.pdf" } });
  const av = avaliarDossie(d);
  assertEquals(av.completo, false);
  assertEquals(av.faltando, [ROTULO_EVIDENCIA.descricao, ROTULO_EVIDENCIA.valor]);
});

Deno.test("avaliarDossie: romaneio + descrição (falta valor) → incompleto", () => {
  let d = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  d = mergeEvidencia(d, { descricao: { fonte: "corpo", texto_bruto: "2 caixas paracetamol" } });
  const av = avaliarDossie(d);
  assertEquals(av.completo, false);
  assertEquals(av.faltando, [ROTULO_EVIDENCIA.valor]);
});

Deno.test("avaliarDossie: as 3 → completo, faltando vazio", () => {
  let d = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  d = mergeEvidencia(d, { descricao: { fonte: "corpo", texto_bruto: "itens..." } });
  d = mergeEvidencia(d, { valor: { fonte: "corpo", texto_bruto: "R$900,00" } });
  const av = avaliarDossie(d);
  assertEquals(av.completo, true);
  assertEquals(av.faltando, []);
});

// ---------------------------------------------------------------------------
// mergeEvidencia — idempotente, monotônico, sobrescreve referência
// ---------------------------------------------------------------------------
Deno.test("mergeEvidencia: idempotente — reaplicar a mesma evidência não muda completude", () => {
  const d1 = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  const d2 = mergeEvidencia(d1, { romaneio: { filename: "r.pdf" } });
  assertEquals(d2.romaneio.presente, true);
  assertEquals(d2.completo, false);
});

Deno.test("mergeEvidencia: monotônico — evidência já recebida não some se e-mail posterior não a repete", () => {
  let d = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  // e-mail seguinte traz só a descrição — romaneio deve permanecer presente
  d = mergeEvidencia(d, { descricao: { fonte: "corpo", texto_bruto: "..." } });
  assertEquals(d.romaneio.presente, true);
  assertEquals(d.descricao.presente, true);
});

Deno.test("mergeEvidencia: sobrescreve referência (última fonte vence) sem perder presente", () => {
  let d = mergeEvidencia(dossieVazio(), { romaneio: { filename: "antigo.pdf", size_bytes: 100 } });
  d = mergeEvidencia(d, { romaneio: { filename: "corrigido.pdf", size_bytes: 200 } });
  assertEquals(d.romaneio.presente, true);
  assertEquals(d.romaneio.filename, "corrigido.pdf");
  assertEquals(d.romaneio.size_bytes, 200);
});

Deno.test("mergeEvidencia: null/undefined não altera o dossiê", () => {
  const base = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  assertEquals(mergeEvidencia(base, null).completo, base.completo);
  assertEquals(mergeEvidencia(base, {}).romaneio.presente, true);
});

Deno.test("mergeEvidencia: não muta a entrada (pureza)", () => {
  const base = dossieVazio();
  mergeEvidencia(base, { romaneio: { filename: "r.pdf" } });
  assertEquals(base.romaneio.presente, false);
});

// ---------------------------------------------------------------------------
// ehExtravioParcial / lerExtravioParcial
// ---------------------------------------------------------------------------
Deno.test("ehExtravioParcial: card sem agent_state → false (extravio total intacto)", () => {
  assertEquals(ehExtravioParcial(null), false);
  assertEquals(ehExtravioParcial({}), false);
  assertEquals(ehExtravioParcial({ agent_state: {} }), false);
  assertEquals(ehExtravioParcial({ agent_state: { chave_cte: "x" } }), false);
});

Deno.test("ehExtravioParcial: só true quando extravio_parcial.caso está setado", () => {
  assertEquals(ehExtravioParcial({ agent_state: { extravio_parcial: { caso: "1", dossie: dossieVazio() } } }), true);
  assertEquals(ehExtravioParcial({ agent_state: { extravio_parcial: { dossie: dossieVazio() } } }), false);
});

Deno.test("lerExtravioParcial: preenche dossiê com defaults", () => {
  const st = lerExtravioParcial({ agent_state: { extravio_parcial: { caso: "2" } } });
  assert(st !== null);
  assertEquals(st!.caso, "2");
  assertEquals(st!.dossie.completo, false);
  assertEquals(st!.dossie.oc33_operacional_lancada, false);
});

// ---------------------------------------------------------------------------
// classificarOc33 — nos 3 shapes de proposta
// ---------------------------------------------------------------------------
Deno.test("classificarOc33: combo é OPERACIONAL só no Caso 2 (Ajuste blocker 1)", () => {
  const combo = { codigo_ssw: 33, tipo_acao: "combo_33_44", tool: "lancar_combo_33_44" };
  assertEquals(classificarOc33(combo, "2"), "operacional"); // Caso 2 → operacional
  assertEquals(classificarOc33(combo, "1"), "completude"); // Caso 1 → completude (nunca romaneio-only)
  assertEquals(classificarOc33(combo, null), "completude"); // fallback conservador
  assertEquals(classificarOc33(combo), "completude"); // sem caso → conservador
});

Deno.test("classificarOc33: oc33 solo é sempre completude; não-oc33 é null", () => {
  assertEquals(classificarOc33({ codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" }, "2"), "completude");
  assertEquals(classificarOc33({ codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" }, "1"), "completude");
  assertEquals(classificarOc33({ codigo_ssw: 44 }, "2"), null);
  assertEquals(classificarOc33({ codigo_ssw: 54, tipo_acao: "relancamento_54" }, "1"), null);
});

Deno.test("classificarOc33: regras-auto-acao (codigo_ssw_proposto + tool_override) sempre completude", () => {
  assertEquals(classificarOc33({ codigo_ssw_proposto: 33 }, "1"), "completude");
  assertEquals(
    classificarOc33({ codigo_ssw_proposto: 33, tool_override: "enviar_email_livre_e_lancar_oc33_portal" }, "2"),
    "completude",
  );
  assertEquals(
    classificarOc33({ codigo_ssw_proposto: 33, tool_override: "enviar_email_e_lancar_33_romaneio_interno" }, "1"),
    "completude",
  );
});

Deno.test("classificarOc33: proposta_payload persistido respeita o caso", () => {
  const comboPayload = { proposta_payload: { tool: "lancar_combo_33_44", args: { codigo_ssw: 33 }, meta: { tipo_acao: "combo_33_44" } } };
  assertEquals(classificarOc33(comboPayload, "2"), "operacional");
  assertEquals(classificarOc33(comboPayload, "1"), "completude");
  assertEquals(
    classificarOc33({ proposta_payload: { tool: "lancar_oc33_solo_portal", args: { codigo_ssw: 33 } } }, "2"),
    "completude",
  );
});

// ---------------------------------------------------------------------------
// decidirGateOc33 — operacional × completude
// ---------------------------------------------------------------------------
Deno.test("decidirGateOc33 completude: bloqueia até dossiê completo", () => {
  assertEquals(decidirGateOc33("completude", dossieVazio()).bloqueada, true);
  const cheio = mergeEvidencia(
    mergeEvidencia(mergeEvidencia(dossieVazio(), { romaneio: {} }), { descricao: {} }),
    { valor: {} },
  );
  assertEquals(decidirGateOc33("completude", cheio).bloqueada, false);
});

Deno.test("decidirGateOc33 operacional (Caso 2): exige SÓ romaneio", () => {
  assertEquals(decidirGateOc33("operacional", dossieVazio()).bloqueada, true);
  const soRomaneio = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  const d = decidirGateOc33("operacional", soRomaneio);
  assertEquals(d.bloqueada, false); // combo operacional roda com romaneio só
  assertEquals(d.faltando, []);
});

// ---------------------------------------------------------------------------
// aplicarGateOc33Parcial — choke-point
// ---------------------------------------------------------------------------
Deno.test("gate: card NÃO parcial (extravio total) → tudo passa intacto", () => {
  const propostas = [{ codigo_ssw: 33, tipo_acao: "oc33_solo" }, { codigo_ssw: 44 }];
  const res = aplicarGateOc33Parcial(propostas, /*ehParcial*/ false, dossieVazio());
  assert(res.every((r) => r.bloqueada === false));
});

Deno.test("gate: parcial + dossiê incompleto → 33 completude bloqueada, faltando as 3, resto livre", () => {
  const propostas = [
    { codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" },
    { codigo_ssw: 55 },
    { codigo_ssw: 44 },
  ];
  const res = aplicarGateOc33Parcial(propostas, true, dossieVazio());
  const oc33 = res.find((r) => r.natureza === "completude")!;
  assertEquals(oc33.bloqueada, true);
  assertEquals(oc33.faltando.length, 3);
  // 55 e 44 nunca bloqueiam
  assert(res.filter((r) => r.natureza === null).every((r) => r.bloqueada === false));
});

Deno.test("gate: parcial + dossiê completo → 33 completude liberada", () => {
  const cheio = mergeEvidencia(
    mergeEvidencia(mergeEvidencia(dossieVazio(), { romaneio: {} }), { descricao: {} }),
    { valor: {} },
  );
  const res = aplicarGateOc33Parcial([{ codigo_ssw: 33, tipo_acao: "oc33_solo" }], true, cheio);
  assertEquals(res[0]!.bloqueada, false);
});

Deno.test("gate: CASO 2 + só romaneio + combo 33+44 → LIBERADO (operacional)", () => {
  const soRomaneio = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  const propostas = [
    { codigo_ssw: 33, tipo_acao: "combo_33_44", tool: "lancar_combo_33_44" },
    { codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" },
  ];
  const res = aplicarGateOc33Parcial(propostas, true, soRomaneio, "2");
  const operacional = res.find((r) => r.natureza === "operacional")!;
  const completude = res.find((r) => r.natureza === "completude")!;
  assertEquals(operacional.bloqueada, false); // combo operacional roda com romaneio só
  assertEquals(completude.bloqueada, true);
  assertEquals(completude.faltando, [ROTULO_EVIDENCIA.descricao, ROTULO_EVIDENCIA.valor]);
});

Deno.test("gate: CASO 1 + só romaneio + combo 33+44 → BLOQUEADO (combo vira completude)", () => {
  const soRomaneio = mergeEvidencia(dossieVazio(), { romaneio: { filename: "r.pdf" } });
  const propostas = [{ codigo_ssw: 33, tipo_acao: "combo_33_44", tool: "lancar_combo_33_44" }];
  const res = aplicarGateOc33Parcial(propostas, true, soRomaneio, "1");
  assertEquals(res[0]!.natureza, "completude"); // Caso 1 nunca libera combo com romaneio só
  assertEquals(res[0]!.bloqueada, true);
  assertEquals(res[0]!.faltando, [ROTULO_EVIDENCIA.descricao, ROTULO_EVIDENCIA.valor]);
});

Deno.test("gate: CASO 1 + dossiê completo + oc33 solo → LIBERADO", () => {
  const cheio = mergeEvidencia(
    mergeEvidencia(mergeEvidencia(dossieVazio(), { romaneio: {} }), { descricao: {} }),
    { valor: {} },
  );
  const res = aplicarGateOc33Parcial(
    [{ codigo_ssw: 33, tipo_acao: "oc33_solo", tool: "lancar_oc33_solo_portal" }],
    true,
    cheio,
    "1",
  );
  assertEquals(res[0]!.natureza, "completude");
  assertEquals(res[0]!.bloqueada, false);
});

Deno.test("gate: extravio TOTAL (ehParcial=false) → oc33/combo passam intactos, qualquer caso", () => {
  const propostas = [
    { codigo_ssw: 33, tipo_acao: "combo_33_44", tool: "lancar_combo_33_44" },
    { codigo_ssw: 33, tipo_acao: "oc33_solo" },
  ];
  const res = aplicarGateOc33Parcial(propostas, /*ehParcial*/ false, dossieVazio(), null);
  assert(res.every((r) => r.bloqueada === false));
});

// ---------------------------------------------------------------------------
// Validação determinística de evidência (blocker 2 / auditoria Codex)
// ---------------------------------------------------------------------------
Deno.test("corpoContemTrecho: trecho real no corpo → true; ausente/trivial → false", () => {
  const corpo = "Segue a descrição: item 1 paracetamol 30un R$300,00. Att.";
  assert(corpoContemTrecho("item 1 paracetamol 30un R$300,00", corpo));
  assert(corpoContemTrecho("ITEM 1   Paracetamol  30un", corpo)); // normalização caixa+espaço
  assertEquals(corpoContemTrecho("dipirona 50un", corpo), false); // não existe no corpo
  assertEquals(corpoContemTrecho("", corpo), false);
  assertEquals(corpoContemTrecho("ab", corpo), false); // trivial (<3)
});

Deno.test("acharAnexoInbound: match real; inexistente → null", () => {
  const anexos = [{ filename: "romaneio_assinado.pdf", mime_type: "application/pdf", size_bytes: 1234 }];
  assert(acharAnexoInbound("romaneio_assinado.pdf", anexos) !== null);
  assert(acharAnexoInbound("ROMANEIO_ASSINADO.PDF", anexos) !== null); // case-insensitive
  assert(acharAnexoInbound("romaneio", anexos) !== null); // substring
  assertEquals(acharAnexoInbound("planilha_inventada.xlsx", anexos), null);
  assertEquals(acharAnexoInbound(undefined, anexos), null);
});

Deno.test("montarEvidenciasRecebidas: descrição verbatim PRESENTE no corpo → aceita", () => {
  const corpo = "Itens faltantes: paracetamol 30un no valor de R$300,00";
  const ev = montarEvidenciasRecebidas(
    { descricao: { fonte: "corpo", trecho_verbatim: "paracetamol 30un" } },
    [],
    corpo,
    REF,
  );
  assert(ev.descricao != null);
  assertEquals(ev.descricao!.fonte, "corpo");
  assertEquals(ev.descricao!.texto_bruto, "paracetamol 30un");
});

Deno.test("montarEvidenciasRecebidas: trecho INVENTADO (não no corpo) → REJEITA", () => {
  const ev = montarEvidenciasRecebidas(
    { valor: { fonte: "corpo", trecho_verbatim: "R$ 9.999,00 inventado" } },
    [],
    "corpo do cliente sem esse valor",
    REF,
  );
  assertEquals(ev.valor, undefined); // não marca evidência inventada
});

Deno.test("montarEvidenciasRecebidas: anexo EXISTENTE → aceita; INEXISTENTE → rejeita", () => {
  const anexos = [{ filename: "itens.xlsx", mime_type: "application/vnd.ms-excel", size_bytes: 999 }];
  const ok = montarEvidenciasRecebidas({ descricao: { fonte: "anexo", anexo_filename: "itens.xlsx" } }, anexos, "", REF);
  assert(ok.descricao != null);
  assertEquals(ok.descricao!.fonte, "anexo");
  assertEquals(ok.descricao!.filename, "itens.xlsx");

  const bad = montarEvidenciasRecebidas({ descricao: { fonte: "anexo", anexo_filename: "nao_existe.pdf" } }, anexos, "", REF);
  assertEquals(bad.descricao, undefined);
});

Deno.test("montarEvidenciasRecebidas: romaneio SÓ com anexo real (filename inventado → rejeita)", () => {
  const anexos = [{ filename: "romaneio.pdf", mime_type: "application/pdf", size_bytes: 500 }];
  const ok = montarEvidenciasRecebidas({ romaneio: { anexo_filename: "romaneio.pdf" } }, anexos, "", REF);
  assert(ok.romaneio != null);

  const inventado = montarEvidenciasRecebidas({ romaneio: { anexo_filename: "romaneio_fantasma.pdf" } }, [], "", REF);
  assertEquals(inventado.romaneio, undefined); // nunca marca romaneio por filename inventado
});

// ---------------------------------------------------------------------------
// Fase 2 — mesclarExtravioParcial / marcarDossie / materialização (2ª oc 33)
// ---------------------------------------------------------------------------
Deno.test("deveProcessarDossie (blocker 1): processa se LLM marcou OU card já é parcial", () => {
  assertEquals(deveProcessarDossie(true, false), true); // LLM marcou
  assertEquals(deveProcessarDossie(false, true), true); // card já tem dossiê (reabertura)
  assertEquals(deveProcessarDossie(undefined, true), true); // LLM esqueceu, mas já é parcial
  assertEquals(deveProcessarDossie(false, false), false); // nenhum → não processa
  assertEquals(deveProcessarDossie(undefined, false), false);
});

Deno.test("mesclarExtravioParcial: copia dossiê do card pro snapshot; no-op sem dossiê", () => {
  const snapshot = { cod_ultima_ocorrencia: 49, chave_cte: null };
  const comDossie = { extravio_parcial: { caso: "2", dossie: dossieVazio() }, outro: 1 };
  const r = mesclarExtravioParcial(snapshot, comDossie);
  assertEquals((r["extravio_parcial"] as { caso: string }).caso, "2");
  assertEquals(r["cod_ultima_ocorrencia"], 49); // snapshot preservado
  // sem dossiê no card → snapshot intacto (sem contaminar)
  assertEquals(mesclarExtravioParcial(snapshot, { chave_cte: "x" })["extravio_parcial"], undefined);
  assertEquals(mesclarExtravioParcial(snapshot, null), snapshot);
});

Deno.test("marcarDossie: seta oc33_operacional_lancada/indenizacao_completa imutável; no-op sem dossiê", () => {
  const st = { extravio_parcial: { caso: "2", fase: "coletando", dossie: dossieVazio() }, chave_cte: "z" };
  const r1 = marcarDossie(st, { oc33_operacional_lancada: true });
  assertEquals((r1["extravio_parcial"] as { dossie: { oc33_operacional_lancada: boolean } }).dossie.oc33_operacional_lancada, true);
  assertEquals(r1["chave_cte"], "z"); // preserva resto do agent_state
  // não muta a entrada
  assertEquals((st.extravio_parcial.dossie as { oc33_operacional_lancada: boolean }).oc33_operacional_lancada, false);
  const r2 = marcarDossie(r1, { indenizacao_completa: true });
  assertEquals((r2["extravio_parcial"] as { dossie: { indenizacao_completa: boolean } }).dossie.indenizacao_completa, true);
  // card sem dossiê → no-op
  assertEquals(marcarDossie({ chave_cte: "a" }, { indenizacao_completa: true }), { chave_cte: "a" });
});

Deno.test("montarTextoDescricaoValor: junta só texto_bruto (fonte corpo); anexo fica de fora", () => {
  let d = mergeEvidencia(dossieVazio(), { descricao: { fonte: "corpo", texto_bruto: "paracetamol 30un" } });
  d = mergeEvidencia(d, { valor: { fonte: "corpo", texto_bruto: "R$300,00" } });
  const t = montarTextoDescricaoValor(d);
  assert(t.includes("paracetamol 30un") && t.includes("R$300,00"));
  // valor veio em anexo (texto_bruto null) → não entra no texto
  const d2 = mergeEvidencia(dossieVazio(), { valor: { fonte: "anexo", filename: "x.pdf" } });
  assertEquals(montarTextoDescricaoValor(d2), "");
});

Deno.test("prepararTextoOc33: cabe em 500 → inteiro; estoura → resumo + imagem", () => {
  const curto = prepararTextoOc33("descrição curta", "66193");
  assertEquals(curto.precisaImagem, false);
  assertEquals(curto.instrucao, "descrição curta");
  const grande = prepararTextoOc33("x".repeat(600), "66193");
  assertEquals(grande.precisaImagem, true);
  assertEquals(grande.textoParaImagem!.length, 600);
  assert(grande.instrucao.length <= 500 && /imagem/i.test(grande.instrucao));
});

Deno.test("montarEvidenciasRecebidas: dossiê NÃO completa com evidência inventada", () => {
  // LLM alega as 3, mas nada existe de fato → dossiê continua incompleto.
  const ev = montarEvidenciasRecebidas(
    {
      romaneio: { anexo_filename: "fantasma.pdf" },
      descricao: { fonte: "corpo", trecho_verbatim: "descrição que não está no corpo" },
      valor: { fonte: "corpo", trecho_verbatim: "R$ inventado" },
    },
    [],
    "corpo real do cliente sem nada disso",
    REF,
  );
  const d = mergeEvidencia(dossieVazio(), ev);
  assertEquals(avaliarDossie(d).completo, false);
});

// ===========================================================================
// Seed HISTÓRICO do romaneio (Codex 2026-07-02, NF 575330). Fixtures reais.
// ===========================================================================

const ANEXO_ROMANEIO_575330: AnexoHistorico[] = [
  { message_inbox_id: "mi_rom", filename: "NF 575330.pdf", mime_type: "application/pdf", size_bytes: 268338, origem: "inbound" },
];
const MSG_ENVIO_ROMANEIO: MensagemHistorico[] = [
  {
    message_inbox_id: "mi_rom",
    conteudo: "Boa tarde. Segue em anexo o romaneio assinado conforme foi solicitado abaixo.",
    remetente: "marcelo.amancio@hdlhospitalar.com.br",
    gmail_message_id: "gm1",
    gmail_thread_id: "gt1",
    operador_id: "op1",
    recebido_em: "2026-06-12T16:55:00Z",
  },
];

// Fixture 1 — 575330: anexo inbound + corpo "segue romaneio assinado" ⇒ romaneio presente por HISTÓRICO.
Deno.test("Nível 1 — 575330: anexo + 'segue romaneio assinado' ⇒ romaneio (fonte anexo, metadados p/ re-busca)", () => {
  const ref = detectarRomaneioNoHistorico(ANEXO_ROMANEIO_575330, MSG_ENVIO_ROMANEIO);
  assert(ref !== null);
  assertEquals(ref!.fonte, "anexo");
  assertEquals(ref!.message_inbox_id, "mi_rom");
  assertEquals(ref!.filename, "NF 575330.pdf");
  assertEquals(ref!.gmail_message_id, "gm1"); // emenda 2: carrega metadados
  assertEquals(ref!.operador_id, "op1");
  assertEquals(ref!.size_bytes, 268338);
  const d = mergeEvidencia(dossieVazio(), montarSeedRomaneio(ANEXO_ROMANEIO_575330, MSG_ENVIO_ROMANEIO, []));
  assertEquals(d.romaneio.presente, true);
  assertEquals(d.romaneio.fonte, "anexo");
});

// Fixture 4 — corpo é PEDIDO do romaneio ("aguardo") ⇒ NÃO marca (mesmo com anexo PDF).
Deno.test("Nível 1 — corpo 'aguardo o romaneio' (pedido) ⇒ NÃO marca", () => {
  const msgsPedido: MensagemHistorico[] = [
    { message_inbox_id: "mi_rom", conteudo: "Prezados, aguardo o romaneio assinado para dar andamento.", remetente: "cliente@hdlhospitalar.com.br", recebido_em: "2026-06-11T00:00:00Z" },
  ];
  assertEquals(detectarRomaneioNoHistorico(ANEXO_ROMANEIO_575330, msgsPedido), null);
});

// remetente @salexpress ⇒ NÃO marca (é o Sal escrevendo, não o cliente enviando).
Deno.test("Nível 1 — remetente @salexpress ⇒ NÃO marca", () => {
  const msgsSal: MensagemHistorico[] = [
    { message_inbox_id: "mi_rom", conteudo: "Segue o romaneio assinado em anexo.", remetente: "larissa.guimaraes@salexpress.com.br", recebido_em: "2026-06-12T00:00:00Z" },
  ];
  assertEquals(detectarRomaneioNoHistorico(ANEXO_ROMANEIO_575330, msgsSal), null);
});

// Fixture 5 — anexo com deletado_em setado + message_inbox_id ⇒ AINDA semeia (não filtra deletado_em).
Deno.test("Nível 1 — anexo deletado (deletado_em setado) AINDA semeia evidência histórica", () => {
  const anexoDeletado: AnexoHistorico[] = [
    { ...ANEXO_ROMANEIO_575330[0]!, deletado_em: "2026-06-12T18:44:00Z" },
  ];
  const ref = detectarRomaneioNoHistorico(anexoDeletado, MSG_ENVIO_ROMANEIO);
  assert(ref !== null);
  assertEquals(ref!.message_inbox_id, "mi_rom"); // reprocessável via message_inbox_id
});

// mime não-documento (ex.: texto) ⇒ NÃO marca.
Deno.test("Nível 1 — anexo não-PDF/imagem ⇒ NÃO marca", () => {
  const anexoTxt: AnexoHistorico[] = [
    { message_inbox_id: "mi_rom", filename: "nota.txt", mime_type: "text/plain", size_bytes: 100, origem: "inbound" },
  ];
  assertEquals(detectarRomaneioNoHistorico(anexoTxt, MSG_ENVIO_ROMANEIO), null);
});

// Codex 2026-07-02: "romaneio de coleta" isolado (não é "assinado" nem tem envio
// perto) + anti-pedido "precisamos" ⇒ NÃO marca. [teste obrigatório]
Deno.test("Nível 1 — 'segue NF em anexo, precisamos do romaneio de coleta' + PDF ⇒ NÃO marca", () => {
  const msgs: MensagemHistorico[] = [
    { message_inbox_id: "mi_rom", conteudo: "Prezados, segue NF em anexo, precisamos do romaneio de coleta para dar andamento.", remetente: "cliente@fg.com.br", recebido_em: "2026-06-30T00:00:00Z" },
  ];
  assertEquals(detectarRomaneioNoHistorico(ANEXO_ROMANEIO_575330, msgs), null);
});

// Controle POSITIVO: envio-verbo perto de romaneio (sem pedido) ⇒ AINDA marca
// (a tightening não pode matar o envio legítimo de "romaneio de coleta").
Deno.test("Nível 1 — 'encaminho o romaneio de coleta em anexo' (envio) ⇒ marca", () => {
  const msgs: MensagemHistorico[] = [
    { message_inbox_id: "mi_rom", conteudo: "Boa tarde, encaminho o romaneio de coleta em anexo.", remetente: "cliente@fg.com.br", recebido_em: "2026-06-30T00:00:00Z" },
  ];
  assert(detectarRomaneioNoHistorico(ANEXO_ROMANEIO_575330, msgs) !== null);
});

const HIST_575330: OcHistSsw[] = [
  { codigo: 54, usuario: "ai.salex", instrucao: "AGUARDANDO RETORNO DO CLIENTE PAGADOR", data: "01/07/26 10:06" },
  { codigo: 49, usuario: "marianab", instrucao: "DESCRICAO E VALOR", data: "30/06/26 15:58" },
  { codigo: 46, usuario: "marianab", instrucao: "EM ANALISE DE RESSARCIMENTO", data: "30/06/26 15:56" },
  { codigo: 33, usuario: "l.silva", instrucao: "REVERSAO DE PERDAS INICIADA", data: "12/06/26 15:42" },
  { codigo: 19, usuario: "silvmatb", instrucao: "ENTREGA REALIZADA COM FALTA DE VOLUMES", data: "11/06/26 15:48" },
];
const HIST_66193: OcHistSsw[] = [
  { codigo: 33, usuario: "l.silva", instrucao: "REVERSAO DE PERDAS INICIADA", data: "01/07/26 17:52" },
  { codigo: 54, usuario: "ai.salex", instrucao: "AGUARDANDO RETORNO DO CLIENTE PAGADOR", data: "01/07/26 10:01" },
  { codigo: 49, usuario: "marianab", instrucao: "DESCRICAO, VALOR E ROMANEIO", data: "30/06/26 17:40" },
  { codigo: 46, usuario: "marianab", instrucao: "EM ANALISE DE RESSARCIMENTO", data: "30/06/26 17:38" },
  { codigo: 33, usuario: "l.silva", instrucao: "REVERSAO DE PERDAS INICIADA. CLIENTE NOTIFICADO.", data: "16/06/26 09:14" },
  { codigo: 19, usuario: "costales", instrucao: "ENTREGA REALIZADA COM FALTA DE VOLUMES", data: "09/06/26 20:11" },
];

// Fixture 3 — oc 33 + oc 49 "descrição e valor" (ctx Ressarcimento) ⇒ romaneio ACEITO por SSW (fonte ssw).
Deno.test("Nível 2 — 575330: oc33 + oc49 'DESCRICAO E VALOR' (marianab+46) ⇒ romaneio aceito (fonte ssw)", () => {
  const r = romaneioAceitoPorRessarcimento(HIST_575330);
  assertEquals(r.aceito, true);
  assertEquals(r.oc33?.data, "12/06/26 15:42");
  assertEquals(r.oc49?.data, "30/06/26 15:58");
  const seed = montarSeedRomaneio([], [], HIST_575330);
  assertEquals(seed.romaneio?.fonte, "ssw");
  const d = mergeEvidencia(dossieVazio(), seed);
  assertEquals(d.romaneio.presente, true);
  assertEquals(d.romaneio.fonte, "ssw");
});

// Fixture 2 — 66193: oc 49 pede "descrição, valor E ROMANEIO" ⇒ NÃO marca romaneio por SSW.
Deno.test("Nível 2 — 66193: oc49 'DESCRICAO, VALOR E ROMANEIO' ⇒ NÃO aceito (menciona romaneio)", () => {
  assertEquals(romaneioAceitoPorRessarcimento(HIST_66193).aceito, false);
  assertEquals(montarSeedRomaneio([], [], HIST_66193), {});
});

// Conservador: sem contexto Ressarcimento (oc 49 sem oc 46 do mesmo usuário) ⇒ NÃO aceito.
Deno.test("Nível 2 — oc49 desc/valor mas SEM oc46 do mesmo usuário ⇒ NÃO aceito", () => {
  const hist: OcHistSsw[] = [
    { codigo: 49, usuario: "fulano", instrucao: "DESCRICAO E VALOR", data: "30/06/26 10:00" },
    { codigo: 33, usuario: "l.silva", instrucao: "REVERSAO", data: "12/06/26 10:00" },
  ];
  assertEquals(romaneioAceitoPorRessarcimento(hist).aceito, false);
});

// Conservador: sem oc 33 anterior ⇒ NÃO aceito.
Deno.test("Nível 2 — oc49 desc/valor + oc46 mas SEM oc33 anterior ⇒ NÃO aceito", () => {
  const hist: OcHistSsw[] = [
    { codigo: 49, usuario: "marianab", instrucao: "DESCRICAO E VALOR", data: "30/06/26 15:58" },
    { codigo: 46, usuario: "marianab", instrucao: "EM ANALISE DE RESSARCIMENTO", data: "30/06/26 15:56" },
  ];
  assertEquals(romaneioAceitoPorRessarcimento(hist).aceito, false);
});

// Codex 2026-07-02: oc46 do MESMO usuário mas FORA do ciclo — a oc33 está ENTRE a
// 49 e a 46 (ordem mais-recente-1º: 49 → 33 → 46), logo não há oc33 DEPOIS da 46
// ⇒ NÃO aceita. [teste obrigatório — impede o antigo .some() de casar 46 de ciclo antigo]
Deno.test("Nível 2 — oc49 desc/valor + oc33 + oc46 antiga fora do ciclo ⇒ NÃO aceita", () => {
  const hist: OcHistSsw[] = [
    { codigo: 49, usuario: "marianab", instrucao: "DESCRICAO E VALOR", data: "30/06/26 15:58" },
    { codigo: 33, usuario: "l.silva", instrucao: "REVERSAO DE PERDAS INICIADA", data: "16/06/26 09:00" },
    { codigo: 46, usuario: "marianab", instrucao: "EM ANALISE DE RESSARCIMENTO", data: "10/06/26 08:00" },
  ];
  assertEquals(romaneioAceitoPorRessarcimento(hist).aceito, false);
});

// Precedência: Nível 1 (anexo) vence Nível 2 (ssw) quando ambos existem.
Deno.test("montarSeedRomaneio — Nível 1 (anexo) tem precedência sobre Nível 2 (ssw)", () => {
  const seed = montarSeedRomaneio(ANEXO_ROMANEIO_575330, MSG_ENVIO_ROMANEIO, HIST_575330);
  assertEquals(seed.romaneio?.fonte, "anexo");
});
Deno.test("montarSeedRomaneio — nenhum sinal ⇒ {} (merge no-op, monotônico)", () => {
  assertEquals(montarSeedRomaneio([], [], []), {});
});

// ===========================================================================
// Emenda 1 — decidirAcaoRomaneioCompletude: ação depende da FONTE.
// ===========================================================================
Deno.test("decidirAcaoRomaneioCompletude — fonte 'ssw' ⇒ processual (NÃO reanexa, NÃO bloqueia)", () => {
  const d = { ...dossieVazio(), romaneio: { presente: true, fonte: "ssw" as const } };
  const a = decidirAcaoRomaneioCompletude(d);
  assertEquals(a.tipo, "processual");
  assert(a.tipo === "processual" && a.nota === NOTA_ROMANEIO_PROCESSUAL);
});
Deno.test("decidirAcaoRomaneioCompletude — fonte 'anexo' ⇒ reanexar (bloqueia se falhar)", () => {
  const d = { ...dossieVazio(), romaneio: { presente: true, fonte: "anexo" as const, message_inbox_id: "x" } };
  assertEquals(decidirAcaoRomaneioCompletude(d).tipo, "reanexar");
});
Deno.test("decidirAcaoRomaneioCompletude — presente sem fonte / ausente ⇒ nenhuma (conservador, não inventa)", () => {
  const semFonte = { ...dossieVazio(), romaneio: { presente: true } };
  assertEquals(decidirAcaoRomaneioCompletude(semFonte).tipo, "nenhuma");
  assertEquals(decidirAcaoRomaneioCompletude(dossieVazio()).tipo, "nenhuma");
});
