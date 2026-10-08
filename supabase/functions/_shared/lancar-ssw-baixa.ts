// =============================================================================
// lancar-ssw-baixa.ts — envelope da BAIXA DO MOTORISTA no SSW (ADR 0040).
//
// Irmão do `lancarSswPortal` (Relacionamento), que NÃO é tocado: aquele exige
// card (idempotência por card em acoes_executadas_ssw) e esta baixa não tem
// card. Aqui a idempotência é a própria fila (baixaId = PK, reserva atômica, uma
// execução no máximo — worker `processar-baixas-motorista`).
//
// Garantias, nesta ordem, para cada baixa:
//   1. CREDENCIAL ÚNICA ai.salex (INV-013/INV-063): a sessão do portal sai SEMPRE
//      de `readSswLancamentoEnv`. No canal `webapi` o usuário da WebAPI
//      (SSW_USERNAME) tem de ser o MESMO da conta de serviço
//      (SSW_LANCAMENTO_USUARIO) — senão nada é enviado.
//   2. VERDADE DO SSW ANTES DE GRAVAR: lê as ocorrências do CTRC
//      (`descobrirUltimaOcSsw`, mesma sessão) — a 01 já está lá → `ja_no_ssw`
//      sem gravar nada; nota entregue/encerrada → recusa o insucesso.
//   3. TRIPÉ (CTRC + NF + Localização atual) contra o SSW, ANTES do submit
//      (`validarTripeCtrcNfPagador`). O CTRC vem da BAIXA — nunca de busca por
//      NF — e nunca é trocado: divergiu, não lança (regra crítica do SSW; a
//      exceção "sem card" do ADR 0040 só vale com o tripé).
//   4. HORA REAL: o evento vai com `ocorridoEm` (nunca futuro; limitado a
//      agora − 2 min).
//   5. CANAL atrás de config (`baixa_motorista_canal`): `portal101` =
//      `lancarOcorrenciaPortal` (opção 101); `webapi` = `ocorrenciaParceiro`
//      (createSswClient, 1 imagem em base64, dataHoraEvento).
//
// Nunca relança: o envelope chama o SSW no máximo UMA vez por baixa e diz em
// que FASE parou (`antes_do_submit` = nada foi gravado, pode tentar de novo;
// `submit` = o SSW pode ter gravado → o worker marca `erro`, conferir à mão).
// =============================================================================

import {
  createSswClient,
  type LancarOcorrenciaInput,
  type LancarOcorrenciaResult,
  readSswEnvFromProcess,
  type SswClient,
} from "./ssw-client.ts";
import {
  type AnexoBytes,
  buscarNFInterno,
  type CtrcRow,
  descobrirUltimaOcSsw,
  type DescobrirUltimaOcSswResultado,
  lancarOcorrenciaPortal,
  type LancarOcorrenciaPortalOpts,
  type LancarOcorrenciaPortalResult,
  listarCTRCsDaNF,
  obterSessao,
  readSswLancamentoEnv,
  type SswNFDetalhe,
  type SswSessao,
} from "./ssw-internal-client.ts";
import { validarTripeCtrcNfPagador } from "./validar-tripe-ssw.ts";
import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";

export type CanalBaixa = "webapi" | "portal101";
export const CANAIS_BAIXA: readonly CanalBaixa[] = ["webapi", "portal101"];

export const CODIGO_ENTREGA_SSW = 1;
/** Ocorrências que ENCERRAM o CTRC no SSW: entregue, devolução autorizada, cancelada. */
export const OCS_ENCERRAM_CTRC: ReadonlySet<number> = new Set([1, 30, 32]);
/** O SSW recusa hora futura; o portal já usava agora − 2 min como margem do relógio. */
export const MARGEM_RELOGIO_MS = 2 * 60_000;
/**
 * Relógio do celular adiantado até isto é aceito (contrato v3, igual ao 422 do POST);
 * a hora que vai ao SSW é limitada a agora − 2 min (`horaDoEventoMs`). Acima, recusa.
 */
export const TOLERANCIA_RELOGIO_APARELHO_MS = 10 * 60_000;

export interface BaixaParaSsw {
  baixaId: string;
  tipo: "entrega" | "insucesso";
  codigo: number;
  /** CTRC DA BAIXA (normalizado). Nunca substituído por resultado de busca por NF. */
  ctrc: string;
  nf: string;
  /** ISO. A hora real do evento. */
  ocorridoEm: string;
  texto: string;
}

export type CategoriaFalhaBaixa =
  | "entrada_invalida"
  | "credencial"
  | "sessao_invalida"
  | "leitura_ssw"
  | "ctrc_nf_divergente"
  | "nota_encerrada"
  | "guard_tripe"
  | "webapi_sem_dados"
  | "ssw_recusou"
  | "interrompido";

export type LancarSswBaixaResult =
  | { ok: true; resultado: "executado"; canal: CanalBaixa; protocolo: string; detalhe: string }
  | { ok: true; resultado: "ja_no_ssw"; canal: CanalBaixa; motivo: string }
  | { ok: false; categoria: CategoriaFalhaBaixa; fase: "antes_do_submit" | "submit"; motivo: string };

/** Tudo que fala com o SSW, injetável (deno test sem rede). */
export interface SswBaixaIo {
  abrirSessao(env: Record<string, string | undefined>): Promise<SswSessao>;
  lerVerdade(nf: string, ctrc: string, env: Record<string, string | undefined>): Promise<DescobrirUltimaOcSswResultado>;
  buscarDetalhe(sessao: SswSessao, nf: string, ctrc: string): Promise<SswNFDetalhe>;
  lancarPortal(sessao: SswSessao, detalhe: SswNFDetalhe, opts: LancarOcorrenciaPortalOpts): Promise<LancarOcorrenciaPortalResult>;
  listarCtrcs(sessao: SswSessao, nf: string): Promise<CtrcRow[]>;
  lancarWebApi(env: Record<string, string | undefined>, input: LancarOcorrenciaInput): Promise<LancarOcorrenciaResult>;
}

/** Marca do erro de login da WebAPI ANTES de qualquer envio de ocorrência. */
export const MARCA_LOGIN_WEBAPI = "login da WebAPI recusado antes do envio";

// Um cliente WebAPI por isolate e por usuário: o token fica em cache nele (1 login).
const clientesWebApi = new Map<string, SswClient>();

export const IO_SSW_PADRAO: SswBaixaIo = {
  // INV-013: a sessão de LANÇAMENTO sai sempre da conta de serviço ai.salex.
  abrirSessao: (env) => obterSessao(readSswLancamentoEnv(env)),
  // Mesma credencial (INV-063) e mesma chave de cache → reusa a sessão acima.
  lerVerdade: (nf, ctrc, env) => descobrirUltimaOcSsw(nf, ctrc, env),
  buscarDetalhe: (sessao, nf, ctrc) => buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc }),
  lancarPortal: (sessao, detalhe, opts) => lancarOcorrenciaPortal(sessao, detalhe, opts),
  listarCtrcs: (sessao, nf) => listarCTRCsDaNF(sessao, nf),
  lancarWebApi: (env, input) => {
    const e = readSswEnvFromProcess(env);
    const chave = `${e.domain}|${e.username}`;
    let c = clientesWebApi.get(chave);
    if (!c) {
      c = createSswClient({ env: e });
      clientesWebApi.set(chave, c);
    }
    return (async () => {
      // Token primeiro, fora do laço de tentativas do cliente: se o login falhar
      // aqui, NENHUM POST de ocorrência saiu (pode tentar de novo depois da quarentena).
      try {
        await c.getToken();
      } catch (e) {
        throw new Error(`${MARCA_LOGIN_WEBAPI}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return await c.lancarOcorrencia(input);
    })();
  },
};

// ── peças puras ──────────────────────────────────────────────────────────────

/**
 * INV-013 no canal webapi: o usuário da WebAPI tem de ser a conta de serviço.
 * Sem os dois valores, ou diferentes, o canal não é usado (nada é enviado).
 */
export function credencialWebApiEhDaContaDeServico(env: Record<string, string | undefined>): boolean {
  const api = (env["SSW_USERNAME"] ?? "").trim().toLowerCase();
  const servico = (env["SSW_LANCAMENTO_USUARIO"] ?? "").trim().toLowerCase();
  return api.length > 0 && api === servico;
}

/** Hora do evento que vai ao SSW: a real, nunca depois de agora − 2 min. */
export function horaDoEventoMs(ocorridoEmMs: number, agoraMs: number): number {
  return Math.min(ocorridoEmMs, agoraMs - MARGEM_RELOGIO_MS);
}

/** Formato da WebAPI: "yyyy-mm-ddThh:mm:ss:mmm-03:00" (São Paulo, UTC−3 fixo). */
export function formatarDataHoraWebApi(ms: number): string {
  const d = new Date(ms - 3 * 3_600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${
    p(d.getUTCSeconds())
  }:${p(d.getUTCMilliseconds(), 3)}-03:00`;
}

/** Mensagem de erro do cliente SSW → categoria (sempre antes do submit). */
export function classificarErroLeitura(msg: string): CategoriaFalhaBaixa {
  if (/SSW_LANCAMENTO_|SSW_INTERNAL_\* env vars ausentes/.test(msg)) return "credencial";
  if (/login falhou/i.test(msg)) return "sessao_invalida";
  if (/mas card espera|nenhum bate com card\.ctrc|sem CTRC vis[ií]vel|m[uú]ltiplos CTRCs/i.test(msg)) return "ctrc_nf_divergente";
  return "leitura_ssw";
}

export type DecisaoVerdade =
  | { acao: "lancar" }
  | { acao: "ja_no_ssw"; motivo: string }
  | { acao: "falha"; categoria: CategoriaFalhaBaixa; motivo: string };

/**
 * Pura: o que o SSW já tem decide se a baixa vai. Dúvida = não lança.
 *   - entrega e a 01 já está no CTRC → `ja_no_ssw` (nada é gravado);
 *   - insucesso e o CTRC já foi entregue/encerrado → recusa;
 *   - insucesso igual (mesmo código, mesma hora ±2 min) já está lá → `ja_no_ssw`;
 *   - CTRC sem ocorrência nenhuma → pode lançar;
 *   - leitura falhou → não lança agora.
 */
export function decidirPelaVerdade(args: {
  tipo: "entrega" | "insucesso";
  codigo: number;
  ocorridoEmMs: number;
  verdade: DescobrirUltimaOcSswResultado;
}): DecisaoVerdade {
  const v = args.verdade;
  if (!v.sucesso) {
    if (v.motivo === "ssw_sem_oc") return { acao: "lancar" };
    const motivo = `leitura das ocorrências do SSW falhou (${v.motivo}${v.detalhe ? `: ${v.detalhe.slice(0, 200)}` : ""})`;
    return { acao: "falha", categoria: classificarErroLeitura(v.detalhe ?? ""), motivo };
  }
  const ocs = v.ocorrencias.length > 0 ? v.ocorrencias : [{ codigo: v.oc, usuario: null, data: v.dataRaw }];
  const entrega = ocs.find((o) => o.codigo === CODIGO_ENTREGA_SSW);
  if (args.tipo === "entrega") {
    if (entrega) {
      return { acao: "ja_no_ssw", motivo: `a 01 já está no SSW (${entrega.data ?? "sem data"}${entrega.usuario ? `, ${entrega.usuario}` : ""}); nada foi gravado` };
    }
  } else {
    if (entrega) return { acao: "falha", categoria: "nota_encerrada", motivo: `a nota já foi entregue no SSW (01 em ${entrega.data ?? "?"}); insucesso não lançado` };
    const igual = ocs.find((o) => {
      if (o.codigo !== args.codigo) return false;
      const t = parseSswDataHoraBrt(o.data);
      return t !== null && Math.abs(t - Math.floor(args.ocorridoEmMs / 60_000) * 60_000) <= 2 * 60_000;
    });
    if (igual) return { acao: "ja_no_ssw", motivo: `a oc ${String(args.codigo).padStart(2, "0")} desta hora já está no SSW (${igual.data}); nada foi gravado` };
  }
  if (OCS_ENCERRAM_CTRC.has(v.oc)) {
    return { acao: "falha", categoria: "nota_encerrada", motivo: `o CTRC está encerrado no SSW (última oc ${v.oc})` };
  }
  return { acao: "lancar" };
}

/** Pura: falha do `lancarOcorrenciaPortal` → categoria + fase. */
export function classificarFalhaPortal(r: Extract<LancarOcorrenciaPortalResult, { ok: false }>): {
  categoria: CategoriaFalhaBaixa;
  fase: "antes_do_submit" | "submit";
} {
  if (r.bloqueado_por_guard) return { categoria: "guard_tripe", fase: "antes_do_submit" };
  // "SSW erro: …" é a resposta do submit (act=II3): o SSW recusou explicitamente.
  if (/^SSW erro:/.test(r.error)) return { categoria: "ssw_recusou", fase: "submit" };
  // sem extraFoto / upload recusado / data inválida: o submit não aconteceu.
  return { categoria: "leitura_ssw", fase: "antes_do_submit" };
}

/** CNPJ do remetente na tela de detalhe do CTRC (para a WebAPI). null = não achou (fail-closed). */
export function extrairCnpjRemetente(html: string): string | null {
  const i = html.search(/Remetente/i);
  if (i < 0) return null;
  const m = html.slice(i, i + 600).match(/(\d{2})\.?(\d{3})\.?(\d{3})\/?(\d{4})-?(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}` : null;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const msgDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── o envelope ───────────────────────────────────────────────────────────────

export interface LancarSswBaixaArgs {
  env: Record<string, string | undefined>;
  canal: CanalBaixa;
  baixa: BaixaParaSsw;
  /** No máximo 1 (o que a WebAPI aceita). Já conferida (sha256 + mime) pelo worker. */
  evidencia: AnexoBytes | null;
  agoraMs?: number;
  io?: Partial<SswBaixaIo>;
}

export async function lancarSswBaixa(args: LancarSswBaixaArgs): Promise<LancarSswBaixaResult> {
  const io: SswBaixaIo = { ...IO_SSW_PADRAO, ...(args.io ?? {}) };
  const { env, canal, baixa } = args;
  const agoraMs = args.agoraMs ?? Date.now();
  const antes = (categoria: CategoriaFalhaBaixa, motivo: string): LancarSswBaixaResult => ({
    ok: false, categoria, fase: "antes_do_submit", motivo: motivo.slice(0, 600),
  });

  // 0. entrada
  const ocorridoMs = Date.parse(baixa.ocorridoEm);
  if (!CANAIS_BAIXA.includes(canal)) return antes("entrada_invalida", `canal desconhecido: ${String(canal)}`);
  if (!baixa.ctrc || !baixa.nf) return antes("entrada_invalida", "baixa sem CTRC ou NF: sem tripé não há lançamento");
  if (!Number.isFinite(ocorridoMs)) return antes("entrada_invalida", "ocorridoEm inválido");
  if (ocorridoMs > agoraMs + TOLERANCIA_RELOGIO_APARELHO_MS) return antes("entrada_invalida", "ocorridoEm no futuro: o SSW não aceita hora futura");
  if (baixa.tipo === "entrega" && baixa.codigo !== CODIGO_ENTREGA_SSW) return antes("entrada_invalida", "entrega só com a 01");
  if (baixa.tipo === "insucesso" && baixa.codigo === CODIGO_ENTREGA_SSW) return antes("entrada_invalida", "insucesso nunca é a 01");

  // 1. credencial (INV-013)
  if (canal === "webapi" && !credencialWebApiEhDaContaDeServico(env)) {
    return antes("credencial", "canal webapi: SSW_USERNAME não é a conta de serviço (SSW_LANCAMENTO_USUARIO); nada foi enviado");
  }
  let sessao: SswSessao;
  try {
    sessao = await io.abrirSessao(env);
  } catch (e) {
    const m = msgDe(e);
    const cat = classificarErroLeitura(m);
    return antes(cat === "credencial" ? "credencial" : cat === "sessao_invalida" ? "sessao_invalida" : "leitura_ssw", `sessão SSW: ${m}`);
  }

  // 2. verdade do SSW antes de gravar
  let verdade: DescobrirUltimaOcSswResultado;
  try {
    verdade = await io.lerVerdade(baixa.nf, baixa.ctrc, env);
  } catch (e) {
    return antes("leitura_ssw", `leitura das ocorrências: ${msgDe(e)}`);
  }
  const dv = decidirPelaVerdade({ tipo: baixa.tipo, codigo: baixa.codigo, ocorridoEmMs: ocorridoMs, verdade });
  if (dv.acao === "ja_no_ssw") return { ok: true, resultado: "ja_no_ssw", canal, motivo: dv.motivo };
  if (dv.acao === "falha") return antes(dv.categoria, dv.motivo);

  // 3. detalhe do CTRC DA BAIXA (buscarNFInterno confere o CTRC exato)
  let detalhe: SswNFDetalhe;
  try {
    detalhe = await io.buscarDetalhe(sessao, baixa.nf, baixa.ctrc);
  } catch (e) {
    const m = msgDe(e);
    return antes(classificarErroLeitura(m), `detalhe do CTRC: ${m}`);
  }
  const eventoMs = horaDoEventoMs(ocorridoMs, agoraMs);

  if (canal === "portal101") {
    let r: LancarOcorrenciaPortalResult;
    try {
      r = await io.lancarPortal(sessao, detalhe, {
        codigoSsw: baixa.codigo,
        texto: baixa.texto,
        imagens: args.evidencia ? [args.evidencia] : [],
        dataHoraEvento: new Date(eventoMs),
        // 4. tripé ANTES do submit, com o HTML do act=O em mãos.
        validarAntesDoSubmit: (htmlO: string) => {
          const v = validarTripeCtrcNfPagador({ cardCtrc: baixa.ctrc, cardNf: baixa.nf, htmlAtoO: htmlO });
          return Promise.resolve(v.ok ? { ok: true as const } : { ok: false as const, motivo: v.motivo, detalhe: v.detalhe });
        },
      });
    } catch (e) {
      return { ok: false, categoria: "interrompido", fase: "submit", motivo: `portal SSW caiu no meio do lançamento: ${msgDe(e)}`.slice(0, 600) };
    }
    if (r.ok) return { ok: true, resultado: "executado", canal, protocolo: r.seq_oc, detalhe: r.descricao };
    const c = classificarFalhaPortal(r);
    return { ok: false, categoria: c.categoria, fase: c.fase, motivo: r.error.slice(0, 600) };
  }

  // canal webapi — o tripé roda sobre a tela de detalhe (fail-closed se o layout não casar).
  const t = validarTripeCtrcNfPagador({ cardCtrc: baixa.ctrc, cardNf: baixa.nf, htmlAtoO: detalhe.html });
  if (!t.ok) return antes("guard_tripe", `tripé: ${t.motivo} — ${t.detalhe}`);
  let linhas: CtrcRow[];
  try {
    linhas = await io.listarCtrcs(sessao, baixa.nf);
  } catch (e) {
    return antes("leitura_ssw", `lista de CTRCs da NF: ${msgDe(e)}`);
  }
  // A lista só serve para LER a chave do CT-e do CTRC que já veio na baixa (igualdade exata).
  const linha = linhas.find((l) => l.ctrc.toUpperCase().trim() === baixa.ctrc && !l.cancelado) ?? null;
  const chaveCTe = (linha?.chave_cte ?? "").replace(/\D/g, "");
  if (chaveCTe.length !== 44) return antes("webapi_sem_dados", `sem chave de CT-e de 44 dígitos para o CTRC ${baixa.ctrc} no SSW`);
  const cnpjRemetente = extrairCnpjRemetente(detalhe.html);
  if (!cnpjRemetente) return antes("webapi_sem_dados", `sem CNPJ do remetente na tela do CTRC ${baixa.ctrc}`);

  let r: LancarOcorrenciaResult;
  try {
    r = await io.lancarWebApi(env, {
      cardId: `baixa:${baixa.baixaId}`,
      todoId: baixa.baixaId,
      cnpjRemetente,
      chaveCTe,
      codigo: String(baixa.codigo).padStart(2, "0"),
      descricao: baixa.texto,
      dataHoraEvento: formatarDataHoraWebApi(eventoMs),
      ...(args.evidencia ? { imagem: base64(args.evidencia.bytes) } : {}),
    });
  } catch (e) {
    const m = msgDe(e);
    // Só o login feito ANTES do envio é seguro de repetir; qualquer outra exceção
    // (inclusive token renovado depois de um 5xx) pode ter deixado a oc gravada.
    if (m.startsWith(MARCA_LOGIN_WEBAPI)) return antes("sessao_invalida", m);
    return { ok: false, categoria: "interrompido", fase: "submit", motivo: `WebAPI SSW caiu no meio do lançamento: ${m}`.slice(0, 600) };
  }
  if (r.ok) return { ok: true, resultado: "executado", canal, protocolo: r.protocolo, detalhe: `WebAPI ocorrenciaParceiro ${r.protocolo}` };
  // 4xx = o SSW recusou explicitamente. 5xx depois das tentativas do cliente = não se sabe se gravou.
  return r.status >= 400 && r.status < 500
    ? { ok: false, categoria: "ssw_recusou", fase: "submit", motivo: `WebAPI ${r.status}: ${r.error}`.slice(0, 600) }
    : { ok: false, categoria: "interrompido", fase: "submit", motivo: `WebAPI sem resposta conclusiva (${r.status}): ${r.error}`.slice(0, 600) };
}
