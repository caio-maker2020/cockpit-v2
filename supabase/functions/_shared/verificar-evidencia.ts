// =============================================================================
// verificar-evidencia — checa se SSW tem foto anexada na ocorrência específica
// de uma NF. Usado pelo hook autônomo no sync-bastao/vinculador (oc=10/11/35
// sem foto → lança oc=56 autônomo).
//
// Causa do bug NF 350898: vercel-r-evidencia/api/r.ts pegava ÚLTIMO btn_foto
// do HTML sem filtrar por oc específica. Cliente recebia foto de oc anterior.
// Aqui filtramos por linha (<tr> ou bloco equivalente) que contenha tanto o
// código da oc desejada quanto o btn_foto.
//
// Performance: ~3-5s por NF (3 hops HTTP + parser HTML). Roda sob demanda
// na criação do card.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

const SSW_BASE = "https://ssw.inf.br";
const SSW_AUTH_URL = `${SSW_BASE}/2/ssw_resultSSW_pag_nro`;
const SSW_DETALHE_URL = `${SSW_BASE}/2/ssw_SSWDetalhado`;
const VOLTAR_URL = `${SSW_BASE}/`;
const TIMEOUT_MS = 10000;

export interface VerificarEvidenciaResult {
  tem_evidencia: boolean;
  foto_url: string | null;
  motivo?: string;
}

export async function temEvidenciaParaOc(
  supabase: SupabaseClient,
  nf: string,
  cnpjPagador: string,
  codOcorrencia: number,
): Promise<VerificarEvidenciaResult> {
  // 1. Busca senha SSW do cliente em tracking_credentials
  const { data: creds, error: credsErr } = await supabase
    .from("tracking_credentials")
    .select("senha")
    .eq("documento", cnpjPagador)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  if (credsErr || !creds || !creds.senha) {
    return {
      tem_evidencia: false,
      foto_url: null,
      motivo: `tracking_credentials sem senha pra cnpj=${cnpjPagador}`,
    };
  }

  const senha = creds.senha as string;

  // 2. Faz scraping em 2 hops
  const url = await resolveFotoUrlFiltrada({
    cnpjpag: cnpjPagador,
    nf,
    senha,
    codOcorrencia,
  });

  if (url) {
    return { tem_evidencia: true, foto_url: url };
  }
  return {
    tem_evidencia: false,
    foto_url: null,
    motivo: `Sem btn_foto correlacionado a oc=${codOcorrencia} no HTML SSW`,
  };
}

interface ScrapeInput {
  cnpjpag: string;
  nf: string;
  senha: string;
  codOcorrencia: number;
}

async function resolveFotoUrlFiltrada(
  input: ScrapeInput,
): Promise<string | null> {
  const jar = new Map<string, string>();
  function applySetCookie(headers: Headers) {
    const list: string[] =
      (headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    for (const raw of list) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1).trim();
      if (k && v) jar.set(k, v);
    }
  }
  function cookieHeader(): string {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const auth = await fetch(SSW_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
        cookie: cookieHeader(),
      },
      body: new URLSearchParams({
        cnpjpag: input.cnpjpag,
        NR: input.nf,
        chave: input.senha,
        urlori: VOLTAR_URL,
      }),
      redirect: "manual",
      signal: ctrl.signal,
    });
    applySetCookie(auth.headers);
    if (auth.status >= 500) return null;

    const auth1Text = await auth.text();
    const detalheParam = auth1Text.match(
      /ssw_SSWDetalhado\?id=([^"'&\s]+)&md=([^"'&\s]+)/,
    );
    if (!detalheParam) return null;
    const idParam = detalheParam[1]!;
    const mdParam = detalheParam[2]!;

    const detalhe = await fetch(
      `${SSW_DETALHE_URL}?id=${encodeURIComponent(idParam)}&md=${encodeURIComponent(mdParam)}`,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
          cookie: cookieHeader(),
          Referer: SSW_AUTH_URL,
        },
        redirect: "follow",
        signal: ctrl.signal,
      },
    );
    applySetCookie(detalhe.headers);
    const html = await detalhe.text();
    if (!html) return null;

    return parseFotoForOc(html, input.codOcorrencia);
  } catch (err) {
    console.error(`verificar-evidencia scrape falhou pra nf=${input.nf} oc=${input.codOcorrencia}:`, err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const OCS_PRECISAM_EVIDENCIA: ReadonlySet<number> = new Set([10, 11, 35]);

/**
 * Helper compartilhado entre sync-bastao e vinculador: se card recém-criado
 * está em oc=10/11/35 e SSW não tem foto naquela oc, dispara
 * auto_lancar_oc56_sem_evidencia. Devolve true se lançou (caller pula
 * proporAutoAcaoSeAplicavel — card sai do fluxo humano).
 *
 * Erros de scraping/RPC retornam false (segue fluxo humano normal — fail-safe).
 */
export async function tentarLancarOc56AutonomoSeSemEvidencia(
  supabase: SupabaseClient,
  cardId: string,
  nf: string | null,
  cnpjPagador: string | null,
  codOcorrencia: number | null,
): Promise<boolean> {
  if (!nf || !cnpjPagador || codOcorrencia == null) return false;
  if (!OCS_PRECISAM_EVIDENCIA.has(codOcorrencia)) return false;

  let resultado: VerificarEvidenciaResult;
  try {
    resultado = await temEvidenciaParaOc(supabase, nf, cnpjPagador, codOcorrencia);
  } catch (err) {
    console.error(`tentarLancarOc56 scrape exception card ${cardId}:`, err);
    return false;
  }

  if (resultado.tem_evidencia) return false;

  const { error: rpcErr } = await supabase.rpc("auto_lancar_oc56_sem_evidencia", {
    p_card_id: cardId,
  });
  if (rpcErr) {
    console.error(`auto_lancar_oc56 RPC erro card ${cardId}: ${rpcErr.message}`);
    return false;
  }
  return true;
}

/**
 * Mapeamento codigo_ssw → keywords da DESCRIÇÃO que SSW exibe no HTML.
 * Caio 2026-05-06: SSW não mostra o número da oc no HTML; mostra a descrição
 * textual. Pra correlacionar foto → oc, procuramos keywords do texto da oc
 * no contexto ANTES do btn_foto.
 *
 * Cada entry: lista de palavras (UPPERCASE, sem acentos) que precisam
 * APARECER no contexto pra considerar match. Match parcial (qualquer 1
 * keyword bate). Pra ocs com risco de overlap (ex: 10 vs 35 = ambas
 * "RECUSA"), usa keywords mais específicas.
 */
const OC_KEYWORDS_HTML: Record<number, string[]> = {
  10: ["RECUSA TOTAL", "RECUSA/NAO PODE", "NAO PODE RECEBER"],
  11: ["ENDERECO", "ENDEREÇO", "PROBLEMA NO ENDERECO"],
  35: ["RECUSA PARCIAL", "PARCIAL"],
  49: ["FALTA DE VOLUME", "FALTA VOLUME", "TRATATIVA"],
};

/**
 * Normaliza texto pra match: remove acentos, uppercase, remove tags HTML
 * e colapsa espaços.
 */
function normalizarTextoMatch(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Parser que filtra btn_foto pela ocorrência específica.
 *
 * Estratégia (Caio 2026-05-06 — refinada após bug NF 690521):
 *  1. Acha todos os btn_foto no HTML.
 *  2. Pra cada um, pega 600 chars ANTES do botão (contexto da linha do
 *     histórico SSW), normaliza (remove tags + acentos + uppercase).
 *  3. Procura keywords do `OC_KEYWORDS_HTML[codOcorrencia]` no contexto.
 *     Se qualquer keyword bate → match.
 *  4. Fallback: se nenhum btn_foto bate por keyword MAS há exatamente 1
 *     btn_foto no HTML inteiro, considera match (caso comum: NF tem só 1
 *     evidência, presumivelmente da última oc).
 *  5. Sem match → null. Página /r mostra "indisponível".
 */
export function parseFotoForOc(html: string, codOcorrencia: number): string | null {
  const btnFotoPattern = /<a[^>]*id=["']btn_foto["'][^>]*pid=["']([^"']+)["'][^>]*ft=["']([^"']+)["'][^>]*emp=["']([^"']+)["']/gi;
  const fotos = [...html.matchAll(btnFotoPattern)];
  if (fotos.length === 0) return null;

  const keywords = OC_KEYWORDS_HTML[codOcorrencia] ?? [];
  const keywordsNorm = keywords.map((k) => normalizarTextoMatch(k));

  // Tenta match por keyword
  if (keywordsNorm.length > 0) {
    for (const f of fotos) {
      const start = Math.max(0, f.index! - 600);
      const contexto = normalizarTextoMatch(html.slice(start, f.index!));
      const bate = keywordsNorm.some((k) => contexto.includes(k));
      if (bate) {
        return `${SSW_BASE}/2/picture?key=${encodeURIComponent(f[1]!)}&key2=${encodeURIComponent(f[2]!)}&e=${encodeURIComponent(f[3]!)}`;
      }
    }
  }

  // Fallback: 1 única foto no histórico → assume que é da última oc.
  // Caso comum em NFs de Sal Express (cliente recusa, motorista anexa 1 foto).
  if (fotos.length === 1) {
    const f = fotos[0]!;
    return `${SSW_BASE}/2/picture?key=${encodeURIComponent(f[1]!)}&key2=${encodeURIComponent(f[2]!)}&e=${encodeURIComponent(f[3]!)}`;
  }

  return null;
}
