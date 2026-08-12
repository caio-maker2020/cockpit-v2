// =============================================================================
// wurth-intranet-client — login + consulta na intranet Würth (Ingrid).
// FLUXO REAL, VALIDADO AO VIVO 2026-08-12 (login SAL, tabela real retornada):
//
//   1. GET  /intranet/index_1.php                 (cookies + form login)
//   2. POST /intranet/redirect.php  usu+senha+button=Entrar
//        ⚠️ NÃO enviar o campo esqueci_senha (checkbox desmarcado NÃO vai no
//        POST do navegador) — enviá-lo dispara o fluxo de reset e o servidor
//        responde SQLSTATE[2002] Connection refused. Esse foi o "erro do
//        servidor" que eu diagnostiquei errado — era o meu request.
//   3. GET  /intranet/intranet.php?primeiro=aa    (estabelece sessão; tem "Sair")
//   4. GET  /sistema/acesso2.php                  (portal "Wurth Web")
//        → link "Pendencia na transportadora": frond.php?...&uid=<hash sessão>
//   5. GET  esse frond.php                        (form da consulta; uid no hidden)
//   6. POST /sistema/consulta_devolucao.php  com:
//        uid, start=consulta_devolucao.html, datainicial/datafinal +
//        datainicialtratada/datafinaltratada = 01/01/ano→hoje, filtro=2
//        (Solucionado Wurth), origem=quente (Atual), gerar_arquivo=N, submit=OK
//
// Contas: 'sal' (Cotia — WTC/ARP) e 'ampla' (Betim — AMB/WTB).
// Secrets: WURTH_INTRANET_SAL_USUARIO/SENHA e WURTH_INTRANET_AMPLA_USUARIO/SENHA.
// Nunca logar senha (INV-063).
// =============================================================================

import { parseTabelaConsulta, type LinhaRetornoWurth, type LoginWurth } from "./wurth-intranet.ts";

const BASE = "https://wprd.wurthdobrasil.com.br";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 30_000;

export interface WurthCreds {
  usuario: string;
  senha: string;
}

export function readWurthEnv(
  env: Record<string, string | undefined>,
  login: LoginWurth,
): WurthCreds | null {
  const pfx = login === "sal" ? "WURTH_INTRANET_SAL" : "WURTH_INTRANET_AMPLA";
  const usuario = env[`${pfx}_USUARIO`];
  const senha = env[`${pfx}_SENHA`];
  if (!usuario || !senha) return null;
  return { usuario, senha };
}

export interface WurthSessao {
  login: LoginWurth;
  cookies: Map<string, string>;
}

export type ResultadoConsulta =
  | { ok: true; linhas: LinhaRetornoWurth[]; via: string }
  | {
    ok: false;
    passo: "login" | "form_consulta" | "submit_consulta" | "parse";
    detalhe: string;
  };

function cookieHeader(c: Map<string, string>): string {
  return [...c.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorveCookies(c: Map<string, string>, h: Headers): void {
  const lista: string[] = (h as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
  for (const raw of lista) {
    const [par] = raw.split(";");
    const i = par!.indexOf("=");
    if (i > 0) c.set(par!.slice(0, i).trim(), par!.slice(i + 1).trim());
  }
}

function ftimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
}

function ftimeoutFollow(url: string, ref: string, cookies: Map<string, string>, init: RequestInit = {}): Promise<string> {
  return (async () => {
    const r = await ftimeout(url, {
      ...init,
      headers: { "User-Agent": UA, cookie: cookieHeader(cookies), Referer: ref, ...(init.headers ?? {}) },
    });
    absorveCookies(cookies, r.headers);
    const loc = r.headers.get("location");
    const body = await r.text();
    if (loc && r.status >= 300 && r.status < 400) {
      const next = loc.startsWith("http") ? loc : `${BASE}${loc.startsWith("/") ? "" : "/sistema/"}${loc}`;
      return ftimeoutFollow(next, url, cookies, {}); // segue redirect (GET)
    }
    return body;
  })();
}

/**
 * Login real (passos 1-3). Estabelece a sessão PHPSESSID e valida pela presença
 * de "Sair" no intranet.php.
 */
export async function loginWurth(creds: WurthCreds, login: LoginWurth): Promise<WurthSessao> {
  const cookies = new Map<string, string>();
  // 1. página de login (cookies)
  const r0 = await ftimeout(`${BASE}/intranet/index_1.php`, { headers: { "User-Agent": UA } });
  absorveCookies(cookies, r0.headers);
  await r0.text();
  // 2. POST redirect.php — SEM esqueci_senha (crítico)
  const body = new URLSearchParams({ usu: creds.usuario, senha: creds.senha, button: "Entrar" });
  const r1 = await ftimeout(`${BASE}/intranet/redirect.php`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${BASE}/intranet/index_1.php`,
      cookie: cookieHeader(cookies),
    },
    body: body.toString(),
  });
  absorveCookies(cookies, r1.headers);
  const posLogin = await r1.text();
  if (/SQLSTATE|Connection refused/i.test(posLogin)) {
    throw new Error("login: servidor Würth retornou erro de banco (ver se o request mandou esqueci_senha)");
  }
  // 3. intranet.php estabelece a sessão
  const hi = await ftimeoutFollow(`${BASE}/intranet/intranet.php?primeiro=aa`, `${BASE}/intranet/redirect.php`, cookies);
  if (!/sair/i.test(hi)) {
    throw new Error("login: sessão não estabelecida (intranet.php sem 'Sair' — credencial inválida?)");
  }
  return { login, cookies };
}

function dataBr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * Consulta "Pendência na Transportadora" (passos 4-6) com as regras da Ingrid:
 * Incluídos E Tratadas Würth = 01/01 do ano corrente → hoje (BRT);
 * Situação = Solucionado Würth (filtro=2); Origem = Atual (origem=quente).
 */
export async function consultarPendencias(sessao: WurthSessao): Promise<ResultadoConsulta> {
  // 4. portal Wurth Web
  let portal: string;
  try {
    portal = await ftimeoutFollow(`${BASE}/sistema/acesso2.php`, `${BASE}/intranet/intranet.php`, sessao.cookies);
  } catch (err) {
    return { ok: false, passo: "form_consulta", detalhe: `acesso2: ${err instanceof Error ? err.message : String(err)}` };
  }
  const linkConsulta = portal.match(
    /(frond\.php\?submit=OK&start=consulta_devolucao\.html&program=[\w=]+&uid=[\w]+)/i,
  )?.[1];
  if (!linkConsulta) {
    return { ok: false, passo: "form_consulta", detalhe: "link 'Pendencia na transportadora' ausente no portal" };
  }

  // 5. form da consulta (pega o uid do hidden)
  let htmlForm: string;
  try {
    htmlForm = await ftimeoutFollow(`${BASE}/sistema/${linkConsulta}`, `${BASE}/sistema/acesso2.php`, sessao.cookies);
  } catch (err) {
    return { ok: false, passo: "form_consulta", detalhe: `form: ${err instanceof Error ? err.message : String(err)}` };
  }
  const uid = htmlForm.match(/name=uid\s+value=(\w+)/i)?.[1];
  if (!uid) return { ok: false, passo: "form_consulta", detalhe: "uid ausente no form da consulta" };

  // 6. submit
  const agoraBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const ini = `01/01/${agoraBrt.getUTCFullYear()}`;
  const fim = dataBr(agoraBrt);
  const corpo = new URLSearchParams({
    uid,
    start: "consulta_devolucao.html",
    datainicial: ini,
    datafinal: fim,
    datainicialtratada: ini,
    datafinaltratada: fim,
    filtro: "2", // Solucionado Wurth
    origem: "quente", // Atual
    gerar_arquivo: "N",
    submit: "OK",
  });
  let resultado: string;
  try {
    const r = await ftimeout(`${BASE}/sistema/consulta_devolucao.php`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/sistema/${linkConsulta}`,
        cookie: cookieHeader(sessao.cookies),
      },
      body: corpo.toString(),
    });
    // o portal serve iso-8859-1; ler como UTF-8 corrompe os acentos da Obs
    // (que vira o texto da oc 21 no SSW). Decodifica latin-1 explicitamente.
    resultado = new TextDecoder("iso-8859-1").decode(await r.arrayBuffer());
  } catch (err) {
    return { ok: false, passo: "submit_consulta", detalhe: err instanceof Error ? err.message : String(err) };
  }

  const linhas = parseTabelaConsulta(resultado);
  if (linhas.length === 0 && !/nota\s*fiscal/i.test(resultado)) {
    return { ok: false, passo: "parse", detalhe: `resultado sem tabela (${resultado.length} bytes)` };
  }
  return { ok: true, linhas, via: `${sessao.login}:${ini}→${fim}` };
}
