// =============================================================================
// estado-tratativa — a MEMÓRIA DO CARD (plano aprovado pelo Caio 17/09).
//
// Objeto estruturado por card com a história da NF: situação, ciclo, o que já
// foi feito nesta passagem, fatos com FONTE, pendências e alertas. É PROJEÇÃO
// 100% recomputável de card_events + tabelas — nunca fonte de verdade
// (convenção nº 1 intocada). Vive em cards.estado_tratativa (coluna própria;
// NUNCA em agent_state — o sync-bastao sobrescreve o snapshot).
//
// Decisões fixas do plano:
//  D1 o estado DESCREVE, nunca prescreve (sem "próxima ação" aqui dentro);
//  D2 fato origem:"llm" só pode FREAR autonomia, nunca liberar;
//  D5 correções/info-externa do operador entram como card_events e são
//     reaplicadas no recompute (overlay) — o jsonb nunca é editado direto.
//
// Este arquivo é PURO (deno test). I/O em estado-tratativa-carregar.ts.
// =============================================================================

import { atribuirCiclo, inicioDoCicloAtual } from "./ciclos-tratativa.ts";
import { reentregaEmAberto } from "./reentrega-em-aberto.ts";

export const ESTADO_SCHEMA_V = 1;
/** Teto duro do jsonb serializado (INV novo: estado ≤ 6KB). */
export const ESTADO_MAX_BYTES = 6 * 1024;

// ── tipos ────────────────────────────────────────────────────────────────────
export type OrigemFato = "deterministico" | "llm" | "operador";
export type TipoFato =
  | "recebimento_doc" | "promessa" | "endereco" | "recusa" | "avaria"
  | "prazo" | "contato" | "autorizacao" | "outro";

export interface FatoConfirmado {
  id: string;                       // estável: hash(tipo+fonte.ref+fato)
  fato: string;                     // slug curto ("comprovante_recebido")
  detalhe: string;                  // ≤200 chars, legível
  tipo: TipoFato;
  fonte: { tipo: "ssw" | "email" | "anexo" | "operador" | "sistema"; ref: string };
  origem: OrigemFato;
  em: string;                       // ISO
}

export interface AcaoDoCiclo {
  acao_key: string;                 // "lancar_ocorrencia:54"
  codigo_oc: number | null;
  em: string;
  resultado: "sucesso" | "falha" | "revertida";
  ref: string;                      // "acoes_executadas_ssw:<id>" | "historico_ssw:<idx>"
}

export interface EstadoTratativa {
  schema_v: number;
  rev: number;                      // monotônica (INV)
  base_event_id: string | null;     // último card_event incorporado
  base_event_at: string | null;
  hash_fontes: string;

  situacao:
    | "coletando_fatos" | "aguardando_cliente" | "aguardando_area_interna"
    | "pronto_para_acao" | "acao_agendada" | "impasse" | "encerrando";
  ciclo_atual: { n: number; total: number; aberto_em: string | null };
  ciclos_anteriores: Array<{ n: number; acoes: number[] }>;   // cap 5, compacto

  resumo: string | null;            // 2-3 frases (Haiku) — só display
  resumo_de_rev: number | null;

  fatos_confirmados: FatoConfirmado[];   // cap 20, mais recentes primeiro
  ja_feito_no_ciclo: AcaoDoCiclo[];      // 100% determinístico
  /** Caso NF 138102 (18/09): execuções com SUCESSO das últimas 72h, CRUZANDO
   *  ciclos — a reabertura rápida (56 transfere → 49 reabre em 4h) zerava o
   *  ja_feito_no_ciclo e o porteiro deixava repetir a 54 na MESMA conversa.
   *  A régua por DATA (48h na cerca) é a mesma do bounce NF 1611059. */
  execucoes_recentes: Array<{ codigo_oc: number; em: string }>;   // cap 10
  aguardando: { quem: "cliente" | "area_interna" | "operador" | "ninguem"; o_que: string; desde: string } | null;
  pendencias_dossie: string[];
  alertas: string[];                // strings canônicas, cap 5 — SÓ o que o operador deve ver
  /** Flags internas pra CERCA — nunca exibidas nem enviadas ao LLM (Caio 18/09,
   *  NF 1558007: "oc55_sem_reentrega_aberta" aparecia em TODO card sem reentrega
   *  aberta e confundia o operador; a informação só serve pro porteiro barrar
   *  uma proposta 55). Opcional: estados persistidos antes do fix não têm. */
  flags_cerca?: string[];
  divida: Array<{ texto: string; origem: OrigemFato; em: string }>;   // cap 5

  gerado_por: { gatilho: string; deterministico_em: string; llm_modelo: string | null; llm_em: string | null };
  atualizado_em: string;
}

/** Correção do operador (payload do evento EstadoCorrigidoPeloOperador). */
export interface CorrecaoOperador {
  op: "remover_fato" | "adicionar_fato";
  fato_id?: string;                 // remover
  fato?: Pick<FatoConfirmado, "fato" | "detalhe" | "tipo">; // adicionar
  em: string;
  por: string;
}

/** Entradas 100% deterministicas do montador (I/O resolve e entrega). */
export interface FontesEstado {
  cardState: string;
  codUltimaOcorrencia: number | null;
  clienteRespondeuEm: string | null;
  /** historico_ssw da coluna, MAIS RECENTE PRIMEIRO. */
  historicoSsw: ReadonlyArray<{ codigo: number | null; descricao?: string | null; instrucao: string | null; data: string | null; tem_foto?: boolean | null }>;
  historicoAtualizadoEm: string | null;
  /** aberturas de ciclo (card_events EVENTOS_ABERTURA_CICLO), ISO asc ou não. */
  aberturasCicloIso: readonly string[];
  /** ações executadas com sucesso/falha (acoes_executadas_ssw). */
  acoesExecutadas: ReadonlyArray<{ id: string; codigo_oc: number; iniciado_em: string; sucesso: boolean }>;
  /** último e-mail ENVIADO ao cliente (outbound) — ISO ou null. */
  ultimoEmailEnviadoEm: string | null;
  /** há ação autônoma agendada pendente pro card? */
  acaoAgendadaPendente: boolean;
  /** dossiê do extravio (agent_state.extravio_parcial.dossie), se houver. */
  dossie: { romaneio?: boolean; descricao?: boolean; valor?: boolean; completo?: boolean } | null;
  /** eventos-overlay do operador (reconstruídos de card_events, asc). */
  correcoes: readonly CorrecaoOperador[];
  infoExterna: ReadonlyArray<{ texto: string; por: string; em: string }>;
  /** âncora: último card_event do card no momento da leitura. */
  baseEventId: string | null;
  baseEventAt: string | null;
  gatilho: string;
  agoraIso: string;
}

// ── helpers puros ────────────────────────────────────────────────────────────
const corta = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);

/** SSW devolve instruções com HTML cru (comentários <!--...-->, <a onclick=...>,
 *  &nbsp;) — fix NF 1558007 (Caio 18/09): fato de tela nunca carrega markup. */
export function limpaHtml(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hash estável e barato (FNV-1a hex) pra id de fato e hash_fontes. */
export function hashEstavel(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function idDoFato(f: Pick<FatoConfirmado, "fato" | "tipo"> & { fonte: { ref: string } }): string {
  return hashEstavel(`${f.tipo}|${f.fato}|${f.fonte.ref}`);
}

/** Hash das fontes deterministicas — recompute só grava se mudou. */
export function hashFontes(f: FontesEstado): string {
  const chave = JSON.stringify({
    s: f.cardState, oc: f.codUltimaOcorrencia,
    h: f.historicoSsw.map((o) => [o.codigo, corta(o.instrucao, 40), o.data]),
    ab: [...f.aberturasCicloIso].sort(),
    ae: f.acoesExecutadas.map((a) => [a.id, a.sucesso]),
    ue: f.ultimoEmailEnviadoEm, ag: f.acaoAgendadaPendente,
    d: f.dossie, co: f.correcoes.length, ie: f.infoExterna.length,
    cr: f.clienteRespondeuEm,
  });
  return hashEstavel(chave);
}

// ── montador determinístico ──────────────────────────────────────────────────
/**
 * Monta o estado NOVO a partir das fontes + estado anterior (carrega os campos
 * de LLM — resumo/divida/fatos origem llm — que não são deriváveis; o worker
 * os renova quando houver texto novo). PURO.
 */
export function montarEstado(
  fontes: FontesEstado,
  anterior: EstadoTratativa | null,
): EstadoTratativa {
  const aberturasMs = fontes.aberturasCicloIso.map((t) => new Date(t).getTime());
  const inicioCicloMs = inicioDoCicloAtual(aberturasMs);
  const agoraMs = new Date(fontes.agoraIso).getTime();
  const pos = atribuirCiclo(aberturasMs, [], agoraMs);

  // ja_feito_no_ciclo: ações executadas DESDE a abertura do ciclo atual
  const jaFeito: AcaoDoCiclo[] = fontes.acoesExecutadas
    .filter((a) => inicioCicloMs == null || new Date(a.iniciado_em).getTime() >= inicioCicloMs)
    .map((a) => ({
      acao_key: `lancar_ocorrencia:${a.codigo_oc}`,
      codigo_oc: a.codigo_oc,
      em: a.iniciado_em,
      resultado: a.sucesso ? "sucesso" as const : "falha" as const,
      ref: `acoes_executadas_ssw:${a.id}`,
    }))
    .sort((a, b) => (a.em < b.em ? 1 : -1));

  // execuções recentes (72h, cruzando ciclos — caso NF 138102)
  const execucoesRecentes = fontes.acoesExecutadas
    .filter((a) => a.sucesso && agoraMs - new Date(a.iniciado_em).getTime() <= 72 * 3_600_000)
    .map((a) => ({ codigo_oc: a.codigo_oc, em: a.iniciado_em }))
    .sort((a, b) => (a.em < b.em ? 1 : -1))
    .slice(0, 10);

  // ciclos anteriores compactos (ações por ciclo, pelas execuções)
  const ciclosAnteriores: Array<{ n: number; acoes: number[] }> = [];
  if (pos.totalCiclos > 1) {
    for (let n = Math.max(1, pos.ciclo - 5); n < pos.ciclo; n++) {
      const acoes = fontes.acoesExecutadas
        .filter((a) => atribuirCiclo(aberturasMs, [], new Date(a.iniciado_em).getTime()).ciclo === n && a.sucesso)
        .map((a) => a.codigo_oc);
      ciclosAnteriores.push({ n, acoes });
    }
  }

  // fatos determinísticos: docs do dossiê recebidos + última oc relevante
  const fatos: FatoConfirmado[] = [];
  const d = fontes.dossie;
  if (d) {
    const docs: Array<[keyof NonNullable<FontesEstado["dossie"]>, string]> = [
      ["romaneio", "romaneio de coleta recebido"],
      ["descricao", "descrição dos itens recebida"],
      ["valor", "valor dos itens recebido"],
    ];
    for (const [k, det] of docs) {
      if (d[k] === true) {
        const f = {
          fato: `doc_${String(k)}_recebido`, detalhe: det, tipo: "recebimento_doc" as const,
          fonte: { tipo: "sistema" as const, ref: `agent_state:extravio_parcial.dossie.${String(k)}` },
          origem: "deterministico" as const, em: fontes.agoraIso,
        };
        fatos.push({ id: idDoFato(f), ...f });
      }
    }
  }
  // Primeira entrada COM código — o SSW intercala linhas informativas sem
  // código ("COMPROVANTE ANEXADO", "CTRC EMITIDO…") no topo, e usar [0]
  // deixava o card sem fato nenhum (varredura 18/09: 6 casos, ex. NF 291194).
  const idxUltOc = fontes.historicoSsw.findIndex((o) => o.codigo != null);
  const ultOc = idxUltOc >= 0 ? fontes.historicoSsw[idxUltOc] : undefined;
  if (ultOc?.codigo != null) {
    const f = {
      fato: `ultima_oc_${ultOc.codigo}`,
      detalhe: corta(`oc ${ultOc.codigo} — ${limpaHtml(ultOc.instrucao ?? ultOc.descricao ?? "")}`, 200),
      tipo: "outro" as const,
      fonte: { tipo: "ssw" as const, ref: `historico_ssw:${idxUltOc}` },
      origem: "deterministico" as const,
      em: ultOc.data ?? fontes.agoraIso,
    };
    fatos.push({ id: idDoFato(f), ...f });
  }
  // fatos do operador (info externa) — a única fonte com autoridade dupla
  for (const ie of fontes.infoExterna) {
    const f = {
      fato: "info_externa", detalhe: corta(ie.texto, 200), tipo: "contato" as const,
      fonte: { tipo: "operador" as const, ref: ie.por },
      origem: "operador" as const, em: ie.em,
    };
    fatos.push({ id: idDoFato(f), ...f });
  }
  // carrega fatos de LLM do estado anterior (não deriváveis; renovados pelo worker)
  for (const f of anterior?.fatos_confirmados ?? []) {
    if (f.origem === "llm" && !fatos.some((x) => x.id === f.id)) fatos.push(f);
  }
  // overlay de correções do operador (ordem cronológica)
  let fatosCorrigidos = [...fatos];
  for (const c of fontes.correcoes) {
    if (c.op === "remover_fato" && c.fato_id) {
      fatosCorrigidos = fatosCorrigidos.filter((f) => f.id !== c.fato_id);
    } else if (c.op === "adicionar_fato" && c.fato) {
      const f = {
        ...c.fato,
        detalhe: corta(c.fato.detalhe, 200),
        fonte: { tipo: "operador" as const, ref: c.por },
        origem: "operador" as const,
        em: c.em,
      };
      fatosCorrigidos.push({ id: idDoFato(f), ...f });
    }
  }
  fatosCorrigidos.sort((a, b) => (a.em < b.em ? 1 : -1));
  fatosCorrigidos = fatosCorrigidos.slice(0, 20);

  // pendências do dossiê
  const pendencias: string[] = [];
  if (d && d.completo !== true) {
    if (d.romaneio !== true) pendencias.push("falta_romaneio");
    if (d.descricao !== true) pendencias.push("falta_descricao_itens");
    if (d.valor !== true) pendencias.push("falta_valor_itens");
  }

  // alertas canônicos (reuso das libs de regra existentes)
  const alertas: string[] = [];
  const flagsCerca: string[] = [];
  const histCron = [...fontes.historicoSsw].reverse()   // reentregaEmAberto espera ordem cronológica
    .map((o) => ({ codigo: o.codigo, instrucao: o.instrucao }));
  // Flag INTERNA da cerca (não é alerta de tela): sem reentrega aberta, uma
  // proposta 55 deve ser barrada — mas isso não é informação pro operador em
  // um card onde 55 nem está em pauta (fix NF 1558007, Caio 18/09).
  if (!reentregaEmAberto(histCron)) flagsCerca.push("oc55_sem_reentrega_aberta");
  if (fontes.historicoAtualizadoEm) {
    const idadeH = (agoraMs - new Date(fontes.historicoAtualizadoEm).getTime()) / 3_600_000;
    if (idadeH > 24) alertas.push("historico_ssw_velho_24h");
  }

  // aguardando + situação (derivação fechada)
  let aguardando: EstadoTratativa["aguardando"] = null;
  if (fontes.cardState === "AGUARDANDO_CLIENTE") {
    aguardando = { quem: "cliente", o_que: "retorno do cliente pagador", desde: fontes.ultimoEmailEnviadoEm ?? fontes.agoraIso };
  } else if (fontes.cardState === "AGUARDANDO_TERCEIRO" || fontes.cardState === "EXECUTANDO_ACAO") {
    aguardando = { quem: "area_interna", o_que: "confirmação da ação no SSW", desde: jaFeito[0]?.em ?? fontes.agoraIso };
  } else if (fontes.cardState === "AGUARDANDO_VALIDACAO_HUMANA") {
    aguardando = { quem: "operador", o_que: "validar a sugestão pendente", desde: fontes.clienteRespondeuEm ?? fontes.agoraIso };
  }
  const situacao: EstadoTratativa["situacao"] =
    fontes.acaoAgendadaPendente ? "acao_agendada"
    : fontes.cardState === "AGUARDANDO_CLIENTE" ? "aguardando_cliente"
    : (fontes.cardState === "AGUARDANDO_TERCEIRO" || fontes.cardState === "EXECUTANDO_ACAO") ? "aguardando_area_interna"
    : fontes.cardState === "AGUARDANDO_VALIDACAO_HUMANA" ? "pronto_para_acao"
    : (fontes.cardState === "TRANSFERIDO" || fontes.cardState === "RESOLVIDO") ? "encerrando"
    : "coletando_fatos";

  const revAnterior = anterior?.rev ?? 0;
  return {
    schema_v: ESTADO_SCHEMA_V,
    rev: revAnterior + 1,
    base_event_id: fontes.baseEventId,
    base_event_at: fontes.baseEventAt,
    hash_fontes: hashFontes(fontes),
    situacao,
    ciclo_atual: {
      n: pos.ciclo, total: pos.totalCiclos,
      aberto_em: inicioCicloMs != null ? new Date(inicioCicloMs).toISOString() : null,
    },
    ciclos_anteriores: ciclosAnteriores.slice(-5),
    resumo: anterior?.resumo ?? null,
    resumo_de_rev: anterior?.resumo_de_rev ?? null,
    fatos_confirmados: fatosCorrigidos,
    ja_feito_no_ciclo: jaFeito,
    execucoes_recentes: execucoesRecentes,
    aguardando,
    pendencias_dossie: pendencias,
    alertas: alertas.slice(0, 5),
    flags_cerca: flagsCerca.slice(0, 5),
    divida: (anterior?.divida ?? []).slice(0, 5),
    gerado_por: {
      gatilho: fontes.gatilho,
      deterministico_em: fontes.agoraIso,
      llm_modelo: anterior?.gerado_por?.llm_modelo ?? null,
      llm_em: anterior?.gerado_por?.llm_em ?? null,
    },
    atualizado_em: fontes.agoraIso,
  };
}

/** Compacta pro prompt (≤ ~800 tokens): só o que orienta decisão. */
export function estadoParaPrompt(e: EstadoTratativa): string {
  const compacto = {
    situacao: e.situacao,
    ciclo: `${e.ciclo_atual.n}/${e.ciclo_atual.total}`,
    resumo: e.resumo,
    ja_feito_neste_ciclo: e.ja_feito_no_ciclo.map((a) => ({ oc: a.codigo_oc, em: a.em.slice(0, 10), resultado: a.resultado })),
    fatos: e.fatos_confirmados.slice(0, 10).map((f) => ({ f: f.detalhe, fonte: f.fonte.tipo, em: f.em.slice(0, 10), origem: f.origem })),
    aguardando: e.aguardando,
    pendencias_dossie: e.pendencias_dossie,
    alertas: e.alertas,
  };
  return JSON.stringify(compacto).slice(0, 3200);
}

/** Guard do INV: serializado cabe no teto? (chamado antes de gravar) */
export function estadoDentroDoTeto(e: EstadoTratativa): boolean {
  return JSON.stringify(e).length <= ESTADO_MAX_BYTES;
}
