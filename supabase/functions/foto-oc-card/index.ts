// =============================================================================
// foto-oc-card — proxia foto de oc específica do card pra operadora ver
// inline no front (aba HISTÓRICO SSW).
//
// Caio 2026-05-13 (bonus do plano "hoje-usamos-o-bastao"):
//
// Hoje "TRAZER HISTÓRICO SSW" mostra ocs com `tem_foto: boolean`. Larissa
// pediu pra clicar e ver a foto sem precisar entrar no SSW manualmente.
// Esta edge function faz o proxy: recebe { card_id, codigo_oc } com auth
// do operador, valida acesso ao card via RLS, baixa foto via SSW interno
// (mesma cadeia do r-evidencia), retorna binary inline.
//
// Diferenças de r-evidencia:
//   - Auth: operador (Authorization header) — não token público.
//   - Input: card_id (RLS valida) + codigo_oc — não token de cliente.
//   - Sem expiração / sem contador de acessos.
//   - Sem geração de token em tokens_evidencia.
//
// Input: POST { card_id: uuid, codigo_oc: number }
// Output: image/jpeg|pdf binary inline OR JSON erro
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { obterFotoDaOc, loadSswInternalEnvForCard } from "../_shared/ssw-internal-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST esperado" }, 405);
  }

  const env = Deno.env.toObject();

  // Auth do operador via RLS: cria client com Authorization header forwardado.
  // SELECT em cards respeita RLS — se operador não tem acesso ao card, retorna null.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUser = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_ANON_KEY"]!,
    { global: { headers: { Authorization: authHeader } } },
  );

  // Caio 2026-05-27: aceita idx opcional pra galeria multi-foto.
  // Default 0 = 1ª foto (comportamento legado).
  let body: { card_id?: string; codigo_oc?: number; idx?: number };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body.card_id || typeof body.codigo_oc !== "number") {
    return json({ ok: false, error: "{ card_id, codigo_oc } obrigatórios" }, 400);
  }
  const idx = typeof body.idx === "number" && Number.isInteger(body.idx) && body.idx >= 0 ? body.idx : 0;

  // 1. Lê card via RLS — só passa se operador tem acesso
  const { data: card, error: cardErr } = await supabaseUser
    .from("cards")
    .select("id, nf, ctrc")
    .eq("id", body.card_id)
    .maybeSingle();

  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: "card não encontrado ou sem acesso" }, 404);
  if (!card.nf) return json({ ok: false, error: "card sem NF" }, 400);

  // 2. Busca foto via SSW interno (mesma cadeia do r-evidencia).
  // Caio 2026-05-13 (NF 20761): NFs com múltiplos CTRCs (reentrega/complementar)
  // exigem ctrcEsperado pra escolher o certo no SSW. card.ctrc é a fonte canônica.
  try {
    // Caio 2026-05-15 (multi-operador): credenciais do operador do card.
    // Usa service client pra lookup em operadores.nome (RLS bloqueia operador).
    const supabaseSvc = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const sswEnv = await loadSswInternalEnvForCard(supabaseSvc, env, card.id as string);
    const r = await obterFotoDaOc(sswEnv, card.nf as string, body.codigo_oc, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
      idx,
    });

    if (r.status === "ok") {
      return new Response(r.binary, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": r.content_type,
          "Cache-Control": "private, max-age=3600",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Disposition": "inline",
          // Caio 2026-05-27: expõe pro front pra renderizar contador "X de N"
          // e navegação. CORS expose-headers permite leitura no client.
          "X-Fotos-Total": String(r.fotos_total),
          "X-Idx-Atual": String(r.idx_atual),
          // Caio 2026-05-28 (NF 696530): metadata da linha SSW de origem
          // pra galeria mostrar "26/05 14:37 POA · RECUSA TOTAL" e
          // diferenciar fotos de múltiplos lançamentos da mesma oc.
          ...(r.foto_data ? { "X-Foto-Data": r.foto_data } : {}),
          ...(r.foto_instrucao ? { "X-Foto-Instrucao": encodeURIComponent(r.foto_instrucao.slice(0, 200)) } : {}),
          "Access-Control-Expose-Headers": "X-Fotos-Total, X-Idx-Atual, X-Foto-Data, X-Foto-Instrucao",
        },
      });
    }

    if (r.status === "idx_invalido") {
      return json({
        ok: false,
        error: "idx_invalido",
        codigo_oc: body.codigo_oc,
        idx_pedido: r.idx_pedido,
        fotos_total: r.fotos_total,
      }, 400);
    }

    if (r.status === "oc_sem_foto") {
      return json({
        ok: false,
        error: "oc_sem_foto",
        descricao: r.descricao,
        codigo_oc: body.codigo_oc,
      }, 404);
    }

    if (r.status === "oc_nao_encontrada") {
      return json({
        ok: false,
        error: "oc_nao_encontrada",
        codigo_oc: body.codigo_oc,
        ocs_disponiveis: r.ocs_disponiveis,
      }, 404);
    }

    // erro_ssw
    return json({ ok: false, error: "ssw_erro", motivo: r.motivo }, 502);
  } catch (err) {
    return json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, 502);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
