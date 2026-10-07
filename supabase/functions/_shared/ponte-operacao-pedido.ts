// =============================================================================
// ponte-operacao-pedido — núcleo do endpoint `ponte-pedido-operacao` (ADR 0039,
// contrato v2 parte B). O Roteirizador PEDE, o Cockpit EXECUTA.
//
//   POST → valida, registra o pedido (pedidoId = chave de idempotência) e, se já
//          existe card para o CTRC, grava o evento no card na hora. NUNCA fala
//          com o SSW nem com o Bastão aqui: o resto é do worker
//          `processar-pedidos-operacao`, por fila com limite de vazão (INV-159).
//   GET  → status do pedido.
//
// Respostas (contrato + emendas de 25/09): 202 recebido · 200 mesmo pedidoId já
// visto · 409 mesmo pedidoId com conteúdo diferente (status do original, sem
// executar) · 422 pedido inválido · 503 flag OFF / sem PONTE_OPERACAO_TOKEN · 401.
//
// `nf` (emenda 1) é opcional. Quando vem, entra no tripé do SSW se o card não tem
// NF, e é CONFERIDA contra a NF do card e a do Bastão: divergência = recusa (o
// CTRC e a NF do card nunca são trocados pelos do pedido).
//
// Origem HUMANA: `solicitadoPor` com id e nome é obrigatório; identificadores de
// automação são recusados. A garantia de que o pedido nasce de um clique é do
// Roteirizador (o endpoint só pode ser chamado por um botão); o Cockpit exige a
// identidade e grava quem pediu em todo evento (ADR 0039, D2 e D7).
// =============================================================================

import {
  autenticarPonte,
  ctrcValido,
  ehTerminal,
  FLAG_PONTE_OPERACAO_LANCAR_SSW,
  FLAG_PONTE_OPERACAO_PEDIDOS,
  isoSaoPaulo,
  json,
  normalizarCtrc,
  normalizarNf,
  respostaAuth,
  respostaFlagOff,
} from "./ponte-operacao-comum.ts";

export type TipoPedido = "devolver_ao_relacionamento" | "lancar_ocorrencia";
export const TIPOS_PEDIDO: readonly TipoPedido[] = ["devolver_ao_relacionamento", "lancar_ocorrencia"];

/** A ocorrência de `devolver_ao_relacionamento` (contrato: "devolver usa 49"). */
export const CODIGO_DEVOLVER = 49;
/** Entregue normalmente / devolução autorizada / operação cancelada (OCS_FINALIZADORAS). */
export const OCS_FINALIZADORAS_PONTE: ReadonlySet<number> = new Set([1, 30, 32]);

export const TEXTO_MIN = 3;
/** O campo Instrução do SSW aceita 500; sobra espaço para "(pedido da operação … por …)". */
export const TEXTO_MAX = 400;

export type StatusPedido = "recebido" | "executado" | "recusado" | "erro";
export type EtapaPedido = "vincular_card" | "vinculado" | "fila_ssw" | "lancando_ssw" | "fim";

export interface SolicitadoPor {
  id: string;
  nome: string;
  email: string | null;
}

export interface PedidoValido {
  pedidoId: string;
  tipo: TipoPedido;
  ctrc: string;
  codigoOcorrencia: number;
  texto: string;
  base: string | null;
  /** NF sem zeros à esquerda (igual a cards.nf), ou null quando o Roteirizador não mandou. */
  nf: string | null;
  solicitadoPor: SolicitadoPor;
  criadoEm: string | null;
}

export interface MotivoRecusa {
  codigo: string;
  mensagem: string;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identificadores de automação. Um pedido desses NÃO é clique de pessoa — a
 * ação que ele pede (ocorrência no SSW) não pode sair de agente (ADR 0033).
 */
const RE_AUTOMACAO =
  /^(sistema|system|agente|agent|bot|robo|robô|ia|ai|llm|cron|auto|automatico|automático|worker|job|script|roteirizador|cockpit|servico|serviço|service)(?=$|[^\p{L}\p{N}])/iu;

function limpar(s: string): string {
  // tira caracteres de controle (menos quebra de linha), colapsa espaços nas pontas
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").trim();
}

/** Pura: valida o corpo do POST. Todos os problemas de uma vez (o painel mostra a lista). */
export function validarPedido(body: unknown):
  | { ok: true; pedido: PedidoValido }
  | { ok: false; motivos: MotivoRecusa[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const motivos: MotivoRecusa[] = [];

  const pedidoId = typeof b.pedidoId === "string" ? b.pedidoId.trim().toLowerCase() : "";
  if (!RE_UUID.test(pedidoId)) motivos.push({ codigo: "pedido_id_invalido", mensagem: "pedidoId precisa ser um uuid" });

  const tipo = b.tipo as TipoPedido;
  const tipoOk = TIPOS_PEDIDO.includes(tipo);
  if (!tipoOk) motivos.push({ codigo: "tipo_invalido", mensagem: `tipo precisa ser ${TIPOS_PEDIDO.join(" ou ")}` });

  const ctrc = typeof b.ctrc === "string" ? normalizarCtrc(b.ctrc) : null;
  if (!ctrcValido(ctrc)) motivos.push({ codigo: "ctrc_invalido", mensagem: "ctrc ausente ou fora do formato (ex.: AMB642904-1)" });

  const texto = typeof b.texto === "string" ? limpar(b.texto) : "";
  if (texto.length < TEXTO_MIN) {
    motivos.push({ codigo: "texto_curto", mensagem: `o texto é obrigatório, com ${TEXTO_MIN} caracteres ou mais` });
  } else if (texto.length > TEXTO_MAX) {
    motivos.push({ codigo: "texto_longo", mensagem: `o texto tem mais de ${TEXTO_MAX} caracteres (o campo do SSW tem 500)` });
  }

  const codRaw = b.codigoOcorrencia;
  const codStr = codRaw === undefined || codRaw === null ? "" : String(codRaw).trim();
  let codigo: number | null = null;
  if (codStr !== "") {
    if (/^\d{1,3}$/.test(codStr)) codigo = parseInt(codStr, 10);
    else motivos.push({ codigo: "codigo_invalido", mensagem: "codigoOcorrencia precisa ser um número de 1 a 3 dígitos" });
  }
  if (tipoOk && tipo === "lancar_ocorrencia" && codStr === "") {
    motivos.push({ codigo: "codigo_obrigatorio", mensagem: "lancar_ocorrencia exige codigoOcorrencia" });
  }
  if (tipoOk && tipo === "lancar_ocorrencia" && codigo === CODIGO_DEVOLVER) {
    motivos.push({ codigo: "codigo_nao_permitido", mensagem: "a 49 entra só por devolver_ao_relacionamento" });
  }
  if (tipoOk && tipo === "devolver_ao_relacionamento" && codigo !== null && codigo !== CODIGO_DEVOLVER) {
    motivos.push({ codigo: "devolver_so_com_49", mensagem: "devolver_ao_relacionamento usa a 49; outro código não é aceito" });
  }

  const sp = (b.solicitadoPor ?? null) as Record<string, unknown> | null;
  const spId = sp && (typeof sp.id === "string" || typeof sp.id === "number") ? String(sp.id).trim() : "";
  const spNome = sp && typeof sp.nome === "string" ? limpar(sp.nome) : "";
  const spEmail = sp && typeof sp.email === "string" && sp.email.trim() ? sp.email.trim().slice(0, 200) : null;
  if (!spId || spId.length > 64 || spNome.length < 2 || spNome.length > 120 || !/\p{L}/u.test(spNome)) {
    motivos.push({
      codigo: "solicitado_por_obrigatorio",
      mensagem: "solicitadoPor precisa de id e nome da pessoa que clicou",
    });
  } else if (RE_AUTOMACAO.test(spId) || RE_AUTOMACAO.test(spNome)) {
    motivos.push({
      codigo: "solicitado_por_automatico",
      mensagem: "o pedido precisa vir do clique de uma pessoa, não de agente ou automação",
    });
  }

  let base: string | null = null;
  if (b.base !== undefined && b.base !== null && String(b.base).trim() !== "") {
    base = String(b.base).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(base)) motivos.push({ codigo: "base_invalida", mensagem: "base fora do formato (ex.: VGA)" });
  }

  let nf: string | null = null;
  if (b.nf !== undefined && b.nf !== null && String(b.nf).trim() !== "") {
    const bruto = String(b.nf).trim();
    const n = /^\d{1,15}$/.test(bruto) ? normalizarNf(bruto) : null;
    if (!n || n.length > 12) motivos.push({ codigo: "nf_invalida", mensagem: "nf precisa ser o número da NF (só dígitos)" });
    else nf = n;
  }

  let criadoEm: string | null = null;
  if (typeof b.criadoEm === "string" && b.criadoEm.trim()) {
    const t = Date.parse(b.criadoEm);
    if (!Number.isFinite(t)) motivos.push({ codigo: "criado_em_invalido", mensagem: "criadoEm não é data ISO" });
    else criadoEm = new Date(t).toISOString();
  }

  if (motivos.length > 0) return { ok: false, motivos };
  return {
    ok: true,
    pedido: {
      pedidoId,
      tipo,
      ctrc: ctrc!,
      codigoOcorrencia: tipo === "devolver_ao_relacionamento" ? CODIGO_DEVOLVER : codigo!,
      texto,
      base,
      nf,
      solicitadoPor: { id: spId, nome: spNome, email: spEmail },
      criadoEm,
    },
  };
}

/** SHA-256 do conteúdo que define o pedido. Mesmo pedidoId com hash diferente → 409. */
export async function hashPedido(p: PedidoValido): Promise<string> {
  const canon = [p.tipo, p.ctrc, String(p.codigoOcorrencia), p.texto, p.base ?? "", p.solicitadoPor.id, p.nf ?? ""].join("|");
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(dig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── repositório ──────────────────────────────────────────────────────────────

export interface CardResumo {
  id: string;
  ctrc: string | null;
  nf: string | null;
  state: string;
  cod_ultima_ocorrencia: number | null;
  created_at: string;
}

export interface PedidoRow {
  pedido_id: string;
  tipo: TipoPedido;
  ctrc: string;
  codigo_ocorrencia: number;
  texto: string;
  base: string | null;
  nf: string | null;
  solicitado_por_id: string;
  solicitado_por_nome: string;
  solicitado_por_email: string | null;
  criado_em_origem: string | null;
  recebido_em: string;
  hash_pedido: string;
  status: StatusPedido;
  etapa: EtapaPedido;
  card_id: string | null;
  card_criado_pelo_pedido: boolean;
  card_event_id: string | null;
  ocorrencia_lancada: number | null;
  acao_ssw_id: string | null;
  categoria_erro: string | null;
  detalhe: string | null;
  executado_em: string | null;
}

export type NovoPedidoRow = Pick<
  PedidoRow,
  | "pedido_id" | "tipo" | "ctrc" | "codigo_ocorrencia" | "texto" | "base" | "nf"
  | "solicitado_por_id" | "solicitado_por_nome" | "solicitado_por_email"
  | "criado_em_origem" | "hash_pedido" | "status" | "etapa"
>;

export interface RepoPedidos {
  flagLigada(key: string): Promise<boolean>;
  buscarPedido(pedidoId: string): Promise<PedidoRow | null>;
  /** "conflito" = o pedido_id já existe (corrida entre dois POST iguais). */
  inserirPedido(p: NovoPedidoRow): Promise<"inserido" | "conflito">;
  /** Código ATIVO na lista da operação E de responsabilidade 'Operação' no dicionário. Erro → false. */
  codigoPermitido(codigo: number): Promise<boolean>;
  /** Cards do CTRC (qualquer state), mais recente primeiro. */
  cardsDoCtrc(ctrc: string): Promise<CardResumo[]>;
  /** RPC atômica: evento no card + vínculo no pedido (mig 415). Lança em erro. */
  vincularCard(args: { pedidoId: string; cardId: string; cardCriado: boolean; payloadCriacao: Record<string, unknown> | null }): Promise<void>;
}

export interface DepsPedidos {
  token: string | null;
  repo: RepoPedidos;
}

export interface StatusPedidoResposta {
  pedidoId: string;
  status: StatusPedido;
  ocorrenciaLancada: string | null;
  cardId: string | null;
  detalhe: string | null;
  executadoEm: string | null;
}

export function statusDoPedido(row: PedidoRow): StatusPedidoResposta {
  return {
    pedidoId: row.pedido_id,
    status: row.status,
    ocorrenciaLancada: row.ocorrencia_lancada !== null && row.ocorrencia_lancada !== undefined
      ? String(row.ocorrencia_lancada)
      : null,
    cardId: row.card_id ?? null,
    detalhe: row.detalhe ?? null,
    executadoEm: isoSaoPaulo(row.executado_em),
  };
}

function recusa422(motivos: MotivoRecusa[]): Response {
  return json({ erro: "invalido", motivos }, 422);
}

/**
 * Pura: dado o pedido e os cards do CTRC, decide em que card o pedido entra
 * AGORA (ou se o worker vai achar/criar depois) e se o pedido é inválido.
 */
export function decidirAlvoDoPedido(
  p: Pick<PedidoValido, "tipo" | "nf">,
  cards: CardResumo[],
): { ok: true; alvo: CardResumo | null } | { ok: false; motivo: MotivoRecusa } {
  const ativo = cards.find((c) => !ehTerminal(c.state)) ?? null;
  const recente = cards[0] ?? null;
  const referencia = ativo ?? recente;
  if (referencia && referencia.cod_ultima_ocorrencia !== null && OCS_FINALIZADORAS_PONTE.has(referencia.cod_ultima_ocorrencia)) {
    return {
      ok: false,
      motivo: {
        codigo: "nota_entregue_ou_baixada",
        mensagem: `a nota está ENTREGUE/BAIXADA (oc ${referencia.cod_ultima_ocorrencia}); o SSW recusaria o lançamento`,
      },
    };
  }
  // A NF do pedido é conferida contra a do card: divergência não se resolve trocando
  // a NF do card (regra de ouro) — o pedido volta para quem mandou.
  const nfCard = normalizarNf(referencia?.nf);
  if (p.nf && nfCard && p.nf !== nfCard) {
    return {
      ok: false,
      motivo: { codigo: "nf_diverge", mensagem: `a NF do pedido (${p.nf}) não é a do card do CTRC (${nfCard})` },
    };
  }
  if (p.tipo === "devolver_ao_relacionamento") {
    // Com card ativo, o evento entra nele agora; sem, o worker acha ou cria (ADR 0039, D2).
    return { ok: true, alvo: ativo };
  }
  // lancar_ocorrencia: um fato da rota, lançado no card do CTRC (o envelope do SSW
  // exige card: CTRC e NF saem dele para o tripé — regra de ouro).
  if (ativo) {
    return {
      ok: false,
      motivo: {
        codigo: "tratativa_aberta",
        mensagem: "a nota tem tratativa aberta no Relacionamento; use devolver_ao_relacionamento",
      },
    };
  }
  if (!recente) {
    return p.nf
      ? {
        ok: false,
        motivo: {
          codigo: "sem_card",
          mensagem: "o Cockpit não tem card para este CTRC; lancar_ocorrencia não cria card e o envelope do SSW exige um",
        },
      }
      : { ok: false, motivo: { codigo: "sem_nf_para_tripe", mensagem: "sem NF para o tripé" } };
  }
  if (!nfCard && !p.nf) {
    return { ok: false, motivo: { codigo: "sem_nf_para_tripe", mensagem: "sem NF para o tripé" } };
  }
  return { ok: true, alvo: recente };
}

/**
 * Mesmo pedidoId já visto: 200 com o status atual. Com CONTEÚDO diferente (emenda 4):
 * 409 com o status do pedido ORIGINAL — nada é executado de novo.
 */
async function responderExistente(existente: PedidoRow, p: PedidoValido): Promise<Response> {
  const st = statusDoPedido(existente);
  if ((await hashPedido(p)) !== existente.hash_pedido) {
    return json({ erro: "conteudo_divergente", mensagem: "este pedidoId já foi usado com outro conteúdo; nada foi executado", ...st }, 409);
  }
  return json(st, 200);
}

/** POST: registra o pedido. Nunca lança. */
export async function handlePostPedido(req: Request, deps: DepsPedidos): Promise<Response> {
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  try {
    const { repo } = deps;
    if (!(await repo.flagLigada(FLAG_PONTE_OPERACAO_PEDIDOS))) return respostaFlagOff(FLAG_PONTE_OPERACAO_PEDIDOS);

    const body = await req.json().catch(() => null);
    const v = validarPedido(body);
    if (!v.ok) return recusa422(v.motivos);
    const p = v.pedido;

    // Idempotência primeiro: o mesmo pedidoId devolve o status atual, mesmo que
    // alguma flag tenha mudado desde o primeiro envio.
    const existente = await repo.buscarPedido(p.pedidoId);
    if (existente) return await responderExistente(existente, p);

    // Lançar ocorrência sem o lançamento no SSW ligado não tem o que executar:
    // responde "desligado" e não registra nada (nunca "meio ligado").
    if (p.tipo === "lancar_ocorrencia" && !(await repo.flagLigada(FLAG_PONTE_OPERACAO_LANCAR_SSW))) {
      return respostaFlagOff(FLAG_PONTE_OPERACAO_LANCAR_SSW);
    }

    if (p.tipo === "lancar_ocorrencia" && !(await repo.codigoPermitido(p.codigoOcorrencia))) {
      return recusa422([{
        codigo: "codigo_nao_permitido",
        mensagem: `a oc ${p.codigoOcorrencia} não está na lista que a operação pode lançar (lista vazia por padrão)`,
      }]);
    }

    const cards = await repo.cardsDoCtrc(p.ctrc);
    const alvo = decidirAlvoDoPedido(p, cards);
    if (!alvo.ok) return recusa422([alvo.motivo]);

    const ins = await repo.inserirPedido({
      pedido_id: p.pedidoId,
      tipo: p.tipo,
      ctrc: p.ctrc,
      codigo_ocorrencia: p.codigoOcorrencia,
      texto: p.texto,
      base: p.base,
      nf: p.nf,
      solicitado_por_id: p.solicitadoPor.id,
      solicitado_por_nome: p.solicitadoPor.nome,
      solicitado_por_email: p.solicitadoPor.email,
      criado_em_origem: p.criadoEm,
      hash_pedido: await hashPedido(p),
      status: "recebido",
      etapa: "vincular_card",
    });
    if (ins === "conflito") {
      const jaVisto = await repo.buscarPedido(p.pedidoId);
      if (jaVisto) return await responderExistente(jaVisto, p);
      return json({ erro: "falha_interna", mensagem: "conflito de pedidoId sem linha" }, 500);
    }

    let cardId: string | null = null;
    if (alvo.alvo) {
      try {
        await repo.vincularCard({ pedidoId: p.pedidoId, cardId: alvo.alvo.id, cardCriado: false, payloadCriacao: null });
        cardId = alvo.alvo.id;
      } catch (e) {
        // O pedido já está gravado: o worker tenta vincular de novo no próximo minuto.
        console.warn(`[ponte-pedido-operacao] vincular ${p.pedidoId} falhou, worker retenta: ${e instanceof Error ? e.message : e}`);
      }
    }
    return json({ pedidoId: p.pedidoId, status: "recebido", cardId }, 202);
  } catch (e) {
    return json({ erro: "falha_interna", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** GET ?pedidoId=: status do pedido. Nunca lança. */
export async function handleGetPedido(req: Request, deps: DepsPedidos): Promise<Response> {
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  try {
    if (!(await deps.repo.flagLigada(FLAG_PONTE_OPERACAO_PEDIDOS))) return respostaFlagOff(FLAG_PONTE_OPERACAO_PEDIDOS);
    const id = (new URL(req.url).searchParams.get("pedidoId") ?? "").trim().toLowerCase();
    if (!RE_UUID.test(id)) {
      return recusa422([{ codigo: "pedido_id_invalido", mensagem: "pedidoId precisa ser um uuid" }]);
    }
    const row = await deps.repo.buscarPedido(id);
    if (!row) return json({ erro: "nao_encontrado", pedidoId: id }, 404);
    return json(statusDoPedido(row), 200);
  } catch (e) {
    return json({ erro: "falha_interna", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function handlePedido(req: Request, deps: DepsPedidos): Promise<Response> {
  if (req.method === "POST") return await handlePostPedido(req, deps);
  if (req.method === "GET") return await handleGetPedido(req, deps);
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  return json({ erro: "metodo_nao_permitido" }, 405);
}
