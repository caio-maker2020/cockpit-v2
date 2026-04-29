// =============================================================================
// finalize-import-chaves — fecha um run de import full-replace.
//
// Deleta todos os rows de nf_chave_cte cuja import_session != current.
// Resultado: tabela contém EXATAMENTE o que veio no último run completo.
//
// Chamada pelo script Python (ou RPA) após enviar todos os batches do CSV
// daquela execução. Se algo falhar antes do finalize ser chamado, sessions
// anteriores ficam intactas — banco mantém estado consistente.
//
// Uso:
//   POST /functions/v1/finalize-import-chaves
//   Headers:
//     Authorization: Bearer <SERVICE_ROLE_KEY>
//     X-Import-Session: <session_id que foi usado nos batches>
//
// Retorno:
//   { session, deleted_old_sessions, kept_current_session, finalized_at }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-import-session",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const session = req.headers.get("x-import-session");
  if (!session || session.trim().length === 0) {
    return jsonResponse(400, {
      error:
        "Header X-Import-Session obrigatório. Deve ser o mesmo session_id usado nos POSTs de /import-chaves-cte.",
    });
  }

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data, error } = await supabase.rpc("finalize_import_chaves_cte", {
      p_current_session: session,
    });

    if (error) {
      console.error("finalize falhou:", error);
      return jsonResponse(500, { error: error.message });
    }

    console.log("finalize-import-chaves:", JSON.stringify(data));
    return jsonResponse(200, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("finalize fatal:", msg);
    return jsonResponse(500, { error: msg });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
