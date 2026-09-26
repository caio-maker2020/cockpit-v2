// =============================================================================
// ponte-pedido-operacao — o Roteirizador PEDE, o Cockpit executa (ADR 0035,
// contrato v2 parte B).
//
//   POST { pedidoId, tipo, ctrc, codigoOcorrencia?, texto, base?, solicitadoPor, criadoEm? }
//        → 202 recebido · 200 pedidoId já visto · 422 inválido · 503 desligado · 401
//   GET  ?pedidoId=uuid → status (recebido | executado | recusado | erro)
//
// Este endpoint NUNCA fala com o SSW nem com o Bastão: registra o pedido e, se o
// CTRC já tem card, grava o evento no card. O resto é do worker
// processar-pedidos-operacao, por fila com limite de vazão (INV-159).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { json, tokenDaPonte } from "../_shared/ponte-operacao-comum.ts";
import { handlePedido } from "../_shared/ponte-operacao-pedido.ts";
import { criarRepoPedidos } from "../_shared/ponte-operacao-repo.ts";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ erro: "falha_interna", mensagem: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return await handlePedido(req, { token: tokenDaPonte(env), repo: criarRepoPedidos(supabase) });
});
