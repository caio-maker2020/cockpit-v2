// =============================================================================
// ponte-operacao-tratativas — núcleo do endpoint `ponte-tratativas` (ADR 0035,
// contrato v2 parte A). O Roteirizador manda até 1000 CTRCs e recebe, por nota,
// o que o Relacionamento sabe dela.
//
// LEITURA PURA: o repositório abaixo só tem métodos de leitura — não existe
// caminho de escrita a partir daqui (o tipo impede). Busca SEMPRE por CTRC
// normalizado, igualdade exata com `cards.ctrc` (nunca por NF: regra de ouro).
//
// Qual card representa o CTRC: o ATIVO mais recente; se não houver ativo, o
// terminal mais recente (o painel mostra "RESOLVIDO", `bloqueiaEntrega:false`).
// Sem card nenhum → `semCard`.
// =============================================================================

import {
  autenticarPonte,
  ctrcValido,
  ehTerminal,
  FLAG_PONTE_OPERACAO_LEITURA,
  isoSaoPaulo,
  json,
  normalizarCtrc,
  respostaAuth,
  respostaFlagOff,
} from "./ponte-operacao-comum.ts";
import { decidirBloqueioEntrega } from "./ponte-operacao-bloqueio.ts";

export const LIMITE_CTRCS_POR_CONSULTA = 1000;

export interface CardTratativaRow {
  id: string;
  ctrc: string | null;
  state: string;
  tipo: string | null;
  responsavel_relacionamento: string | null;
  cod_ultima_ocorrencia: number | null;
  created_at: string;
  updated_at: string;
  /** estado_tratativa->>situacao (null se a memória do card não existe). */
  situacao: string | null;
  /** estado_tratativa->aguardando. */
  aguardando: { quem?: string | null; o_que?: string | null; desde?: string | null } | null;
}

export interface OcDicionario {
  descricao: string;
  responsabilidade: string;
}

/** Só leitura. */
export interface RepoTratativas {
  flagLigada(key: string): Promise<boolean>;
  /** Todos os cards cujo ctrc ∈ ctrcs (qualquer state). */
  cardsPorCtrcs(ctrcs: string[]): Promise<CardTratativaRow[]>;
  /** ocorrencias_dicionario. Falha → mapa vazio (a regra trata como desconhecida → bloqueia). */
  dicionario(): Promise<Map<number, OcDicionario>>;
}

export interface DepsTratativas {
  token: string | null;
  /** Base do front do Cockpit (COCKPIT_APP_URL). null → linkCard null. */
  appUrl: string | null;
  repo: RepoTratativas;
  agora?: () => Date;
}

export interface TratativaPonte {
  ctrc: string;
  cardId: string;
  estado: string;
  tipo: string | null;
  situacao: string | null;
  aguardando: string | null;
  responsavel: string | null;
  ultimaOcorrencia: string | null;
  atualizadoEm: string | null;
  bloqueiaEntrega: boolean;
  motivoBloqueio: string | null;
  linkCard: string | null;
}

export interface RespostaTratativas {
  geradoEm: string;
  tratativas: TratativaPonte[];
  semCard: string[];
}

/** Pura: escolhe o card que representa cada CTRC (ativo mais recente > terminal mais recente). */
export function escolherCardPorCtrc(rows: CardTratativaRow[]): Map<string, CardTratativaRow> {
  const ordenados = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const out = new Map<string, CardTratativaRow>();
  for (const r of ordenados) {
    const k = normalizarCtrc(r.ctrc);
    if (!k) continue;
    const atual = out.get(k);
    if (!atual) { out.set(k, r); continue; }
    // Já tenho um mais recente; só troco se ele é terminal e este é ativo.
    if (ehTerminal(atual.state) && !ehTerminal(r.state)) out.set(k, r);
  }
  return out;
}

/** Pura: monta a resposta do contrato a partir das linhas lidas. */
export function montarRespostaTratativas(args: {
  ctrcs: string[];
  rows: CardTratativaRow[];
  dicionario: Map<number, OcDicionario>;
  appUrl: string | null;
  agora: Date;
}): RespostaTratativas {
  const porCtrc = escolherCardPorCtrc(args.rows);
  const tratativas: TratativaPonte[] = [];
  const semCard: string[] = [];
  const base = args.appUrl ? args.appUrl.replace(/\/+$/, "") : null;
  for (const ctrc of args.ctrcs) {
    const c = porCtrc.get(ctrc);
    if (!c) { semCard.push(ctrc); continue; }
    const cod = typeof c.cod_ultima_ocorrencia === "number" ? c.cod_ultima_ocorrencia : null;
    const b = decidirBloqueioEntrega({
      state: c.state,
      tipo: c.tipo,
      situacao: c.situacao ?? null,
      aguardandoQuem: c.aguardando?.quem ?? null,
      aguardandoDesde: c.aguardando?.desde ?? null,
      codUltimaOcorrencia: cod,
      ocDicionario: cod !== null ? args.dicionario.get(cod) ?? null : null,
      tratativaDesde: c.created_at,
    });
    tratativas.push({
      ctrc,
      cardId: c.id,
      estado: c.state,
      tipo: c.tipo ?? null,
      situacao: c.situacao ?? null,
      aguardando: c.aguardando?.quem ?? null,
      responsavel: c.responsavel_relacionamento ?? null,
      ultimaOcorrencia: cod !== null ? String(cod) : null,
      atualizadoEm: isoSaoPaulo(c.updated_at),
      bloqueiaEntrega: b.bloqueiaEntrega,
      motivoBloqueio: b.motivoBloqueio,
      linkCard: base ? `${base}/cards/${c.id}` : null,
    });
  }
  return { geradoEm: isoSaoPaulo(args.agora)!, tratativas, semCard };
}

/** Pura: valida e normaliza o corpo. */
export function lerCtrcsDoCorpo(body: unknown):
  | { ok: true; ctrcs: string[]; invalidos: string[] }
  | { ok: false; motivo: string } {
  const lista = (body as { ctrcs?: unknown } | null)?.ctrcs;
  if (!Array.isArray(lista)) return { ok: false, motivo: "ctrcs precisa ser uma lista" };
  if (lista.length > LIMITE_CTRCS_POR_CONSULTA) {
    return { ok: false, motivo: `no máximo ${LIMITE_CTRCS_POR_CONSULTA} CTRCs por consulta` };
  }
  const vistos = new Set<string>();
  const ctrcs: string[] = [];
  const invalidos: string[] = [];
  for (const item of lista) {
    const n = typeof item === "string" ? normalizarCtrc(item) : null;
    if (!ctrcValido(n)) {
      if (typeof item === "string" && item.trim()) invalidos.push(item.trim().toUpperCase().slice(0, 30));
      continue;
    }
    if (vistos.has(n)) continue;
    vistos.add(n);
    ctrcs.push(n);
  }
  return { ok: true, ctrcs, invalidos };
}

/** Handler completo (sem Deno.serve): testável com repositório falso. Nunca lança. */
export async function handleTratativas(req: Request, deps: DepsTratativas): Promise<Response> {
  try {
    const auth = autenticarPonte(req, deps.token);
    if (auth !== "ok") return respostaAuth(auth);
    if (req.method !== "POST") return json({ erro: "metodo_nao_permitido" }, 405);
    if (!(await deps.repo.flagLigada(FLAG_PONTE_OPERACAO_LEITURA))) {
      return respostaFlagOff(FLAG_PONTE_OPERACAO_LEITURA);
    }
    const body = await req.json().catch(() => null);
    const lidos = lerCtrcsDoCorpo(body);
    if (!lidos.ok) return json({ erro: "invalido", motivos: [lidos.motivo] }, 422);

    const rows = lidos.ctrcs.length > 0 ? await deps.repo.cardsPorCtrcs(lidos.ctrcs) : [];
    const dicionario = rows.length > 0 ? await deps.repo.dicionario() : new Map<number, OcDicionario>();
    const resposta = montarRespostaTratativas({
      ctrcs: lidos.ctrcs,
      rows,
      dicionario,
      appUrl: deps.appUrl,
      agora: (deps.agora ?? (() => new Date()))(),
    });
    // CTRC fora do formato não tem card por definição: vai para semCard, como o contrato pede.
    resposta.semCard.push(...lidos.invalidos);
    return json(resposta, 200);
  } catch (e) {
    return json({ erro: "falha_interna", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
}
