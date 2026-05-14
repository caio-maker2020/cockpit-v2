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
  | { tipo: "tracking_ent"; seqCtrc: string; fotoPath: string }
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

export function readSswInternalEnv(env: Record<string, string | undefined>): SswInternalEnv {
  const dominio = env["SSW_INTERNAL_DOMINIO"];
  const cpf = env["SSW_INTERNAL_CPF"];
  const usuario = env["SSW_INTERNAL_USUARIO"];
  const senha = env["SSW_INTERNAL_SENHA"];
  if (!dominio || !cpf || !usuario || !senha) {
    throw new Error(
      "SSW_INTERNAL_* env vars ausentes (DOMINIO/CPF/USUARIO/SENHA). " +
      "Setar via `npx supabase secrets set` antes de usar o cliente interno.",
    );
  }
  return { dominio, cpf, usuario, senha };
}

// Cache de sessão por processo da edge function. Re-aproveita login.
let cachedSessao: SswSessao | null = null;

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
    throw new Error(`SSW login falhou — sem cookie 'token' após POST (creds: dominio=${env.dominio} usuario=${env.usuario})`);
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
 */
export async function obterSessao(env: SswInternalEnv): Promise<SswSessao> {
  if (cachedSessao && Date.now() < cachedSessao.tokenExpMs - 60_000) {
    return cachedSessao;
  }
  cachedSessao = await loginInternoSSW(env);
  return cachedSessao;
}

/**
 * Limpa cache de sessão (útil quando algum request volta 401/403).
 */
export function limparSessaoCache(): void {
  cachedSessao = null;
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
    t_data_ini: dateYYMMDD(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
    t_data_fin: dateYYMMDD(new Date()),
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
  throw new Error(
    `SSW buscar NF ${nf}: sem seq_ctrc/FAMILIA na resposta e sem XML de lista — NF inexistente?`,
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
  | { status: "ok"; binary: Uint8Array; content_type: string; picture_src: string; oc_descricao: string }
  | { status: "oc_nao_encontrada"; codigo_buscado: number; ocs_disponiveis: Array<{ codigo: number | null; descricao: string; tem_foto: boolean }> }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
  | { status: "erro_ssw"; motivo: string };

export async function obterFotoDaOc(
  env: SswInternalEnv,
  nf: string,
  codigoOc: number,
  opts?: { ctrcEsperado?: string | null },
): Promise<FotoOcResult> {
  try {
    const sessao = await obterSessao(env);
    // Caio 2026-05-13 (NF 20761): NFs com múltiplos CTRCs (reentrega/complementar)
    // fazem buscarNFInterno throw "múltiplos CTRCs retornados". Propagar
    // ctrcEsperado do card pra escolher o certo.
    const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: opts?.ctrcEsperado ?? null });
    const ocs = await listarOcorrenciasNF(sessao, detalhe);

    // Caio 2026-05-13 (NF 29326): há casos com MÚLTIPLAS linhas do mesmo código
    // de ocorrência no histórico (ex: motorista relança oc=19 via SSWMOBILE,
    // app duplica linha). Antes pegava só `find()` → primeira ocorrência (mais
    // recente, pelo ordering do SSW). Se a foto estava na linha ANTIGA, retornava
    // "oc_sem_foto" mesmo havendo foto. Fix: filtrar todas as linhas do código
    // e priorizar a que tem foto. Senão (nenhuma tem foto), usa a primeira pra
    // retornar `oc_sem_foto` com descrição correta.
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
    const ocAlvo = ocsDoCodigo.find((o) => o.fotos.length > 0) ?? ocsDoCodigo[0]!;
    if (ocAlvo.fotos.length === 0) {
      return { status: "oc_sem_foto", codigo_buscado: codigoOc, descricao: ocAlvo.descricao };
    }
    // Pega primeira foto. (Há ocs com 2+ fotos — extensão futura: array de
    // todas, e r-evidencia pode mostrar um indicador ou retornar uma página
    // com múltiplas. Por enquanto: primeira foto.)
    const baixada = await baixarFotoOcorrencia(sessao, ocAlvo.fotos[0]!);
    return {
      status: "ok",
      binary: baixada.binary,
      content_type: baixada.content_type,
      picture_src: baixada.picture_src,
      oc_descricao: ocAlvo.descricao,
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
}

export type LancarOcorrenciaPortalResult =
  | { ok: true; seq_oc: string; descricao: string; raw_response_snippet: string }
  | { ok: false; error: string; raw_response_snippet?: string };

export async function lancarOcorrenciaPortal(
  sessao: SswSessao,
  detalhe: SswNFDetalhe,
  opts: LancarOcorrenciaPortalOpts,
): Promise<LancarOcorrenciaPortalResult> {
  const codigo = String(opts.codigoSsw).padStart(2, "0"); // ex: 49 ou 03
  const texto = (opts.texto ?? "").slice(0, 70); // SSW limita f6 a 70 chars
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
    f6: texto,
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
  const resII3 = await fetchTimeout(`${BASE}/bin/ssw0122`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/bin/ssw0053`,
      cookie: cookieHeader(sessao.cookies),
    },
    body: formII3,
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
  //
  // Heurística: remove hidden fields + scripts e checa se sobra texto com
  // palavras-chave de erro.
  const limpo = htmlII3
    .replace(/<input[^>]*type=["']?hidden["']?[^>]*>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

function dateYYMMDD(d: Date): string {
  // Usa UTC pra evitar variação por timezone do edge runtime.
  const y = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}${m}${y}`;
}

function fetchTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Re-export pra ergonomia
export { SSW_CGI_BASE };

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
  | { sucesso: true; oc: number }
  | { sucesso: false; motivo: "sem_nf" | "ssw_sem_oc" | "env_ausente" | "ssw_erro"; detalhe?: string };

export async function descobrirUltimaOcSsw(
  nf: string | null | undefined,
  ctrcEsperado: string | null | undefined,
  envOverride?: Record<string, string | undefined>,
): Promise<DescobrirUltimaOcSswResultado> {
  if (!nf) return { sucesso: false, motivo: "sem_nf" };
  try {
    const env = envOverride ?? (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
    const sswEnv = readSswInternalEnv(env);
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
    return { sucesso: true, oc: primeira.codigo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SSW_INTERNAL_") && msg.includes("env vars")) {
      return { sucesso: false, motivo: "env_ausente", detalhe: msg };
    }
    return { sucesso: false, motivo: "ssw_erro", detalhe: msg };
  }
}

declare const Deno: { env: { toObject(): Record<string, string | undefined> } };
