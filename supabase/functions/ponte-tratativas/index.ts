// =============================================================================
// ponte-tratativas — o Roteirizador lê, por CTRC, o estado da tratativa no
// Cockpit (ADR 0035, contrato v2 parte A). LEITURA PURA.
//
//   POST { ctrcs: [...] }  (até 1000, normalizados)  Bearer ROTEIRIZADOR_PONTE_TOKEN
//   → 200 { geradoEm, tratativas: [...], semCard: [...] }
//
// Sem o segredo → 503. Token errado → 401. Flag ponte_operacao_leitura OFF → 503
// (depois de autenticar, antes de qualquer SELECT de negócio). Nunca grava nada.
// Regra do bloqueiaEntrega: _shared/ponte-operacao-bloqueio.ts.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { json, tokenDaPonte } from "../_shared/ponte-operacao-comum.ts";
import { criarRepoTratativas } from "../_shared/ponte-operacao-repo.ts";
import { handleTratativas } from "../_shared/ponte-operacao-tratativas.ts";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ erro: "falha_interna", mensagem: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return await handleTratativas(req, {
    token: tokenDaPonte(env),
    appUrl: (env["COCKPIT_APP_URL"] ?? "").trim() || null,
    repo: criarRepoTratativas(supabase),
  });
});
