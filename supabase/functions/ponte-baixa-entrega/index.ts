// =============================================================================
// ponte-baixa-entrega — o Roteirizador manda a baixa do motorista (ADR 0040,
// "Ponte v3: baixa do motorista").
//
//   POST { baixaId, tipo, codigoOcorrencia, ctrc, nf, ocorridoEm, recebidoEm,
//          recebedor, geo, evidencias, motorista, rota, base }
//        → 202 recebido · 200 mesmo baixaId · 409 conteúdo diferente · 422 · 503 · 401
//   GET  ?ids=a,b → [{ baixaId, status, em, motivo }]
//
// Este endpoint NUNCA fala com o SSW nem com o Roteirizador: só registra a baixa.
// Quem baixa a evidência e lança no SSW é o worker processar-baixas-motorista,
// por fila com limite de vazão (INV-159). Auth: Bearer PONTE_OPERACAO_TOKEN.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { json, tokenDaPonte } from "../_shared/ponte-operacao-comum.ts";
import { handleBaixa } from "../_shared/baixa-motorista-contrato.ts";
import { criarRepoRecepcao } from "../_shared/baixa-motorista-repo.ts";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ erro: "falha_interna", mensagem: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return await handleBaixa(req, { token: tokenDaPonte(env), repo: criarRepoRecepcao(supabase) });
});
