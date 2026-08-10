// =============================================================================
// trava-visualizacao — guard "modo visualização" pras edge functions mutantes
// invocadas pelo front com JWT do usuário (mig 324, Caio 2026-08-10).
//
// João/Isadora (operadores.pode_executar=false) veem tudo mas não executam.
// service_role (cron/edge-to-edge) NUNCA é travado. Sem operador → passa
// (não quebrar chamadas legítimas fora do quadro de operadores).
//
// Uso no handler, depois do preflight CORS:
//   const bloqueio = await bloquearSeModoVisualizacao(req, supabaseAdmin);
//   if (bloqueio) return bloqueio;
// =============================================================================

// Estrutural mínimo com PromiseLike: o PostgrestBuilder do supabase-js é
// thenable mas não Promise, e o tipo fechado explodia TS2589 nos callers.
type ClienteAdmin = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        maybeSingle: () => PromiseLike<{ data: { pode_executar?: boolean | null } | null }>;
      };
    };
  };
};

/** Decodifica claims do Bearer sem verificar assinatura (gateway já verificou
 * quando verify_jwt=true; pra service_role o claim `role` decide). */
export function claimsDoBearer(req: Request): { role?: string; sub?: string } {
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return { role: payload?.role, sub: payload?.sub };
  } catch {
    return {};
  }
}

/** Retorna Response 403 se o caller é operador com pode_executar=false; null
 * libera. Falha de lookup → libera (fail-open: trava é pra 2 gestores
 * conhecidos, não pode derrubar operação por instabilidade). */
export async function bloquearSeModoVisualizacao(
  req: Request,
  // unknown + cast interno: comparar o SupabaseClient real com tipo estrutural
  // explode TS2589 (instanciação profunda) em todos os callers.
  adminClient: unknown,
  corsHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const { role, sub } = claimsDoBearer(req);
  if (role === "service_role" || !sub) return null;
  const admin = adminClient as ClienteAdmin;
  try {
    const { data } = await admin
      .from("operadores")
      .select("pode_executar")
      .eq("user_id", sub)
      .maybeSingle();
    if (data && data.pode_executar === false) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "MODO_VISUALIZACAO: seu usuário é somente visualização — ações bloqueadas",
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  } catch {
    return null;
  }
  return null;
}
