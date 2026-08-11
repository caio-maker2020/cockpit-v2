// =============================================================================
// wurth-intranet-client — login + consulta na intranet Würth (Ingrid, 11/08).
//
// URLs vistas nos vídeos:
//   login:    https://wprd.wurthdobrasil.com.br/intranet/index_1.php
//   pós-login: /intranet/intranet.php?primeiro=aa  ("Boa tarde, AMPLA...")
//   form:     /sistema/frond.php?submit=OK&start=consulta_devolucao.html&program=<dyn>&uid=<dyn>
//   resultado: /sistema/consulta_devolucao.php
//
// Os NOMES dos campos dos forms não aparecem nos vídeos — o cliente parseia os
// forms genericamente (action + inputs) e preenche por heurística de rótulo,
// com categoria de falha estável em cada passo. VALIDAR AO VIVO na fase de
// teste da branch com as credenciais reais (mesmos logins da Ingrid), antes do
// merge. Nunca logar senha (lição INV-063).
//
// Duas contas: 'sal' (Cotia — prefixos WTC/ARP) e 'ampla' (Betim — AMB/WTB).
// Secrets: WURTH_INTRANET_SAL_USUARIO/SENHA e WURTH_INTRANET_AMPLA_USUARIO/SENHA.
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

/** Parse genérico do PRIMEIRO form: action + campos (input/select) com valores default. */
export function parseForm(html: string): { action: string | null; campos: Record<string, string> } {
  const form = html.match(/<form[\s\S]*?<\/form>/i)?.[0] ?? html;
  const action = form.match(/action\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
  const campos: Record<string, string> = {};
  for (const inp of form.match(/<input[^>]*>/gi) ?? []) {
    const nome = inp.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!nome) continue;
    const tipo = (inp.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "text").toLowerCase();
    const valor = inp.match(/value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    // radio/checkbox: só entra o marcado por default; o caller sobrescreve
    if ((tipo === "radio" || tipo === "checkbox") && !/checked/i.test(inp)) {
      if (!(nome in campos)) campos[nome] = campos[nome] ?? "";
      continue;
    }
    campos[nome] = valor;
  }
  for (const sel of form.match(/<select[\s\S]*?<\/select>/gi) ?? []) {
    const nome = sel.match(/name\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!nome) continue;
    const marcado = sel.match(/<option[^>]*selected[^>]*value\s*=\s*["']([^"']*)["']/i)?.[1] ??
      sel.match(/<option[^>]*value\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    campos[nome] = marcado;
  }
  return { action, campos };
}

/** Heurística: acha o nome do campo de usuário e de senha no form de login. */
export function camposLogin(html: string): { usuario: string | null; senha: string | null } {
  const form = html.match(/<form[\s\S]*?<\/form>/i)?.[0] ?? html;
  const senha = form.match(/<input[^>]*type\s*=\s*["']password["'][^>]*name\s*=\s*["']([^"']+)["']/i)?.[1] ??
    form.match(/<input[^>]*name\s*=\s*["']([^"']+)["'][^>]*type\s*=\s*["']password["']/i)?.[1] ?? null;
  // usuário = primeiro input text/sem-tipo que não seja o de senha
  let usuario: string | null = null;
  for (const inp of form.match(/<input[^>]*>/gi) ?? []) {
    const tipo = (inp.match(/type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "text").toLowerCase();
    const nome = inp.match(/name\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    if (!nome || nome === senha) continue;
    if (tipo === "text" || tipo === "email") {
      usuario = nome;
      break;
    }
  }
  return { usuario, senha };
}

export async function loginWurth(creds: WurthCreds, login: LoginWurth): Promise<WurthSessao> {
  const cookies = new Map<string, string>();
  const r1 = await ftimeout(`${BASE}/intranet/index_1.php`, { headers: { "User-Agent": UA } });
  absorveCookies(cookies, r1.headers);
  const html1 = await r1.text();
  const { usuario: campoU, senha: campoS } = camposLogin(html1);
  if (!campoU || !campoS) {
    throw new Error(`login: form não reconhecido (usuario=${campoU} senha=${campoS != null})`);
  }
  const { action, campos } = parseForm(html1);
  const body = new URLSearchParams({ ...campos, [campoU]: creds.usuario, [campoS]: creds.senha });
  const alvo = action
    ? (action.startsWith("http") ? action : `${BASE}${action.startsWith("/") ? "" : "/intranet/"}${action}`)
    : `${BASE}/intranet/index_1.php`;
  const r2 = await ftimeout(alvo, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE}/intranet/index_1.php`,
      cookie: cookieHeader(cookies),
    },
    body: body.toString(),
  });
  absorveCookies(cookies, r2.headers);
  // pós-login redireciona pra intranet.php; valida sessão
  const r3 = await ftimeout(`${BASE}/intranet/intranet.php?primeiro=aa`, {
    headers: { "User-Agent": UA, cookie: cookieHeader(cookies), Referer: alvo },
  });
  const html3 = await r3.text();
  if (/index_1\.php|senha/i.test(html3) && !/sair/i.test(html3)) {
    throw new Error("login: sessão não estabelecida (voltou pra tela de login)");
  }
  return { login, cookies };
}

function dataBr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * Consulta "Pendência na Transportadora" com as regras da Ingrid:
 * Incluídos E Tratadas Würth = 01/01 do ano corrente → hoje;
 * Situação = Solucionado Würth; Origem = Atual; sem gerar arquivo.
 */
export async function consultarPendencias(sessao: WurthSessao): Promise<ResultadoConsulta> {
  const agoraBrt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const ini = `01/01/${agoraBrt.getUTCFullYear()}`;
  const fim = dataBr(agoraBrt);

  // 1. Página do form (frond.php abre consulta_devolucao.html com program/uid da sessão)
  let htmlForm: string;
  try {
    const r = await ftimeout(
      `${BASE}/sistema/frond.php?submit=OK&start=consulta_devolucao.html`,
      { headers: { "User-Agent": UA, cookie: cookieHeader(sessao.cookies), Referer: `${BASE}/intranet/intranet.php` } },
    );
    htmlForm = await r.text();
  } catch (err) {
    return { ok: false, passo: "form_consulta", detalhe: err instanceof Error ? err.message : String(err) };
  }
  const { action, campos } = parseForm(htmlForm);
  if (Object.keys(campos).length === 0) {
    return { ok: false, passo: "form_consulta", detalhe: "form sem campos reconhecíveis" };
  }

  // 2. Preenche por heurística de NOME do campo (datas aos pares; situação; origem)
  const nomes = Object.keys(campos);
  const camposData = nomes.filter((n) => /data|dt|incl|trat/i.test(n));
  for (const n of camposData) {
    campos[n] = /ini|de(?![a-z])|1/i.test(n) ? ini : fim;
  }
  // se não distinguiu ini/fim pelos nomes, alterna na ordem (par ini/fim)
  if (camposData.length >= 2 && camposData.every((n) => campos[n] === fim)) {
    camposData.forEach((n, i) => (campos[n] = i % 2 === 0 ? ini : fim));
  }
  for (const n of nomes) {
    if (/situa/i.test(n)) campos[n] = valorParecido(htmlForm, n, /solucionado/i) ?? campos[n];
    if (/orig/i.test(n)) campos[n] = valorParecido(htmlForm, n, /atual/i) ?? campos[n];
    if (/arquivo|gerar/i.test(n)) campos[n] = valorParecido(htmlForm, n, /n[aã]o/i) ?? campos[n];
  }

  // 3. Submit
  let htmlResultado: string;
  try {
    const alvo = action
      ? (action.startsWith("http") ? action : `${BASE}${action.startsWith("/") ? "" : "/sistema/"}${action}`)
      : `${BASE}/sistema/consulta_devolucao.php`;
    const r = await ftimeout(alvo, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE}/sistema/frond.php`,
        cookie: cookieHeader(sessao.cookies),
      },
      body: new URLSearchParams(campos).toString(),
    });
    htmlResultado = await r.text();
  } catch (err) {
    return { ok: false, passo: "submit_consulta", detalhe: err instanceof Error ? err.message : String(err) };
  }

  const linhas = parseTabelaConsulta(htmlResultado);
  if (linhas.length === 0 && !/nota\s*fiscal/i.test(htmlResultado)) {
    return {
      ok: false,
      passo: "parse",
      detalhe: `resultado sem tabela reconhecível (${htmlResultado.length} bytes)`,
    };
  }
  return { ok: true, linhas, via: `${sessao.login}:${ini}→${fim}` };
}

/** Acha, no HTML, o value do input radio/option daquele campo cujo RÓTULO casa. */
function valorParecido(html: string, nomeCampo: string, rotulo: RegExp): string | null {
  const rx = new RegExp(
    `<input[^>]*name\\s*=\\s*["']${nomeCampo}["'][^>]*value\\s*=\\s*["']([^"']*)["'][^>]*>\\s*([^<]{0,40})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    if (rotulo.test(m[2] ?? "") || rotulo.test(m[1] ?? "")) return m[1] ?? null;
  }
  const rxOpt = new RegExp(
    `<select[^>]*name\\s*=\\s*["']${nomeCampo}["'][\\s\\S]*?</select>`,
    "i",
  );
  const sel = html.match(rxOpt)?.[0];
  if (sel) {
    const opt = new RegExp(`<option[^>]*value\\s*=\\s*["']([^"']*)["'][^>]*>([^<]*)`, "gi");
    let o: RegExpExecArray | null;
    while ((o = opt.exec(sel)) !== null) {
      if (rotulo.test(o[2] ?? "") || rotulo.test(o[1] ?? "")) return o[1] ?? null;
    }
  }
  return null;
}
