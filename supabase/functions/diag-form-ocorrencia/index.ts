// =============================================================================
// diag-form-ocorrencia — TEMPORÁRIO (Caio 2026-06-08)
//
// Inspeciona o HTML do form de "Incluir Ocorrência" no SSW interno (act=O)
// pra mapear os field names exatos antes de generalizar lancarOcorrenciaPortal.
//
// Em particular: descobrir se "Instrução" (textarea grande) tem name diferente
// de "Informações complementares" (campo curto que o código atual preenche
// em `f6` com slice(0,70)).
//
// Auth: nenhum (--no-verify-jwt). REMOVER após investigação.
//
// Input: POST { card_id: uuid }
// Output: dump de todos <input>, <textarea>, <select> do HTML do form
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  obterSessao,
  buscarNFInterno,
  loadSswInternalEnvForCard,
} from "../_shared/ssw-internal-client.ts";

const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST", { status: 405 });
  const env = Deno.env.toObject();

  let body: { card_id?: string };
  try {
    body = await req.json();
  } catch {
    return j({ ok: false, error: "bad json" }, 400);
  }
  if (!body.card_id) return j({ ok: false, error: "card_id obrigatório" }, 400);

  const sb = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: card } = await sb.from("cards")
    .select("id, nf, ctrc, responsavel_relacionamento")
    .eq("id", body.card_id)
    .maybeSingle();
  if (!card) return j({ ok: false, error: "card not found" }, 404);

  try {
    const sswEnv = await loadSswInternalEnvForCard(sb, env, card.id as string);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, card.nf as string, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
    });

    // POST act=O — abre a tela "Ocorrências" igual ao lancarOcorrenciaPortal faz
    const formO = new URLSearchParams({
      act: "O",
      seq_ctrc: detalhe.seq_ctrc,
      FAMILIA: detalhe.familia,
      t_nro_nf: detalhe.nf,
    });
    const cookieStr = [...sessao.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const rO = await fetch(`${BASE}/bin/ssw0053`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE}/bin/ssw0053`,
        cookie: cookieStr,
      },
      body: formO,
      redirect: "manual",
    });
    const htmlO = await rO.text();

    // Extrai TODOS <input>, <textarea>, <select> com seus atributos relevantes
    const inputs = [...htmlO.matchAll(/<input\b([^>]*)>/gi)].map((m) => parseAttrs(m[1]!));
    const textareas = [...htmlO.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)].map((m) => ({
      ...parseAttrs(m[1]!),
      content_preview: (m[2] ?? "").slice(0, 100),
    }));
    const selects = [...htmlO.matchAll(/<select\b([^>]*)>/gi)].map((m) => parseAttrs(m[1]!));

    // Procura labels visíveis pra correlacionar com names
    const labels = [...htmlO.matchAll(/<div\s+class="?texto"?[^>]*>([^<]+)<\/div>/gi)].map((m) => m[1]?.trim()).filter(Boolean);

    // Strings reveladoras
    const hasInstrucao = /Inst[r&]?[ua][cç&]?[a&]o:/i.test(htmlO);
    const hasInfoComplementar = /Informa[cç&]?[ouõo][es&]?\s+complementares?:/i.test(htmlO);
    const hasFotografar = /Fotografar|Buscar no meu micro/i.test(htmlO);

    return j({
      ok: true,
      nf: card.nf,
      ctrc: card.ctrc,
      seq_ctrc: detalhe.seq_ctrc,
      familia: detalhe.familia,
      responsavel: card.responsavel_relacionamento,
      html_len: htmlO.length,
      labels_visiveis: labels,
      inputs_count: inputs.length,
      inputs: inputs.filter((i) => i.name || i.id), // só os com name/id
      textareas_count: textareas.length,
      textareas,
      selects_count: selects.length,
      selects: selects.filter((s) => s.name || s.id),
      has_instrucao_label: hasInstrucao,
      has_info_complementar_label: hasInfoComplementar,
      has_imagem_widget: hasFotografar,
      // Pra fim de calibração: pega todo trecho HTML em volta dos campos de texto
      area_textos_html: extractAreaTextos(htmlO).slice(0, 4000),
    }, 200);
  } catch (err) {
    return j({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)\s*=\s*"([^"]*)"/gi)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  // attrs sem aspas
  for (const m of s.matchAll(/(\w+)\s*=\s*([^"\s>]+)/gi)) {
    if (!out[m[1]!.toLowerCase()]) out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

function extractAreaTextos(html: string): string {
  // Pega entre "Incluir Ocorrência" e "Resposta a um Fale Conosco" (campos visíveis no print)
  const start = html.search(/Incluir\s+Ocorr[eê]ncia/i);
  const end = html.search(/Resposta\s+a\s+um\s+Fale\s+Conosco/i);
  if (start < 0) return html.slice(0, 4000);
  const endIdx = end > start ? end + 100 : Math.min(start + 4000, html.length);
  return html.slice(start, endIdx);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
