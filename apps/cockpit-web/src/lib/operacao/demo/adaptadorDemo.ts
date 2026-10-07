// =============================================================================
// ADAPTADOR FALSO, EM MEMÓRIA, da OpApi — modo demonstração (VITE_OPERACAO_DEMO).
//
// Implementa as MESMAS RPCs/visão do ADR 0041 com as mesmas cercas, na mesma
// ordem que `op__checar_lancamento` (mig 430), para a tela se comportar como
// em produção: prévia com token, token conferido no clique, um lançamento
// ativo por item, cancelar só na fila, 41/56 exigindo texto etc.
// Um "worker" falso anda com os lançamentos (fila → lançando → lançado →
// confirmado) em segundos, para dar para ver o ciclo.
//
// NUNCA fala com rede, banco ou SSW. Só é importado por `carregarOpApi` em
// `vite dev` com a flag; no `vite build` o chunk nem existe.
// =============================================================================
import type { OpApi } from "../api";
import type {
  OpCodigo,
  OpEvento,
  OpFalha,
  OpFilaLinha,
  OpItem,
  OpLancamento,
  OpMembro,
  OpPrevia,
  OpRespostaAssumir,
  OpRespostaCancelar,
  OpRespostaDetalhe,
  OpRespostaPrevia,
  OpRespostaSolicitar,
  OpSessao,
} from "../tipos";
import {
  CODIGOS_DEMO,
  DESCRICOES_OC,
  MEMBRO_DEMO,
  OUTROS_MEMBROS,
  SEMENTES,
  ctrcDe,
  cidadeDe,
  destinatarioDe,
  nfDe,
  pagadorDe,
} from "./dadosDemo";

const PROIBIDOS = new Set([49, 54, 59, 33, 44, 6, 9, 16]);
const TEXTO_OBRIGATORIO = new Set([41, 56]);
const FINALIZADORAS_OU_DOCUMENTAIS = new Set([1, 30, 32, 2, 34]);
const HORA = 3_600_000;
const MIN = 60_000;

export interface OpcoesDemo {
  agora?: () => number;
  /** Latência artificial de cada chamada (ms). 0 nos testes. */
  latenciaMs?: number;
  /** Anda com os lançamentos sozinho (fila → lançado → confirmado). false nos testes. */
  simularWorker?: boolean;
  /** Passos do worker falso (ms). */
  passosWorkerMs?: { reservar: number; lancar: number; confirmar: number };
  codigos?: OpCodigo[];
  membro?: OpMembro | null;
  ehGestor?: boolean;
  flags?: Partial<NonNullable<OpSessao["flags"]>>;
}

interface ItemInterno extends OpItem {
  _cardAtivo: boolean;
}

/** Mesmo texto do `op__texto_ssw` (mig 430). */
export function textoSswDemo(texto: string, unidade: string | null, nome: string): string {
  const t = texto.trim();
  const u = unidade ? ` ${unidade}` : "";
  const s = t.length > 0 ? `${t} (Operação${u} por ${nome})` : `Lançado pela Operação${u} por ${nome}`;
  return s.slice(0, 500);
}

/** Token determinístico das mesmas partes do `op__token` (lá é md5; aqui basta mudar quando algo muda). */
export function tokenDemo(partes: (string | number | null)[]): string {
  const s = partes.map((p) => (p == null ? "" : String(p))).join("|");
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return `demo-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function criarAdaptadorDemo(opcoes: OpcoesDemo = {}): OpApi & {
  /** Só para testes/inspeção: o que já foi pedido. */
  _lancamentos(): OpLancamento[];
} {
  const agora = opcoes.agora ?? (() => Date.now());
  const latencia = opcoes.latenciaMs ?? 220;
  const simular = opcoes.simularWorker ?? true;
  const passos = opcoes.passosWorkerMs ?? { reservar: 5_000, lancar: 4_000, confirmar: 8_000 };
  const codigos = opcoes.codigos ?? CODIGOS_DEMO;
  const membro = opcoes.membro === undefined ? MEMBRO_DEMO : opcoes.membro;
  const flags = { operacao_tela: true, operacao_lancar_ssw: true, operacao_fila: true, ...opcoes.flags };

  const iso = (ms: number) => new Date(ms).toISOString();
  const t0 = agora();

  const itens = new Map<string, ItemInterno>();
  const eventos: OpEvento[] = [];
  const lancamentos: OpLancamento[] = [];
  const ouvintes = new Set<() => void>();
  let seqEvento = 1;
  let seqLanc = 1;

  const avisar = () => ouvintes.forEach((cb) => cb());
  const esperar = () => (latencia > 0 ? new Promise((r) => setTimeout(r, latencia)) : Promise.resolve());

  function evento(itemId: string, tipo: string, ator: { id: string; nome: string } | null, payload: Record<string, unknown>, quando = agora()) {
    eventos.push({
      id: seqEvento++,
      op_item_id: itemId,
      tipo,
      ator_tipo: ator ? "membro_op" : "system",
      ator_id: ator ? ator.id : "materializar-fila-operacao",
      ator_nome: ator ? ator.nome : null,
      payload,
      created_at: iso(quando),
    });
  }

  // --- semente ------------------------------------------------------------------
  SEMENTES.forEach((s, i) => {
    const id = `demo-item-${String(i + 1).padStart(2, "0")}`;
    const dataOc = t0 - s.horasParado * HORA;
    const criado = dataOc + 12 * MIN;
    const assumido = s.assumidoPor ? OUTROS_MEMBROS[s.assumidoPor] : s.lancamento ? OUTROS_MEMBROS[s.lancamento.por] : null;
    const item: ItemInterno = {
      id,
      ctrc: ctrcDe(s.unidade, i),
      nf: s.semNf ? null : nfDe(i),
      unidade: s.unidade,
      status: assumido ? "assumido" : "aberto",
      cod_ultima_ocorrencia: s.oc,
      instrucao_ultima_ocorrencia: s.oc === 56 ? "Endereço sem número; aguardando complemento" : null,
      data_ultima_ocorrencia: iso(dataOc),
      responsavel_atual: "Operação",
      pagador: pagadorDe(i),
      destinatario: destinatarioDe(i),
      cidade_destino: cidadeDe(s.unidade, i),
      uf_destino: "MG",
      previsao_entrega: s.previsaoEmDias != null ? iso(t0 + s.previsaoEmDias * 24 * HORA) : null,
      atraso_original: s.atrasoDias ?? null,
      qtd_volumes: 1 + ((i * 5) % 9),
      sugestao: s.sugestao ? { ...s.sugestao, versao_regras: "demo" } : null,
      sugestao_em: s.sugestao ? iso(criado + 2 * MIN) : null,
      assumido_por: assumido?.id ?? null,
      assumido_por_nome: assumido?.nome ?? null,
      assumido_em: assumido ? iso(criado + 30 * MIN) : null,
      motivo_encerramento: null,
      encerrado_em: null,
      materializado_em: iso(t0 - 4 * MIN),
      created_at: iso(criado),
      updated_at: iso(t0 - 4 * MIN),
      _cardAtivo: !!s.cardAtivoNoRelacionamento,
    };
    itens.set(id, item);
    evento(id, "ItemMaterializado", null, { cod_ultima_ocorrencia: s.oc, unidade: s.unidade, nf: item.nf }, criado);
    if (item.sugestao) evento(id, "SugestaoGerada", null, { ...item.sugestao }, criado + 2 * MIN);
    if (assumido) evento(id, "ItemAssumido", assumido, { forcado: false }, criado + 30 * MIN);

    if (s.lancamento) {
      const L = s.lancamento;
      const por = OUTROS_MEMBROS[L.por];
      const pedido = t0 - L.minutosAtras * MIN;
      const textoSsw = textoSswDemo(L.texto, s.unidade, por.nome);
      const lanc: OpLancamento = {
        id: `demo-lanc-${seqLanc++}`,
        op_item_id: id,
        ctrc: item.ctrc,
        nf: item.nf,
        codigo_oc: L.codigo,
        texto_operador: L.texto,
        texto_ssw: textoSsw,
        origem: "manual",
        sugestao_regra_id: null,
        solicitado_por: por.id,
        solicitado_por_nome: por.nome,
        solicitado_em: iso(pedido),
        status: L.status,
        reservado_em: L.status === "fila" ? null : iso(pedido + MIN),
        lancado_em: ["lancado", "confirmado", "nao_confirmado"].includes(L.status) ? iso(pedido + 2 * MIN) : null,
        protocolo: null,
        categoria_erro: L.categoria_erro ?? null,
        detalhe: L.detalhe ?? null,
        confirmado_em: L.status === "confirmado" ? iso(pedido + 25 * MIN) : null,
        confirmado_por: L.status === "confirmado" ? "bastao" : null,
        oc_vista_na_confirmacao: L.status === "confirmado" ? L.codigo : L.status === "nao_confirmado" ? 13 : null,
        finalizado_em: ["confirmado", "nao_confirmado", "erro", "recusado"].includes(L.status) ? iso(pedido + 30 * MIN) : null,
        atualizado_em: iso(pedido + 30 * MIN),
      };
      lancamentos.push(lanc);
      evento(id, "LancamentoSolicitado", por, { lancamento_id: lanc.id, codigo_oc: L.codigo, texto_ssw: textoSsw }, pedido);
      if (L.status === "fila") item.status = "lancamento_pendente";
      if (L.status === "lancado") {
        item.status = "aguardando_confirmacao";
        evento(id, "LancamentoLancadoNoSsw", null, { lancamento_id: lanc.id }, pedido + 2 * MIN);
      }
      if (L.status === "confirmado") {
        evento(id, "LancamentoLancadoNoSsw", null, { lancamento_id: lanc.id }, pedido + 2 * MIN);
        evento(id, "LancamentoConfirmado", null, { lancamento_id: lanc.id, por: "bastao" }, pedido + 25 * MIN);
      }
      if (L.status === "nao_confirmado") {
        evento(id, "LancamentoLancadoNoSsw", null, { lancamento_id: lanc.id }, pedido + 2 * MIN);
        evento(id, "LancamentoNaoConfirmado", null, { lancamento_id: lanc.id, oc_vista: 13 }, pedido + 30 * MIN);
      }
      if (L.status === "erro") evento(id, "LancamentoExpirado", null, { lancamento_id: lanc.id }, pedido + 30 * MIN);
      if (L.status === "recusado") evento(id, "LancamentoRecusado", null, { lancamento_id: lanc.id, detalhe: L.detalhe }, pedido + 3 * MIN);
    }
  });

  // --- regras (espelho da cerca da mig 430) ----------------------------------------
  const ativoPorItem = (id: string) =>
    lancamentos.find((l) => l.op_item_id === id && (l.status === "fila" || l.status === "lancando" || l.status === "lancado"));

  function checar(itemId: string, codigo: number, textoBruto: string):
    | { ok: true; previa: OpPrevia; confirmacao: string; texto_ssw: string; texto: string }
    | { ok: false; erro: string; motivo: string } {
    const texto = (textoBruto ?? "").trim();
    if (!membro) return { ok: false, erro: "nao_e_membro_da_operacao", motivo: "só membros ativos da Operação lançam pela fila" };
    if (!flags.operacao_tela || !flags.operacao_lancar_ssw) {
      return { ok: false, erro: "lancamento_desligado", motivo: "o lançamento pela Operação está desligado" };
    }
    if (!membro.pode_lancar) return { ok: false, erro: "sem_permissao_de_lancar", motivo: "seu acesso é só de leitura" };
    const sup = membro.papel_op === "supervisor_op";
    const i = itens.get(itemId);
    if (!i || i.status === "encerrado") return { ok: false, erro: "item_fechado", motivo: "o item não está mais na fila" };
    if (!sup && (!i.unidade || !membro.unidades.includes(i.unidade))) {
      return { ok: false, erro: "fora_da_sua_unidade", motivo: "o item é de outra unidade" };
    }
    if (i.assumido_por && i.assumido_por !== membro.id && !sup) {
      return { ok: false, erro: "assumido_por_outro", motivo: `o item foi assumido por ${i.assumido_por_nome ?? "outra pessoa"}` };
    }
    if (i._cardAtivo) {
      return { ok: false, erro: "tratativa_aberta_no_relacionamento", motivo: "a nota tem tratativa aberta no Relacionamento" };
    }
    if (i.cod_ultima_ocorrencia != null && FINALIZADORAS_OU_DOCUMENTAIS.has(i.cod_ultima_ocorrencia)) {
      return { ok: false, erro: "nota_finalizada", motivo: "a nota está finalizada ou em ocorrência documental" };
    }
    if (!i.nf) return { ok: false, erro: "sem_nf_para_tripe", motivo: "sem NF para o tripé CTRC + NF + localização" };
    if (codigo == null || PROIBIDOS.has(codigo)) return { ok: false, erro: "codigo_proibido", motivo: "a Operação nunca lança este código" };
    const c = codigos.find((x) => x.codigo === codigo);
    if (!c) return { ok: false, erro: "codigo_nao_permitido", motivo: "o código não está na lista da Operação" };
    if ((c.exige_texto || TEXTO_OBRIGATORIO.has(codigo)) && texto.length < 10) {
      return { ok: false, erro: "texto_obrigatorio", motivo: "este código exige o seu texto (mínimo 10 caracteres)" };
    }
    if (texto.length > 400) return { ok: false, erro: "texto_longo", motivo: "texto acima de 400 caracteres" };
    if (i.cod_ultima_ocorrencia === codigo) return { ok: false, erro: "ja_e_a_ultima_oc", motivo: "esta já é a última ocorrência da nota" };
    if (ativoPorItem(i.id)) return { ok: false, erro: "lancamento_em_andamento", motivo: "já existe um lançamento deste item em andamento" };

    const texto_ssw = textoSswDemo(texto, i.unidade, membro.nome);
    const confirmacao = tokenDemo([i.id, i.ctrc, i.nf, i.cod_ultima_ocorrencia, codigo, texto_ssw]);
    return {
      ok: true,
      texto,
      texto_ssw,
      confirmacao,
      previa: {
        op_item_id: i.id,
        ctrc: i.ctrc,
        nf: i.nf,
        unidade: i.unidade,
        oc_atual: i.cod_ultima_ocorrencia,
        codigo_oc: codigo,
        descricao_oc: c.descricao,
        texto_ssw,
        conta_ssw: "ai.salex (conta de serviço)",
      },
    };
  }

  function liberar(i: ItemInterno) {
    if (i.status === "lancamento_pendente" || i.status === "aguardando_confirmacao") {
      i.status = i.assumido_por ? "assumido" : "aberto";
    }
  }

  function andarWorker(lanc: OpLancamento) {
    if (!simular) return;
    const item = itens.get(lanc.op_item_id)!;
    setTimeout(() => {
      if (lanc.status !== "fila") return;
      lanc.status = "lancando";
      lanc.reservado_em = iso(agora());
      lanc.atualizado_em = lanc.reservado_em;
      avisar();
      setTimeout(() => {
        if (lanc.status !== "lancando") return;
        lanc.status = "lancado";
        lanc.lancado_em = iso(agora());
        lanc.atualizado_em = lanc.lancado_em;
        item.status = "aguardando_confirmacao";
        evento(item.id, "LancamentoLancadoNoSsw", null, { lancamento_id: lanc.id, codigo_oc: lanc.codigo_oc });
        avisar();
        setTimeout(() => {
          if (lanc.status !== "lancado") return;
          lanc.status = "confirmado";
          lanc.confirmado_em = iso(agora());
          lanc.confirmado_por = "bastao";
          lanc.oc_vista_na_confirmacao = lanc.codigo_oc;
          lanc.finalizado_em = lanc.confirmado_em;
          lanc.atualizado_em = lanc.confirmado_em;
          item.cod_ultima_ocorrencia = lanc.codigo_oc;
          item.data_ultima_ocorrencia = lanc.confirmado_em;
          item.sugestao = null;
          item.sugestao_em = null;
          liberar(item);
          evento(item.id, "LancamentoConfirmado", null, { lancamento_id: lanc.id, por: "bastao" });
          avisar();
        }, passos.confirmar);
      }, passos.lancar);
    }, passos.reservar);
  }

  function solicitarInterno(itemId: string, codigo: number, texto: string, confirmacao: string, origem: "manual" | "sugestao", regraId: string | null): OpRespostaSolicitar {
    const chk0 = checar(itemId, codigo, texto);
    // tsconfig do app não é strict: o narrowing pela união não vale, então separa à mão.
    if (chk0.ok === false) return chk0 as OpFalha;
    const chk = chk0 as Extract<typeof chk0, { ok: true }>;
    if (!confirmacao || confirmacao !== chk.confirmacao) {
      return {
        ok: false,
        erro: "previa_desatualizada",
        motivo: "o que seria lançado mudou desde a prévia; confira de novo antes de confirmar",
        previa: chk.previa,
        confirmacao: chk.confirmacao,
      };
    }
    const i = itens.get(itemId)!;
    const eu = { id: membro!.id, nome: membro!.nome };
    if (i.assumido_por !== eu.id) {
      evento(i.id, "ItemAssumido", eu, { de: i.assumido_por, via: "pedido_de_lancamento" });
      i.assumido_por = eu.id;
      i.assumido_por_nome = eu.nome;
      i.assumido_em = iso(agora());
    }
    const lanc: OpLancamento = {
      id: `demo-lanc-${seqLanc++}`,
      op_item_id: i.id,
      ctrc: i.ctrc,
      nf: i.nf,
      codigo_oc: codigo,
      texto_operador: chk.texto,
      texto_ssw: chk.texto_ssw,
      origem,
      sugestao_regra_id: regraId,
      solicitado_por: eu.id,
      solicitado_por_nome: eu.nome,
      solicitado_em: iso(agora()),
      status: "fila",
      reservado_em: null,
      lancado_em: null,
      protocolo: null,
      categoria_erro: null,
      detalhe: null,
      confirmado_em: null,
      confirmado_por: null,
      oc_vista_na_confirmacao: null,
      finalizado_em: null,
      atualizado_em: iso(agora()),
    };
    lancamentos.push(lanc);
    i.status = "lancamento_pendente";
    evento(i.id, origem === "sugestao" ? "SugestaoAceita" : "LancamentoSolicitado", eu, {
      lancamento_id: lanc.id,
      codigo_oc: codigo,
      texto_ssw: chk.texto_ssw,
      regra_id: regraId,
    });
    andarWorker(lanc);
    avisar();
    return { ok: true, lancamento_id: lanc.id, status: "fila", previa: chk.previa };
  }

  function linhaDaFila(i: ItemInterno): OpFilaLinha {
    const ultimo = lancamentos
      .filter((l) => l.op_item_id === i.id)
      .sort((a, b) => b.solicitado_em.localeCompare(a.solicitado_em))[0];
    return {
      op_item_id: i.id,
      ctrc: i.ctrc,
      nf: i.nf,
      unidade: i.unidade,
      status: i.status,
      cod_ultima_ocorrencia: i.cod_ultima_ocorrencia,
      descricao_oc: i.cod_ultima_ocorrencia != null ? DESCRICOES_OC[i.cod_ultima_ocorrencia] ?? null : null,
      data_ultima_ocorrencia: i.data_ultima_ocorrencia,
      instrucao_ultima_ocorrencia: i.instrucao_ultima_ocorrencia,
      pagador: i.pagador,
      destinatario: i.destinatario,
      cidade_destino: i.cidade_destino,
      uf_destino: i.uf_destino,
      previsao_entrega: i.previsao_entrega,
      atraso_original: i.atraso_original,
      qtd_volumes: i.qtd_volumes,
      assumido_por: i.assumido_por,
      assumido_por_nome: i.assumido_por_nome,
      assumido_em: i.assumido_em,
      sugestao: i.sugestao,
      sugestao_em: i.sugestao_em,
      lancamento_id: ultimo?.id ?? null,
      lancamento_status: ultimo?.status ?? null,
      lancamento_codigo_oc: ultimo?.codigo_oc ?? null,
      lancamento_solicitado_por_nome: ultimo?.solicitado_por_nome ?? null,
      lancamento_solicitado_em: ultimo?.solicitado_em ?? null,
      materializado_em: i.materializado_em,
      updated_at: i.updated_at,
    };
  }

  const podeVer = (i: ItemInterno) =>
    !!opcoes.ehGestor ||
    (!!membro && (membro.papel_op === "supervisor_op" || (!!i.unidade && membro.unidades.includes(i.unidade))));

  // --- a OpApi --------------------------------------------------------------------
  return {
    modo: "demo",

    async minhaSessao(): Promise<OpSessao> {
      await esperar();
      return {
        membro: membro ? clone(membro) : null,
        eh_gestor: !!opcoes.ehGestor,
        eh_supervisor: membro?.papel_op === "supervisor_op",
        flags: { ...flags },
      };
    },

    async fila() {
      await esperar();
      if (!flags.operacao_tela && !opcoes.ehGestor) return [];
      return [...itens.values()].filter((i) => i.status !== "encerrado" && podeVer(i)).map((i) => clone(linhaDaFila(i)));
    },

    async itemDetalhe(id): Promise<OpRespostaDetalhe> {
      await esperar();
      const i = itens.get(id);
      if (!i || !podeVer(i)) return { ok: false, erro: "nao_encontrado" };
      const { _cardAtivo: _ignorado, ...item } = i;
      return clone({
        ok: true as const,
        item,
        descricao_oc: i.cod_ultima_ocorrencia != null ? DESCRICOES_OC[i.cod_ultima_ocorrencia] ?? null : null,
        eventos: eventos.filter((e) => e.op_item_id === id).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).slice(0, 50),
        lancamentos: lancamentos.filter((l) => l.op_item_id === id).sort((a, b) => b.solicitado_em.localeCompare(a.solicitado_em)).slice(0, 20),
        codigos_disponiveis: membro || opcoes.ehGestor ? codigos : [],
      });
    },

    async codigosDisponiveis() {
      await esperar();
      return membro || opcoes.ehGestor ? clone(codigos) : [];
    },

    async assumir(id, forcar = false): Promise<OpRespostaAssumir> {
      await esperar();
      if (!membro) return { ok: false, erro: "nao_e_membro_da_operacao" };
      if (!flags.operacao_tela) return { ok: false, erro: "tela_desligada" };
      const i = itens.get(id);
      if (!i || i.status === "encerrado") return { ok: false, erro: "item_fechado" };
      const sup = membro.papel_op === "supervisor_op";
      if (!sup && (!i.unidade || !membro.unidades.includes(i.unidade))) return { ok: false, erro: "fora_da_sua_unidade" };
      if (i.assumido_por === membro.id) return { ok: true, op_item_id: i.id, assumido_por: membro.id, status: i.status, ja_era_seu: true };
      if (i.assumido_por && !(forcar && sup)) {
        return { ok: false, erro: "assumido_por_outro", assumido_por_nome: i.assumido_por_nome };
      }
      i.assumido_por = membro.id;
      i.assumido_por_nome = membro.nome;
      i.assumido_em = iso(agora());
      if (i.status === "aberto") i.status = "assumido";
      evento(i.id, "ItemAssumido", membro, { forcado: forcar });
      avisar();
      return { ok: true, op_item_id: i.id, assumido_por: membro.id, status: i.status };
    },

    async previa(id, codigo, texto): Promise<OpRespostaPrevia> {
      await esperar();
      const chk0 = checar(id, codigo, texto);
      if (chk0.ok === false) return chk0 as OpFalha;
      const chk = chk0 as Extract<typeof chk0, { ok: true }>;
      return { ok: true, texto_ssw: chk.texto_ssw, confirmacao: chk.confirmacao, previa: chk.previa };
    },

    async solicitar(id, codigo, texto, confirmacao) {
      await esperar();
      return solicitarInterno(id, codigo, texto, confirmacao, "manual", null);
    },

    async aceitarSugestao(id, confirmacao) {
      await esperar();
      const s = itens.get(id)?.sugestao;
      if (!s) return { ok: false, erro: "sem_sugestao", motivo: "este item não tem sugestão" };
      return solicitarInterno(id, s.codigo, s.texto ?? "", confirmacao, "sugestao", s.regra_id);
    },

    async cancelar(lancamentoId): Promise<OpRespostaCancelar> {
      await esperar();
      if (!membro) return { ok: false, erro: "nao_e_membro_da_operacao" };
      const l = lancamentos.find((x) => x.id === lancamentoId);
      if (!l) return { ok: false, erro: "nao_encontrado" };
      if (l.solicitado_por !== membro.id && membro.papel_op !== "supervisor_op") return { ok: false, erro: "nao_e_seu" };
      if (l.status !== "fila") return { ok: false, erro: "ja_saiu_da_fila", status: l.status };
      l.status = "cancelado";
      l.finalizado_em = iso(agora());
      l.atualizado_em = l.finalizado_em;
      l.detalhe = `cancelado por ${membro.nome}`;
      const i = itens.get(l.op_item_id);
      if (i) liberar(i);
      evento(l.op_item_id, "LancamentoCancelado", membro, { lancamento_id: l.id, codigo_oc: l.codigo_oc });
      avisar();
      return { ok: true, lancamento_id: l.id, status: "cancelado" };
    },

    assinarMudancas(cb) {
      ouvintes.add(cb);
      return () => {
        ouvintes.delete(cb);
      };
    },

    _lancamentos: () => clone(lancamentos),
  };
}
