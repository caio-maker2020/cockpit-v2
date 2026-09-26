// Guard — worker dos pedidos da operação (ADR 0035, D2/D5; INV-159; INV-161).
// O "mundo" em memória reproduz a semântica das RPCs da mig 411 (reserva com
// janela de 60 s e teto, finalizar só `recebido`, expirar, vincular). Trava:
//   - VAZÃO: nunca mais de LIMITE por janela de 60 s, nem com chamadas paralelas,
//     nem com limite errado (teto 3); login recusado → quarentena de 30 min;
//   - idempotência: o mesmo pedido nunca vai ao SSW 2x; lançamento interrompido
//     vira erro e NÃO é relançado; duplicidade entre pedidos e com o executor;
//   - flags OFF: nada roda / nada chega ao SSW; kill-switch no meio da rodada;
//   - nascimento do card: só com dado do Bastão e sem ferir INV-006/017/040;
//   - CTRC e NF do SSW vêm do CARD; texto leva quem pediu.
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/ponte-operacao-worker.test.ts

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { LancarSswPortalResult } from "./lancar-ssw-portal.ts";
import type { PedidoRow, TipoPedido } from "./ponte-operacao-pedido.ts";
import { LIMITE_TERMINAIS_24H } from "./guard-anti-loop-criacao.ts";
import {
  type AuditPonte,
  type CardLancamento,
  type CardResumoWorker,
  decidirLancamento,
  decidirNascimentoCard,
  type DepsWorker,
  interpretarLancamento,
  JANELA_VAZAO_SEGUNDOS,
  LIMITE_SSW_POR_MINUTO,
  LIMITE_TERMINAIS_24H_PONTE,
  montarTextoSsw,
  motivoDuplicidade,
  nfParaTripe,
  type NovoCardDoPedido,
  type PendenciaBastaoMin,
  type RepoWorker,
  rodarWorkerPedidos,
  TETO_SSW_POR_MINUTO,
  vagasDeLancamento,
} from "./ponte-operacao-worker.ts";

const T0 = Date.parse("2026-09-26T11:00:00Z");
const TERMINAIS = ["RESOLVIDO", "CANCELADO", "TRANSFERIDO"];
const ativo = (s: string) => !TERMINAIS.includes(s);

interface CardFake extends CardResumoWorker {}
type PedidoFake = PedidoRow & { reservado_em: string | null; finalizado_em: string | null };

class Mundo {
  agoraMs = T0;
  flags: Record<string, boolean> = { ponte_operacao_pedidos: true, ponte_operacao_lancar_ssw: true };
  /** Se definido, sobrepõe a leitura da flag de lançamento (n = nº da leitura, começa em 1). */
  flagLancarPorLeitura: ((n: number) => boolean) | null = null;
  leiturasLancar = 0;
  pedidos = new Map<string, PedidoFake>();
  cards: CardFake[] = [];
  eventos: Array<{ card_id: string; tipo: string; payload: Record<string, unknown> }> = [];
  audits: AuditPonte[] = [];
  permitidos = new Set<number>();
  acoes: Array<{ id: string; card_id: string; codigo_oc: number; sucesso: boolean | null; iniciado_em: string; finalizado_em: string | null }> = [];
  chamadas: string[] = [];
  lancamentos: Array<{ em: number; cardId: string; nf: string; ctrc: string; codigo: number; texto: string }> = [];
  pendencias = new Map<string, PendenciaBastaoMin>();
  bastaoFalha = false;
  atribuicaoVia = "carteira_cnpj";
  criados: NovoCardDoPedido[] = [];
  respostaLancar: (n: number) => LancarSswPortalResult = (n) => ({ ok: true, protocolo: `seq-${n}`, idempotent_skip: false, acao_id: `acao-${n}` });

  iso(ms = this.agoraMs) { return new Date(ms).toISOString(); }
  avancar(seg: number) { this.agoraMs += seg * 1000; }

  pedido(over: Partial<PedidoFake> & { pedido_id: string; ctrc: string }): PedidoFake {
    const p: PedidoFake = {
      tipo: "devolver_ao_relacionamento" as TipoPedido, codigo_ocorrencia: 49, texto: "Cliente pediu para segurar",
      base: "VGA", nf: null, solicitado_por_id: "12", solicitado_por_nome: "Operador X", solicitado_por_email: null,
      criado_em_origem: null, recebido_em: this.iso(), hash_pedido: "h", status: "recebido", etapa: "vincular_card",
      card_id: null, card_criado_pelo_pedido: false, card_event_id: null, ocorrencia_lancada: null, acao_ssw_id: null,
      categoria_erro: null, detalhe: null, executado_em: null, reservado_em: null, finalizado_em: null, ...over,
    };
    this.pedidos.set(p.pedido_id, p);
    return p;
  }

  card(over: Partial<CardFake> & { id: string; ctrc: string }): CardFake {
    const c: CardFake = { nf: "638789", state: "AGUARDANDO_VALIDACAO_HUMANA", cod_ultima_ocorrencia: 11, created_at: this.iso(T0 - 86_400_000), ...over };
    this.cards.push(c);
    return c;
  }

  /** N pedidos de devolver, cada um com card próprio, já na fila do SSW. */
  filaDeDevolver(n: number) {
    for (let i = 1; i <= n; i++) {
      const ctrc = `AMB${1000 + i}-1`;
      this.card({ id: `c${i}`, ctrc, nf: `${1000 + i}` });
      this.pedido({ pedido_id: `p${String(i).padStart(2, "0")}`, ctrc, etapa: "fila_ssw", card_id: `c${i}`, recebido_em: this.iso(T0 + i) });
    }
  }

  repo(): RepoWorker {
    // deno-lint-ignore no-this-alias
    const m = this;
    const finalizar: RepoWorker["finalizar"] = (id, a) => {
      m.chamadas.push(`finalizar:${id}:${a.status}`);
      const p = m.pedidos.get(id)!;
      if (p.status !== "recebido") return Promise.resolve();
      Object.assign(p, {
        status: a.status, etapa: "fim", detalhe: a.detalhe, categoria_erro: a.categoria ?? null,
        ocorrencia_lancada: a.status === "executado" ? a.ocorrenciaLancada ?? null : null,
        acao_ssw_id: a.acaoSswId ?? null, executado_em: a.status === "executado" ? m.iso() : null, finalizado_em: m.iso(),
      });
      if (a.evento && p.card_id) m.eventos.push({ card_id: p.card_id, tipo: a.evento.tipo, payload: a.evento.payload });
      return Promise.resolve();
    };
    return {
      flagLigada: (k) => {
        m.chamadas.push(`flag:${k}`);
        if (k === "ponte_operacao_lancar_ssw" && m.flagLancarPorLeitura) return Promise.resolve(m.flagLancarPorLeitura(++m.leiturasLancar));
        return Promise.resolve(m.flags[k] ?? false);
      },
      expirarVencidos: (ttlHoras, travadoMin) => {
        m.chamadas.push("expirar");
        let n = 0;
        for (const p of m.pedidos.values()) {
          if (p.status !== "recebido") continue;
          const travado = p.etapa === "lancando_ssw" && Date.parse(p.reservado_em!) < m.agoraMs - travadoMin * 60_000;
          const vencido = p.etapa !== "lancando_ssw" && Date.parse(p.recebido_em) < m.agoraMs - ttlHoras * 3_600_000;
          if (!travado && !vencido) continue;
          Object.assign(p, { status: "erro", etapa: "fim", categoria_erro: travado ? "lancamento_interrompido" : "expirado", finalizado_em: m.iso() });
          if (p.card_id) m.eventos.push({ card_id: p.card_id, tipo: "PedidoOperacaoNaoExecutado", payload: { pedido_id: p.pedido_id } });
          n++;
        }
        return Promise.resolve(n);
      },
      pedidosParaVincular: (l) => Promise.resolve([...m.pedidos.values()].filter((p) => p.status === "recebido" && p.etapa === "vincular_card").slice(0, l)),
      pedidosVinculados: (l) => Promise.resolve([...m.pedidos.values()].filter((p) => p.status === "recebido" && p.etapa === "vinculado").slice(0, l)),
      cardsDoCtrc: (ctrc) => Promise.resolve(m.cards.filter((c) => c.ctrc === ctrc).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))),
      cardsAtivosDaNf: (nf) => Promise.resolve(m.cards.filter((c) => c.nf === nf && ativo(c.state))),
      terminaisDaNf24h: (nf) => Promise.resolve(m.cards.filter((c) => c.nf === nf && !ativo(c.state) && Date.parse(c.created_at) > m.agoraMs - 86_400_000).length),
      criarCard: (novo) => {
        m.chamadas.push("criarCard");
        if (m.cards.some((c) => c.nf === novo.nf && ativo(c.state))) return Promise.resolve("conflito" as const);
        m.criados.push(novo);
        const id = `novo-${m.criados.length}`;
        m.cards.push({ id, ctrc: novo.ctrc, nf: novo.nf, state: novo.state, cod_ultima_ocorrencia: novo.cod_ultima_ocorrencia, created_at: m.iso(), pedido_operacao_id: String(novo.agent_state["pedido_operacao_id"]) });
        return Promise.resolve({ id });
      },
      vincularCard: (a) => {
        m.chamadas.push(`vincular:${a.pedidoId}`);
        const p = m.pedidos.get(a.pedidoId)!;
        if (p.card_event_id) return Promise.resolve();
        if (p.status !== "recebido" || p.etapa !== "vincular_card") return Promise.reject(new Error("não aguarda vínculo"));
        const c = m.cards.find((x) => x.id === a.cardId);
        if (!c) return Promise.reject(new Error("card não existe"));
        if (c.ctrc !== p.ctrc) return Promise.reject(new Error("CTRC diverge"));
        if (p.tipo === "devolver_ao_relacionamento" && !ativo(c.state)) return Promise.reject(new Error("devolver exige card ativo"));
        if (a.cardCriado) m.eventos.push({ card_id: c.id, tipo: "CardCriadoPorPedidoOperacao", payload: { pedido_id: p.pedido_id } });
        m.eventos.push({ card_id: c.id, tipo: p.tipo === "devolver_ao_relacionamento" ? "DevolvidoPelaOperacao" : "OcorrenciaSolicitadaPelaOperacao", payload: { pedido_id: p.pedido_id, solicitado_por: { id: p.solicitado_por_id, nome: p.solicitado_por_nome } } });
        Object.assign(p, { card_id: c.id, card_event_id: `ev-${m.eventos.length}`, etapa: "vinculado", card_criado_pelo_pedido: a.cardCriado });
        return Promise.resolve();
      },
      moverParaFila: (id) => {
        const p = m.pedidos.get(id)!;
        if (p.status === "recebido" && p.etapa === "vinculado") p.etapa = "fila_ssw";
        return Promise.resolve();
      },
      finalizar,
      // Mesma conta da RPC ponte_operacao_reservar_lancamentos (sem await dentro = atômico, como o advisory lock).
      reservarLancamentos: (limite, ttlHoras, quarentenaMin) => {
        m.chamadas.push("reservar");
        const todos = [...m.pedidos.values()];
        const emQuarentena = todos.some((p) => p.categoria_erro === "sessao_invalida" && Date.parse(p.finalizado_em!) > m.agoraMs - quarentenaMin * 60_000);
        const naJanela = todos.filter((p) => p.reservado_em && Date.parse(p.reservado_em) > m.agoraMs - 60_000).length;
        const vagas = vagasDeLancamento({ limitePorMinuto: limite, reservadosNaJanela: naJanela, emQuarentena });
        const escolhidos = todos
          .filter((p) => p.status === "recebido" && p.etapa === "fila_ssw" && Date.parse(p.recebido_em) > m.agoraMs - ttlHoras * 3_600_000)
          .sort((a, b) => (a.recebido_em < b.recebido_em ? -1 : 1))
          .slice(0, vagas);
        for (const p of escolhidos) { p.etapa = "lancando_ssw"; p.reservado_em = m.iso(); }
        return Promise.resolve(escolhidos.map((p) => ({ ...p })));
      },
      devolverParaFila: (ids) => {
        for (const id of ids) {
          const p = m.pedidos.get(id)!;
          if (p.status === "recebido" && p.etapa === "lancando_ssw") p.etapa = "fila_ssw";
        }
        return Promise.resolve();
      },
      cardParaLancar: (id) => {
        const c = m.cards.find((x) => x.id === id);
        return Promise.resolve(c ? { id: c.id, nf: c.nf, ctrc: c.ctrc, state: c.state, cod_ultima_ocorrencia: c.cod_ultima_ocorrencia } as CardLancamento : null);
      },
      fatosDuplicidade: (p, cardId, janelaHoras) => {
        const outro = [...m.pedidos.values()].find((x) =>
          x.pedido_id !== p.pedido_id && x.ctrc === p.ctrc && x.codigo_ocorrencia === p.codigo_ocorrencia &&
          x.status === "executado" && x.ocorrencia_lancada !== null && Date.parse(x.executado_em!) > m.agoraMs - janelaHoras * 3_600_000
        );
        const ultima = m.acoes.filter((a) => a.card_id === cardId && a.codigo_oc === p.codigo_ocorrencia).sort((a, b) => (a.iniciado_em < b.iniciado_em ? 1 : -1))[0];
        return Promise.resolve({
          outroPedido: outro ? { pedido_id: outro.pedido_id, executado_em: outro.executado_em } : null,
          ultimaAcao: ultima ?? null,
        });
      },
      codigoPermitido: (c) => Promise.resolve(m.permitidos.has(c)),
      registrarAudit: (a) => { m.audits.push(a); return Promise.resolve(); },
    };
  }

  deps(over: Partial<DepsWorker> = {}): DepsWorker {
    // deno-lint-ignore no-this-alias
    const m = this;
    return {
      repo: m.repo(),
      buscarPendenciaPorCtrc: (ctrc) => {
        m.chamadas.push(`bastao:${ctrc}`);
        if (m.bastaoFalha) return Promise.reject(new Error("bastão fora"));
        return Promise.resolve(m.pendencias.get(ctrc) ?? null);
      },
      resolverAtribuicao: () => Promise.resolve({ responsavel_relacionamento: "FELIPE", assigned_operator_id: "op-1", via: m.atribuicaoVia }),
      ocsCliente: new Set([54, 59]),
      lancar: (a) => {
        const n = m.lancamentos.length + 1;
        m.lancamentos.push({ em: m.agoraMs, cardId: a.card.id, nf: a.card.nf, ctrc: a.card.ctrc, codigo: a.codigoSsw, texto: a.texto });
        const r = m.respostaLancar(n);
        m.acoes.push({ id: `acao-${n}`, card_id: a.card.id, codigo_oc: a.codigoSsw, sucesso: r.ok, iniciado_em: m.iso(), finalizado_em: m.iso() });
        return Promise.resolve(r);
      },
      agora: () => new Date(m.agoraMs),
      ...over,
    };
  }
}

const pend = (over: Partial<PendenciaBastaoMin> = {}): PendenciaBastaoMin => ({
  id: "pend-1", ctrc: "AMB638789-6", nf: "000638789", cod_ultima_ocorrencia: 11, instrucao_ultima_ocorrencia: "endereço não localizado",
  data_ultima_ocorrencia: "2026-09-25", pagador: "CLIENTE SA", cnpj_pagador: "12345678000199", cnpj_remetente: "12345678000199",
  base_destino: "VGA", responsavel_relacionamento: "FELIPE", segmento_cliente: null, tipo_documento: "NORMAL", qtd_volumes: 3,
  atraso_original: 2, ...over,
});

/** Nenhuma janela de 60 s (a partir de cada lançamento) tem mais de `max` lançamentos. */
function assertVazao(tempos: number[], max: number) {
  for (const t of tempos) {
    const naJanela = tempos.filter((x) => x >= t && x < t + JANELA_VAZAO_SEGUNDOS * 1000).length;
    assert(naJanela <= max, `${naJanela} lançamentos na janela que começa em ${new Date(t).toISOString()} (máx ${max})`);
  }
}

// ── funções puras ────────────────────────────────────────────────────────────

Deno.test("vagas: limite − reservados; teto duro de 3; quarentena zera; nunca negativo", () => {
  assertEquals(vagasDeLancamento({ limitePorMinuto: 2, reservadosNaJanela: 0, emQuarentena: false }), 2);
  assertEquals(vagasDeLancamento({ limitePorMinuto: 2, reservadosNaJanela: 1, emQuarentena: false }), 1);
  assertEquals(vagasDeLancamento({ limitePorMinuto: 2, reservadosNaJanela: 5, emQuarentena: false }), 0);
  assertEquals(vagasDeLancamento({ limitePorMinuto: 500, reservadosNaJanela: 0, emQuarentena: false }), TETO_SSW_POR_MINUTO);
  assertEquals(vagasDeLancamento({ limitePorMinuto: -3, reservadosNaJanela: 0, emQuarentena: false }), 0);
  assertEquals(vagasDeLancamento({ limitePorMinuto: 2, reservadosNaJanela: 0, emQuarentena: true }), 0);
  assertEquals(LIMITE_SSW_POR_MINUTO, 2);
});

Deno.test("a RPC da mig 411 tem a MESMA conta do TS (teto 3, janela 60 s, quarentena, advisory lock)", async () => {
  const sql = await Deno.readTextFile(new URL("../../../migration/2026-09-25_411_ponte_operacao.sql", import.meta.url));
  const rpc = sql.slice(sql.indexOf("FUNCTION public.ponte_operacao_reservar_lancamentos"), sql.indexOf("REVOKE ALL ON FUNCTION public.ponte_operacao_reservar_lancamentos"));
  assert(rpc.includes(`least(greatest(coalesce(p_limite_por_minuto, 0), 0), ${TETO_SSW_POR_MINUTO})`), "teto da RPC diverge do TETO_SSW_POR_MINUTO");
  assert(rpc.includes(`interval '${JANELA_VAZAO_SEGUNDOS} seconds'`), "janela da RPC diverge");
  assert(rpc.includes("pg_advisory_xact_lock"), "reserva sem advisory lock");
  assert(rpc.includes("categoria_erro = 'sessao_invalida'"), "reserva sem quarentena de login");
  assert(rpc.includes("FOR UPDATE SKIP LOCKED"), "reserva sem SKIP LOCKED");
});

Deno.test("nascimento: só com Bastão e NF; nunca entregue/extravio/CNPJ excluído; 54/59 → AGUARDANDO_CLIENTE", () => {
  const cli = new Set([54, 59]);
  const d = (p: PendenciaBastaoMin | null, via?: string, nfPedido: string | null = null) =>
    decidirNascimentoCard({ pendencia: p, ctrcPedido: "AMB638789-6", ocsCliente: cli, atribuicaoVia: via, nfPedido });
  // emenda 1: fora do Bastão e sem NF → não nasce; com a NF do pedido também não (sem pagador)
  assertEquals((d(null) as { codigo: string }).codigo, "sem_nf");
  assertEquals((d(null, undefined, "638789") as { codigo: string }).codigo, "sem_card_fora_do_bastao");
  assertEquals((d(pend(), undefined, "111") as { codigo: string }).codigo, "nf_diverge_bastao");
  assertEquals(d(pend(), undefined, "638789"), { cria: true, state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true });
  for (const oc of [1, 30, 32]) assertEquals((d(pend({ cod_ultima_ocorrencia: oc })) as { codigo: string }).codigo, "nota_entregue_ou_baixada");
  for (const oc of [6, 9, 16]) assertEquals((d(pend({ cod_ultima_ocorrencia: oc })) as { codigo: string }).codigo, "nota_em_extravio");
  assertEquals((d(pend({ nf: "  " })) as { codigo: string }).codigo, "bastao_sem_nf");
  assertEquals((d(pend({ ctrc: "OUTRO1-1" })) as { codigo: string }).codigo, "ctrc_diverge_bastao");
  assertEquals((d(pend(), "cnpj_excluido") as { codigo: string }).codigo, "cnpj_fora_do_cockpit");
  assertEquals(d(pend({ cod_ultima_ocorrencia: 54 })), { cria: true, state: "AGUARDANDO_CLIENTE", lock: false });
  assertEquals(d(pend({ cod_ultima_ocorrencia: 59 })), { cria: true, state: "AGUARDANDO_CLIENTE", lock: false });
  assertEquals(d(pend({ cod_ultima_ocorrencia: 11 })), { cria: true, state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true });
  assertEquals(d(pend({ cod_ultima_ocorrencia: 21 })), { cria: true, state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true });
});

Deno.test("cerca do lançamento: card relido na hora decide", () => {
  const card = (o: Partial<CardLancamento> = {}): CardLancamento => ({ id: "c", nf: "1", ctrc: "AMB1-1", state: "AGUARDANDO_VALIDACAO_HUMANA", cod_ultima_ocorrencia: 11, ...o });
  const dev = { tipo: "devolver_ao_relacionamento" as const, ctrc: "AMB1-1", codigo_ocorrencia: 49 };
  const lan = { tipo: "lancar_ocorrencia" as const, ctrc: "AMB1-1", codigo_ocorrencia: 15 };
  const d = (pedido: typeof dev | typeof lan, c: CardLancamento | null, permitido = true, dup: string | null = null) =>
    decidirLancamento({ pedido, card: c, codigoAindaPermitido: permitido, duplicadoDe: dup });
  assertEquals(d(dev, card()), { lancar: true, nf: "1" });
  assertEquals((d(dev, null) as { codigo: string }).codigo, "card_sumiu");
  assertEquals((d(dev, card({ ctrc: "AMB2-2" })) as { codigo: string }).codigo, "ctrc_diverge");
  assertEquals((d(dev, card({ nf: null })) as { codigo: string }).codigo, "sem_nf_para_tripe");
  // emenda 1: card sem NF usa a do pedido; as duas diferentes → não lança
  assertEquals(d({ ...dev, nf: "77" } as typeof dev, card({ nf: null })), { lancar: true, nf: "77" });
  assertEquals((d({ ...dev, nf: "77" } as typeof dev, card({ nf: "1" })) as { codigo: string }).codigo, "nf_diverge");
  assertEquals((d(dev, card({ state: "EXECUTANDO_ACAO" })) as { codigo: string }).codigo, "acao_em_confirmacao");
  assertEquals((d(dev, card({ state: "ACAO_EXECUTADA" })) as { codigo: string }).codigo, "acao_em_confirmacao");
  assertEquals((d(dev, card({ cod_ultima_ocorrencia: 1 })) as { codigo: string }).codigo, "nota_entregue_ou_baixada");
  assertEquals((d(dev, card({ state: "EXTRAVIO_MONITORADO", cod_ultima_ocorrencia: 6 })) as { codigo: string }).codigo, "nota_em_extravio");
  assertEquals(d(dev, card({ cod_ultima_ocorrencia: 49 })), {
    lancar: false, status: "executado", codigo: "ja_era_49", motivo: "registrado no card; a 49 já é a última ocorrência no SSW, não foi relançada",
  });
  assertEquals((d(dev, card(), true, "dup") as { codigo: string }).codigo, "duplicado");
  assertEquals(d(lan, card({ state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 })), { lancar: true, nf: "1" });
  assertEquals((d(lan, card({ state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 }), false) as { codigo: string }).codigo, "codigo_saiu_da_lista");
  assertEquals((d(lan, card()) as { codigo: string }).codigo, "tratativa_aberta");
});

Deno.test("resultado do envelope: ok → executado; tripé → recusado; sessão → erro + quarentena", () => {
  const ok = interpretarLancamento(49, { ok: true, protocolo: "seq", idempotent_skip: false, acao_id: "a1" });
  assertEquals([ok.status, ok.ocorrenciaLancada, ok.acaoSswId, ok.quarentena], ["executado", 49, "a1", false]);
  const tri = interpretarLancamento(49, { ok: false, error: "localização ENTREGUE", categoria: "guard_tripe", acao_id: "a2" });
  assertEquals([tri.status, tri.ocorrenciaLancada, tri.quarentena], ["recusado", null, false]);
  const ses = interpretarLancamento(49, { ok: false, error: "login falhou", categoria: "sessao_invalida", acao_id: "a3" });
  assertEquals([ses.status, ses.quarentena], ["erro", true]);
  assertEquals(interpretarLancamento(49, { ok: false, error: "5xx", categoria: "ssw_erro" }).status, "erro");
});

Deno.test("duplicidade: outro pedido, lançamento em voo e lançamento recente do executor", () => {
  const agora = T0;
  assertEquals(motivoDuplicidade({ outroPedido: null, ultimaAcao: null }, 49, agora), null);
  assertMatch(motivoDuplicidade({ outroPedido: { pedido_id: "p9", executado_em: null }, ultimaAcao: null }, 49, agora)!, /pedido p9/);
  const emVoo = { id: "a", sucesso: null, iniciado_em: new Date(agora - 60_000).toISOString(), finalizado_em: null };
  assertMatch(motivoDuplicidade({ outroPedido: null, ultimaAcao: emVoo }, 49, agora)!, /em andamento/);
  const recente = { id: "a", sucesso: true, iniciado_em: new Date(agora - 300_000).toISOString(), finalizado_em: new Date(agora - 240_000).toISOString() };
  assertMatch(motivoDuplicidade({ outroPedido: null, ultimaAcao: recente }, 49, agora)!, /menos de 10 min/);
  const antigo = { ...recente, finalizado_em: new Date(agora - 3_600_000).toISOString() };
  assertEquals(motivoDuplicidade({ outroPedido: null, ultimaAcao: antigo }, 49, agora), null);
  const falhou = { ...recente, sucesso: false };
  assertEquals(motivoDuplicidade({ outroPedido: null, ultimaAcao: falhou }, 49, agora), null);
});

Deno.test("texto do SSW leva quem pediu e a base, e cabe nos 500 da Instrução", () => {
  assertEquals(
    montarTextoSsw({ texto: "Cliente pediu para segurar", base: "VGA", solicitado_por_nome: "Operador X" }),
    "Cliente pediu para segurar (pedido da operação VGA por Operador X)",
  );
  assertEquals(montarTextoSsw({ texto: "x".repeat(400), base: null, solicitado_por_nome: "N".repeat(120) }).length, 500);
});

// ── flags OFF ────────────────────────────────────────────────────────────────

Deno.test("FLAGS OFF: ponte_operacao_pedidos OFF → só lê a flag; nada mais roda; SSW nunca", async () => {
  const m = new Mundo();
  m.flags = {};
  m.filaDeDevolver(3);
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(r.skipped, "flag_off");
  assertEquals(m.chamadas, ["flag:ponte_operacao_pedidos"]);
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("FLAGS OFF: lancar_ssw OFF → devolver termina no card sem 49; lancar é recusado; nada reservado", async () => {
  const m = new Mundo();
  m.flags = { ponte_operacao_pedidos: true };
  m.card({ id: "c1", ctrc: "AMB1-1" });
  m.card({ id: "c2", ctrc: "AMB2-2", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 });
  m.pedido({ pedido_id: "pd", ctrc: "AMB1-1" });
  m.pedido({ pedido_id: "pl", ctrc: "AMB2-2", tipo: "lancar_ocorrencia", codigo_ocorrencia: 15 });
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 0);
  assert(!m.chamadas.includes("reservar"));
  assertEquals(m.pedidos.get("pd")!.status, "executado");
  assertEquals(m.pedidos.get("pd")!.ocorrencia_lancada, null);
  assertMatch(m.pedidos.get("pd")!.detalhe!, /a 49 não foi lançada/);
  assertEquals(m.pedidos.get("pl")!.status, "recusado");
  assertEquals(m.eventos.map((e) => e.tipo), ["DevolvidoPelaOperacao", "OcorrenciaSolicitadaPelaOperacao", "PedidoOperacaoNaoExecutado"]);
  assertEquals([r.finalizados_sem_ssw, r.recusados], [1, 1]);
});

Deno.test("KILL-SWITCH: lancar_ssw desligada no meio da rodada → nada mais vai ao SSW; reservados voltam à fila", async () => {
  const m = new Mundo();
  m.filaDeDevolver(2);
  // leitura 1 = etapa B, leitura 2 = antes do 1º lançamento, leitura 3 = antes do 2º
  m.flagLancarPorLeitura = (n) => n <= 2;
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 1);
  assertEquals(m.pedidos.get("p02")!.etapa, "fila_ssw");
  assertEquals(m.pedidos.get("p02")!.status, "recebido");
});

Deno.test("FREIO DE EMERGÊNCIA: flag desligada DURANTE o 1º lançamento → o 2º não sai; volta para a fila", async () => {
  const m = new Mundo();
  m.filaDeDevolver(2);
  const deps = m.deps();
  const lancarOriginal = deps.lancar;
  deps.lancar = async (a) => {
    const r = await lancarOriginal(a);
    m.flags["ponte_operacao_lancar_ssw"] = false; // alguém puxou o freio enquanto o 1º estava no SSW
    return r;
  };
  await rodarWorkerPedidos(deps);
  assertEquals(m.lancamentos.length, 1);
  assertEquals(m.pedidos.get("p01")!.status, "executado");
  assertEquals([m.pedidos.get("p02")!.status, m.pedidos.get("p02")!.etapa], ["recebido", "fila_ssw"]);
  // e na rodada seguinte, com a flag ainda OFF, ninguém é reservado nem lançado
  m.avancar(120);
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 1);
});

Deno.test("FREIO DE EMERGÊNCIA: a flag é lida IMEDIATAMENTE antes de cada chamada ao SSW (dentro do laço)", async () => {
  const m = new Mundo();
  m.filaDeDevolver(2);
  const deps = m.deps();
  const lancarOriginal = deps.lancar;
  deps.lancar = (a) => { m.chamadas.push("lancar"); return lancarOriginal(a); };
  await rodarWorkerPedidos(deps);
  const idx = m.chamadas.flatMap((c, i) => (c === "lancar" ? [i] : []));
  assertEquals(idx.length, 2);
  for (const i of idx) assertEquals(m.chamadas[i - 1], "flag:ponte_operacao_lancar_ssw", `chamada ${i} sem freio antes`);
});

Deno.test("INV-040 no nascimento por pedido: mesmo limite do guard do sync; 2 encerrados cria, 3 recusa; erro na contagem NÃO cria", async () => {
  assertEquals(LIMITE_TERMINAIS_24H_PONTE, LIMITE_TERMINAIS_24H);
  const comTerminais = (n: number) => {
    const m = new Mundo();
    m.flags = { ponte_operacao_pedidos: true };
    m.pendencias.set("AMB638789-6", pend());
    for (let i = 0; i < n; i++) {
      m.card({ id: `t${i}`, ctrc: "AMB638789-6", nf: "638789", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21, created_at: new Date(T0 - 3_600_000).toISOString() });
    }
    m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
    return m;
  };
  const dois = comTerminais(LIMITE_TERMINAIS_24H - 1);
  await rodarWorkerPedidos(dois.deps());
  assertEquals(dois.criados.length, 1);
  const tres = comTerminais(LIMITE_TERMINAIS_24H);
  await rodarWorkerPedidos(tres.deps());
  assertEquals([tres.criados.length, tres.pedidos.get("p1")!.categoria_erro], [0, "loop_criacao"]);
  // fail-CLOSED: sem conseguir contar, nenhum card nasce e o pedido espera a próxima rodada
  const erro = comTerminais(0);
  const deps = erro.deps();
  deps.repo.terminaisDaNf24h = () => Promise.reject(new Error("timeout"));
  await rodarWorkerPedidos(deps);
  assertEquals(erro.criados.length, 0);
  assertEquals([erro.pedidos.get("p1")!.status, erro.pedidos.get("p1")!.etapa], ["recebido", "vincular_card"]);
});

Deno.test("INV-040 na raiz: o card que nasce de pedido NUNCA nasce encerrado (o gatilho do loop da NF 2084)", () => {
  const cli = new Set([54, 59]);
  for (const oc of [2, 11, 13, 21, 44, 49, 54, 55, 59, null]) {
    const d = decidirNascimentoCard({ pendencia: pend({ cod_ultima_ocorrencia: oc }), ctrcPedido: "AMB638789-6", ocsCliente: cli });
    if (d.cria) assert(!["RESOLVIDO", "CANCELADO", "TRANSFERIDO"].includes(d.state), `oc ${oc} nasceu ${d.state}`);
  }
});

// ── vazão (INV-159) ──────────────────────────────────────────────────────────

Deno.test("VAZÃO: 10 pedidos, worker a cada 10 s por 3 min → no máximo 2 por janela de 60 s", async () => {
  const m = new Mundo();
  m.filaDeDevolver(10);
  for (let t = 0; t < 180; t += 10) {
    await rodarWorkerPedidos(m.deps());
    m.avancar(10);
  }
  assertVazao(m.lancamentos.map((l) => l.em), LIMITE_SSW_POR_MINUTO);
  assertEquals(m.lancamentos.length, 6);
  // cada pedido foi ao SSW no máximo uma vez
  assertEquals(new Set(m.lancamentos.map((l) => l.cardId)).size, m.lancamentos.length);
});

Deno.test("VAZÃO: 5 execuções PARALELAS no mesmo instante não passam de 2", async () => {
  const m = new Mundo();
  m.filaDeDevolver(10);
  await Promise.all(Array.from({ length: 5 }, () => rodarWorkerPedidos(m.deps())));
  assertEquals(m.lancamentos.length, 2);
});

Deno.test("VAZÃO: limite errado (50/min) ainda para no teto de 3", async () => {
  const m = new Mundo();
  m.filaDeDevolver(10);
  for (let t = 0; t < 120; t += 5) {
    await rodarWorkerPedidos(m.deps({ limitePorMinuto: 50 }));
    m.avancar(5);
  }
  assertVazao(m.lancamentos.map((l) => l.em), TETO_SSW_POR_MINUTO);
});

Deno.test("QUARENTENA: login recusado para a ponte por 30 min; o resto volta à fila; depois retoma", async () => {
  const m = new Mundo();
  m.filaDeDevolver(4);
  m.respostaLancar = (n) => n === 1
    ? { ok: false, error: "Usuário bloqueado até 12:48h por uso indevido", categoria: "sessao_invalida", acao_id: "a1" }
    : { ok: true, protocolo: `seq-${n}`, idempotent_skip: false, acao_id: `acao-${n}` };
  const r1 = await rodarWorkerPedidos(m.deps());
  assertEquals(r1.quarentena, true);
  assertEquals(m.lancamentos.length, 1);
  assertEquals(m.pedidos.get("p01")!.status, "erro");
  assertEquals(m.pedidos.get("p02")!.etapa, "fila_ssw"); // o 2º reservado não foi tentado
  for (let i = 0; i < 7; i++) { m.avancar(240); await rodarWorkerPedidos(m.deps()); } // até 28 min
  assertEquals(m.lancamentos.length, 1, "ninguém abre sessão durante a quarentena");
  m.agoraMs = T0 + 31 * 60_000;
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 3);
});

// ── idempotência e interrupção ───────────────────────────────────────────────

Deno.test("IDEMPOTÊNCIA: rodar de novo (e em paralelo) nunca leva o mesmo pedido 2x ao SSW", async () => {
  const m = new Mundo();
  m.filaDeDevolver(1);
  await Promise.all([rodarWorkerPedidos(m.deps()), rodarWorkerPedidos(m.deps())]);
  m.avancar(120);
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 1);
  assertEquals(m.pedidos.get("p01")!.status, "executado");
  assertEquals(m.pedidos.get("p01")!.ocorrencia_lancada, 49);
  assertEquals(m.audits.length, 1);
  assertEquals(m.audits[0]!.idempotency_key, "ponte_operacao:p01");
});

Deno.test("INTERRUPÇÃO: pedido travado em lancando_ssw vira erro e NÃO é relançado", async () => {
  const m = new Mundo();
  m.card({ id: "c1", ctrc: "AMB1-1" });
  m.pedido({ pedido_id: "px", ctrc: "AMB1-1", etapa: "lancando_ssw", card_id: "c1", reservado_em: new Date(T0 - 20 * 60_000).toISOString() });
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(r.expirados, 1);
  assertEquals(m.pedidos.get("px")!.status, "erro");
  assertEquals(m.pedidos.get("px")!.categoria_erro, "lancamento_interrompido");
  assertEquals(m.lancamentos.length, 0);
  assertEquals(m.eventos.map((e) => e.tipo), ["PedidoOperacaoNaoExecutado"]);
});

Deno.test("TTL: pedido parado há mais de 4 h expira (nunca executa atrasado)", async () => {
  const m = new Mundo();
  m.card({ id: "c1", ctrc: "AMB1-1" });
  m.pedido({ pedido_id: "velho", ctrc: "AMB1-1", etapa: "fila_ssw", card_id: "c1", recebido_em: new Date(T0 - 5 * 3_600_000).toISOString() });
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.pedidos.get("velho")!.categoria_erro, "expirado");
  assertEquals(m.lancamentos.length, 0);
});

Deno.test("DUPLICIDADE: dois pedidos de devolver da mesma nota → só uma 49 no SSW", async () => {
  const m = new Mundo();
  m.card({ id: "c1", ctrc: "AMB1-1" });
  m.pedido({ pedido_id: "a", ctrc: "AMB1-1", recebido_em: new Date(T0).toISOString() });
  m.pedido({ pedido_id: "b", ctrc: "AMB1-1", recebido_em: new Date(T0 + 1000).toISOString(), solicitado_por_nome: "Operadora Y" });
  await rodarWorkerPedidos(m.deps());
  m.avancar(70);
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 1);
  assertEquals(m.pedidos.get("a")!.status, "executado");
  assertEquals(m.pedidos.get("b")!.status, "recusado");
  assertEquals(m.pedidos.get("b")!.categoria_erro, "duplicado");
  // os dois textos ficaram no card (cada pessoa que pediu aparece)
  assertEquals(m.eventos.filter((e) => e.tipo === "DevolvidoPelaOperacao").length, 2);
});

Deno.test("DUPLICIDADE: o executor acabou de lançar a mesma oc no card → o pedido não lança por cima", async () => {
  const m = new Mundo();
  m.filaDeDevolver(1);
  m.acoes.push({ id: "exec-1", card_id: "c1", codigo_oc: 49, sucesso: true, iniciado_em: new Date(T0 - 120_000).toISOString(), finalizado_em: new Date(T0 - 60_000).toISOString() });
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.lancamentos.length, 0);
  assertEquals(m.pedidos.get("p01")!.categoria_erro, "duplicado");
});

Deno.test("DUPLICIDADE fail-closed: não deu para conferir → não lança", async () => {
  const m = new Mundo();
  m.filaDeDevolver(1);
  const deps = m.deps();
  deps.repo.fatosDuplicidade = () => Promise.reject(new Error("timeout"));
  await rodarWorkerPedidos(deps);
  assertEquals(m.lancamentos.length, 0);
  assertEquals(m.pedidos.get("p01")!.status, "recusado");
});

// ── o caminho completo ───────────────────────────────────────────────────────

Deno.test("devolver com card ativo: evento no card → fila → 49 pelo envelope com CTRC/NF do CARD", async () => {
  const m = new Mundo();
  m.card({ id: "c1", ctrc: "AMB638789-6", nf: "0638789" });
  m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(r.lancados, 1);
  assertEquals(m.lancamentos[0], {
    em: T0, cardId: "c1", nf: "0638789", ctrc: "AMB638789-6", codigo: 49,
    texto: "Cliente pediu para segurar (pedido da operação VGA por Operador X)",
  });
  assertEquals(m.eventos.map((e) => e.tipo), ["DevolvidoPelaOperacao", "PedidoOperacaoLancadoNoSsw"]);
  const lancado = m.eventos[1]!.payload;
  assertEquals(lancado["solicitado_por"], { id: "12", nome: "Operador X", email: null });
  const a = m.audits[0]!;
  assertEquals([a.status, a.card_id, a.external_id], ["success", "c1", "seq-1"]);
  assertEquals((a.request_payload["solicitado_por"] as { nome: string }).nome, "Operador X");
});

Deno.test("devolver SEM card: nasce do Bastão em AVH+lock, NF normalizada, CTRC do pedido, e segue", async () => {
  const m = new Mundo();
  m.pendencias.set("AMB638789-6", pend());
  m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(r.cards_criados, 1);
  const novo = m.criados[0]!;
  assertEquals([novo.nf, novo.ctrc, novo.state, novo.lock_aguardando_validacao, novo.assigned_operator_id], ["638789", "AMB638789-6", "AGUARDANDO_VALIDACAO_HUMANA", true, "op-1"]);
  assertEquals(novo.agent_state["criado_via"], "ponte_operacao");
  assertEquals(novo.agent_state["pedido_operacao_id"], "p1");
  assertEquals(m.eventos.map((e) => e.tipo), ["CardCriadoPorPedidoOperacao", "DevolvidoPelaOperacao", "PedidoOperacaoLancadoNoSsw"]);
  assertEquals(m.lancamentos[0]!.nf, "638789");
});

Deno.test("devolver SEM card e fora do Bastão → recusado com motivo; nenhum card inventado", async () => {
  const m = new Mundo();
  m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.pedidos.get("p1")!.status, "recusado");
  assertEquals(m.pedidos.get("p1")!.categoria_erro, "sem_nf");
  assert(!m.chamadas.includes("criarCard"));
  // com a NF do pedido, fora do Bastão, continua sem card inventado (sem pagador)
  const m2 = new Mundo();
  m2.pedido({ pedido_id: "p1", ctrc: "AMB638789-6", nf: "638789" });
  await rodarWorkerPedidos(m2.deps());
  assertEquals(m2.pedidos.get("p1")!.categoria_erro, "sem_card_fora_do_bastao");
  assert(!m2.chamadas.includes("criarCard"));
});

Deno.test("nf do pedido ≠ NF do Bastão → recusado, nenhum card nasce", async () => {
  const m = new Mundo();
  m.pendencias.set("AMB638789-6", pend());
  m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6", nf: "999" });
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.pedidos.get("p1")!.categoria_erro, "nf_diverge_bastao");
  assert(!m.chamadas.includes("criarCard"));
});

Deno.test("TRIPÉ (emenda 1): card sem NF usa a NF do pedido; card com NF usa a do CARD; divergentes não lançam", async () => {
  assertEquals(nfParaTripe("0638789", "638789"), { ok: true, nf: "0638789" });
  assertEquals(nfParaTripe(null, "638789"), { ok: true, nf: "638789" });
  assertEquals(nfParaTripe("  ", null), { ok: false, codigo: "sem_nf_para_tripe", motivo: "sem NF para o tripé" });
  assertEquals(nfParaTripe("1", "2").ok, false);

  const semNf = new Mundo();
  semNf.card({ id: "c1", ctrc: "AMB1-1", nf: null });
  semNf.pedido({ pedido_id: "p1", ctrc: "AMB1-1", nf: "638789", etapa: "fila_ssw", card_id: "c1" });
  await rodarWorkerPedidos(semNf.deps());
  assertEquals(semNf.lancamentos.map((l) => [l.nf, l.ctrc]), [["638789", "AMB1-1"]]);

  const diverge = new Mundo();
  diverge.card({ id: "c1", ctrc: "AMB1-1", nf: "638789" });
  diverge.pedido({ pedido_id: "p1", ctrc: "AMB1-1", nf: "111", etapa: "fila_ssw", card_id: "c1" });
  await rodarWorkerPedidos(diverge.deps());
  assertEquals(diverge.lancamentos.length, 0);
  assertEquals(diverge.pedidos.get("p1")!.categoria_erro, "nf_diverge");

  const nenhuma = new Mundo();
  nenhuma.card({ id: "c1", ctrc: "AMB1-1", nf: null });
  nenhuma.pedido({ pedido_id: "p1", ctrc: "AMB1-1", etapa: "fila_ssw", card_id: "c1" });
  await rodarWorkerPedidos(nenhuma.deps());
  assertEquals(nenhuma.lancamentos.length, 0);
  assertEquals(nenhuma.pedidos.get("p1")!.detalhe, "sem NF para o tripé");
});

Deno.test("nascimento recusado: NF com card ativo de outro CTRC (regra de ouro), INV-040, CNPJ excluído", async () => {
  const casos: Array<[string, (m: Mundo) => void]> = [
    ["nf_com_card_ativo_outro_ctrc", (m) => { m.card({ id: "outro", ctrc: "TTO1-1", nf: "638789" }); }],
    ["loop_criacao", (m) => { for (let i = 0; i < 3; i++) m.card({ id: `t${i}`, ctrc: "AMB638789-6", nf: "638789", state: "RESOLVIDO", cod_ultima_ocorrencia: 21, created_at: new Date(T0 - 3_600_000).toISOString() }); }],
    ["cnpj_fora_do_cockpit", (m) => { m.atribuicaoVia = "cnpj_excluido"; }],
  ];
  for (const [codigo, prepara] of casos) {
    const m = new Mundo();
    m.pendencias.set("AMB638789-6", pend());
    prepara(m);
    m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
    await rodarWorkerPedidos(m.deps());
    assertEquals(m.pedidos.get("p1")!.categoria_erro, codigo);
    assert(!m.chamadas.includes("criarCard"), codigo);
    assertEquals(m.lancamentos.length, 0, codigo);
  }
});

Deno.test("Bastão fora do ar → o pedido espera (sem recusar), e anda quando volta", async () => {
  const m = new Mundo();
  m.pendencias.set("AMB638789-6", pend());
  m.bastaoFalha = true;
  m.pedido({ pedido_id: "p1", ctrc: "AMB638789-6" });
  const r = await rodarWorkerPedidos(m.deps());
  assertEquals(r.aguardando_bastao, 1);
  assertEquals(m.pedidos.get("p1")!.status, "recebido");
  m.bastaoFalha = false;
  m.avancar(60);
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.pedidos.get("p1")!.status, "executado");
});

Deno.test("retomada: card nasceu do pedido mas a rodada caiu antes do vínculo → vincula nele com o evento de criação", async () => {
  const m = new Mundo();
  m.card({ id: "nasceu", ctrc: "AMB1-1", pedido_operacao_id: "p1" });
  m.pedido({ pedido_id: "p1", ctrc: "AMB1-1" });
  m.flags = { ponte_operacao_pedidos: true };
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.eventos.map((e) => e.tipo), ["CardCriadoPorPedidoOperacao", "DevolvidoPelaOperacao"]);
});

Deno.test("cerca na hora do SSW: card em extravio, em confirmação ou já na 49 → não lança", async () => {
  const casos: Array<[Omit<Partial<CardFake>, "ctrc">, string, string]> = [
    [{ state: "EXTRAVIO_MONITORADO", cod_ultima_ocorrencia: 6 }, "recusado", "nota_em_extravio"],
    [{ state: "EXECUTANDO_ACAO" }, "recusado", "acao_em_confirmacao"],
    [{ cod_ultima_ocorrencia: 49 }, "executado", "ja_era_49"],
  ];
  for (const [over, status, codigo] of casos) {
    const m = new Mundo();
    m.card({ id: "c1", ctrc: "AMB1-1", ...over });
    m.pedido({ pedido_id: "p1", ctrc: "AMB1-1", etapa: "fila_ssw", card_id: "c1" });
    await rodarWorkerPedidos(m.deps());
    assertEquals([m.pedidos.get("p1")!.status, m.pedidos.get("p1")!.categoria_erro], [status, codigo]);
    assertEquals(m.lancamentos.length, 0);
  }
});

Deno.test("lancar_ocorrencia: código tirado da lista entre o pedido e a execução → recusado, sem SSW", async () => {
  const m = new Mundo();
  m.card({ id: "c1", ctrc: "AMB1-1", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 });
  m.pedido({ pedido_id: "p1", ctrc: "AMB1-1", tipo: "lancar_ocorrencia", codigo_ocorrencia: 15, etapa: "fila_ssw", card_id: "c1" });
  await rodarWorkerPedidos(m.deps());
  assertEquals(m.pedidos.get("p1")!.categoria_erro, "codigo_saiu_da_lista");
  assertEquals(m.lancamentos.length, 0);
  // com o código na lista, vai (1 lançamento, pelo envelope)
  const m2 = new Mundo();
  m2.permitidos.add(15);
  m2.card({ id: "c1", ctrc: "AMB1-1", state: "TRANSFERIDO", cod_ultima_ocorrencia: 21 });
  m2.pedido({ pedido_id: "p1", ctrc: "AMB1-1", tipo: "lancar_ocorrencia", codigo_ocorrencia: 15, etapa: "fila_ssw", card_id: "c1" });
  await rodarWorkerPedidos(m2.deps());
  assertEquals(m2.lancamentos.map((l) => l.codigo), [15]);
});

Deno.test("guard do tripé recusou → pedido recusado com o motivo e evento de não execução", async () => {
  const m = new Mundo();
  m.filaDeDevolver(1);
  m.respostaLancar = () => ({ ok: false, error: "bloqueado_por_guard: Localização atual ENTREGUE", categoria: "guard_tripe", acao_id: "a1" });
  await rodarWorkerPedidos(m.deps());
  const p = m.pedidos.get("p01")!;
  assertEquals([p.status, p.categoria_erro, p.ocorrencia_lancada], ["recusado", "guard_tripe", null]);
  assertEquals(m.eventos.at(-1)!.tipo, "PedidoOperacaoNaoExecutado");
  assertEquals(m.audits[0]!.status, "failed");
});

Deno.test("o worker só fala com o SSW pelo envelope injetado (o fonte não importa cliente SSW nem faz fetch)", async () => {
  const fonte = await Deno.readTextFile(new URL("./ponte-operacao-worker.ts", import.meta.url));
  assert(!/^import (?!type).*lancar-ssw-portal/m.test(fonte), "o núcleo só pode importar o TIPO do envelope");
  for (const proibido of ["ssw-internal-client", "fetch(", "loginInternoSSW", "obterSessao"]) {
    assert(!fonte.includes(proibido), `ponte-operacao-worker.ts não pode usar ${proibido}`);
  }
  const edge = await Deno.readTextFile(new URL("../processar-pedidos-operacao/index.ts", import.meta.url));
  assert(edge.includes('import { lancarSswPortal } from "../_shared/lancar-ssw-portal.ts"'));
  assert(!edge.includes("ssw-internal-client"), "a edge não pode abrir sessão SSW direto");
});
