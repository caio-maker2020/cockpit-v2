// =============================================================================
// romaneio-interno-client — cliente HTTP do portal interno de romaneio da
// Sal Express (https://app.salexpress.org/Romaneio-app-front-backend).
//
// Caio 2026-05-12 (PRATI): clientes que escaneiam romaneio internamente
// (em vez de pedir pro cliente final) ficam configurados em cliente_config.
// O agente loga no portal, busca pela NF, baixa as fotos JPEG e anexa na
// oc=33 no SSW.
//
// Descoberta crítica: as fotos já vêm em JPEG direto do portal (servidor
// faz a conversão/OCR na ingestão). Não precisamos converter PDF→JPEG
// no Cockpit.
//
// API flow (descoberto via inspeção da SPA):
//   1. POST /api.php?endpoint=auth%2Flogin  body {email,password}
//      → 200 { access_token, user }
//   2. GET  /api.php?endpoint=documents%2F&page=N&per_page=N&search=NF
//      headers Authorization: Bearer {token}
//      → 200 { items[], total, page, total_pages }
//   3. GET  /{caminho_foto}                 (path direto, sem auth)
//      → JPEG bytes
//
// Cada item.photos[] tem N JPEGs (1+ páginas do romaneio).
// =============================================================================

const TIMEOUT_MS = 20000;

export interface RomaneioEnv {
  baseUrl: string;
  login: string;
  senha: string;
}

export interface RomaneioSessao {
  token: string;
  expiresAtMs: number; // best-effort; JWT exp claim
  baseUrl: string;
}

export interface RomaneioFoto {
  id: number;
  caminhoFoto: string; // ex: "uploads/uuid.jpg"
  url: string;         // url completa pronta pra GET
  ordem: number;
}

export interface RomaneioDocumento {
  id: number;
  titulo: string;
  status: string;
  fotos: RomaneioFoto[];
}

export function readRomaneioEnv(env: Record<string, string | undefined>): RomaneioEnv {
  const login = env["SAL_ROMANEIO_LOGIN"];
  const senha = env["SAL_ROMANEIO_SENHA"];
  const baseUrl = env["SAL_ROMANEIO_BASE_URL"] ?? "https://app.salexpress.org/Romaneio-app-front-backend";
  if (!login || !senha) {
    throw new Error(
      "SAL_ROMANEIO_LOGIN/SAL_ROMANEIO_SENHA env ausentes. Setar via `npx supabase secrets set`.",
    );
  }
  return { login, senha, baseUrl: baseUrl.replace(/\/+$/, "") };
}

// Cache de sessão por processo (mesma estratégia do ssw-internal-client)
let cachedSessao: RomaneioSessao | null = null;

function fetchTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function parseJwtExp(token: string): number {
  try {
    const [, payload] = token.split(".");
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return (decoded.exp ?? 0) * 1000;
  } catch {
    return Date.now() + 60 * 60_000; // fallback 1h
  }
}

export async function obterSessao(env: RomaneioEnv): Promise<RomaneioSessao> {
  if (cachedSessao && cachedSessao.expiresAtMs > Date.now() + 60_000) {
    return cachedSessao;
  }
  const res = await fetchTimeout(
    `${env.baseUrl}/api.php?endpoint=auth%2Flogin`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: env.login, password: env.senha }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Romaneio login falhou (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { access_token?: string; user?: unknown };
  if (!data.access_token) {
    throw new Error(`Romaneio login sem access_token na resposta`);
  }
  cachedSessao = {
    token: data.access_token,
    expiresAtMs: parseJwtExp(data.access_token),
    baseUrl: env.baseUrl,
  };
  return cachedSessao;
}

/**
 * Busca documentos por NF. Search é amplo (título, descrição, etc) — a NF
 * geralmente bate quando aparece dentro da descrição HTML do romaneio.
 *
 * Retorna lista de documentos completos (com fotos). Vazio se nenhum.
 *
 * Caio 2026-05-12: PRATI tem ~104 docs hoje; busca por NF específica retorna
 * 0-3 normalmente.
 */
export async function buscarRomaneiosPorNf(
  sessao: RomaneioSessao,
  nf: string,
): Promise<RomaneioDocumento[]> {
  const nfLimpa = String(nf).trim();
  const url = `${sessao.baseUrl}/api.php?endpoint=documents%2F&page=1&per_page=10&search=${encodeURIComponent(nfLimpa)}`;
  const res = await fetchTimeout(url, {
    headers: { Authorization: `Bearer ${sessao.token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Romaneio search NF ${nfLimpa} (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json() as {
    items?: Array<{
      id: number;
      titulo: string;
      status: string;
      photos?: Array<{ id: number; caminho_foto: string; ordem: number }>;
    }>;
  };
  const items = data.items ?? [];
  return items.map((it) => ({
    id: it.id,
    titulo: it.titulo,
    status: it.status,
    fotos: (it.photos ?? []).map((p) => ({
      id: p.id,
      caminhoFoto: p.caminho_foto,
      url: `${sessao.baseUrl}/${p.caminho_foto.replace(/^\/+/, "")}`,
      ordem: p.ordem,
    })),
  }));
}

/**
 * Baixa o JPEG de uma foto do romaneio. Path direto (sem auth — servidor
 * serve `uploads/*.jpg` como arquivos estáticos).
 */
export async function baixarFoto(foto: RomaneioFoto): Promise<Uint8Array> {
  const res = await fetchTimeout(foto.url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Romaneio download ${foto.caminhoFoto} (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Conveniência: busca + baixa todas as fotos do(s) romaneio(s) que casam
 * com a NF. Retorna array plano de JPEGs prontos pra anexar no SSW.
 *
 * Se múltiplos documentos casam, usa o PRIMEIRO (mais recente — listagem
 * vem ordenada por id desc na API). Larissa decide caso queira filtrar
 * outro.
 */
export async function buscarFotosRomaneioPorNf(
  sessao: RomaneioSessao,
  nf: string,
): Promise<{ encontrado: boolean; documento?: RomaneioDocumento; jpegs: Uint8Array[] }> {
  const docs = await buscarRomaneiosPorNf(sessao, nf);
  if (docs.length === 0) return { encontrado: false, jpegs: [] };
  const doc = docs[0]!;
  const jpegs: Uint8Array[] = [];
  for (const foto of doc.fotos) {
    try {
      jpegs.push(await baixarFoto(foto));
    } catch (err) {
      console.warn(`Romaneio baixarFoto falhou pra ${foto.caminhoFoto}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return { encontrado: true, documento: doc, jpegs };
}

/**
 * Alias semântico (SBD/Ingrid 2026-08-11): a API busca por TERMO LIVRE
 * (`search=`) — pra Black & Decker o termo é o Nº Remessa/delivery, não a NF.
 * Mesma implementação; nome deixa o executor legível.
 */
export const buscarFotosRomaneioPorTermo = buscarFotosRomaneioPorNf;
