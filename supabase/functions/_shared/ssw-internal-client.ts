// =============================================================================
// ssw-internal-client — HTTP client genérico pro portal SSW interno
// (sistema.ssw.inf.br) usando login operador Sal Express.
//
// Resolve o bug NF 920161 (Caio 2026-05-11): trackingpag SSW público oculta
// 31 ocs internas (49/56/44/...) — fotos dessas ocs ficam invisíveis pro
// cliente. Com login interno, o portal mostra TUDO incluindo essas fotos.
//
// Fluxo HTTP mapeado (não tem captcha/CSRF/JS dinâmico — só forms tradicionais):
//   1. POST /bin/ssw0422 (act=L, f1=Dominio, f2=CPF, f3=Usuario, f4=Senha)
//      → cookies (token JWT + sigla_emp + ssw_dom + login + chave)
//   2. GET  /bin/ssw0053 → form de busca CTRC/NF (opção 101)
//   3. POST /bin/ssw0053 act=P2 t_nro_nf=<NF> → página detalhe da NF
//      (extrai seq_ctrc e FAMILIA dos hidden fields)
//   4. POST /bin/ssw0053 act=O seq_ctrc=... FAMILIA=... → tela ssw0122.07
//      com XML embutido `<xml id="xmlsr"><rs><r>...</r></rs></xml>` listando
//      TODAS as ocorrências (inclusive bloqueadas no trackingpag público)
//   5. Parse XML → cada <r> tem <f5>código - descrição</f5>, <f6>instrução</f6>,
//      <f9><a onclick=ajaxEnvia('',1,'ssw0122?seq_ctrc=...&foto=PATH&act=FOT')>...
//   6. GET /bin/ssw0122?seq_ctrc=...&foto=...&act=FOT → HTML com JS:
//      `$("picture").src = "https://ssw.inf.br/cgi-local/ssw0637?..."`
//   7. GET https://ssw.inf.br/cgi-local/ssw0637?... → binário JPEG/PDF
//
// Sessão: JWT no cookie `token` tem `exp` epoch — cache em memória respeita TTL
// e re-loga automaticamente quando próximo de expirar (com margem de 60s).
//
// Limitações conhecidas:
//   - Login l.silva (Larissa) é compartilhado — risco de invalidação se Larissa
//     loga manualmente no SSW. Migração pra usuário dedicado quando SSW criar.
// =============================================================================

const BASE = "https://sistema.ssw.inf.br";
const SSW_CGI_BASE = "https://ssw.inf.br";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

// =============================================================================
// Encoding helpers — SSW serve charset=iso-8859-1 (latin-1). Submeter body em
// UTF-8 com bytes multi-byte (—, "", '', etc.) faz SSW rejeitar campo inteiro
// silenciosamente — bug crítico NF 2161614/156022/2282024 (2026-06-10).
// =============================================================================

import { parseSswDataHoraBrt } from "./ssw-data-hora.ts";
import type { FotoMetaItem } from "./foto-oc-manifest.ts";

/**
 * Resultado do manifesto de fotos (metadata, sem binário). Estruturalmente
 * compatível com `ListarFotosMetaLike` de foto-oc-manifest.ts (consumido por
 * `montarManifestoFotos`). INV-012b (NF 362406).
 */
export type ListarFotosMetadataResult =
  | { status: "ok"; fotos: FotoMetaItem[]; fotos_total: number; incompleto: boolean }
  | {
    status: "oc_nao_encontrada";
    codigo_buscado: number;
    ocs_disponiveis: Array<{ codigo: number | null; descricao: string; tem_foto: boolean }>;
  }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
  | { status: "erro_ssw"; motivo: string };

/**
 * Substitui caracteres unicode comuns por equivalentes ASCII/latin-1 antes
 * de ir pro SSW. Acentos PT-BR (ç, ã, ê, etc.) existem em latin-1 e passam
 * direto — não precisam substituição.
 *
 * Foco: caracteres que IA/templates costumam gerar e que NÃO existem em
 * latin-1 (range U+0100 em diante).
 */
export function sanitizarParaLatin1(s: string): string {
  if (!s) return s;
  return s
    .replace(/[—–]/g, "-")       // em/en dash → hífen ASCII
    .replace(/[“”„]/g, '"')      // curly double quotes → "
    .replace(/[‘’‚]/g, "'")      // curly single quotes → '
    .replace(/…/g, "...")        // ellipsis → 3 pontos
    .replace(/•/g, "*")          // bullet → asterisco
    .replace(/[  ]/g, " ") // non-breaking space → espaço normal
    .replace(/[^\x00-\xFF]/g, "?"); // qualquer outro fora de latin-1 (U+0100+) → '?'
}

/**
 * Encoda URLSearchParams como body iso-8859-1 percent-encoded.
 * Diferença pro `.toString()` padrão: caracteres latin-1 (ex: 'ç' = 0xE7)
 * viram `%E7` em vez de `%C3%A7` (que é UTF-8 multi-byte).
 *
 * Garante que SSW (que decodifica como latin-1) lê os bytes corretos.
 */
export function urlEncodeLatin1(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const [key, value] of params.entries()) {
    parts.push(`${percentEncodeLatin1(key)}=${percentEncodeLatin1(value)}`);
  }
  return parts.join("&");
}

function percentEncodeLatin1(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // Unreserved chars conforme RFC 3986 + alguns extras seguros pra form
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5A) || // A-Z
      (code >= 0x61 && code <= 0x7A) || // a-z
      code === 0x2D || code === 0x2E || code === 0x5F || code === 0x7E // -._~
    ) {
      out += ch;
    } else if (code === 0x20) {
      out += "+"; // form-urlencoded usa + pra espaço
    } else if (code <= 0xFF) {
      // Latin-1 puro — 1 byte direto
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      // Fora do range latin-1 (não devia chegar aqui se sanitizarParaLatin1
      // foi chamado antes). Fallback: '?'.
      out += "%3F";
    }
  }
  return out;
}

export interface SswInternalEnv {
  dominio: string;
  cpf: string;
  usuario: string;
  senha: string;
}

export interface SswSessao {
  cookies: Map<string, string>;
  criadoEm: number;
  tokenExpMs: number;
}

/**
 * Foto de ocorrência no SSW tem 2 formatos distintos:
 * - `tracking_ent`: ocs normais (ex: 49). Link via ssw0122?seq_ctrc=X&foto=PATH&act=FOT.
 *   Precisa 2 hops: ssw0122 → extrai picture_src → ssw0637 (binário).
 * - `fot_ent_mobile`: ocs de entrega via SSWMOBILE (ex: 10, 27). Link via
 *   ssw0053?act=FOT_ENT&seq_ctrc=X&data_rec=D&hora_rec=H. HTML retornado já
 *   contém o link direto ssw0637 (sem variável JS picture_src).
 *
 * Caio 2026-05-13 (NF 20761 oc=10): formato fot_ent_mobile era ignorado pelo
 * regex antigo. Larissa via "📷 Ver Foto" não aparecer em ocs SSWMOBILE.
 */
export type SswFoto =
  | {
      tipo: "tracking_ent";
      seqCtrc: string;
      fotoPath: string;
      /**
       * Caio 2026-06-05 (NF 357645 LARISSA): ocs tracking_ent podem ter 2+
       * fotos paginadas no viewer (links 01/02/03 no topo de ssw0122 com
       * `onclick="ajaxEnvia('FOT_N',0)"`). O XML cru só expõe a 1ª via
       * `foto=PATH`. Pra páginas >1, baixarFotoOcorrencia usa POST
       * `act=FOT_<paginaN>` no mesmo seq_ctrc+fotoPath.
       * Default = 1 (compat com comportamento legado).
       */
      paginaN?: number;
    }
  | { tipo: "fot_ent_mobile"; seqCtrc: string; dataRec: string; horaRec: string };

export interface SswOcorrencia {
  codigo: number | null;
  descricao: string;
  instrucao: string;
  data: string;
  filial: string | null;
  usuario: string | null;
  fotos: Array<SswFoto>;
}

export interface SswNFDetalhe {
  nf: string;
  seq_ctrc: string;
  familia: string;
  html: string;
}

/**
 * Lê credenciais SSW interno do env, opcionalmente filtrado por operador.
 *
 * Caio 2026-05-15 (onboarding Duilio): SSW interno agora é POR OPERADOR.
 * Cards atribuídos ao Duilio usam SSW.DUILIO; cards da Larissa usam SSW.LARISSA.
 * Antes era credencial única (Larissa pra todos os cards), gerando 2 problemas:
 *   1. Quando senha da Larissa troca, scrape falha pra TODOS os cards.
 *   2. Conta de operador real usada como service account pra Duilio = auditoria
 *      ruim no SSW.
 *
 * Resolução (em ordem):
 *   1. operadorNome != null → tenta `SSW_INTERNAL_<NOME>_DOMINIO` etc
 *      (ex: SSW_INTERNAL_DUILIO_*, SSW_INTERNAL_LARISSA_*).
 *   2. Fallback → `SSW_INTERNAL_DOMINIO` etc (legado, single-operator).
 *   3. Se nenhum existir → throw.
 *
 * Setar via `supabase secrets set SSW_INTERNAL_DUILIO_DOMINIO=...` etc.
 */
export function readSswInternalEnv(
  env: Record<string, string | undefined>,
  operadorNome?: string | null,
): SswInternalEnv {
  // Caio 2026-06-15 (onboarding ISA E KAROL): nome do operador pode ter espaços
  // (ex: "ISA E KAROL", conta compartilhada Karol+Isabelly). Env var / secret
  // não aceita espaço, então sanitizamos pra [A-Z0-9_] colapsando runs em '_'
  // → SSW_INTERNAL_ISA_E_KAROL_*. Nomes de 1 palavra (DURAFA, VICTOR, LARISSA)
  // não mudam — retrocompatível.
  const prefix = operadorNome
    ? `SSW_INTERNAL_${operadorNome.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`
    : "SSW_INTERNAL_";

  const dominio = env[`${prefix}DOMINIO`] ?? env["SSW_INTERNAL_DOMINIO"];
  const cpf = env[`${prefix}CPF`] ?? env["SSW_INTERNAL_CPF"];
  const usuario = env[`${prefix}USUARIO`] ?? env["SSW_INTERNAL_USUARIO"];
  const senha = env[`${prefix}SENHA`] ?? env["SSW_INTERNAL_SENHA"];

  if (!dominio || !cpf || !usuario || !senha) {
    throw new Error(
      `SSW_INTERNAL_* env vars ausentes (prefix=${prefix}, fallback=SSW_INTERNAL_*). ` +
      "Setar via `supabase secrets set` antes de usar o cliente interno.",
    );
  }
  return { dominio, cpf, usuario, senha };
}

/**
 * Credencial ÚNICA de LANÇAMENTO de ocorrência no SSW (Caio 2026-06-22).
 *
 * Regra: TODO lançamento de oc no portal SSW usa a conta de serviço `ai.salex`,
 * INDEPENDENTE do operador dono do card. Cobre os 6 pontos que chamam
 * `lancarOcorrenciaPortal`: o envelope `lancarSswPortal` (oc 54/21/44/padrão) e
 * as 4 tools de oc=33 no executor (solo, combo 33+44, email+33 romaneio,
 * email livre+33).
 *
 * Motivo: auditoria no SSW sob 1 identidade de robô. Antes, oc=33 saía como
 * Larissa (credencial legada `SSW_INTERNAL_*` sem operador) e as demais como o
 * operador do card (`loadSswInternalEnvForCard`) — desencontro real no card
 * d11717f9 / NF 651244 (Duilio aprovou, SSW registrou Larissa).
 *
 * NÃO confundir com `readSswInternalEnv`/`loadSswInternalEnvForCard` (resolução
 * por-operador), que continuam valendo SÓ pra LEITURA (foto, histórico).
 *
 * Secrets: `SSW_LANCAMENTO_USUARIO` / `_SENHA` / `_CPF` (obrigatórios);
 * `_DOMINIO` com default `SSW_INTERNAL_DOMINIO` → `SSW_DOMAIN`.
 * SEM fallback silencioso de conta: se faltar credencial → THROW (o lançamento
 * aborta e reverte o card). Nunca cair pra outra conta — esse era o bug.
 */
export function readSswLancamentoEnv(
  env: Record<string, string | undefined>,
): SswInternalEnv {
  const dominio = env["SSW_LANCAMENTO_DOMINIO"] ?? env["SSW_INTERNAL_DOMINIO"] ??
    env["SSW_DOMAIN"];
  const cpf = env["SSW_LANCAMENTO_CPF"];
  const usuario = env["SSW_LANCAMENTO_USUARIO"];
  const senha = env["SSW_LANCAMENTO_SENHA"];

  if (!dominio || !cpf || !usuario || !senha) {
    throw new Error(
      "SSW_LANCAMENTO_* env vars ausentes — conta de serviço ai.salex pra " +
      "lançamento de oc. Obrigatórios: SSW_LANCAMENTO_USUARIO/SENHA/CPF " +
      "(dominio via SSW_LANCAMENTO_DOMINIO/SSW_INTERNAL_DOMINIO/SSW_DOMAIN). " +
      "Setar via `supabase secrets set`. SEM fallback pra credencial de operador.",
    );
  }
  return { dominio, cpf, usuario, senha };
}

// Cache de sessão por (dominio + usuario) — multi-operador.
// Antes era cache único global, que mistura sessões e gera 401 quando alterna
// entre operadores. Caio 2026-05-15.
const cachedSessoes = new Map<string, SswSessao>();
function cacheKeyFromEnv(env: SswInternalEnv): string {
  return `${env.dominio}|${env.usuario}`;
}

function applySetCookie(cookies: Map<string, string>, headers: Headers) {
  const list: string[] =
    (headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const raw of list) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) cookies.set(k, v);
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function decodeJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const json = JSON.parse(atob(padded));
    if (typeof json.exp === "number") return json.exp * 1000;
  } catch { /* ignore */ }
  return 0;
}

/**
 * Faz login no portal interno SSW. Retorna sessão (cookies + tokenExpMs).
 * Throws se credencial inválida ou SSW indisponível.
 */
export async function loginInternoSSW(env: SswInternalEnv): Promise<SswSessao> {
  const cookies = new Map<string, string>();

  // 1. GET pra warm-up (alguns sistemas exigem cookies iniciais)
  const init = await fetchTimeout(`${BASE}/bin/ssw0422`, {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  applySetCookie(cookies, init.headers);

  // 2. POST credenciais — act=L = ajaxEnvia('L', 0) do botão de submit
  const body = new URLSearchParams({
    act: "L",
    f1: env.dominio,
    f2: env.cpf,
    f3: env.usuario,
    f4: env.senha,
  });
  const post = await fetchTimeout(`${BASE}/bin/ssw0422`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0422`,
      cookie: cookieHeader(cookies),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(cookies, post.headers);

  if (!cookies.has("token")) {
    // Captura forensics: status, set-cookie headers, snippet do body
    let bodySnippet = "";
    try {
      bodySnippet = (await post.text()).slice(0, 300).replace(/\s+/g, " ").trim();
    } catch { /* ignore */ }
    const setCookieHeaders: string[] = [];
    post.headers.forEach((v, k) => {
      if (k.toLowerCase() === "set-cookie") setCookieHeaders.push(v);
    });
    const cookieNames = Array.from(cookies.keys()).join(",") || "(nenhum)";
    throw new Error(
      `SSW login falhou — sem cookie 'token' após POST ` +
      `(creds: dominio=${env.dominio} usuario=${env.usuario}) ` +
      `[status=${post.status} cookies_recebidos=${cookieNames}] ` +
      `body="${bodySnippet}" ` +
      `set_cookie_hdrs=${setCookieHeaders.length}`,
    );
  }

  const tokenExpMs = decodeJwtExp(cookies.get("token")!);
  return {
    cookies,
    criadoEm: Date.now(),
    tokenExpMs: tokenExpMs || Date.now() + 60 * 60_000, // fallback 1h
  };
}

/**
 * Retorna sessão válida do cache OU loga de novo se expirada/próxima do exp.
 * Cache é por (dominio, usuario) — cada operador tem sua sessão isolada.
 */
export async function obterSessao(env: SswInternalEnv): Promise<SswSessao> {
  const key = cacheKeyFromEnv(env);
  const cached = cachedSessoes.get(key);
  if (cached && Date.now() < cached.tokenExpMs - 60_000) {
    return cached;
  }
  const novo = await loginInternoSSW(env);
  cachedSessoes.set(key, novo);
  return novo;
}

/**
 * Limpa cache de sessão (útil quando algum request volta 401/403).
 * Se `env` passado, limpa só a sessão daquele operador; senão limpa todas.
 */
export function limparSessaoCache(env?: SswInternalEnv): void {
  if (env) {
    cachedSessoes.delete(cacheKeyFromEnv(env));
  } else {
    cachedSessoes.clear();
  }
}

/**
 * Busca uma NF na opção 101 e retorna a página de detalhe.
 *
 * Recebe a sessão (com cookies) e a NF. Faz o POST com act=P2 (botão da
 * linha de Nota Fiscal no form de busca) — SSW responde com a tela detalhe
 * direto (1 NF). Extrai seq_ctrc e FAMILIA pra próximos hops.
 */
export interface BuscarNFOpts {
  /** CTRC esperado (do card.ctrc). Se vier, valida match exato no detalhe —
   * protege contra (a) NF de outro pagador retornada por engano OU (b) CT-e de
   * reentrega/complementar. Throw com erro claro se mismatch. Caio 2026-05-12. */
  ctrcEsperado?: string | null;
}

export async function buscarNFInterno(
  sessao: SswSessao,
  nf: string,
  opts?: BuscarNFOpts,
): Promise<SswNFDetalhe> {
  // GET form (estabelece referer + alguns sistemas exigem warm-up)
  await fetchTimeout(`${BASE}/bin/ssw0053`, {
    headers: { "User-Agent": UA, cookie: cookieHeader(sessao.cookies) },
    redirect: "manual",
  });

  const body = new URLSearchParams({
    act: "P2", // botão de busca por Nota Fiscal
    t_nro_nf: nf,
    // Datas em BRT (SSW usa fuso de Brasília). Sem o -3h, das 21h à meia-noite
    // BRT a data_fin vira amanhã no SSW → "Data final maior que data corrente".
    t_data_ini: dateYYMMDD(dataBRT(Date.now() - 365 * 24 * 60 * 60 * 1000)),
    t_data_fin: dateYYMMDD(dataBRT()),
  });
  const res = await fetchTimeout(`${BASE}/bin/ssw0053`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, res.headers);
  const html = await res.text();
  const seqCtrcDireto = html.match(/name=seq_ctrc[^>]*value="(\d+)"/)?.[1];
  const familiaDireto = html.match(/name=FAMILIA[^>]*value="([^"]*)"/)?.[1];

  // CAMINHO 1: tela de detalhe direto (1 CTRC só). Valida CTRC esperado.
  if (seqCtrcDireto && seqCtrcDireto !== "0" && familiaDireto) {
    if (opts?.ctrcEsperado) {
      const ctrcNorm = opts.ctrcEsperado.toUpperCase().trim();
      const ctrcMatch = html.match(/([A-Z]{3}\d{6}-\d)/);
      const ctrcDetalhe = ctrcMatch?.[1]?.toUpperCase() ?? null;
      if (!ctrcDetalhe) {
        throw new Error(
          `SSW buscar NF ${nf}: detalhe sem CTRC visível, não dá pra validar contra esperado ${ctrcNorm}.`,
        );
      }
      if (ctrcDetalhe !== ctrcNorm) {
        throw new Error(
          `SSW buscar NF ${nf}: CTRC no SSW é ${ctrcDetalhe} mas card espera ${ctrcNorm}. ` +
          `Provável: mesmo número de NF pra pagador diferente OU CT-e de reentrega/complementar. ` +
          `Operação não foi feita pra proteger.`,
        );
      }
    }
    return { nf, seq_ctrc: seqCtrcDireto, familia: familiaDireto, html };
  }

  // CAMINHO 2: tela de lista (múltiplos CTRCs pra essa NF). Parseia XML
  // embutido `<xml id="xmlsr"><rs><r>...</r></rs></xml>` e seleciona pelo CTRC.
  // Regra Caio 2026-05-12: CTRC é único globalmente; mesmo número de NF pode
  // existir pra múltiplos pagadores, mas card.ctrc identifica unicamente o
  // CTRC correto. Filtra <r> cujo <f1> bate com ctrcEsperado.
  //
  // Cada <r> tem:
  //   <f0>SEP</f0>           (domínio)
  //   <f1>CTRC</f1>          (ex: ADI213548-5)
  //   <f2>tipo</f2>          (REVERSA / NORMAL / vazio)
  //   <f3>data</f3>
  //   <f4>remetente</f4>
  //   <f5>cidade origem</f5>
  //   <f6>pagador</f6>
  //   <f7>destinatario</f7>
  //   <f8>cidade destino</f8>
  //   <f9>peso</f9> <f10>frete</f10>
  //   <f11>chave_cte</f11>
  //   <f12>cancelado</f12>
  //   <f13>FAMILIA@DOM@seq_ctrc@data</f13>  ← extrai seq_ctrc + FAMILIA daqui
  const xmlMatch = html.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i);
  if (xmlMatch) {
    if (!opts?.ctrcEsperado) {
      throw new Error(
        `SSW buscar NF ${nf}: múltiplos CTRCs retornados — exige ctrcEsperado pra escolher o certo. ` +
        `Card sem CTRC populado? Investigue card.ctrc.`,
      );
    }
    const ctrcNorm = opts.ctrcEsperado.toUpperCase().trim();
    const rows = [...(xmlMatch[1] ?? "").matchAll(/<r>([\s\S]*?)<\/r>/gi)];
    const linhas = rows.map((r) => {
      const inner = r[1] ?? "";
      const get = (n: number) =>
        inner.match(new RegExp(`<f${n}>([\\s\\S]*?)<\\/f${n}>`, "i"))?.[1] ?? "";
      return {
        ctrc: decodeEntities(get(1)).toUpperCase().trim(),
        tipo: decodeEntities(get(2)).trim(),
        pagador: decodeEntities(get(6)).trim(),
        f13: decodeEntities(get(13)).trim(),
      };
    });

    const match = linhas.find((l) => l.ctrc === ctrcNorm);
    if (!match) {
      throw new Error(
        `SSW buscar NF ${nf}: tem ${linhas.length} CTRCs mas nenhum bate com card.ctrc=${ctrcNorm}. ` +
        `Disponíveis: ${linhas.map((l) => `${l.ctrc} (pagador: ${l.pagador})`).join(" | ")}.`,
      );
    }

    // f13 formato: "FAMILIA@SEP@10624834@05/05/2026"
    const partes = match.f13.split("@");
    const familiaLista = partes[1] ?? "SEP";
    const seqCtrcLista = partes[2];
    if (!seqCtrcLista) {
      throw new Error(
        `SSW buscar NF ${nf}: linha do CTRC ${match.ctrc} sem seq_ctrc em f13 (formato: ${match.f13}).`,
      );
    }
    return { nf, seq_ctrc: seqCtrcLista, familia: familiaLista, html };
  }

  // CAMINHO 3: nem detalhe nem lista — NF não existe ou outro problema.
  // Forensics: snippet do HTML, status, content-type, tamanho — pra distinguir
  // "NF de fato inexistente" de "SSW devolveu página diferente do esperado"
  // (manutenção, anti-bot, sessão expulsa, mudança de layout).
  const htmlSnippet = html.length > 600
    ? html.substring(0, 300).replace(/\s+/g, " ") + " ... " + html.substring(html.length - 200).replace(/\s+/g, " ")
    : html.replace(/\s+/g, " ");
  throw new Error(
    `SSW buscar NF ${nf}: sem seq_ctrc/FAMILIA na resposta e sem XML de lista — NF inexistente? ` +
    `[http_status=${res.status} content_type=${res.headers.get("content-type") ?? "?"} html_len=${html.length}] ` +
    `html_snippet="${htmlSnippet}"`,
  );
}

/**
 * Lista todas as ocorrências da NF (página ssw0122.07). Retorna array
 * estruturado com código, descrição, instrução, e link da foto se houver.
 */
export async function listarOcorrenciasNF(
  sessao: SswSessao,
  detalhe: SswNFDetalhe,
): Promise<SswOcorrencia[]> {
  const body = new URLSearchParams({
    act: "O", // botão "Ocorrências"
    seq_ctrc: detalhe.seq_ctrc,
    FAMILIA: detalhe.familia,
    t_nro_nf: detalhe.nf,
  });
  const res = await fetchTimeout(`${BASE}/bin/ssw0053`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, res.headers);
  const html = await res.text();
  return parseOcorrenciasXML(html);
}

/**
 * Faz parse do `<xml id="xmlsr">` embutido na página ssw0122.07.
 * Cada <r> = 1 ocorrência com fields <f0>...<f12>:
 *   f0 = inclusão tela
 *   f1 = domínio, f2 = filial, f3 = inclusão local
 *   f4 = usuário (#u#login|1338#/u#)
 *   f5 = "CÓDIGO - DESCRIÇÃO" (ex: "49 - TRATATIVA DE RELACIONAMENTO...")
 *   f6 = instrução/complemento
 *   f7 = link Detalhe, f8 = Documentos
 *   f9 = link Imagem (se houver foto)
 *   f10..f12 = aux
 */
function parseOcorrenciasXML(html: string): SswOcorrencia[] {
  const xmlMatch = html.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i);
  if (!xmlMatch) return [];
  const xmlBody = xmlMatch[1] ?? "";
  const rows = [...xmlBody.matchAll(/<r>([\s\S]*?)<\/r>/gi)];

  return rows.map((r) => {
    const inner = r[1] ?? "";
    const f = (n: number) => {
      const m = inner.match(new RegExp(`<f${n}>([\\s\\S]*?)<\/f${n}>`, "i"));
      return m?.[1] ?? "";
    };
    const f5Raw = decodeEntities(f(5));
    const f6Raw = decodeEntities(f(6));
    const f9Raw = f(9);
    const f4Raw = decodeEntities(f(4)).replace(/#u#|#\/u#/g, "");

    // f5 = "CODIGO - DESCRICAO". Extrai número.
    const codigoMatch = f5Raw.match(/^(\d+)\s*-\s*(.+)/);
    const codigo = codigoMatch ? parseInt(codigoMatch[1]!, 10) : null;
    const descricao = codigoMatch ? codigoMatch[2]!.trim() : f5Raw.trim();

    // f9 contém HTML escapado com link da foto em 2 formatos:
    //  (A) tracking_ent: ssw0122?seq_ctrc=X&foto=Y&act=FOT (ocs normais ex: 49)
    //  (B) fot_ent_mobile: ssw0053?act=FOT_ENT&seq_ctrc=X&data_rec=D&hora_rec=H
    //      (entregas via SSWMOBILE ex: 10/27 — Caio 2026-05-13 NF 20761)
    const f9Decoded = decodeEntities(f9Raw);
    const fotos: Array<SswFoto> = [];
    const fotoReA = /ssw0122\?seq_ctrc=(\d+)&foto=([^&'"]+)&act=FOT/gi;
    let fmA: RegExpExecArray | null;
    while ((fmA = fotoReA.exec(f9Decoded)) !== null) {
      fotos.push({ tipo: "tracking_ent", seqCtrc: fmA[1]!, fotoPath: fmA[2]! });
    }
    const fotoReB = /ssw0053\?act=FOT_ENT&seq_ctrc=(\d+)&data_rec=([^&'"]+)&hora_rec=([^&'")]+)/gi;
    let fmB: RegExpExecArray | null;
    while ((fmB = fotoReB.exec(f9Decoded)) !== null) {
      fotos.push({
        tipo: "fot_ent_mobile",
        seqCtrc: fmB[1]!,
        dataRec: fmB[2]!,
        horaRec: fmB[3]!,
      });
    }

    return {
      codigo,
      descricao,
      instrucao: f6Raw.trim(),
      data: decodeEntities(f(3)),
      filial: decodeEntities(f(2)) || null,
      usuario: f4Raw.split("|")[0] || null,
      fotos,
    };
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ccedil;/g, "ç")
    .replace(/&atilde;/g, "ã")
    .replace(/&aacute;/g, "á")
    .replace(/&eacute;/g, "é")
    .replace(/&iacute;/g, "í")
    .replace(/&oacute;/g, "ó")
    .replace(/&uacute;/g, "ú");
}

/**
 * Baixa o binário de uma foto da ocorrência. Suporta 2 formatos:
 *
 *  - tracking_ent (ocs normais): 2 hops. GET ssw0122?seq_ctrc=X&foto=Y&act=FOT
 *    → HTML intermediário com `$("picture").src = "URL"` → GET URL → binário.
 *
 *  - fot_ent_mobile (SSWMOBILE): 2 hops também, mas via endpoint diferente.
 *    GET ssw0053?act=FOT_ENT&seq_ctrc=X&data_rec=D&hora_rec=H → HTML com link
 *    direto pro ssw0637 → GET ssw0637 → binário. Caio 2026-05-13 (NF 20761).
 *
 * Retorna { binary, content_type, picture_src }. Throws se SSW falhar.
 */
export async function baixarFotoOcorrencia(
  sessao: SswSessao,
  foto: SswFoto,
): Promise<{ binary: Uint8Array; content_type: string; picture_src: string }> {
  let url1: string;
  let pictureSrc: string | undefined;

  if (foto.tipo === "tracking_ent") {
    // Caio 2026-06-05 (NF 357645 LARISSA): paginação 01/02/03 do viewer SSW.
    // - paginaN=1 (default) → GET act=FOT (URL do XML cru, 1ª foto)
    // - paginaN>1 → POST act=FOT_<N> no mesmo seq_ctrc+foto, server responde
    //   HTML com novo picture.src apontando pra outro IMG no ssw0637.
    const paginaN = foto.paginaN ?? 1;
    if (paginaN <= 1) {
      url1 = `${BASE}/bin/ssw0122?seq_ctrc=${foto.seqCtrc}&foto=${foto.fotoPath}&act=FOT`;
      const r1 = await fetchTimeout(url1, {
        headers: {
          "User-Agent": UA,
          "Referer": `${BASE}/bin/ssw0122`,
          cookie: cookieHeader(sessao.cookies),
        },
        redirect: "manual",
      });
      applySetCookie(sessao.cookies, r1.headers);
      const html1 = await r1.text();
      pictureSrc = html1.match(/\$\("picture"\)\.src\s*=\s*"([^"]+)"/)?.[1];
      if (!pictureSrc) {
        throw new Error(`SSW foto ${foto.fotoPath}: HTML intermediário sem picture.src`);
      }
    } else {
      url1 = `${BASE}/bin/ssw0122`;
      const form = new URLSearchParams({
        act: `FOT_${paginaN}`,
        seq_ctrc: foto.seqCtrc,
        foto: foto.fotoPath,
      });
      const r1 = await fetchTimeout(url1, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Referer": `${BASE}/bin/ssw0122?seq_ctrc=${foto.seqCtrc}&foto=${foto.fotoPath}&act=FOT`,
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: cookieHeader(sessao.cookies),
        },
        body: form,
        redirect: "manual",
      });
      applySetCookie(sessao.cookies, r1.headers);
      const html1 = await r1.text();
      pictureSrc = html1.match(/\$\("picture"\)\.src\s*=\s*"([^"]+)"/)?.[1];
      if (!pictureSrc) {
        throw new Error(`SSW foto ${foto.fotoPath} pag ${paginaN}: HTML intermediário sem picture.src`);
      }
    }
  } else {
    // fot_ent_mobile — HTML retorna link ssw0637 direto, sem variável JS
    url1 = `${BASE}/bin/ssw0053?act=FOT_ENT&seq_ctrc=${foto.seqCtrc}&data_rec=${encodeURIComponent(foto.dataRec)}&hora_rec=${encodeURIComponent(foto.horaRec)}`;
    const r1 = await fetchTimeout(url1, {
      headers: {
        "User-Agent": UA,
        "Referer": `${BASE}/bin/ssw0053`,
        cookie: cookieHeader(sessao.cookies),
      },
      redirect: "manual",
    });
    applySetCookie(sessao.cookies, r1.headers);
    const html1 = await r1.text();
    pictureSrc = html1.match(/(https?:\/\/[^"'\s]*ssw0637[^"'\s]+)/)?.[1];
    if (!pictureSrc) {
      throw new Error(`SSW foto SSWMOBILE seq=${foto.seqCtrc} data=${foto.dataRec}: HTML sem link ssw0637`);
    }
  }

  const r2 = await fetchTimeout(pictureSrc, {
    headers: {
      "User-Agent": UA,
      "Referer": url1,
      cookie: cookieHeader(sessao.cookies),
    },
    redirect: "follow",
  });
  applySetCookie(sessao.cookies, r2.headers);
  const ct = r2.headers.get("content-type") ?? "image/jpeg";
  if (!ct.toLowerCase().includes("image") && !ct.toLowerCase().includes("pdf")) {
    throw new Error(`SSW foto: picture_src retornou ${ct} (esperava image/*)`);
  }
  const binary = new Uint8Array(await r2.arrayBuffer());
  if (binary.byteLength === 0) {
    throw new Error(`SSW foto: binário vazio`);
  }
  // Normaliza content-type (alguns vêm com trailing ; ou charset)
  const ctClean = ct.split(";")[0]!.trim();
  return { binary, content_type: ctClean, picture_src: pictureSrc };
}

/**
 * Orquestra: login → busca NF → lista ocorrências → encontra oc do código
 * → baixa primeira foto. Retorna binário ou descritivo do erro.
 *
 * Usa cache de sessão (loga 1x e reusa). Se SSW retornar não-imagem ou faltar
 * foto na oc, retorna `null_motivo` pra caller renderizar erro educado.
 */
export type FotoOcResult =
  | {
      status: "ok";
      binary: Uint8Array;
      content_type: string;
      picture_src: string;
      oc_descricao: string;
      /** Caio 2026-05-27: total de fotos disponíveis nessa oc no SSW.
       *  Caio 2026-05-28 (NF 696530): agora agrega fotos de TODAS as linhas
       *  do código (quando SSW tem múltiplos lançamentos da mesma oc). */
      fotos_total: number;
      /** Caio 2026-05-27: índice (0-based) da foto baixada nesta chamada. */
      idx_atual: number;
      /** Caio 2026-05-28 (NF 696530): timestamp da linha SSW de origem da
       *  foto (formato SSW "dd/MM/yy HH:mm"). null quando agregação não
       *  consegue identificar a linha. */
      foto_data?: string | null;
      /** Caio 2026-05-28 (NF 696530): instrução do motorista da linha de
       *  origem (texto bruto SSW). Pode vir vazio. */
      foto_instrucao?: string | null;
    }
  | { status: "oc_nao_encontrada"; codigo_buscado: number; ocs_disponiveis: Array<{ codigo: number | null; descricao: string; tem_foto: boolean }> }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
  | { status: "idx_invalido"; codigo_buscado: number; fotos_total: number; idx_pedido: number }
  | { status: "erro_ssw"; motivo: string };

/**
 * Caio 2026-06-05 (NF 357645 LARISSA): conta quantas fotos `tracking_ent`
 * existem no viewer SSW pra uma linha. O XML cru só expõe a 1ª (`foto=PATH`),
 * mas o viewer HTML (`/bin/ssw0122?seq_ctrc=X&foto=Y&act=FOT`) mostra
 * paginadores `01 02 03` no topo via `<A onclick="ajaxEnvia('FOT_N',0)">`.
 * Retorna N ≥ 1 (1 = só a 1ª, comportamento legado).
 *
 * Se o probe falhar, lança erro — caller decide se degrada (manter 1) ou
 * propaga.
 */
async function contarPaginasFotoTrackingEnt(
  sessao: SswSessao,
  foto: Extract<SswFoto, { tipo: "tracking_ent" }>,
): Promise<number> {
  const url = `${BASE}/bin/ssw0122?seq_ctrc=${foto.seqCtrc}&foto=${foto.fotoPath}&act=FOT`;
  const r = await fetchTimeout(url, {
    headers: {
      "User-Agent": UA,
      "Referer": `${BASE}/bin/ssw0122`,
      cookie: cookieHeader(sessao.cookies),
    },
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, r.headers);
  const html = await r.text();
  const matches = [...html.matchAll(/ajaxEnvia\(['"]FOT_(\d+)['"]/gi)];
  if (matches.length === 0) return 1;
  // SSW lista 01..N — pega o maior pra cobrir caso de regex pular algum
  const max = matches.reduce((m, x) => Math.max(m, parseInt(x[1]!, 10) || 0), 0);
  return Math.max(1, max);
}

// Caio 2026-06-18 (NF 355283 oc=49): entry de foto JÁ baixada, usado por
// obterTodasFotosDaOc. `idx` é a posição 0-based no array linear agregado.
export interface FotoBaixadaDaOc {
  binary: Uint8Array;
  content_type: string;
  picture_src: string;
  oc_descricao: string;
  idx: number;
  foto_data?: string | null;
  foto_instrucao?: string | null;
}

export type TodasFotosOcResult =
  | { status: "ok"; fotos: FotoBaixadaDaOc[]; fotos_total: number }
  | { status: "oc_nao_encontrada"; codigo_buscado: number; ocs_disponiveis: Array<{ codigo: number | null; descricao: string; tem_foto: boolean }> }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
  | { status: "erro_ssw"; motivo: string };

type FotoAgregadaInterna = {
  foto: SswFoto;
  linhaIdx: number;
  descricao: string;
  data?: string | null;
  instrucao?: string | null;
};

/**
 * Núcleo compartilhado (Caio 2026-06-18): abre sessão, lista as ocorrências da
 * NF e agrega TODAS as fotos de TODAS as linhas do código num array linear,
 * EXPANDINDO a paginação tracking_ent 01/02/03 (NF 357645). NÃO baixa o binário
 * — só monta a lista. Usado por obterFotoDaOc (pega 1 por idx) e por
 * obterTodasFotosDaOc (baixa todas). Pode lançar (sessão/scrape); callers
 * públicos envolvem em try/catch.
 *
 * Caio 2026-05-13 (NF 20761): NFs com múltiplos CTRCs (reentrega/complementar)
 * fazem buscarNFInterno throw — propaga ctrcEsperado pra escolher o certo.
 * Caio 2026-05-28 (NF 696530): agrega fotos de TODAS as linhas do código (SSW
 * pode ter múltiplos lançamentos da mesma oc com fotos diferentes).
 */
async function coletarFotosDaOc(
  env: SswInternalEnv,
  nf: string,
  codigoOc: number,
  opts?: { ctrcEsperado?: string | null },
): Promise<
  | { status: "ok"; sessao: SswSessao; todasFotos: FotoAgregadaInterna[]; incompleto: boolean }
  | { status: "oc_nao_encontrada"; codigo_buscado: number; ocs_disponiveis: Array<{ codigo: number | null; descricao: string; tem_foto: boolean }> }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
> {
  const sessao = await obterSessao(env);
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: opts?.ctrcEsperado ?? null });
  const ocs = await listarOcorrenciasNF(sessao, detalhe);
  const ocsDoCodigo = ocs.filter((o) => o.codigo === codigoOc);
  if (ocsDoCodigo.length === 0) {
    return {
      status: "oc_nao_encontrada",
      codigo_buscado: codigoOc,
      ocs_disponiveis: ocs.map((o) => ({
        codigo: o.codigo,
        descricao: o.descricao,
        tem_foto: o.fotos.length > 0,
      })),
    };
  }
  const todasFotos: FotoAgregadaInterna[] = [];
  // true quando algum probe de paginação tracking_ent falhou (mantivemos só a 1ª
  // daquela linha) — sinaliza pro front que a contagem pode estar subestimada.
  let probeIncompleto = false;
  for (let linhaIdx = 0; linhaIdx < ocsDoCodigo.length; linhaIdx++) {
    const oc = ocsDoCodigo[linhaIdx]!;
    const ocRec = oc as unknown as { data?: string; instrucao?: string };
    for (const f of oc.fotos) {
      if (f.tipo === "tracking_ent") {
        // Caio 2026-06-05 (NF 357645 LARISSA): viewer SSW pode ter paginação
        // 01/02/03 pra uma única linha tracking_ent. O XML cru só expõe a 1ª
        // via `foto=PATH`. Detectamos as outras chamando o viewer 1x e
        // contando `ajaxEnvia('FOT_N')`. Expandimos em N entries (paginaN
        // = 1..N). Falha graciosamente: se o probe falhar, mantém só a 1ª.
        let totalPaginas = 1;
        try {
          totalPaginas = await contarPaginasFotoTrackingEnt(sessao, f);
        } catch {
          totalPaginas = 1;
          probeIncompleto = true;
        }
        for (let n = 1; n <= totalPaginas; n++) {
          todasFotos.push({
            foto: { ...f, paginaN: n },
            linhaIdx,
            descricao: oc.descricao,
            data: ocRec.data ?? null,
            instrucao: ocRec.instrucao ?? null,
          });
        }
      } else {
        todasFotos.push({
          foto: f,
          linhaIdx,
          descricao: oc.descricao,
          data: ocRec.data ?? null,
          instrucao: ocRec.instrucao ?? null,
        });
      }
    }
  }
  if (todasFotos.length === 0) {
    return { status: "oc_sem_foto", codigo_buscado: codigoOc, descricao: ocsDoCodigo[0]!.descricao };
  }
  return { status: "ok", sessao, todasFotos, incompleto: probeIncompleto };
}

/**
 * Caio 2026-06-30 / 2026-07-06 (NF 362406 / INV-012b): MANIFESTO de fotos da oc.
 * Lista a metadata de TODAS as fotos (idx + data + instrução) numa só chamada,
 * SEM baixar binário. É a fonte que o `foto-oc-card` (modo `list`) devolve pro
 * front — que renderiza `manifesto.fotos.map(f => <img idx=f.idx>)`, declarativo,
 * sem "lembrar de iterar idx" (raiz da 3ª recorrência do bug "só 1 foto").
 *
 * Reusa `coletarFotosDaOc` (já agrega TODAS as fotos com a paginação tracking_ent
 * 01/02/03 expandida). `incompleto=true` sinaliza que algum probe de paginação
 * falhou e a contagem pode estar subestimada (front DEVE avisar, nunca mascarar).
 */
export async function listarFotosDaOcMetadata(
  env: SswInternalEnv,
  nf: string,
  codigoOc: number,
  opts?: { ctrcEsperado?: string | null },
): Promise<ListarFotosMetadataResult> {
  try {
    const coleta = await coletarFotosDaOc(env, nf, codigoOc, opts);
    if (coleta.status === "oc_nao_encontrada") {
      return { status: "oc_nao_encontrada", codigo_buscado: codigoOc, ocs_disponiveis: coleta.ocs_disponiveis };
    }
    if (coleta.status === "oc_sem_foto") {
      return { status: "oc_sem_foto", codigo_buscado: codigoOc, descricao: coleta.descricao };
    }
    // INV-012b: mapeia TODAS as fotos agregadas — NUNCA trunca pra [0].
    const fotos: FotoMetaItem[] = coleta.todasFotos.map((f, idx) => ({
      idx,
      oc_descricao: f.descricao,
      foto_data: f.data ?? null,
      foto_instrucao: f.instrucao ?? null,
    }));
    return { status: "ok", fotos, fotos_total: fotos.length, incompleto: coleta.incompleto === true };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (/token|401|403|sessao|sess/i.test(motivo)) limparSessaoCache();
    return { status: "erro_ssw", motivo };
  }
}

export async function obterFotoDaOc(
  env: SswInternalEnv,
  nf: string,
  codigoOc: number,
  opts?: {
    ctrcEsperado?: string | null;
    /**
     * Caio 2026-05-27: SSW pode ter MÚLTIPLAS fotos por oc (até hoje só
     * baixávamos a 1ª). Caller passa idx 0..N-1 pra escolher qual.
     * Default 0 = 1ª foto (compat com comportamento legado).
     *
     * ATENÇÃO (Caio 2026-06-18, NF 355283): se você precisa de TODAS as fotos
     * (IA Vision, anexo de email), NÃO chame isto com idx fixo — use
     * obterTodasFotosDaOc. Esquecer de iterar fotos_total é a raiz do bug
     * recorrente "puxou só uma foto" (NF 357645, NF 355283).
     */
    idx?: number;
  },
): Promise<FotoOcResult> {
  try {
    const coleta = await coletarFotosDaOc(env, nf, codigoOc, opts);
    if (coleta.status !== "ok") return coleta;
    const { sessao, todasFotos } = coleta;
    // Caio 2026-05-27: suporte a múltiplas fotos por oc. Caller passa idx 0..N-1
    // pra escolher qual baixar. Default 0 (compat com comportamento legado).
    const idx = opts?.idx ?? 0;
    if (idx < 0 || idx >= todasFotos.length) {
      return {
        status: "idx_invalido",
        codigo_buscado: codigoOc,
        fotos_total: todasFotos.length,
        idx_pedido: idx,
      };
    }
    const alvo = todasFotos[idx]!;
    const baixada = await baixarFotoOcorrencia(sessao, alvo.foto);
    return {
      status: "ok",
      binary: baixada.binary,
      content_type: baixada.content_type,
      picture_src: baixada.picture_src,
      oc_descricao: alvo.descricao,
      fotos_total: todasFotos.length,
      idx_atual: idx,
      // Caio 2026-05-28 (NF 696530): metadata da linha de origem pra UX —
      // operador vê "26/05 14:37 POA · RECUSA TOTAL DA ENTREGA" no header
      // da foto e diferencia das outras linhas do mesmo código.
      foto_data: alvo.data,
      foto_instrucao: alvo.instrucao,
    };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    // Se foi falha de sessão (401/403/timeout), invalida cache pra próxima
    // chamada re-logar.
    if (/token|401|403|sessao|sess/i.test(motivo)) {
      limparSessaoCache();
    }
    return { status: "erro_ssw", motivo };
  }
}

/**
 * Caio 2026-06-18 (NF 355283 oc=49): baixa TODAS as fotos da oc de uma vez,
 * reutilizando UMA sessão/listagem (coletarFotosDaOc) e baixando o binário de
 * cada foto agregada (já com a paginação tracking_ent 01/02/03 expandida).
 *
 * USE ISTO sempre que precisar do conjunto completo de evidências (IA Vision,
 * anexo de email). Era a raiz do bug reincidente: cada novo caller copiava
 * `obterFotoDaOc(idx:0)` e só puxava a 1ª foto, ignorando fotos_total. A
 * galeria (foto-oc-card/r-evidencia) já iterava por idx; IA e anexo não.
 */
export async function obterTodasFotosDaOc(
  env: SswInternalEnv,
  nf: string,
  codigoOc: number,
  opts?: {
    ctrcEsperado?: string | null;
    /** Limite de segurança pra não estourar custo/payload (default = todas). */
    max?: number;
  },
): Promise<TodasFotosOcResult> {
  try {
    const coleta = await coletarFotosDaOc(env, nf, codigoOc, opts);
    if (coleta.status !== "ok") return coleta;
    const { sessao, todasFotos } = coleta;
    const limite = Math.min(todasFotos.length, opts?.max ?? todasFotos.length);
    const fotos: FotoBaixadaDaOc[] = [];
    for (let i = 0; i < limite; i++) {
      const alvo = todasFotos[i]!;
      const baixada = await baixarFotoOcorrencia(sessao, alvo.foto);
      fotos.push({
        binary: baixada.binary,
        content_type: baixada.content_type,
        picture_src: baixada.picture_src,
        oc_descricao: alvo.descricao,
        idx: i,
        foto_data: alvo.data,
        foto_instrucao: alvo.instrucao,
      });
    }
    return { status: "ok", fotos, fotos_total: todasFotos.length };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (/token|401|403|sessao|sess/i.test(motivo)) {
      limparSessaoCache();
    }
    return { status: "erro_ssw", motivo };
  }
}

/**
 * Opção 383 (Cadastro de Clientes - Rastreamento). Busca o registro pelo
 * CNPJ do cliente e retorna a senha do "Site de rastreamento".
 *
 * Fluxo HTTP:
 *   1. GET  /bin/ssw0838 — warm-up (cookies, csrf vazio)
 *   2. POST /bin/ssw0838 act=ENV f2=<cnpj> — submit do form (botão "►" =
 *      onclick=ajaxEnvia('ENV', 1))
 *   3. Parse: extrai `<input name="f1" id="1" value="...">` da tela detalhe.
 *      Nome do cliente vem do segundo `<div class=data ...>...</div>` após
 *      "Cliente:".
 */
export interface SenhaTrackingResult {
  cnpj: string;
  nome_amigavel: string | null;
  senha: string | null;
  senha_obrigatoria: boolean | null;
}

export async function obterSenhaTrackingPorCnpj(
  env: SswInternalEnv,
  cnpjRaw: string,
): Promise<SenhaTrackingResult> {
  const cnpj = String(cnpjRaw).replace(/\D/g, "");
  if (cnpj.length !== 14) {
    throw new Error(`CNPJ inválido pra opção 383: "${cnpjRaw}" (esperado 14 dígitos)`);
  }

  const sessao = await obterSessao(env);

  // 1. GET warm-up
  await fetchTimeout(`${BASE}/bin/ssw0838`, {
    headers: { "User-Agent": UA, cookie: cookieHeader(sessao.cookies) },
    redirect: "manual",
  });

  // 2. POST com act=ENV (ajaxEnvia do botão "►" do form)
  const body = new URLSearchParams({ act: "ENV", f2: cnpj });
  const res = await fetchTimeout(`${BASE}/bin/ssw0838`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0838`,
      cookie: cookieHeader(sessao.cookies),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, res.headers);
  const html = await res.text();

  // Detecta "não encontrado": tela vem curta (~3KB) sem "Site de rastreamento".
  if (!/Site&nbsp;de&nbsp;rastreamento|Site de rastreamento/.test(html)) {
    return { cnpj, nome_amigavel: null, senha: null, senha_obrigatoria: null };
  }

  // Nome amigável: terceiro <div class=data>...</div> tem o nome
  // (1º é cnpj, 2º é nome, 3º é a data de última alteração).
  const dataDivs = [...html.matchAll(/<div class=data[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((m) => decodeEntities(m[1] ?? "").trim());
  const nomeAmigavel = dataDivs.find((d) => /[A-Za-z]/.test(d) && !/\d{6,}/.test(d)) ?? null;

  // Senha: <input name="f1" id="1" value="..." maxlength=8 ...>
  const senhaMatch = html.match(/<input[^>]*name="?f1"?[^>]*value="([^"]*)"/i);
  const senha = senhaMatch?.[1]?.trim() || null;

  // Senha obrigatória: <input name="f2" id="2" value="S" ...> ou "N"
  const obrigMatch = html.match(/<input[^>]*name="?f2"?[^>]*value="([SN])"/i);
  const senhaObrigatoria = obrigMatch ? obrigMatch[1] === "S" : null;

  return {
    cnpj,
    nome_amigavel: nomeAmigavel,
    senha,
    senha_obrigatoria: senhaObrigatoria,
  };
}

/**
 * Lança uma ocorrência no SSW pela tela 101 (portal interno) — caminho que
 * Larissa faz manualmente. Útil quando o caso requer N imagens em UMA
 * ocorrência (caso ressarcimento oc=33+44 — Caio 2026-05-12 NF 920161). A
 * WebAPI WebApi/ocorrenciaParceiro só aceita 1 imagem; o portal aceita N.
 *
 * Fluxo:
 *   1. POST /bin/ssw0053 act=O (abre tela de inclusão) → captura hidden
 *      fields (nomeFoto, extraFoto, tipoFoto).
 *   2. Pra cada imagem: POST multipart /bin/ssw1017 com file + tipoFoto +
 *      nomeFoto + extraFoto + sigla. Recebe resposta — vazia = OK.
 *      Acumula paths.
 *   3. POST /bin/ssw0053 act=II3 (botão azul "Incluir Ocorrência") com
 *      f3=codigo, f4=data, f5=hora, f6=texto, seq_ctrc, FAMILIA, seq_instr=0,
 *      tipoFoto=instr_foto, nomeFotoUsed=<paths>.
 *   4. Parse HTML response — confirma que a nova oc apareceu na lista.
 *
 * Mapeamento via scripts SSW (Caio 2026-05-12):
 *   - /scripts/upload_200825.js (upload multipart)
 *   - /scripts/ssw0122_270922.js (submit ajaxEnvia('II3'))
 */
export interface AnexoBytes {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface LancarOcorrenciaPortalOpts {
  codigoSsw: number;
  texto?: string;
  imagens?: AnexoBytes[];
  /**
   * Caio 2026-06-08: callback que roda ANTES do submit, com o HTML completo
   * do `act=O` em mãos. Usado pelo envelope `lancarSswPortal` pra validar o
   * tripé (CTRC, NF, Localização atual) via `validarTripeCtrcNfPagador`.
   * Se retornar `ok:false`, o submit é abortado com o motivo informado.
   */
  validarAntesDoSubmit?: (htmlAtoO: string) => Promise<
    { ok: true } | { ok: false; motivo: string; detalhe: string }
  >;
}

export type LancarOcorrenciaPortalResult =
  | { ok: true; seq_oc: string; descricao: string; raw_response_snippet: string }
  | {
      ok: false;
      error: string;
      raw_response_snippet?: string;
      /** Preenchido quando bloqueio veio do guard `validarAntesDoSubmit` */
      bloqueado_por_guard?: { motivo: string; detalhe: string };
    };

export async function lancarOcorrenciaPortal(
  sessao: SswSessao,
  detalhe: SswNFDetalhe,
  opts: LancarOcorrenciaPortalOpts,
): Promise<LancarOcorrenciaPortalResult> {
  const codigo = String(opts.codigoSsw).padStart(2, "0"); // ex: 49 ou 03
  // Caio 2026-06-08: portal SSW tem 2 campos de texto na tela 101:
  //   - f6 (`Informações complementares`, maxlength=70) — campo curto, era o
  //     que essa função preenchia. ❌ Errado pra texto longo.
  //   - observ (`Instrução`, textarea, maxlength=500) — onde o operador escreve
  //     o texto livre real. ✅ Confirmado via diag-form-ocorrencia 2026-06-08.
  // Fix: texto principal vai pra `observ`, `f6` deixado vazio (espaço pra
  // info adicional curta quando precisar — por hora N/A).
  // Caio 2026-06-10 (NF 2161614, 156022, 2282024 e várias outras): bug crítico
  // descoberto via diag — TODAS as ocs lançadas via portal desde a migração
  // 2026-06-08 chegaram no SSW com `observ` VAZIO (só o título auto da oc:
  // "RETORNO DE CARGA", "AGUARDANDO RETORNO DO CLIENTE PAGADOR"). Causa:
  // SSW serve `charset=iso-8859-1` (latin-1), mas estávamos submetendo o body
  // como URLSearchParams (UTF-8). Bytes UTF-8 multi-byte de "—" (emdash), "ç",
  // "ã", etc., interpretados como latin-1 viram lixo — provavelmente o SSW
  // rejeita o campo inteiro silenciosamente quando detecta bytes inválidos.
  //
  // Fix: sanitização preventiva (emdash → hífen, curly quotes → ASCII) +
  // encoding latin-1 explícito no body (`urlEncodeLatin1`). Acentos PT-BR
  // (ç, ã, ê, etc.) existem em latin-1 e passam direto. Caracteres fora do
  // range (U+0100+) viram '?'.
  // Caio 2026-06-12 (NF 345834, validado por Caio via print): o texto livre
  // do Cockpit vai pro campo f6 (Informacoes complementares), que aparece na
  // coluna "Instrucao/Complemento" do historico SSW que o SETOR que recebe a
  // oc LE. O fix de 06-08 (texto p/ observ) escondia o texto do setor (so
  // mostrava o titulo auto da oc). f6 maxlength=70; overflow (>70) vai pra
  // observ como backup completo.
  const textoLimpoSsw = sanitizarParaLatin1(opts.texto ?? "");
  const textoF6 = textoLimpoSsw.slice(0, 70);
  const textoObserv = textoLimpoSsw.length > 70 ? textoLimpoSsw.slice(0, 500) : "";
  const imagens = opts.imagens ?? [];

  // 1. Abre tela de Ocorrências (act=O) — captura nomeFoto/extraFoto/tipoFoto
  const formO = new URLSearchParams({
    act: "O",
    seq_ctrc: detalhe.seq_ctrc,
    FAMILIA: detalhe.familia,
    t_nro_nf: detalhe.nf,
  });
  const resO = await fetchTimeout(`${BASE}/bin/ssw0053`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: formO,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, resO.headers);
  const htmlO = await resO.text();

  // Hidden fields críticos pro upload + submit
  const nomeFotoInicial =
    htmlO.match(/name=nomeFoto[^>]*value="([^"]*)"/)?.[1] ?? "";
  const extraFoto = htmlO.match(/name=extraFoto[^>]*value="([^"]*)"/)?.[1] ?? "";
  const tipoFoto = htmlO.match(/name=tipoFoto[^>]*value="([^"]*)"/)?.[1] ?? "instr_foto";

  if (!extraFoto) {
    return {
      ok: false,
      error: `SSW tela ocorrências sem extraFoto — possivelmente sessão expirou ou NF inválida.`,
      raw_response_snippet: htmlO.slice(0, 500),
    };
  }

  // Caio 2026-06-08: guard inviolável (tripé CTRC/NF/Localização) ANTES de
  // qualquer upload/submit. Caller (envelope `lancarSswPortal`) passa o
  // validator que confere o HTML do `act=O`. Se falhar: abort sem tocar SSW.
  // Detalhes: docs/INVARIANTES_COCKPIT.md e `_shared/validar-tripe-ssw.ts`.
  if (opts.validarAntesDoSubmit) {
    const guardResult = await opts.validarAntesDoSubmit(htmlO);
    if (!guardResult.ok) {
      return {
        ok: false,
        error: `Guard tripé rejeitou lançamento: ${guardResult.motivo} — ${guardResult.detalhe}`,
        raw_response_snippet: htmlO.slice(0, 500),
        bloqueado_por_guard: {
          motivo: guardResult.motivo,
          detalhe: guardResult.detalhe,
        },
      };
    }
  }

  // sigla = cookie ssw_dom (ex: SEP)
  const sigla = sessao.cookies.get("ssw_dom") ?? "SEP";

  // 2. Upload de N imagens (1 POST multipart com file, file_1, file_2, ...)
  let nomeFotoUsed = "";
  let uploadDebug: Record<string, unknown> = {};
  if (imagens.length > 0) {
    const fd = new FormData();
    for (let i = 0; i < imagens.length; i++) {
      const a = imagens[i]!;
      const fieldName = i === 0 ? "file" : `file_${i}`;
      const blob = new Blob([a.bytes as BlobPart], { type: a.mimeType });
      fd.append(fieldName, blob, a.filename);
    }
    fd.append("tipoFoto", tipoFoto);
    fd.append("nomeFoto", decodeURIComponent(nomeFotoInicial));
    fd.append("extraFoto", decodeURIComponent(extraFoto));
    fd.append("sigla", sigla);
    fd.append("dummy", String(Date.now()));

    const resU = await fetchTimeout(`${BASE}/bin/ssw1017`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Referer: `${BASE}/bin/ssw0053`,
        cookie: cookieHeader(sessao.cookies),
      },
      body: fd,
      redirect: "manual",
      timeoutMs: 60_000,
    });
    applySetCookie(sessao.cookies, resU.headers);
    const responseUpload = (await resU.text()).trim();

    uploadDebug = {
      upload_status: resU.status,
      upload_response: responseUpload.slice(0, 400),
      upload_response_len: responseUpload.length,
      nomeFotoInicial_decoded: decodeURIComponent(nomeFotoInicial),
    };

    if (responseUpload.length > 0 && !/^\s*<\s*$/.test(responseUpload)) {
      return {
        ok: false,
        error: `Upload SSW retornou erro: ${responseUpload.slice(0, 500)}`,
        raw_response_snippet: JSON.stringify(uploadDebug),
      };
    }

    // SSW retornou response vazio. No fluxo do browser, o JS NÃO refazz GET
    // — usa o valor do hidden `nomeFoto` que JÁ estava na tela (template
    // path pré-alocado pelo servidor). Replicar exatamente: usa o mesmo path
    // inicial como nomeFotoUsed.
    nomeFotoUsed = decodeURIComponent(nomeFotoInicial);
    uploadDebug["nomeFotoUsed"] = nomeFotoUsed;
  }

  // 3. Submit Incluir Ocorrência (act=II3)
  // Caio 2026-05-12: SSW valida "hora não pode ser futura" comparando com
  // hora local da unidade (Brasília UTC-3). Edge functions rodam em UTC —
  // subtrai 3h. Subtrai mais 2min de safety pra cobrir clock drift.
  const agoraBR = new Date(Date.now() - 3 * 60 * 60 * 1000 - 2 * 60 * 1000);
  const dataFmt = dateYYMMDD(agoraBR);
  const horaFmt =
    String(agoraBR.getUTCHours()).padStart(2, "0") +
    String(agoraBR.getUTCMinutes()).padStart(2, "0");

  const formII3 = new URLSearchParams({
    act: "II3",
    seq_ctrc: detalhe.seq_ctrc,
    FAMILIA: detalhe.familia,
    t_nro_nf: detalhe.nf,
    seq_instr: "0",
    f3: codigo,
    f4: dataFmt,
    f5: horaFmt,
    f6: textoF6,              // Informações complementares — deixado vazio.
    observ: textoObserv, // Instrução (textarea, maxlength=500) — texto livre.
    f8: "N",
    f11: "N",
    tipoFoto,
    nomeFoto: nomeFotoUsed,
    nomeFotoUsed,
    extraFoto,
    detalhe_oco: "",
    detalhe_ins: "",
  });

  // Caio 2026-05-12: submit vai pra /bin/ssw0122 (não ssw0053). O JS faz
  // `ajaxEnvia('II3', 0, '', 'ssw0122')` — 4º param é o programa SSW.
  // Caio 2026-06-10: body codificado em latin-1 (urlEncodeLatin1) com
  // charset=iso-8859-1 declarado — SSW descarta `observ` silenciosamente
  // quando recebe bytes UTF-8 multi-byte. Acentos PT-BR ainda passam direto
  // (existem em latin-1). Sanitização preventiva já fez emdash/quotes/etc.
  const resII3 = await fetchTimeout(`${BASE}/bin/ssw0122`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1",
      Referer: `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: urlEncodeLatin1(formII3),
    redirect: "manual",
    timeoutMs: 30_000,
  });
  applySetCookie(sessao.cookies, resII3.headers);
  const htmlII3 = await resII3.text();

  // Caio 2026-05-12 (teste NF 59938 oc=49): response do SSW pós-submit é
  // texto mínimo com hidden fields + `<!--GoBack-->`. Sucesso é detectado
  // pela AUSÊNCIA de mensagem de erro visível (showmsg ou texto fora de tags).
  //
  // Erros conhecidos (texto livre fora de hidden inputs):
  //   - "Data/hora informada não pode ser futura."
  //   - "Ocorrência não cadastrada"
  //   - "Sua opção não está autorizada"
  //   - "Ocorrência inválida" (HTML-encoded: "Ocorr&ecirc;ncia inv&aacute;lida")
  //
  // Caio 2026-05-26 (NF 424475 oc=33): bug crítico — portal SSW devolve
  // mensagens com entities HTML (&aacute;=á, &eacute;=é, etc) mas o regex
  // procurava caracteres unicode. "inv&aacute;lid" NÃO casava com /inv[aá]lid/
  // → erroDetectado=false → ok:true falso positivo → card foi pra ACAO_EXECUTADA
  // e anexos foram deletados, mas oc nunca chegou ao SSW.
  // Fix: decodificar entities ANTES da regex.
  const decodeHtmlEntities = (s: string): string =>
    s
      .replace(/&aacute;/gi, "á")
      .replace(/&eacute;/gi, "é")
      .replace(/&iacute;/gi, "í")
      .replace(/&oacute;/gi, "ó")
      .replace(/&uacute;/gi, "ú")
      .replace(/&atilde;/gi, "ã")
      .replace(/&otilde;/gi, "õ")
      .replace(/&acirc;/gi, "â")
      .replace(/&ecirc;/gi, "ê")
      .replace(/&ocirc;/gi, "ô")
      .replace(/&ccedil;/gi, "ç")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

  // Heurística: remove hidden fields + scripts, decodifica entities, e checa
  // se sobra texto com palavras-chave de erro.
  const limpo = decodeHtmlEntities(
    htmlII3
      .replace(/<input[^>]*type=["']?hidden["']?[^>]*>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  const erroDetectado = /futura|n[aã]o cadastrad|n[aã]o (est[aá] )?autorizad|inv[aá]lid|incorret|obrigat[oó]ri/i.test(limpo);
  if (erroDetectado) {
    return {
      ok: false,
      error: `SSW erro: ${limpo.slice(0, 400)}`,
      raw_response_snippet: htmlII3.slice(0, 600),
    };
  }

  // Sem erro detectado — assume sucesso. Caller pode validar via
  // listarOcorrenciasNF se quiser certeza.
  return {
    ok: true,
    seq_oc: "(confirmar via listarOcorrenciasNF)",
    descricao: `oc=${codigo} lançada sem erro detectado no response SSW`,
    raw_response_snippet: JSON.stringify({
      submit_response: htmlII3.slice(0, 300),
      upload_debug: uploadDebug,
      nomeFotoUsed,
      extraFoto,
      tipoFoto,
    }),
  };
}

// =============================================================================
// listarCTRCsDaNF — busca todos os CT-es vinculados a uma NF.
// Diferente do buscarNFInterno (que THROWS quando há múltiplos CTRCs e exige
// ctrcEsperado), aqui retornamos a lista crua pra o caller decidir qual usar.
// Use quando precisar identificar CT-e de REENTREGA/COMPLEMENTAR pelo padrão
// "coluna Colet vazia" (campo f2 = tipo, vazio significa complementar/reentrega).
//
// Caio 2026-05-18: usado pelo handler `cancelar_reentrega_ssw` em
// processar-acoes-agendadas pra achar o CTRC novo de reentrega 24h após oc=21.
// =============================================================================
export interface CtrcRow {
  /** CTRC normalizado, ex: "OVD395536-2" */
  ctrc: string;
  /** Tipo Colet: "NORMAL" (original), "REVERSA" (devolução), "" (vazio = COMPLEMENTAR/REENTREGA) */
  tipo: string;
  /** Nome do pagador como aparece na lista (ex: "O.V.D. IMPORTADORA E DIST (A.)") */
  pagador: string;
  /** Data emissão (string crua do XML, formato dd/mm/yy) */
  data_emissao: string;
  /** true se f12 indicar cancelado (última coluna "Ca" na tela) */
  cancelado: boolean;
  /** Sequencial interno do CTRC (extraído de f13). Usado pra abrir detalhe. */
  seq_ctrc: string;
  /** Família/domínio (extraído de f13). */
  familia: string;
  /** Chave CT-e (44 dígitos) — f11. Pode ser vazio quando ainda não autorizado. */
  chave_cte: string;
  /** Remetente (nome) — f4. Caio 2026-06-17: usado p/ desambiguar CTRC por NF. */
  remetente: string;
  /** Destinatário (nome) — f7. Caio 2026-06-17: usado p/ desambiguar CTRC por NF. */
  destinatario: string;
}

export async function listarCTRCsDaNF(
  sessao: SswSessao,
  nf: string,
): Promise<CtrcRow[]> {
  // Mesmo warm-up + POST que buscarNFInterno, mas sem filter por CTRC.
  await fetchTimeout(`${BASE}/bin/ssw0053`, {
    headers: { "User-Agent": UA, cookie: cookieHeader(sessao.cookies) },
    redirect: "manual",
  });

  const body = new URLSearchParams({
    act: "P2",
    t_nro_nf: nf,
    // Datas em BRT (SSW usa fuso de Brasília). Sem o -3h, das 21h à meia-noite
    // BRT a data_fin vira amanhã no SSW → "Data final maior que data corrente".
    t_data_ini: dateYYMMDD(dataBRT(Date.now() - 365 * 24 * 60 * 60 * 1000)),
    t_data_fin: dateYYMMDD(dataBRT()),
  });
  const res = await fetchTimeout(`${BASE}/bin/ssw0053`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, res.headers);
  const html = await res.text();

  // CASO A: tela de detalhe direto (1 CTRC só) — extrai dele um único CtrcRow
  const seqCtrcDireto = html.match(/name=seq_ctrc[^>]*value="(\d+)"/)?.[1];
  const familiaDireto = html.match(/name=FAMILIA[^>]*value="([^"]*)"/)?.[1];
  if (seqCtrcDireto && seqCtrcDireto !== "0" && familiaDireto) {
    const ctrcMatch = html.match(/([A-Z]{3}\d{6}-\d)/);
    if (!ctrcMatch) return [];
    return [{
      ctrc: ctrcMatch[1]!.toUpperCase(),
      // Sem XML não temos tipo/pagador estruturados — caller cai no fallback
      // (busca o detalhe via buscarNFInterno pra cada um) ou pula esse caminho.
      tipo: "",
      pagador: "",
      remetente: "",
      destinatario: "",
      data_emissao: "",
      cancelado: false,
      seq_ctrc: seqCtrcDireto,
      familia: familiaDireto,
      chave_cte: "",
    }];
  }

  // CASO B: tela de lista (múltiplos CTRCs) — parseia XML embutido.
  const xmlMatch = html.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i);
  if (!xmlMatch) return [];

  const rows = [...(xmlMatch[1] ?? "").matchAll(/<r>([\s\S]*?)<\/r>/gi)];
  return rows.map((r) => {
    const inner = r[1] ?? "";
    const get = (n: number) =>
      inner.match(new RegExp(`<f${n}>([\\s\\S]*?)<\\/f${n}>`, "i"))?.[1] ?? "";
    const f13 = decodeEntities(get(13)).trim();
    const partes = f13.split("@");
    const familia = partes[1] ?? "";
    const seq_ctrc = partes[2] ?? "";
    return {
      ctrc: decodeEntities(get(1)).toUpperCase().trim(),
      tipo: decodeEntities(get(2)).trim(),
      data_emissao: decodeEntities(get(3)).trim(),
      remetente: decodeEntities(get(4)).trim(), // f4
      pagador: decodeEntities(get(6)).trim(),
      destinatario: decodeEntities(get(7)).trim(), // f7
      chave_cte: decodeEntities(get(11)).trim(),
      cancelado: decodeEntities(get(12)).trim().length > 0,
      seq_ctrc,
      familia,
    };
  });
}

// =============================================================================
// cancelarReentregaPortal — Opção 450 do SSW (ssw0069). Cancela um CTRC
// de reentrega complementar dado seu prefixo (letras) + número/dígito.
// Fluxo manual capturado com Caio 2026-05-18 (prints):
//   1. Trocar unidade pra MTZ (já refletido na URL via cookie/sessão).
//   2. GET /bin/ssw0069 → tela com 3 blocos: Cancelar / Cancelar Unitização /
//      Relação cancelados. Usar o 1º.
//   3. POST com ctrc_letras + ctrc_numero → tela de confirmação com dados +
//      campo "Descrição do motivo".
//   4. POST com motivo + submit → cancelamento gravado.
//
// NOTA Caio 2026-05-18: helper construído sem HTML real do submit final.
// Endpoint/params são best-effort baseados no padrão SSW (act=C, f1/f2 pro CTRC).
// Primeiro teste vai precisar de log do raw_response pra ajustar nomes de campos.
// =============================================================================
export interface CancelarReentregaOpts {
  /** Prefixo de letras do CTRC, ex: "OVD" */
  ctrcLetras: string;
  /** Número e dígito do CTRC, ex: "395536-2" */
  ctrcNumero: string;
  /** Texto da "Descrição do motivo". Ex: "PARA FINS DE ROMANEIO" */
  motivo: string;
  /** Unidade obrigatória pra acessar a opção 450. Default "MTZ" (Caio 2026-05-18). */
  unidade?: string;
}

export type CancelarReentregaSubcategoria =
  | "ctrc_faturado"
  | "ctrc_inexistente"
  | "ctrc_ja_cancelado"
  | "sem_permissao"
  | "fora_prazo"
  | "tela_inesperada"
  | "outro";

export type CancelarReentregaResult =
  | {
    ok: true;
    raw_response_snippet: string;
    debug: Record<string, unknown>;
  }
  | {
    ok: false;
    error: string;
    /** Categoria padronizada da falha pro handler decidir status+sugestão. */
    subcategoria: CancelarReentregaSubcategoria;
    /** true = falha definitiva, NÃO retry. false = falha temporária, reagenda. */
    definitivo: boolean;
    raw_response_snippet?: string;
    debug?: Record<string, unknown>;
  };

export async function cancelarReentregaPortal(
  sessao: SswSessao,
  opts: CancelarReentregaOpts,
): Promise<CancelarReentregaResult> {
  const unidade = (opts.unidade ?? "MTZ").toUpperCase();
  const letras = opts.ctrcLetras.toUpperCase().trim();
  // Caio 2026-05-18 (descoberto via debug): SSW input f2 tem maxlength=7 e
  // REJEITA hífen. Formato esperado: 7 dígitos puros (6 do número + 1 do DV).
  // Se vier "395536-2" ou "395536-2 ", normaliza pra "3955362".
  const numero = opts.ctrcNumero.replace(/[^\d]/g, "").trim();
  const motivo = opts.motivo.trim().slice(0, 200);

  if (!/^[A-Z]{3}$/.test(letras)) {
    return { ok: false, error: `ctrcLetras inválido: "${letras}" (esperado 3 letras maiúsculas)`, subcategoria: "outro", definitivo: true };
  }
  if (!/^\d{7}$/.test(numero)) {
    return { ok: false, error: `ctrcNumero inválido após normalização: "${numero}" (esperado 7 dígitos, ex: "3955362")`, subcategoria: "outro", definitivo: true };
  }
  if (!motivo) {
    return { ok: false, error: `motivo vazio — SSW exige descrição`, subcategoria: "outro", definitivo: true };
  }

  // 1. Trocar unidade do operador pra MTZ (necessário pra opção 450).
  // Caio 2026-05-18: descoberto via debug que o operador (ex: Duilio) loga
  // na sua filial default (VGA, etc) e a 450 precisa contexto da MTZ. O
  // endpoint /bin/menu01?act=TRO&f2=<unidade>&f3=<opcao> faz isso (TRO=Trocar).
  // f3=450 abre a opção 450 já no contexto da unidade nova.
  await fetchTimeout(
    `${BASE}/bin/menu01?act=TRO&f2=${encodeURIComponent(unidade)}&f3=450`,
    {
      headers: {
        "User-Agent": UA,
        cookie: cookieHeader(sessao.cookies),
        Referer: `${BASE}/bin/menu01`,
        "X-Requested-With": "XMLHttpRequest",
      },
      redirect: "manual",
    },
  );

  // 2. GET tela inicial (já em MTZ) — captura hidden fields
  const resGet = await fetchTimeout(`${BASE}/bin/ssw0069`, {
    headers: {
      "User-Agent": UA,
      cookie: cookieHeader(sessao.cookies),
      Referer: `${BASE}/bin/menu01`,
    },
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, resGet.headers);
  const htmlInicial = await resGet.text();

  // Confirma que troca de unidade pegou (cabeçalho "Domínio: SEP MTZ duilio.d")
  const unidadeAtual = htmlInicial.match(/(?:SEP|MTZ|VGA|[A-Z]{3})\s*(?:&nbsp;|\s)+([A-Z]{3})\s*(?:&nbsp;|\s)*\w+\.d/)?.[1];
  const trocouUnidade = unidadeAtual === unidade;
  const precisaTrocarUnidade = !trocouUnidade;

  // 2. POST com CTRC. Form names confirmados via HTML real capturado
  // 2026-05-18 (debug-ssw0069):
  //   - <form action="/bin/ssw0069" method="POST">
  //   - <input name="f1" maxlength=3> (letras prefixo CTRC)
  //   - <input name="f2" maxlength=7> (número+dígito, separador é parte dos 7)
  //   - <A onclick="ajaxEnvia('ENV', 0)"> ← act='ENV', não 'C'
  // Note: o input f2 tem maxlength=7 — formato "395536-2" tem 8 chars. SSW
  // provavelmente aceita o hífen mesmo com maxlength=7 OU espera só os 7
  // dígitos. Testar com hífen primeiro; se falhar, retirar.
  const bodyCancelar = new URLSearchParams({
    act: "ENV",                // 'ENV' = botão setinha azul do bloco "Cancelar"
    f1: letras,                // prefixo letras (ex: "OVD")
    f2: numero,                // número+dígito (ex: "395536-2")
  });
  const resPost = await fetchTimeout(`${BASE}/bin/ssw0069`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0069`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: bodyCancelar,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, resPost.headers);
  const htmlConfirma = await resPost.text();

  // Caio 2026-05-18: respostas curtas do SSW em texto puro indicam erro
  // imediato (sem precisar parsear HTML). Descobertos via debug:
  //   - "CTRC FATURADO - FATURA: <num>" → CTRC já entrou em fatura, não cancelável (DEFINITIVO)
  //   - "Conhecimento não cadastrado" → CTRC inexistente nessa unidade (DEFINITIVO)
  //   - Resposta longa com campos "Série/Número", "Descrição do motivo" → tela de confirmação OK
  const htmlLimpo = htmlConfirma.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

  const errosConhecidos: Array<{ re: RegExp; label: string; subcategoria: CancelarReentregaSubcategoria; definitivo: boolean }> = [
    { re: /CTRC\s*FATURADO/i,                        label: "CTRC já foi faturado — não pode mais ser cancelado",   subcategoria: "ctrc_faturado",    definitivo: true  },
    // ctrc_inexistente é tratado como NÃO definitivo: pode ser que SSW ainda não emitiu o CT-e de reentrega; handler reagenda até N tentativas.
    { re: /Conhecimento\s+n[aã]o\s+cadastrad/i,      label: "CTRC não cadastrado no SSW (CT-e de reentrega ainda não emitido OU CTRC errado)", subcategoria: "ctrc_inexistente", definitivo: false },
    { re: /j[aá]\s*(foi\s+)?cancelad/i,              label: "CTRC já cancelado anteriormente",                       subcategoria: "ctrc_ja_cancelado", definitivo: true  },
    { re: /n[aã]o\s+permitid|sem\s+permiss/i,        label: "Sem permissão pra cancelar este CTRC",                  subcategoria: "sem_permissao",    definitivo: true  },
    { re: /fora\s+(do\s+)?prazo/i,                   label: "Fora do prazo de cancelamento",                         subcategoria: "fora_prazo",       definitivo: true  },
  ];
  for (const e of errosConhecidos) {
    if (e.re.test(htmlLimpo)) {
      return {
        ok: false,
        error: `SSW recusou cancelamento: ${e.label}`,
        subcategoria: e.subcategoria,
        definitivo: e.definitivo,
        raw_response_snippet: htmlConfirma.slice(0, 3000),
        debug: {
          fase: "confirmacao",
          precisa_trocar_unidade: precisaTrocarUnidade,
        },
      };
    }
  }

  // Tela de confirmação esperada (vide print 6 do Caio): tem "Série/Número do
  // CTRC", "Remetente", "Pagador", "Descrição do motivo". Se a resposta NÃO
  // tem esses campos, algo inesperado.
  const temCamposConfirmacao = /(s[eé]rie\s*\/\s*n[uú]mero|Descri[cç][aã]o.*motivo|Pagador)/i.test(htmlConfirma);
  if (!temCamposConfirmacao) {
    return {
      ok: false,
      error: "SSW não retornou tela de confirmação esperada — verificar raw_response pra mapear caso novo",
      subcategoria: "tela_inesperada",
      definitivo: false,
      raw_response_snippet: htmlConfirma.slice(0, 3000),
      debug: {
        fase: "confirmacao",
        precisa_trocar_unidade: precisaTrocarUnidade,
        tamanho_resposta: htmlConfirma.length,
        html_limpo_snippet: htmlLimpo.slice(0, 500),
      },
    };
  }

  // 3. Captura hidden fields da tela de confirmação pro submit final.
  // Descoberta Caio 2026-05-18 (debug HTML real da tela 0069 pós-POST CTRC):
  //   - Hidden `seq_ctrc` (sequencial interno do CT-e) — OBRIGATÓRIO no submit final
  //   - Input visível name="f2" maxlength=65 = campo "Descrição do motivo"
  //   - Botão submit (setinha azul) onclick="ajaxEnvia('CAN', 0)" → act='CAN'
  const hiddens: Record<string, string> = {};
  for (const m of htmlConfirma.matchAll(
    /<input[^>]*type=["']?hidden["']?[^>]*name=["']?(\w+)["']?[^>]*value=["']?([^"'>]*)["']?/gi,
  )) {
    if (m[1]) hiddens[m[1]] = m[2] ?? "";
  }

  // 4. POST final: act='CAN' + f2=<motivo> + seq_ctrc dos hiddens
  const motivoLimitado = motivo.slice(0, 65); // SSW: maxlength=65
  const bodyFinal = new URLSearchParams({
    ...hiddens,        // inclui seq_ctrc
    act: "CAN",        // botão azul "Cancelar" (confirmado via HTML)
    f2: motivoLimitado,
  });
  const resFinal = await fetchTimeout(`${BASE}/bin/ssw0069`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/bin/ssw0069`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: bodyFinal,
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, resFinal.headers);
  const htmlFinal = await resFinal.text();

  // Detecta sucesso na resposta final. Padrões prováveis pós-cancelamento OK:
  //   - Resposta curta (tipo "<foc vl=...>" ajax-style) → sucesso silencioso
  //   - Volta pra tela inicial ssw0069 (com bloco "Cancelar:") → sucesso
  //   - Mensagem explícita "Cancelamento efetuado" / "Gravado"
  // Falhas reais retornam texto curto similar ao "CTRC FATURADO".
  const htmlFinalLimpo = htmlFinal.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  const errosPosCancel: Array<{ re: RegExp; label: string; subcategoria: CancelarReentregaSubcategoria; definitivo: boolean }> = [
    { re: /CTRC\s*FATURADO/i,                   label: "CTRC já foi faturado — não pode ser cancelado",     subcategoria: "ctrc_faturado",     definitivo: true  },
    { re: /j[aá]\s*(foi\s+)?cancelad/i,         label: "CTRC já cancelado anteriormente",                    subcategoria: "ctrc_ja_cancelado", definitivo: true  },
    { re: /n[aã]o\s+permitid|sem\s+permiss/i,   label: "Sem permissão pra cancelar este CTRC",               subcategoria: "sem_permissao",     definitivo: true  },
    { re: /fora\s+(do\s+)?prazo/i,              label: "Fora do prazo de cancelamento",                      subcategoria: "fora_prazo",        definitivo: true  },
    { re: /erro|invalid|falha/i,                label: "SSW reportou erro genérico — verificar raw_response", subcategoria: "outro",             definitivo: false },
  ];
  for (const e of errosPosCancel) {
    if (e.re.test(htmlFinalLimpo)) {
      return {
        ok: false,
        error: `SSW rejeitou submit final: ${e.label}`,
        subcategoria: e.subcategoria,
        definitivo: e.definitivo,
        raw_response_snippet: htmlFinal.slice(0, 3000),
        debug: { fase: "submit_final", html_limpo: htmlFinalLimpo.slice(0, 500) },
      };
    }
  }

  // Sucesso silencioso: SSW costuma responder com bloco AJAX curto
  // (ex: "<foc vl=...>" ou redirect implícito). Se não tem erro detectado E
  // a resposta NÃO contém mais a tela de confirmação (sem "Descrição do
  // motivo"), considera sucesso.
  const aindaTaNaConfirmacao = /Descri[cç][aã]o.*motivo|s[eé]rie\/n[uú]mero/i.test(htmlFinal);
  const sucesso = !aindaTaNaConfirmacao;

  if (sucesso) {
    return {
      ok: true,
      raw_response_snippet: htmlFinal.slice(0, 500),
      debug: {
        unidade,
        ctrc_completo: `${letras}${numero}`,
        hiddens_capturados: Object.keys(hiddens),
        precisa_trocar_unidade_inicial: precisaTrocarUnidade,
      },
    };
  }

  return {
    ok: false,
    error: "SSW respondeu ao submit final mas sem indicador de sucesso reconhecido — verificar raw_response pra ajustar regex",
    subcategoria: "tela_inesperada",
    definitivo: false,
    raw_response_snippet: htmlFinal.slice(0, 1000),
    debug: {
      unidade,
      ctrc_completo: `${letras}${numero}`,
      hiddens_capturados: Object.keys(hiddens),
      tamanho_resposta: htmlFinal.length,
    },
  };
}

// =============================================================================
// Espécie do cliente — opção 382 / programa ssw1552 (Caio 2026-06-12)
//
// Troca a(s) espécie(s) de um cliente. Limitação sistêmica do SSW: precisa ser
// 1 cliente por vez. O grid é renderizado por srcore a partir de
// `<xml id="xmlsr">` (f0=código, f1=descrição, f2=estado/ok.gif, f3=SEQ interno).
//
// Fluxo HTTP mapeado:
//   1. POST /bin/ssw1552 act=ENV f2=<cnpj>  → tela ssw1552.02 (grid + seq_cliente)
//   2. Parse XML → estado atual + SEQ de cada espécie
//   3. POST /bin/ssw1552 act="SRENV|<seq>|<seq>..." seq_cliente=<n>
//      (srcore sendXML serializa SÓ as linhas marcadas como `srAct|seq|seq`;
//       srAct="SRENV"). Mandar só os SEQ desejados = estado final = exatamente
//       esses códigos marcados.
//   4. POST act=ENV de novo → re-leitura → verifica que o estado final bate.
//
// Body em latin-1 (charset=iso-8859-1) como todo submit do portal.
// =============================================================================

export interface EspecieGridRow {
  codigo: string; // ex "022"
  descricao: string; // ex "MOTOBIKE"
  seq: string; // SEQ interno (f3), usado no submit
  marcado: boolean;
}

export type AlterarEspecieResult =
  | {
    ok: true;
    cnpj: string;
    cliente: string;
    seqCliente: string;
    antes: string[]; // códigos marcados antes
    depois: string[]; // códigos marcados depois (verificado)
    desejados: string[];
  }
  | {
    ok: false;
    cnpj: string;
    erro: string;
    cliente?: string;
    antes?: string[];
    depois?: string[];
    desejados: string[];
  };

function parseEspecieGrid(html: string): EspecieGridRow[] {
  const xml = html.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i)?.[1] ?? "";
  return [...xml.matchAll(/<r>([\s\S]*?)<\/r>/gi)].map((r) => {
    const inner = r[1] ?? "";
    const get = (n: number) =>
      inner.match(new RegExp(`<f${n}>([\\s\\S]*?)<\\/f${n}>`, "i"))?.[1] ?? "";
    return {
      codigo: decodeEntities(get(0)).trim(),
      descricao: decodeEntities(get(1)).trim(),
      marcado: /ok\.gif/i.test(get(2)),
      seq: decodeEntities(get(3)).trim(),
    };
  });
}

async function buscarEspecieCliente(
  sessao: SswSessao,
  cnpjDigits: string,
): Promise<{ html: string; cliente: string; seqCliente: string; grid: EspecieGridRow[] }> {
  const body = new URLSearchParams({ act: "ENV", f2: cnpjDigits });
  const res = await fetchTimeout(`${BASE}/bin/ssw1552`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1",
      "Referer": `${BASE}/bin/ssw1552`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: urlEncodeLatin1(body),
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, res.headers);
  const html = await res.text();
  const seqCliente = html.match(/name=seq_cliente[^>]*value="(\d+)"/i)?.[1] ?? "";
  const cliente = decodeEntities(
    html.match(/class=data[^>]*>\s*([^<]+?)\s*<\/div>/i)?.[1]?.trim() ?? "",
  );
  return { html, cliente, seqCliente, grid: parseEspecieGrid(html) };
}

/**
 * Altera a(s) espécie(s) de um cliente no SSW (opção 382). `codigosDesejados`
 * é o conjunto EXATO que deve ficar marcado ao final (ex.: ["022"] = só Motobike).
 * Valida pós-gravação relendo o grid; só retorna ok se o estado final bate
 * caractere-a-caractere com o desejado. Não toca em nada se algum código pedido
 * não existir na lista de espécies do SSW.
 */
export async function alterarEspecieCliente(
  env: SswInternalEnv,
  cnpj: string,
  codigosDesejados: string[],
): Promise<AlterarEspecieResult> {
  const cnpjDigits = cnpj.replace(/\D/g, "");
  const desejados = [...new Set(codigosDesejados.map((c) => c.trim().padStart(3, "0")))].sort();

  if (desejados.length === 0) {
    return { ok: false, cnpj: cnpjDigits, erro: "codigosDesejados vazio", desejados };
  }

  const sessao = await obterSessao(env);

  // 1. Lê estado atual + seq_cliente + SEQ de cada espécie
  const antesRes = await buscarEspecieCliente(sessao, cnpjDigits);
  if (!antesRes.seqCliente || antesRes.grid.length === 0) {
    return {
      ok: false,
      cnpj: cnpjDigits,
      cliente: antesRes.cliente || undefined,
      erro: `Cliente não localizado ou grid de espécie vazio (seq_cliente=${antesRes.seqCliente || "?"}, linhas=${antesRes.grid.length}). HTML_len=${antesRes.html.length}.`,
      desejados,
    };
  }
  const antes = antesRes.grid.filter((r) => r.marcado).map((r) => r.codigo).sort();

  // Mapeia código desejado → SEQ. Aborta se algum não existe.
  const seqs: string[] = [];
  const naoEncontrados: string[] = [];
  for (const cod of desejados) {
    const row = antesRes.grid.find((r) => r.codigo === cod);
    if (!row || !row.seq) naoEncontrados.push(cod);
    else seqs.push(row.seq);
  }
  if (naoEncontrados.length > 0) {
    return {
      ok: false,
      cnpj: cnpjDigits,
      cliente: antesRes.cliente,
      antes,
      erro: `Código(s) de espécie inexistente(s) no SSW: ${naoEncontrados.join(", ")}. ` +
        `Disponíveis: ${antesRes.grid.map((r) => r.codigo).join(", ")}.`,
      desejados,
    };
  }

  // Já está exatamente como desejado? Idempotência — não regrava.
  if (antes.length === desejados.length && antes.every((c, i) => c === desejados[i])) {
    return {
      ok: true,
      cnpj: cnpjDigits,
      cliente: antesRes.cliente,
      seqCliente: antesRes.seqCliente,
      antes,
      depois: antes,
      desejados,
    };
  }

  // 2. Grava: act = "SRENV" + cada SEQ desejado (srcore sendXML format)
  const actStr = "SRENV" + seqs.map((s) => `|${s}`).join("");
  const gravarBody = new URLSearchParams({ act: actStr, seq_cliente: antesRes.seqCliente });
  const gravarRes = await fetchTimeout(`${BASE}/bin/ssw1552`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1",
      "Referer": `${BASE}/bin/ssw1552`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: urlEncodeLatin1(gravarBody),
    redirect: "manual",
  });
  applySetCookie(sessao.cookies, gravarRes.headers);
  await gravarRes.text();

  // 3. Re-lê e valida estado final
  const depoisRes = await buscarEspecieCliente(sessao, cnpjDigits);
  const depois = depoisRes.grid.filter((r) => r.marcado).map((r) => r.codigo).sort();

  const bateu = depois.length === desejados.length && depois.every((c, i) => c === desejados[i]);
  if (!bateu) {
    return {
      ok: false,
      cnpj: cnpjDigits,
      cliente: antesRes.cliente,
      antes,
      depois,
      erro: `Estado final ${JSON.stringify(depois)} != desejado ${JSON.stringify(desejados)} ` +
        `(act enviado="${actStr}"). Gravação não confirmada.`,
      desejados,
    };
  }

  return {
    ok: true,
    cnpj: cnpjDigits,
    cliente: antesRes.cliente,
    seqCliente: antesRes.seqCliente,
    antes,
    depois,
    desejados,
  };
}

/**
 * Lê (read-only) as espécies atualmente marcadas de um cliente. Pra auditoria
 * pós-lote — não grava nada.
 */
export async function lerEspecieCliente(
  env: SswInternalEnv,
  cnpj: string,
): Promise<{ cnpj: string; cliente: string; seqCliente: string; marcados: string[]; encontrado: boolean }> {
  const cnpjDigits = cnpj.replace(/\D/g, "");
  const sessao = await obterSessao(env);
  const res = await buscarEspecieCliente(sessao, cnpjDigits);
  return {
    cnpj: cnpjDigits,
    cliente: res.cliente,
    seqCliente: res.seqCliente,
    marcados: res.grid.filter((r) => r.marcado).map((r) => r.codigo).sort(),
    encontrado: !!res.seqCliente && res.grid.length > 0,
  };
}

function dateYYMMDD(d: Date): string {
  // Usa UTC pra evitar variação por timezone do edge runtime.
  const y = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}${m}${y}`;
}

// SSW opera em horário de Brasília (BRT = UTC-3, sem DST). dateYYMMDD formata em
// UTC, então a DATA precisa ser deslocada -3h ANTES de formatar — senão, das
// 21:00 às 23:59 BRT (00:00-02:59 UTC) a "data de hoje" vira AMANHÃ no fuso do
// SSW e a busca por NF (act=P2, t_data_fin) é rejeitada com "Data final maior que
// data corrente", voltando HTML vazio que o parser lê como "NF inexistente" e a
// ação é revertida. Bug âncora: NF 1505494 (DUILIO) 15/06 21:00 BRT. (Caio 2026-06-18)
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
function dataBRT(epochMs: number = Date.now()): Date {
  return new Date(epochMs - BRT_OFFSET_MS);
}

function fetchTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Re-export pra ergonomia
export { SSW_CGI_BASE };

/**
 * Resolve credenciais SSW interno pro operador atribuído ao card.
 *
 * Caio 2026-05-15 (multi-operador onboarding Duilio): substitui chamadas
 * diretas de `readSswInternalEnv(env)` que sempre pegavam credencial única
 * (Larissa). Agora cada card usa as credenciais do operador dele.
 *
 * Resolução (em ordem):
 *   1. card.responsavel_relacionamento → readSswInternalEnv(env, nome)
 *   2. card.assigned_operator_id → lookup operadores.nome → idem
 *   3. Fallback: readSswInternalEnv(env) (env genérico SSW_INTERNAL_*)
 */
export async function loadSswInternalEnvForCard(
  supabase: { from: (t: string) => { select: (s: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> } } } },
  env: Record<string, string | undefined>,
  cardId: string | null | undefined,
): Promise<SswInternalEnv> {
  if (!cardId) return readSswInternalEnv(env);
  const { data } = await supabase
    .from("cards")
    .select("responsavel_relacionamento, assigned_operator_id")
    .eq("id", cardId)
    .maybeSingle();
  const nome = (data?.["responsavel_relacionamento"] as string | null | undefined) ?? null;
  if (nome && nome.trim()) {
    try { return readSswInternalEnv(env, nome); } catch { /* fallback */ }
  }
  const operadorId = (data?.["assigned_operator_id"] as string | null | undefined) ?? null;
  if (operadorId) {
    const { data: op } = await supabase
      .from("operadores")
      .select("nome")
      .eq("id", operadorId)
      .maybeSingle();
    const opNome = (op?.["nome"] as string | null | undefined) ?? null;
    if (opNome) {
      try { return readSswInternalEnv(env, opNome); } catch { /* fallback */ }
    }
  }
  return readSswInternalEnv(env);
}

// =============================================================================
// descobrirUltimaOcSsw — helper de leitura: retorna só a última oc REAL do SSW
//
// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
// Usado pelos passes sync-bastao (B, E) que precisam saber "última oc real
// no SSW" pra decidir destino do card. Substitui chamadas ao tracking SSW
// público (`/api/trackingpag`) que estavam sendo deprecadas. Performance:
// reusa sessão JWT cacheada, 2-3s end-to-end (login amortizado).
//
// Retorna sucesso/erro sem throw — caller decide o que fazer com falha.
// =============================================================================

export type DescobrirUltimaOcSswResultado =
  // Caio 2026-06-25: `dataBrtMs`/`dataRaw` = instante da ocorrência mais recente
  // (epoch ms UTC e string crua "DD/MM/YY HH:MM" BRT). Aditivo — callers antigos
  // que só leem `oc` seguem funcionando. Usado pelo discriminador de reabertura
  // por VERDADE-DO-SSW-POR-HORA (decidirReaberturaPorSsw).
  // Caio 2026-06-29 (PR3b shadow): `ocorrencias` = histórico completo (recente-primeiro)
  // com autor. ADITIVO — callers reais (oc/dataBrtMs/dataRaw) seguem iguais. Usado SÓ
  // pelo shadow (registrarShadowReabertura) p/ decidir por identidade/ordem.
  | {
    sucesso: true;
    oc: number;
    dataBrtMs: number | null;
    dataRaw: string | null;
    ocorrencias: Array<{ codigo: number | null; usuario: string | null; data: string | null }>;
  }
  | { sucesso: false; motivo: "sem_nf" | "ssw_sem_oc" | "env_ausente" | "ssw_erro"; detalhe?: string };

export async function descobrirUltimaOcSsw(
  nf: string | null | undefined,
  ctrcEsperado: string | null | undefined,
  envOverride?: Record<string, string | undefined>,
  operadorNome?: string | null,
): Promise<DescobrirUltimaOcSswResultado> {
  if (!nf) return { sucesso: false, motivo: "sem_nf" };
  try {
    const env = envOverride ?? (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
    const sswEnv = readSswInternalEnv(env, operadorNome);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrcEsperado ?? null });
    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    const primeira = ocs.find((o) => o.codigo != null);
    if (primeira?.codigo == null) {
      return {
        sucesso: false,
        motivo: "ssw_sem_oc",
        detalhe: `SSW retornou ${ocs.length} entradas sem código válido`,
      };
    }
    const dataRaw = (primeira as { data?: string | null }).data ?? null;
    return {
      sucesso: true,
      oc: primeira.codigo,
      dataBrtMs: parseSswDataHoraBrt(dataRaw),
      dataRaw,
      // ADITIVO (PR3b shadow): histórico completo com autor, recente-primeiro.
      ocorrencias: ocs.map((o) => ({
        codigo: o.codigo ?? null,
        usuario: o.usuario ?? null,
        data: o.data ?? null,
      })),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SSW_INTERNAL_") && msg.includes("env vars")) {
      return { sucesso: false, motivo: "env_ausente", detalhe: msg };
    }
    return { sucesso: false, motivo: "ssw_erro", detalhe: msg };
  }
}

declare const Deno: { env: { toObject(): Record<string, string | undefined> } };
