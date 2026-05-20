// =============================================================================
// atualizar-card-via-tracking — WRAPPER DEPRECATED (Caio 2026-05-20).
//
// Nome desatualizado. Função real renomeada pra `atualizar-card-via-portal-ssw`
// pra refletir fonte verdadeira (portal SSW interno opção 101, não tracking
// público). Esse wrapper proxy mantém compat enquanto front Lovable migra
// pro nome novo.
//
// Encaminha o request pra `atualizar-card-via-portal-ssw` preservando body e
// auth. Remover quando todo invoke do Lovable estiver atualizado.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    return new Response(
      JSON.stringify({ ok: false, error: "SUPABASE_URL não configurado" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const targetUrl = `${supabaseUrl}/functions/v1/atualizar-card-via-portal-ssw`;
  const body = await req.text();
  const headers = new Headers(req.headers);
  headers.delete("host");

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: body || undefined,
  });

  const respBody = await upstream.text();
  return new Response(respBody, {
    status: upstream.status,
    headers: { ...corsHeaders, "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
});
