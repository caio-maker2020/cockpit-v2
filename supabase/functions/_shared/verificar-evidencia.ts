// =============================================================================
// verificar-evidencia — checa se SSW tem foto correlacionada à oc atual da NF.
//
// Caio 2026-05-07 (incidente das 6 NFs com oc=56 falsa):
// SEM AÇÃO AUTÔNOMA. Sistema apenas SUGERE pra Larissa via banner amarelo no
// front (cards.evidencia_status + cards.evidencia_diagnostico). Larissa decide
// manualmente entre as 4 propostas (21/54+email/44/56) que `proporAutoAcao`
// sempre cria.
//
// Regra estrita: foto válida precisa estar OBRIGATORIAMENTE na linha da oc
// 10/11/35 — keyword da descrição da oc deve bater no contexto antes do
// btn_foto. Foto em outra linha (REMETENTE AVALIA, LOCAL DE ENTREGA NAO
// LOCALIZADO etc) NÃO conta como evidência válida.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

const SSW_BASE = "https://ssw.inf.br";
const SSW_AUTH_URL = `${SSW_BASE}/2/ssw_resultSSW_pag_nro`;
const SSW_DETALHE_URL = `${SSW_BASE}/2/ssw_SSWDetalhado`;
const VOLTAR_URL = `${SSW_BASE}/`;
const TIMEOUT_MS = 10000;

export type VerificarEvidenciaResult =
  | { status: "ok_com_foto_correlacionada"; foto_url: string }
  | { status: "ok_sem_btn_foto" }
  | {
      status: "ambiguo_foto_em_outra_oc";
      total_fotos: number;
      titulo_linha_foto: string | null;
      foto_url_amostra: string;
    }
  | { status: "scrape_indisponivel"; motivo: string };

export const OCS_PRECISAM_EVIDENCIA: ReadonlySet<number> = new Set([10, 11, 35]);

// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
// temEvidenciaParaOc REESCRITO pra usar SSW interno (opção 101) em vez de
// scrape do tracking SSW público. Antes consultava `tracking_credentials`
// pra pegar senha cliente; agora usa login Sal compartilhado que cobre todas
// as ocs (público ocultava 31). Interface externa preservada — callers
// (executor, sync-bastao, vinculador, revalidar-evidencia-card) NÃO mudam.
//
// Mantém os 4 status do enum:
//   - ok_com_foto_correlacionada: oc-alvo TEM foto. foto_url aponta pro endpoint
//     do CGI SSW que serve o binário (precisa de sessão pra baixar, mas estamos
//     consumindo direto via obterFotoDaOc nos callers que querem o binário).
//   - ok_sem_btn_foto: oc-alvo existe mas sem foto.
//   - ambiguo_foto_em_outra_oc: usado no fluxo público antigo quando havia foto
//     mas associada a outra linha; SSW interno retorna foto por oc específica,
//     então esse caso só aparece se a oc-alvo sumir do histórico (raro).
//   - scrape_indisponivel: erro de scrape / NF não localizada.
export async function temEvidenciaParaOc(
  _supabase: SupabaseClient,
  nf: string,
  _cnpjPagador: string,
  codOcorrencia: number,
): Promise<VerificarEvidenciaResult> {
  try {
    const { obterSessao, buscarNFInterno, listarOcorrenciasNF, readSswInternalEnv } = await import(
      "./ssw-internal-client.ts"
    );
    const env = readSswInternalEnv(Deno.env.toObject());
    const sessao = await obterSessao(env);
    const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: null });
    const ocs = await listarOcorrenciasNF(sessao, detalhe);

    // Caio 2026-05-13 (NF 29326): múltiplas linhas do mesmo código no histórico.
    // Priorizar a que tem foto.
    const ocsDoCodigo = ocs.filter((o) => o.codigo === codOcorrencia);
    if (ocsDoCodigo.length === 0) {
      return {
        status: "scrape_indisponivel",
        motivo: `oc ${codOcorrencia} não encontrada no histórico SSW (NF ${nf}). ocs disponíveis: ${ocs.map((o) => o.codigo).join(",")}`,
      };
    }
    const ocAlvo = ocsDoCodigo.find((o) => o.fotos.length > 0) ?? ocsDoCodigo[0]!;

    if (ocAlvo.fotos.length === 0) {
      return { status: "ok_sem_btn_foto" };
    }

    // SSW interno retorna fotos por oc específica — foto_url é o path do CGI
    // que serve o binário (precisa de sessão). Callers que querem o binário
    // direto usam obterFotoDaOc; callers que só querem saber se TEM foto usam
    // o status. foto_url aqui é mantido pra compat com o tipo, mas não é mais
    // consumido pelo r-evidencia (que passou a usar obterFotoDaOc).
    return {
      status: "ok_com_foto_correlacionada",
      foto_url: ocAlvo.fotos[0]!.fotoPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "scrape_indisponivel", motivo: `SSW interno: ${msg}` };
  }
}

interface ScrapeInput {
  cnpjpag: string;
  nf: string;
  senha: string;
  codOcorrencia: number;
}

async function scrapeSsw(input: ScrapeInput): Promise<VerificarEvidenciaResult> {
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
    if (auth.status >= 500) {
      return { status: "scrape_indisponivel", motivo: `SSW auth HTTP ${auth.status}` };
    }

    const auth1Text = await auth.text();
    const detalheParam = auth1Text.match(
      /ssw_SSWDetalhado\?id=([^"'&\s]+)&md=([^"'&\s]+)/,
    );
    if (!detalheParam) {
      return { status: "scrape_indisponivel", motivo: "SSW auth ok mas sem link detalhe (senha errada?)" };
    }
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
    if (!html) {
      return { status: "scrape_indisponivel", motivo: "SSW detalhe HTML vazio" };
    }

    return analisarEvidenciaNoHtml(html, input.codOcorrencia);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "scrape_indisponivel", motivo: `scrape exception: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Mapeamento codigo_ssw → keywords da DESCRIÇÃO que SSW exibe no HTML.
 *
 * SSW NÃO mostra o número/código da oc no rastreio; mostra:
 *   - TÍTULO da linha (descrição padrão SSWMOBILE — ex: "REMETENTE AVALIA ENVIO NOVA MERCADORIA")
 *   - INSTRUÇÃO/DESCRIÇÃO abaixo (ex: "ENTREGA REALIZADA COM RECUSA PARCIAL", "LOCAL FECHADO (SSWMOBILE)")
 *
 * Caio 2026-05-08: ajustado mapeamento após confirmação dos prints.
 *   - oc=10: SSW mostra "RECUSA TOTAL DA ENTREGA" → bate keyword existente
 *   - oc=11: SSW mostra "LOCAL DE ENTREGA NAO LOCALIZADO" + descrição "LOCAL FECHADO" → keywords novas
 *   - oc=35: SSW mostra "REMETENTE AVALIA ENVIO NOVA MERCADORIA" + descrição "ENTREGA REALIZADA COM RECUSA PARCIAL" → keywords novas
 *
 * Parser pega contexto ANTES e DEPOIS do btn_foto pra cobrir título + descrição.
 */
const OC_KEYWORDS_HTML: Record<number, string[]> = {
  10: ["RECUSA TOTAL", "RECUSA/NAO PODE", "NAO PODE RECEBER"],
  11: [
    "ENDERECO",
    "PROBLEMA NO ENDERECO",
    "LOCAL DE ENTREGA NAO LOCALIZADO",
    "LOCAL FECHADO",
  ],
  35: [
    "RECUSA PARCIAL",
    "ENTREGA REALIZADA COM RECUSA PARCIAL",
    "REMETENTE AVALIA ENVIO NOVA MERCADORIA",
    "REMETENTE AVALIA",
  ],
};

function normalizarTextoMatch(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Analisa HTML do SSW e retorna status discriminado.
 *
 * Regra (Caio 2026-05-07 — sem fallback):
 *  - Sem nenhum btn_foto → `ok_sem_btn_foto`
 *  - btn_foto com keyword da oc no contexto → `ok_com_foto_correlacionada`
 *  - btn_foto existe mas sem keyword match → `ambiguo_foto_em_outra_oc`
 *    (com título da linha onde a foto está, pra mostrar pra Larissa)
 */
export function analisarEvidenciaNoHtml(
  html: string,
  codOcorrencia: number,
): VerificarEvidenciaResult {
  const btnFotoPattern = /<a[^>]*id=["']btn_foto["'][^>]*pid=["']([^"']+)["'][^>]*ft=["']([^"']+)["'][^>]*emp=["']([^"']+)["']/gi;
  const fotos = [...html.matchAll(btnFotoPattern)];

  if (fotos.length === 0) {
    return { status: "ok_sem_btn_foto" };
  }

  const keywords = OC_KEYWORDS_HTML[codOcorrencia] ?? [];
  const keywordsNorm = keywords.map((k) => normalizarTextoMatch(k));

  for (const f of fotos) {
    // Caio 2026-05-08: contexto = 600 chars ANTES + 400 chars DEPOIS do btn_foto.
    // SSW mostra TÍTULO da linha antes do btn_foto (ex: "LOCAL DE ENTREGA NAO
    // LOCALIZADO  GPS Foto") e DESCRIÇÃO abaixo (ex: "LOCAL FECHADO (SSWMOBILE)").
    // Janela "depois" captura a descrição. Match em qualquer posição vale.
    const start = Math.max(0, f.index! - 600);
    const end = Math.min(html.length, f.index! + (f[0]?.length ?? 0) + 400);
    const contexto = normalizarTextoMatch(html.slice(start, end));
    const bate = keywordsNorm.some((k) => contexto.includes(k));
    if (bate) {
      const url = `${SSW_BASE}/2/picture?key=${encodeURIComponent(f[1]!)}&key2=${encodeURIComponent(f[2]!)}&e=${encodeURIComponent(f[3]!)}`;
      return { status: "ok_com_foto_correlacionada", foto_url: url };
    }
  }

  // Foto existe mas nenhuma bate na oc atual — ambíguo.
  const primeira = fotos[0]!;
  const tituloLinha = extrairTituloLinhaFoto(html, primeira.index!);
  const fotoUrlAmostra = `${SSW_BASE}/2/picture?key=${encodeURIComponent(primeira[1]!)}&key2=${encodeURIComponent(primeira[2]!)}&e=${encodeURIComponent(primeira[3]!)}`;
  return {
    status: "ambiguo_foto_em_outra_oc",
    total_fotos: fotos.length,
    titulo_linha_foto: tituloLinha,
    foto_url_amostra: fotoUrlAmostra,
  };
}

/**
 * Pega o último `<b>...</b>` antes da posição do btn_foto (nome da linha do
 * histórico SSW onde a foto está anexada — ex: "REMETENTE AVALIA ENVIO NOVA
 * MERCADORIA"). Usado pra mostrar pra Larissa onde o sistema viu foto que
 * não correlaciona com a oc atual.
 */
function extrairTituloLinhaFoto(html: string, btnFotoPos: number): string | null {
  const before = html.slice(0, btnFotoPos);
  const matches = [...before.matchAll(/<b>([^<]{5,80})<\/b>/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!.trim();
}

/**
 * Caio 2026-05-11: helper de debug — extrai TODAS as fotos do HTML com seus
 * títulos (último <b>...</b> antes do btn_foto) + preview de 200 chars do
 * contexto. Usado pra mapear keywords de ocs novas no OC_KEYWORDS_HTML.
 */
function extrairTodasFotosTitulos(
  html: string,
): Array<{ titulo: string | null; contexto_preview: string }> {
  const pattern = /<a[^>]*id=["']btn_foto["'][^>]*pid=["'][^"']+["'][^>]*ft=["'][^"']+["'][^>]*emp=["'][^"']+["']/gi;
  const fotos = [...html.matchAll(pattern)];
  return fotos.map((f) => {
    const start = Math.max(0, f.index! - 300);
    const end = Math.min(html.length, f.index! + (f[0]?.length ?? 0) + 200);
    const contextoRaw = html.slice(start, end);
    return {
      titulo: extrairTituloLinhaFoto(html, f.index!),
      contexto_preview: normalizarTextoMatch(contextoRaw).slice(0, 200),
    };
  });
}

/**
 * Diagnóstico humano gravado em `cards.evidencia_diagnostico` — mostrado
 * direto no banner amarelo do front. Texto exato alinhado com Caio 2026-05-07.
 */
export function montarDiagnostico(
  resultado: VerificarEvidenciaResult,
  codOcorrencia: number,
): string | null {
  switch (resultado.status) {
    case "ok_com_foto_correlacionada":
      return null; // sem banner
    case "ok_sem_btn_foto":
      return "Não encontrei nenhuma foto anexada no histórico SSW dessa NF. Sugiro lançar oc=56 (encaminhar Operação).";
    case "ambiguo_foto_em_outra_oc":
      return `Encontrei foto na linha '${resultado.titulo_linha_foto ?? "?"}', mas não na linha da oc atual (${codOcorrencia}). A regra exige foto exatamente na ocorrência 10/11/35. Olha o SSW e decide se aprova 54+email (foto válida que perdi) ou 56 (sem evidência da oc).`;
    case "scrape_indisponivel":
      return `Não consegui verificar evidência: ${resultado.motivo}. Olha o histórico SSW manualmente antes de aprovar.`;
  }
}

/**
 * Helper compartilhado entre sync-bastao e vinculador. Roda a verificação,
 * grava `cards.evidencia_status` + `cards.evidencia_diagnostico`, e insere
 * `card_event` `EvidenciaSugestaoIA`. NUNCA dispara ação autônoma — Larissa
 * decide manualmente.
 *
 * Caller continua chamando `proporAutoAcaoSeAplicavel` normalmente — as 4
 * propostas (21/54+email/44/56) seguem sendo criadas pra Larissa aprovar.
 */
/**
 * Caio 2026-05-11: bug NF 920161 — cliente recebia link `/r?t=<token>` que
 * apenas redirecionava pro trackingpag SSW público. Trackingpag oculta ~31
 * ocs (49, 56, 44, ...) e mostra só ocs visíveis (ex: oc=04 entrega anterior).
 * Resultado: cliente via foto da oc errada.
 *
 * Fix: este helper faz o scrape completo (auth + detalhe + parse) E baixa o
 * BINÁRIO da foto da oc específica usando a mesma sessão SSW autenticada.
 * `r-evidencia` proxia esse binário direto pro cliente — cliente nunca cai
 * no trackingpag.
 *
 * Retorno discriminado: foto baixada com sucesso OU motivo da indisponibilidade
 * pra renderizar mensagem educada.
 */
export type FotoEvidenciaResult =
  | {
      status: "ok";
      binary: Uint8Array;
      content_type: string;
      foto_url: string;
    }
  | {
      status: "sem_btn_foto";
    }
  | {
      status: "ambiguo_foto_em_outra_oc";
      titulo_linha_foto: string | null;
      // Caio 2026-05-11: lista todas as fotos achadas pra debug — usado pra
      // mapear keywords novas (ex: oc=49) quando o parser não correlaciona.
      todas_fotos_titulos: Array<{ titulo: string | null; contexto_preview: string }>;
    }
  | {
      status: "scrape_indisponivel";
      motivo: string;
    };

export async function obterFotoBinarioEvidencia(
  supabase: SupabaseClient,
  nf: string,
  cnpjPagador: string,
  codOcorrencia: number,
): Promise<FotoEvidenciaResult> {
  const { data: creds, error: credsErr } = await supabase
    .from("tracking_credentials")
    .select("senha")
    .eq("documento", cnpjPagador)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  if (credsErr) {
    return { status: "scrape_indisponivel", motivo: `tracking_credentials erro: ${credsErr.message}` };
  }
  const senha = (creds as { senha?: string } | null)?.senha;
  if (!senha) {
    return { status: "scrape_indisponivel", motivo: `Sem credentials SSW pra cnpj=${cnpjPagador}` };
  }

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
  const timeoutId = setTimeout(() => ctrl.abort(), TIMEOUT_MS * 2);

  try {
    // 1. Auth SSW (POST)
    const auth = await fetch(SSW_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
        cookie: cookieHeader(),
      },
      body: new URLSearchParams({
        cnpjpag: cnpjPagador,
        NR: nf,
        chave: senha,
        urlori: VOLTAR_URL,
      }),
      redirect: "manual",
      signal: ctrl.signal,
    });
    applySetCookie(auth.headers);
    if (auth.status >= 500) {
      return { status: "scrape_indisponivel", motivo: `SSW auth HTTP ${auth.status}` };
    }

    const auth1Text = await auth.text();
    const detalheParam = auth1Text.match(
      /ssw_SSWDetalhado\?id=([^"'&\s]+)&md=([^"'&\s]+)/,
    );
    if (!detalheParam) {
      return { status: "scrape_indisponivel", motivo: "SSW auth ok mas sem link detalhe (senha errada?)" };
    }
    const idParam = detalheParam[1]!;
    const mdParam = detalheParam[2]!;

    // 2. GET detalhe
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
    if (!html) {
      return { status: "scrape_indisponivel", motivo: "SSW detalhe HTML vazio" };
    }

    // 3. Reusa o parser pra achar foto correlacionada
    const analise = analisarEvidenciaNoHtml(html, codOcorrencia);
    if (analise.status === "ok_sem_btn_foto") {
      return { status: "sem_btn_foto" };
    }
    if (analise.status === "ambiguo_foto_em_outra_oc") {
      return {
        status: "ambiguo_foto_em_outra_oc",
        titulo_linha_foto: analise.titulo_linha_foto,
        todas_fotos_titulos: extrairTodasFotosTitulos(html),
      };
    }
    if (analise.status === "scrape_indisponivel") {
      return analise; // já tem motivo
    }

    // 4. Baixa o binário da foto com a mesma sessão autenticada
    const fotoUrl = analise.foto_url;
    const fotoRes = await fetch(fotoUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SalExpressEvidencia/1.0)",
        cookie: cookieHeader(),
        Referer: `${SSW_DETALHE_URL}?id=${encodeURIComponent(idParam)}`,
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!fotoRes.ok) {
      return {
        status: "scrape_indisponivel",
        motivo: `SSW picture HTTP ${fotoRes.status}`,
      };
    }
    const contentType = fotoRes.headers.get("content-type") ?? "image/jpeg";
    const buf = new Uint8Array(await fotoRes.arrayBuffer());
    if (buf.byteLength === 0) {
      return {
        status: "scrape_indisponivel",
        motivo: "SSW picture body vazio",
      };
    }
    return {
      status: "ok",
      binary: buf,
      content_type: contentType,
      foto_url: fotoUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "scrape_indisponivel", motivo: `scrape/download exception: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function verificarEvidenciaESinalizar(
  supabase: SupabaseClient,
  cardId: string,
  nf: string | null,
  cnpjPagador: string | null,
  codOcorrencia: number | null,
): Promise<void> {
  if (!nf || !cnpjPagador || codOcorrencia == null) return;
  if (!OCS_PRECISAM_EVIDENCIA.has(codOcorrencia)) return;

  let resultado: VerificarEvidenciaResult;
  try {
    resultado = await temEvidenciaParaOc(supabase, nf, cnpjPagador, codOcorrencia);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    resultado = { status: "scrape_indisponivel", motivo: `exception fora do scrape: ${msg}` };
  }

  const diagnostico = montarDiagnostico(resultado, codOcorrencia);

  await supabase.from("cards").update({
    evidencia_status: resultado.status,
    evidencia_diagnostico: diagnostico,
  }).eq("id", cardId);

  await supabase.from("card_events").insert({
    card_id: cardId,
    event_type: "EvidenciaSugestaoIA",
    actor_type: "system",
    actor_id: "verificar-evidencia",
    payload: { ...resultado, cod_ocorrencia: codOcorrencia, nf, cnpj_pagador: cnpjPagador },
  });
}
