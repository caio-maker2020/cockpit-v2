// =============================================================================
// service-auth — gate "service role only" por CAPACIDADE, não por igualdade
// de string (Caio 26/08, cerebro/converter): comparar o header com
// Deno.env.SUPABASE_SERVICE_ROLE_KEY quebrou quando o platform rotacionou os
// secrets injetados (digest do runtime ≠ chave legacy do vault/cron/admin).
//
// Aqui o token do CHAMADOR é usado num client e testado contra uma RPC
// inócua com GRANT exclusivo pro service_role (cancelar_acoes_agendadas_do_card,
// mig 035 — uuid zero ⇒ 0 linhas, nenhum efeito). Não-service → permission
// denied. Funciona com chave legacy, nova, rotacionada — qualquer credencial
// que DE FATO seja service deste projeto.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

export async function ehChamadaServiceRole(
  supabaseUrl: string,
  authHeader: string | null,
): Promise<boolean> {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const probe = createClient(supabaseUrl, token, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await probe.rpc("cancelar_acoes_agendadas_do_card", {
      p_card_id: UUID_ZERO,
      p_motivo: "auth-probe (inócuo — uuid zero)",
    });
    return !error;
  } catch {
    return false;
  }
}
