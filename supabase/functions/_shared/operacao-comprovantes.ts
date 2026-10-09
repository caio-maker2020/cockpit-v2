// =============================================================================
// operacao-comprovantes — a aba Comprovantes da Operação lendo a fonte REAL
// (ADR 0042 D6; recria o "Comprovantes de Entrega" do Pendências,
// tatiana-kelly/pendency-tracker, com os defeitos corrigidos).
//
// Fonte: o projeto Supabase secundário do Pendências (views
// `vw_pendencias_comprovante_entrega` e `vw_comprovantes_entregues`), lido com a
// chave anon dele, SÓ com GET/HEAD. Nada é escrito lá nem aqui.
//
// Quem vê o quê (mesma regra do `op_pode_ver_unidade`, mig 430):
//   - gestor do Cockpit: tudo, sempre;
//   - membro da Operação só com a flag `operacao_tela` ligada;
//   - supervisor_op: todas as unidades;
//   - os outros (operador_op, gerente_op): só as unidades do cadastro. Cadastro sem
//     unidade = lista VAZIA, nunca "todas".
// O filtro de unidade vai no servidor da fonte (unidade_receptora=in.(...)).
//
// Defeitos do Pendências corrigidos aqui:
//   - a paginação tem ordem estável (order=serie_numero_ctrc), senão o PostgREST
//     pode repetir/pular linhas entre páginas;
//   - a idade sem `idade_pendencia_dias` é calculada no fuso de São Paulo, não em UTC;
//   - datas saem como 'YYYY-MM-DD' (o front formata sem passar por Date/UTC);
//   - as exclusões (CTRC em duplicidade e ocorrência de ressarcimento) acontecem
//     aqui, uma vez, e não espalhadas pela tela.
//
// % de pendência = pendentes ÷ (pendentes + entregues). É APROXIMAÇÃO: as exclusões
// só tiram linhas do numerador; o total de entregues vem da contagem da view sem
// filtro de exclusão.
//
// PURO: a I/O entra por `deps` (fetch, sessão). Testes: operacao-comprovantes.test.ts.
// =============================================================================

export const VIEW_PENDENTES = "vw_pendencias_comprovante_entrega";
export const VIEW_ENTREGUES = "vw_comprovantes_entregues";
export const PAGINA_COMPROVANTES = 1000;
export const TETO_LINHAS_COMPROVANTES = 50_000;

/** CTRCs em duplicidade na fonte (Pendências, src/lib/comprovantes/exclusoesPendencia.ts). */
export const CTRCS_EXCLUIDOS: ReadonlySet<string> = new Set(["OVD352980-1"]);

export const ERRO_SEM_CREDENCIAL = "comprovantes_sem_credencial" as const;

export const CORS_COMPROVANTES: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function jsonComprovantes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_COMPROVANTES, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ── quem vê o quê ────────────────────────────────────────────────────────────

/** O pedaço de `op_minha_sessao()` (mig 441) que importa aqui. */
export interface SessaoOpComprovantes {
  membro: { papel_op?: string | null; unidades?: readonly string[] | null } | null;
  eh_gestor?: boolean | null;
  eh_supervisor?: boolean | null;
  flags?: { operacao_tela?: boolean | null } | null;
}

export interface EscopoComprovantes {
  /** true = sem filtro de unidade (gestor, supervisor_op). */
  todas: boolean;
  /** Siglas aceitas (maiúsculas). Vale só com `todas=false`; vazio = nada. */
  unidades: string[];
}

export type ResultadoEscopo =
  | { ok: true; escopo: EscopoComprovantes }
  | { ok: false; erro: "sem_acesso" | "tela_desligada" };

export function escopoDaSessao(s: SessaoOpComprovantes | null | undefined): ResultadoEscopo {
  if (!s) return { ok: false, erro: "sem_acesso" };
  if (s.eh_gestor === true) return { ok: true, escopo: { todas: true, unidades: [] } };
  if (!s.membro) return { ok: false, erro: "sem_acesso" };
  if (s.flags?.operacao_tela !== true) return { ok: false, erro: "tela_desligada" };
  if (s.eh_supervisor === true || s.membro.papel_op === "supervisor_op") {
    return { ok: true, escopo: { todas: true, unidades: [] } };
  }
  const unidades = [
    ...new Set((s.membro.unidades ?? []).map((u) => String(u ?? "").trim().toUpperCase()).filter((u) => u.length > 0)),
  ].sort();
  return { ok: true, escopo: { todas: false, unidades } };
}

/** Valor PostgREST `in.(...)` com cada sigla entre aspas (vírgula/parêntese não quebram o filtro). */
export function filtroUnidades(unidades: readonly string[]): string {
  return `in.(${unidades.map((u) => `"${u.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

// ── normalização de valores ──────────────────────────────────────────────────

const OFFSET_SP_MS = -3 * 3_600_000; // America/Sao_Paulo sem horário de verão desde 2019
const DIA_MS = 86_400_000;

/** Dia (índice desde 1970) em São Paulo de um instante. */
export function diaSP(ms: number): number {
  return Math.floor((ms + OFFSET_SP_MS) / DIA_MS);
}

/**
 * Qualquer data da fonte → 'YYYY-MM-DD' (dia de São Paulo), ou null.
 * 'YYYY-MM-DD' e timestamp sem fuso valem como estão (já são dia local);
 * timestamp com fuso vira o dia em São Paulo; 'DD/MM/YYYY' também é aceito.
 */
export function dataIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s);
  if (!m) return null;
  if (!m[7]) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (!Number.isFinite(t)) return `${m[1]}-${m[2]}-${m[3]}`;
  return new Date(diaSP(t) * DIA_MS).toISOString().slice(0, 10);
}

/** Número da fonte (numeric vem como number ou string; aceita '1.234,56'). */
export function numero(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

const texto = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Dias corridos da entrega até hoje, em São Paulo. */
export function idadeDesde(dataEntrega: string | null, agoraMs: number): number | null {
  if (!dataEntrega) return null;
  const [y, mo, d] = dataEntrega.split("-").map(Number) as [number, number, number];
  const dia = Date.UTC(y, mo - 1, d) / DIA_MS;
  if (!Number.isFinite(dia)) return null;
  return Math.max(0, diaSP(agoraMs) - dia);
}

// ── linha da view → linha da resposta ────────────────────────────────────────

/** Linha da view `vw_pendencias_comprovante_entrega` (colunas conferidas em 09/10). */
export interface LinhaViewPendente {
  compr_entrega_escaneado?: unknown;
  data_escaneamento?: unknown;
  unidade_receptora?: unknown;
  nome_base?: unknown;
  tipo_base?: unknown;
  cliente_pagador?: unknown;
  descricao_ultima_ocorrencia?: unknown;
  serie_numero_ctrc?: unknown;
  placa_entrega?: unknown;
  valor_frete?: unknown;
  valor_mercadoria?: unknown;
  data_entrega_realizada?: unknown;
  tipo_do_documento?: unknown;
  data_emissao?: unknown;
  numero_da_nota_fiscal?: unknown;
  numero_pacote_arquivo?: unknown;
  idade_pendencia_dias?: unknown;
  faixa_idade?: unknown;
}

/** O que a tela recebe (mesmos nomes do `ComprovantePendente` do front). */
export interface ComprovanteResposta {
  ctrc: string;
  nf: string | null;
  unidade: string | null;
  base_nome: string | null;
  base_tipo: string | null;
  cliente_pagador: string | null;
  placa: string | null;
  descricao_oc: string | null;
  tipo_documento: string | null;
  data_entrega: string | null;
  data_emissao: string | null;
  idade_dias: number | null;
  valor_frete: number | null;
  valor_mercadoria: number | null;
  pacote: string | null;
}

export function excluidaDaLista(l: Pick<LinhaViewPendente, "serie_numero_ctrc" | "descricao_ultima_ocorrencia">): boolean {
  const ctrc = (texto(l.serie_numero_ctrc) ?? "").toUpperCase();
  if (CTRCS_EXCLUIDOS.has(ctrc)) return true;
  return (texto(l.descricao_ultima_ocorrencia) ?? "").toUpperCase().includes("RESSARCIMENTO");
}

export function mapearLinha(l: LinhaViewPendente, agoraMs: number): ComprovanteResposta | null {
  const ctrc = texto(l.serie_numero_ctrc);
  if (!ctrc) return null;
  const dataEntrega = dataIso(l.data_entrega_realizada);
  const idadeFonte = numero(l.idade_pendencia_dias);
  const unidade = texto(l.unidade_receptora);
  return {
    ctrc: ctrc.toUpperCase(),
    nf: texto(l.numero_da_nota_fiscal),
    unidade: unidade ? unidade.toUpperCase() : null,
    base_nome: texto(l.nome_base),
    base_tipo: texto(l.tipo_base)?.toLowerCase() ?? null,
    cliente_pagador: texto(l.cliente_pagador),
    placa: texto(l.placa_entrega)?.toUpperCase() ?? null,
    descricao_oc: texto(l.descricao_ultima_ocorrencia),
    tipo_documento: texto(l.tipo_do_documento),
    data_entrega: dataEntrega,
    data_emissao: dataIso(l.data_emissao),
    idade_dias: idadeFonte != null ? Math.max(0, Math.floor(idadeFonte)) : idadeDesde(dataEntrega, agoraMs),
    valor_frete: numero(l.valor_frete),
    valor_mercadoria: numero(l.valor_mercadoria),
    pacote: texto(l.numero_pacote_arquivo),
  };
}

// ── leitura da fonte ─────────────────────────────────────────────────────────

export interface FonteComprovantes {
  url: string;
  anonKey: string;
}

export function fonteDoEnv(env: Record<string, string | undefined>): FonteComprovantes | null {
  const url = (env["COMPROVANTES_SUPABASE_URL"] ?? "").trim().replace(/\/+$/, "");
  const anonKey = (env["COMPROVANTES_SUPABASE_ANON_KEY"] ?? "").trim();
  return url && anonKey ? { url, anonKey } : null;
}

const cabecalhos = (f: FonteComprovantes) => ({ apikey: f.anonKey, Authorization: `Bearer ${f.anonKey}`, Accept: "application/json" });

export function urlPendentes(f: FonteComprovantes, escopo: EscopoComprovantes, offset: number): string {
  const p = new URLSearchParams();
  p.set("select", "*");
  if (!escopo.todas) p.set("unidade_receptora", filtroUnidades(escopo.unidades));
  p.set("order", "serie_numero_ctrc.asc");
  p.set("limit", String(PAGINA_COMPROVANTES));
  p.set("offset", String(offset));
  return `${f.url}/rest/v1/${VIEW_PENDENTES}?${p.toString()}`;
}

export function urlEntregues(f: FonteComprovantes, escopo: EscopoComprovantes): string {
  const p = new URLSearchParams();
  p.set("select", "serie_numero_ctrc");
  if (!escopo.todas) p.set("unidade_receptora", filtroUnidades(escopo.unidades));
  return `${f.url}/rest/v1/${VIEW_ENTREGUES}?${p.toString()}`;
}

/** Todas as páginas da view de pendentes, só GET, em ordem estável. */
export async function lerPendentes(
  f: FonteComprovantes,
  escopo: EscopoComprovantes,
  fetchFn: typeof fetch,
): Promise<{ linhas: LinhaViewPendente[]; erro: string | null }> {
  const linhas: LinhaViewPendente[] = [];
  for (let offset = 0; offset < TETO_LINHAS_COMPROVANTES; offset += PAGINA_COMPROVANTES) {
    let res: Response;
    try {
      res = await fetchFn(urlPendentes(f, escopo, offset), { method: "GET", headers: cabecalhos(f) });
    } catch (e) {
      return { linhas, erro: `rede: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!res.ok) return { linhas, erro: `fonte ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const pagina = (await res.json()) as LinhaViewPendente[];
    linhas.push(...pagina);
    if (pagina.length < PAGINA_COMPROVANTES) return { linhas, erro: null };
  }
  return { linhas, erro: `teto de ${TETO_LINHAS_COMPROVANTES} linhas atingido` };
}

/** Total de entregues com comprovante (HEAD + count=exact). null = não deu para contar. */
export async function contarEntregues(f: FonteComprovantes, escopo: EscopoComprovantes, fetchFn: typeof fetch): Promise<number | null> {
  try {
    const res = await fetchFn(urlEntregues(f, escopo), { method: "HEAD", headers: { ...cabecalhos(f), Prefer: "count=exact" } });
    if (!res.ok) return null;
    const total = Number((res.headers.get("content-range") ?? "").split("/")[1]);
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

// ── montagem da resposta ─────────────────────────────────────────────────────

export interface RespostaComprovantesOk {
  ok: true;
  linhas: ComprovanteResposta[];
  /** Entregues com comprovante nas mesmas unidades; null = a contagem falhou. */
  entregues: number | null;
  /** Maior `data_escaneamento` lida ('YYYY-MM-DD'). */
  ultimaAtualizacao: string | null;
  escopo: EscopoComprovantes;
  /** Linhas tiradas pelas exclusões (CTRC em duplicidade, ressarcimento). */
  excluidas: number;
  geradoEm: string;
}

export function montarResposta(
  brutas: readonly LinhaViewPendente[],
  entregues: number | null,
  escopo: EscopoComprovantes,
  agoraMs: number,
): RespostaComprovantesOk {
  let excluidas = 0;
  let ultima: string | null = null;
  const vistos = new Set<string>();
  const linhas: ComprovanteResposta[] = [];
  for (const b of brutas) {
    const esc = dataIso(b.data_escaneamento);
    if (esc && (!ultima || esc > ultima)) ultima = esc;
    if (excluidaDaLista(b)) {
      excluidas++;
      continue;
    }
    const l = mapearLinha(b, agoraMs);
    if (!l) continue;
    // Defesa: escopo restrito nunca devolve unidade de fora, mesmo se a fonte ignorar o filtro.
    if (!escopo.todas && (!l.unidade || !escopo.unidades.includes(l.unidade))) continue;
    const chave = `${l.ctrc}|${l.nf ?? ""}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    linhas.push(l);
  }
  return { ok: true, linhas, entregues, ultimaAtualizacao: ultima, escopo, excluidas, geradoEm: new Date(agoraMs).toISOString() };
}

// ── handler ──────────────────────────────────────────────────────────────────

export interface DepsComprovantes {
  env: Record<string, string | undefined>;
  /** `op_minha_sessao()` com o JWT de quem chamou. Lança se a RPC falhar. */
  sessao: (authorization: string) => Promise<SessaoOpComprovantes | null>;
  fetch: typeof fetch;
  agoraMs: () => number;
}

export async function handleComprovantes(req: Request, deps: DepsComprovantes): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_COMPROVANTES });
  if (req.method !== "GET" && req.method !== "POST") return jsonComprovantes({ ok: false, erro: "metodo_nao_permitido" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/.test(auth)) return jsonComprovantes({ ok: false, erro: "nao_autenticado" }, 401);

  let sessao: SessaoOpComprovantes | null;
  try {
    sessao = await deps.sessao(auth);
  } catch (e) {
    return jsonComprovantes({ ok: false, erro: "sessao_indisponivel", mensagem: e instanceof Error ? e.message : String(e) }, 502);
  }
  const r = escopoDaSessao(sessao);
  if (!r.ok) return jsonComprovantes({ ok: false, erro: r.erro }, 403);

  const fonte = fonteDoEnv(deps.env);
  if (!fonte) return jsonComprovantes({ ok: false, erro: ERRO_SEM_CREDENCIAL }, 503);

  const agora = deps.agoraMs();
  // Cadastro sem unidade: lista vazia, sem nem perguntar à fonte.
  if (!r.escopo.todas && r.escopo.unidades.length === 0) {
    return jsonComprovantes(montarResposta([], 0, r.escopo, agora));
  }

  const [pend, entregues] = await Promise.all([
    lerPendentes(fonte, r.escopo, deps.fetch),
    contarEntregues(fonte, r.escopo, deps.fetch),
  ]);
  if (pend.erro) return jsonComprovantes({ ok: false, erro: "fonte_falhou", mensagem: pend.erro }, 502);
  return jsonComprovantes(montarResposta(pend.linhas, entregues, r.escopo, agora));
}
