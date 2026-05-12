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

export interface SswOcorrencia {
  codigo: number | null;
  descricao: string;
  instrucao: string;
  data: string;
  filial: string | null;
  usuario: string | null;
  fotos: Array<{ fotoPath: string; seqCtrc: string }>;
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

    // f9 contém HTML escapado com onclick=ajaxEnvia('',1,'ssw0122?seq_ctrc=X&foto=Y&act=FOT')
    const f9Decoded = decodeEntities(f9Raw);
    const fotos: Array<{ fotoPath: string; seqCtrc: string }> = [];
    const fotoRe = /ssw0122\?seq_ctrc=(\d+)&foto=([^&'"]+)&act=FOT/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fotoRe.exec(f9Decoded)) !== null) {
      fotos.push({ seqCtrc: fm[1]!, fotoPath: fm[2]! });
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
 * Baixa o binário de uma foto da ocorrência (2 hops: ssw0122?foto → extrai
 * picture_src da página HTML intermediária → GET na URL CGI real).
 *
 * Retorna { binary, content_type }. Throws se SSW não retornar imagem.
 */
export async function baixarFotoOcorrencia(
  sessao: SswSessao,
  foto: { fotoPath: string; seqCtrc: string },
): Promise<{ binary: Uint8Array; content_type: string; picture_src: string }> {
  const url1 = `${BASE}/bin/ssw0122?seq_ctrc=${foto.seqCtrc}&foto=${foto.fotoPath}&act=FOT`;
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
  const pictureSrc = html1.match(/\$\("picture"\)\.src\s*=\s*"([^"]+)"/)?.[1];
  if (!pictureSrc) {
    throw new Error(`SSW foto ${foto.fotoPath}: HTML intermediário sem picture.src`);
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
    throw new Error(`SSW foto ${foto.fotoPath}: picture_src retornou ${ct} (esperava image/*)`);
  }
  const binary = new Uint8Array(await r2.arrayBuffer());
  if (binary.byteLength === 0) {
    throw new Error(`SSW foto ${foto.fotoPath}: binário vazio`);
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
): Promise<FotoOcResult> {
  try {
    const sessao = await obterSessao(env);
    const detalhe = await buscarNFInterno(sessao, nf);
    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    const ocAlvo = ocs.find((o) => o.codigo === codigoOc);
    if (!ocAlvo) {
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

function dateYYMMDD(d: Date): string {
  const y = String(d.getFullYear() % 100).padStart(2, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${day}${m}${y}`;
}

function fetchTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Re-export pra ergonomia
export { SSW_CGI_BASE };
