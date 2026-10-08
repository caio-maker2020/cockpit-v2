// =============================================================================
// baixa-motorista-contrato — núcleo do endpoint `ponte-baixa-entrega` (ADR 0040,
// "Ponte v3: baixa do motorista" do contrato do Roteirizador).
//
//   POST → valida, registra a baixa (baixaId = chave de idempotência). NUNCA fala
//          com o SSW, com o Bastão nem com o Roteirizador: o resto é do worker
//          `processar-baixas-motorista`, por fila com vazão (INV-159, INV-177).
//   GET  ?ids=a,b → status de cada baixa.
//
// Respostas: 202 {baixaId, status:"recebido"} · 200 mesmo baixaId e mesmo conteúdo
// (status atual) · 409 mesmo baixaId com conteúdo diferente (nada é executado) ·
// 422 mérito (código fora da lista, nf/ctrc inválidos, ocorridoEm no futuro…) ·
// 503 flag `baixa_motorista_receber` OFF ou sem PONTE_OPERACAO_TOKEN · 401.
//
// Auth: o MESMO esquema da ponte v2 (Bearer PONTE_OPERACAO_TOKEN — o segredo da
// direção Roteirizador → Cockpit; o da v1 não abre esta porta).
//
// Exceção do ADR 0040: a baixa NÃO tem card. O CTRC e a NF vêm da baixa (do
// romaneio do Roteirizador) e só chegam ao SSW pelo envelope `lancarSswBaixa`,
// que confere o tripé CTRC + NF + localização no SSW antes de gravar.
//
// Arquivo sem I/O próprio (repositório injetado) → deno test.
// =============================================================================

import {
  autenticarPonte,
  ctrcValido,
  isoSaoPaulo,
  json,
  normalizarCtrc,
  normalizarNf,
  respostaAuth,
} from "./ponte-operacao-comum.ts";
import { type MotivoRecusa, RE_AUTOMACAO } from "./ponte-operacao-pedido.ts";

export type { MotivoRecusa };

// ── flags e constantes (mig 420, tudo nasce OFF / vazio) ─────────────────────
export const FLAG_BAIXA_RECEBER = "baixa_motorista_receber" as const;
export const FLAG_BAIXA_LANCAR_SSW = "baixa_motorista_lancar_ssw" as const;

/** A ocorrência da entrega. Implícita para `tipo: entrega`; nunca vale para insucesso. */
export const CODIGO_ENTREGA = 1;
/** O que o SSW aceita como anexo nos dois canais (WebAPI: JPEG ou PDF). */
export const MIMES_EVIDENCIA: readonly string[] = ["image/jpeg", "application/pdf"];
export const MAX_EVIDENCIAS = 1;
/**
 * Relógio do celular adiantado até isto não é "futuro" (contrato v3: 10 min). Acima, 422.
 * Dentro da tolerância a baixa entra, e o envelope limita a hora a "agora" ao gravar no
 * SSW (que recusa hora futura).
 */
export const TOLERANCIA_FUTURO_MS = 10 * 60_000;
/** `texto` do motorista (aditivo do contrato v3): até 200, sanitizado para latin-1. */
export const TEXTO_MAX = 200;
export const MAX_IDS_GET = 200;

export type TipoBaixa = "entrega" | "insucesso";
export const TIPOS_BAIXA: readonly TipoBaixa[] = ["entrega", "insucesso"];

/** Status do contrato. `lancando` é interno e sai como `na_fila` no GET. */
export type StatusBaixaContrato = "recebido" | "na_fila" | "executado" | "ja_no_ssw" | "recusado" | "erro";
export type StatusBaixa = StatusBaixaContrato | "lancando";
export const STATUS_FINAIS: readonly StatusBaixa[] = ["executado", "ja_no_ssw", "recusado", "erro"];

export interface BaixaValida {
  baixaId: string;
  tipo: TipoBaixa;
  codigoOcorrencia: number;
  ctrc: string;
  nf: string;
  /** ISO UTC (normalizado). O original tinha fuso explícito. */
  ocorridoEm: string;
  recebidoEm: string;
  recebedor: { nome: string; documento: string | null } | null;
  geo: { lat: number; lng: number; precisaoM: number | null } | null;
  evidencias: Array<{ id: string; sha256: string; mime: string }>;
  motorista: { id: string; nome: string };
  rota: { sugestaoId: string; rotaId: string; veiculoIndice: number | null; placa: string | null };
  /** Sigla da base da rota, ou null (o v3 manda null quando não sabe). */
  base: string | null;
  /** O que o motorista escreveu (insucesso). Sanitizado para latin-1; null = nada. */
  texto: string | null;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 com fuso OBRIGATÓRIO (Z ou ±hh:mm): hora sem fuso é ambígua para o SSW. */
const RE_ISO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const RE_EVIDENCIA_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RE_SHA256 = /^[0-9a-f]{64}$/;

function limpar(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * O portal do SSW serve latin-1 e descarta o campo inteiro com byte UTF-8 multi-byte
 * (CLAUDE.md, regra 4). Mesma regra do `sanitizarParaLatin1` do cliente SSW, aqui sem
 * importar o cliente (o POST nunca toca o SSW, INV-176).
 */
export function sanitizarTextoLatin1(s: string): string {
  return s
    .replace(/[\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2000-\u200B\u202F]/g, " ")
    .replace(/[^\u0000-\u00FF]/gu, "?");
}

function idTexto(v: unknown, max = 64): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") {
    const t = limpar(v);
    return t.length <= max ? t : "";
  }
  return "";
}

function isoComFuso(v: unknown): number | null {
  if (typeof v !== "string" || !RE_ISO_COM_FUSO.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Pura: valida o corpo do POST. Todos os problemas de uma vez (o painel mostra a
 * lista). O mérito que depende do banco (código de insucesso na lista) fica no
 * handler; o resto (incluindo "ocorridoEm no futuro") é decidido aqui.
 */
export function validarBaixa(body: unknown, agoraMs: number):
  | { ok: true; baixa: BaixaValida }
  | { ok: false; motivos: MotivoRecusa[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const motivos: MotivoRecusa[] = [];
  const m = (codigo: string, mensagem: string) => motivos.push({ codigo, mensagem });

  const baixaId = typeof b.baixaId === "string" ? b.baixaId.trim().toLowerCase() : "";
  if (!RE_UUID.test(baixaId)) m("baixa_id_invalido", "baixaId precisa ser um uuid");

  const tipo = b.tipo as TipoBaixa;
  const tipoOk = TIPOS_BAIXA.includes(tipo);
  if (!tipoOk) m("tipo_invalido", `tipo precisa ser ${TIPOS_BAIXA.join(" ou ")}`);

  const codStr = b.codigoOcorrencia === undefined || b.codigoOcorrencia === null ? "" : String(b.codigoOcorrencia).trim();
  let codigo: number | null = null;
  if (!/^\d{1,3}$/.test(codStr)) m("codigo_invalido", "codigoOcorrencia precisa ser o código numérico do SSW (ex.: \"01\")");
  else codigo = parseInt(codStr, 10);
  if (tipoOk && codigo !== null) {
    if (tipo === "entrega" && codigo !== CODIGO_ENTREGA) m("entrega_so_com_01", "tipo entrega usa a ocorrência 01");
    if (tipo === "insucesso" && codigo === CODIGO_ENTREGA) m("insucesso_nao_e_01", "a 01 é a entrega; insucesso usa um código da lista fechada");
  }

  const ctrc = typeof b.ctrc === "string" ? normalizarCtrc(b.ctrc) : null;
  if (!ctrcValido(ctrc)) m("ctrc_invalido", "ctrc ausente ou fora do formato (ex.: AMB642904-1)");

  let nf: string | null = null;
  const nfBruta = b.nf === undefined || b.nf === null ? "" : String(b.nf).trim();
  if (!/^\d{1,15}$/.test(nfBruta)) m("nf_invalida", "nf é obrigatória: o número da NF, só dígitos");
  else {
    nf = normalizarNf(nfBruta);
    if (!nf || nf.length > 12) {
      nf = null;
      m("nf_invalida", "nf é obrigatória: o número da NF, só dígitos");
    }
  }

  const ocorridoMs = isoComFuso(b.ocorridoEm);
  if (ocorridoMs === null) m("ocorrido_em_invalido", "ocorridoEm precisa ser ISO com fuso (ex.: 2026-10-07T10:15:00-03:00)");
  else if (ocorridoMs > agoraMs + TOLERANCIA_FUTURO_MS) m("ocorrido_em_futuro", "ocorridoEm está no futuro; o SSW não aceita hora futura");

  const recebidoMs = isoComFuso(b.recebidoEm);
  if (recebidoMs === null) m("recebido_em_invalido", "recebidoEm precisa ser ISO com fuso");
  else if (recebidoMs > agoraMs + TOLERANCIA_FUTURO_MS) m("recebido_em_futuro", "recebidoEm está no futuro");

  let recebedor: BaixaValida["recebedor"] = null;
  if (b.recebedor !== undefined && b.recebedor !== null) {
    const r = b.recebedor as Record<string, unknown>;
    const nome = typeof r.nome === "string" ? limpar(r.nome) : "";
    const docBruto = r.documento === undefined || r.documento === null ? null : limpar(String(r.documento));
    if (nome.length < 2 || nome.length > 120 || !/\p{L}/u.test(nome)) m("recebedor_invalido", "recebedor.nome precisa ter de 2 a 120 caracteres");
    else if (docBruto !== null && (docBruto.length === 0 || docBruto.length > 30)) m("recebedor_invalido", "recebedor.documento tem até 30 caracteres (ou null)");
    else recebedor = { nome, documento: docBruto };
  }

  let geo: BaixaValida["geo"] = null;
  if (b.geo !== undefined && b.geo !== null) {
    const g = b.geo as Record<string, unknown>;
    const lat = Number(g.lat), lng = Number(g.lng);
    const semPrecisao = g.precisaoM === undefined || g.precisaoM === null;
    const p = semPrecisao ? null : Number(g.precisaoM);
    const ok = typeof g.lat === "number" && typeof g.lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
      (p === null || (typeof g.precisaoM === "number" && Number.isFinite(p) && p >= 0 && p <= 100_000));
    if (!ok) m("geo_invalido", "geo precisa de lat (−90..90), lng (−180..180) e precisaoM (0..100000 ou null), ou null");
    else geo = { lat, lng, precisaoM: p };
  }

  const evidencias: BaixaValida["evidencias"] = [];
  if (b.evidencias !== undefined && b.evidencias !== null) {
    if (!Array.isArray(b.evidencias)) m("evidencias_invalidas", "evidencias precisa ser uma lista");
    else if (b.evidencias.length > MAX_EVIDENCIAS) m("evidencias_demais", `no máximo ${MAX_EVIDENCIAS} evidência (o SSW aceita 1 imagem)`);
    else {
      for (const e of b.evidencias as Array<Record<string, unknown>>) {
        const id = typeof e?.id === "string" ? e.id.trim() : "";
        const sha = typeof e?.sha256 === "string" ? e.sha256.trim().toLowerCase() : "";
        const mime = typeof e?.mime === "string" ? e.mime.trim().toLowerCase() : "";
        if (!RE_EVIDENCIA_ID.test(id) || !RE_SHA256.test(sha)) m("evidencias_invalidas", "evidência precisa de id e sha256 (64 hex)");
        else if (!MIMES_EVIDENCIA.includes(mime)) m("evidencia_mime", `mime da evidência precisa ser ${MIMES_EVIDENCIA.join(" ou ")}`);
        else evidencias.push({ id, sha256: sha, mime });
      }
    }
  }

  const mo = (b.motorista ?? null) as Record<string, unknown> | null;
  // id: qualquer texto não vazio — o v3 manda o ri_executores.id ou "usuario:<id>" quando
  // quem deu a baixa foi uma pessoa logada que não é motorista cadastrado.
  const moId = mo ? idTexto(mo.id, 128) : "";
  const moNome = mo && typeof mo.nome === "string" ? limpar(mo.nome) : "";
  if (!moId || moNome.length < 2 || moNome.length > 120 || !/\p{L}/u.test(moNome)) {
    m("motorista_obrigatorio", "motorista precisa de id e nome");
  } else if (RE_AUTOMACAO.test(moNome)) {
    m("motorista_automatico", "a baixa precisa vir do motorista, não de agente ou automação");
  }

  const ro = (b.rota ?? null) as Record<string, unknown> | null;
  const sugestaoId = ro ? idTexto(ro.sugestaoId) : "";
  const rotaId = ro ? idTexto(ro.rotaId) : "";
  const vi = ro ? ro.veiculoIndice : undefined;
  const veiculoOk = vi === null || vi === undefined || (typeof vi === "number" && Number.isInteger(vi) && vi >= 0 && vi <= 999);
  let placa: string | null = null;
  let placaOk = true;
  if (ro && ro.placa !== undefined && ro.placa !== null) {
    placa = String(ro.placa).trim().toUpperCase().replace(/\s+/g, "");
    placaOk = /^[A-Z0-9-]{5,8}$/.test(placa);
  }
  if (!sugestaoId || !rotaId || !veiculoOk || !placaOk) {
    m("rota_invalida", "rota precisa de sugestaoId, rotaId, veiculoIndice (inteiro ≥ 0 ou null) e placa (ou null)");
  }

  let base: string | null = null;
  if (b.base !== undefined && b.base !== null && String(b.base).trim() !== "") {
    base = String(b.base).trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(base)) m("base_invalida", "base fora do formato (ex.: VGA), ou null");
  }

  let texto: string | null = null;
  if (b.texto !== undefined && b.texto !== null) {
    if (typeof b.texto !== "string") m("texto_invalido", "texto precisa ser string ou null");
    else {
      const t = sanitizarTextoLatin1(limpar(b.texto));
      if (t.length > TEXTO_MAX) m("texto_longo", `texto tem até ${TEXTO_MAX} caracteres`);
      else if (t.length > 0) texto = t;
    }
  }

  if (motivos.length > 0) return { ok: false, motivos };
  return {
    ok: true,
    baixa: {
      baixaId,
      tipo,
      codigoOcorrencia: codigo!,
      ctrc: ctrc!,
      nf: nf!,
      ocorridoEm: new Date(ocorridoMs!).toISOString(),
      recebidoEm: new Date(recebidoMs!).toISOString(),
      recebedor,
      geo,
      evidencias,
      motorista: { id: moId, nome: moNome },
      rota: { sugestaoId, rotaId, veiculoIndice: typeof vi === "number" ? vi : null, placa },
      base,
      texto,
    },
  };
}

/**
 * SHA-256 do conteúdo canônico da baixa. Mesmo baixaId com hash diferente → 409.
 * Contrato v3: "mesmo conteúdo" = todos os campos menos `baixaId` e `recebidoEm`.
 */
export async function hashBaixa(b: BaixaValida): Promise<string> {
  const canon = JSON.stringify([
    b.tipo, b.codigoOcorrencia, b.ctrc, b.nf, b.ocorridoEm,
    b.recebedor ? [b.recebedor.nome, b.recebedor.documento] : null,
    b.geo ? [b.geo.lat, b.geo.lng, b.geo.precisaoM] : null,
    b.evidencias.map((e) => [e.id, e.sha256, e.mime]),
    [b.motorista.id, b.motorista.nome],
    [b.rota.sugestaoId, b.rota.rotaId, b.rota.veiculoIndice, b.rota.placa],
    b.base,
    b.texto,
  ]);
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(dig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const DIA_MS = 86_400_000;
const OFFSET_SP_MS = 3 * 3_600_000;

/**
 * Pura: o prazo da baixa (TTL) = fim do DIA SEGUINTE ao ocorrido, no fuso de São
 * Paulo (23:59:59.999 de D+1). Passou disso sem lançar → `erro` "expirou" e a
 * operação lança à mão: uma baixa de anteontem já não é "hora real".
 */
export function prazoDaBaixa(ocorridoEmIso: string): string {
  const t = Date.parse(ocorridoEmIso);
  const diaLocal = Math.floor((t - OFFSET_SP_MS) / DIA_MS);
  return new Date((diaLocal + 2) * DIA_MS + OFFSET_SP_MS - 1).toISOString();
}

// ── repositório ──────────────────────────────────────────────────────────────

export interface BaixaRow {
  baixa_id: string;
  seq: number;
  tipo: TipoBaixa;
  codigo_ocorrencia: number;
  ctrc: string;
  nf: string;
  ocorrido_em: string;
  recebido_em_origem: string;
  recebedor_nome: string | null;
  recebedor_documento: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  geo_precisao_m: number | null;
  evidencia_id: string | null;
  evidencia_sha256: string | null;
  evidencia_mime: string | null;
  motorista_id: string;
  motorista_nome: string;
  rota_sugestao_id: string;
  rota_id: string;
  rota_veiculo_indice: number | null;
  rota_placa: string | null;
  base: string | null;
  texto: string | null;
  hash_baixa: string;
  recebido_em: string;
  prazo_em: string;
  status: StatusBaixa;
  status_em: string;
  tentativas: number;
  reservado_em: string | null;
  ultima_categoria: string | null;
  ultima_falha_em: string | null;
  categoria: string | null;
  motivo: string | null;
  protocolo: string | null;
  canal: string | null;
  finalizado_em: string | null;
}

export type NovaBaixaRow = Omit<
  BaixaRow,
  | "seq" | "recebido_em" | "status_em" | "tentativas" | "reservado_em" | "ultima_categoria"
  | "ultima_falha_em" | "categoria" | "motivo" | "protocolo" | "canal" | "finalizado_em"
>;

export function linhaDaBaixa(b: BaixaValida, hash: string): NovaBaixaRow {
  const ev = b.evidencias[0] ?? null;
  return {
    baixa_id: b.baixaId,
    tipo: b.tipo,
    codigo_ocorrencia: b.codigoOcorrencia,
    ctrc: b.ctrc,
    nf: b.nf,
    ocorrido_em: b.ocorridoEm,
    recebido_em_origem: b.recebidoEm,
    recebedor_nome: b.recebedor?.nome ?? null,
    recebedor_documento: b.recebedor?.documento ?? null,
    geo_lat: b.geo?.lat ?? null,
    geo_lng: b.geo?.lng ?? null,
    geo_precisao_m: b.geo?.precisaoM ?? null,
    evidencia_id: ev?.id ?? null,
    evidencia_sha256: ev?.sha256 ?? null,
    evidencia_mime: ev?.mime ?? null,
    motorista_id: b.motorista.id,
    motorista_nome: b.motorista.nome,
    rota_sugestao_id: b.rota.sugestaoId,
    rota_id: b.rota.rotaId,
    rota_veiculo_indice: b.rota.veiculoIndice,
    rota_placa: b.rota.placa,
    base: b.base,
    texto: b.texto,
    hash_baixa: hash,
    prazo_em: prazoDaBaixa(b.ocorridoEm),
    status: "recebido",
  };
}

export interface RepoRecepcao {
  flagLigada(key: string): Promise<boolean>;
  buscar(baixaId: string): Promise<BaixaRow | null>;
  buscarVarias(ids: string[]): Promise<BaixaRow[]>;
  /** Código ATIVO na lista fechada de insucesso (baixa_motorista_codigos). Erro → false (fail-closed). */
  codigoInsucessoPermitido(codigo: number): Promise<boolean>;
  /** "conflito" = o baixa_id já existe (corrida entre dois POST iguais). */
  inserir(row: NovaBaixaRow): Promise<"inserido" | "conflito">;
}

export interface DepsRecepcao {
  token: string | null;
  repo: RepoRecepcao;
  agora?: () => Date;
}

export interface StatusBaixaResposta {
  baixaId: string;
  status: StatusBaixaContrato;
  /** Quando o status mudou (ISO). */
  statusEm: string | null;
  /** Quando foi gravada no SSW (executado) ou constatada lá (ja_no_ssw); senão null. */
  executadoEm: string | null;
  motivo: string | null;
}

export function statusDaBaixa(
  row: Pick<BaixaRow, "baixa_id" | "status" | "status_em" | "motivo"> & { finalizado_em?: string | null },
): StatusBaixaResposta {
  const gravada = row.status === "executado" || row.status === "ja_no_ssw";
  return {
    baixaId: row.baixa_id,
    status: row.status === "lancando" ? "na_fila" : row.status,
    statusEm: isoSaoPaulo(row.status_em),
    executadoEm: gravada ? isoSaoPaulo(row.finalizado_em ?? row.status_em) : null,
    motivo: row.motivo ?? null,
  };
}

function recusa422(motivos: MotivoRecusa[]): Response {
  return json({ erro: "invalido", motivos }, 422);
}

function respostaFlagOff(): Response {
  return json({ erro: "desligado", flag: FLAG_BAIXA_RECEBER, mensagem: `flag ${FLAG_BAIXA_RECEBER} desligada — nada foi feito` }, 503);
}

async function responderExistente(existente: BaixaRow, b: BaixaValida): Promise<Response> {
  const st = statusDaBaixa(existente);
  if ((await hashBaixa(b)) !== existente.hash_baixa) {
    return json({ erro: "conteudo_divergente", mensagem: "este baixaId já foi usado com outro conteúdo; nada foi executado", ...st }, 409);
  }
  return json(st, 200);
}

/** POST: registra a baixa. Nunca fala com o SSW. */
export async function handlePostBaixa(req: Request, deps: DepsRecepcao): Promise<Response> {
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  try {
    const { repo } = deps;
    if (!(await repo.flagLigada(FLAG_BAIXA_RECEBER))) return respostaFlagOff();

    const body = await req.json().catch(() => null);
    const agoraMs = (deps.agora ?? (() => new Date()))().getTime();
    const v = validarBaixa(body, agoraMs);
    if (!v.ok) return recusa422(v.motivos);
    const b = v.baixa;

    // Idempotência primeiro: o mesmo baixaId devolve o status atual, mesmo que a
    // lista de códigos tenha mudado desde o primeiro envio.
    const existente = await repo.buscar(b.baixaId);
    if (existente) return await responderExistente(existente, b);

    if (b.tipo === "insucesso" && !(await repo.codigoInsucessoPermitido(b.codigoOcorrencia))) {
      return recusa422([{
        codigo: "codigo_nao_permitido",
        mensagem: `a oc ${String(b.codigoOcorrencia).padStart(2, "0")} não está na lista fechada de insucesso (vazia por padrão)`,
      }]);
    }

    const ins = await repo.inserir(linhaDaBaixa(b, await hashBaixa(b)));
    if (ins === "conflito") {
      const jaVista = await repo.buscar(b.baixaId);
      if (jaVista) return await responderExistente(jaVista, b);
      return json({ erro: "falha_interna", mensagem: "conflito de baixaId sem linha" }, 500);
    }
    return json({ baixaId: b.baixaId, status: "recebido" }, 202);
  } catch (e) {
    return json({ erro: "falha_interna", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** GET ?ids=a,b → {baixas:[{baixaId,status,statusEm,executadoEm,motivo}]} (ids desconhecidos ficam de fora). */
export async function handleGetBaixas(req: Request, deps: DepsRecepcao): Promise<Response> {
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  try {
    if (!(await deps.repo.flagLigada(FLAG_BAIXA_RECEBER))) return respostaFlagOff();
    const bruto = new URL(req.url).searchParams.get("ids") ?? "";
    const ids = [...new Set(bruto.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))];
    if (ids.length === 0 || ids.length > MAX_IDS_GET || ids.some((id) => !RE_UUID.test(id))) {
      return recusa422([{ codigo: "ids_invalidos", mensagem: `ids precisa de 1 a ${MAX_IDS_GET} uuids separados por vírgula` }]);
    }
    const rows = await deps.repo.buscarVarias(ids);
    const porId = new Map(rows.map((r) => [r.baixa_id, r]));
    return json({ baixas: ids.filter((id) => porId.has(id)).map((id) => statusDaBaixa(porId.get(id)!)) }, 200);
  } catch (e) {
    return json({ erro: "falha_interna", mensagem: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function handleBaixa(req: Request, deps: DepsRecepcao): Promise<Response> {
  if (req.method === "POST") return await handlePostBaixa(req, deps);
  if (req.method === "GET") return await handleGetBaixas(req, deps);
  const auth = autenticarPonte(req, deps.token);
  if (auth !== "ok") return respostaAuth(auth);
  return json({ erro: "metodo_nao_permitido" }, 405);
}
