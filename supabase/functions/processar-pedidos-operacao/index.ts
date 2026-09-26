// =============================================================================
// processar-pedidos-operacao — worker dos pedidos da operação (ADR 0035).
// Cron de 1 min (mig 412). Flag ponte_operacao_pedidos OFF → `skipped: flag_off`
// antes de qualquer outra leitura.
//
// A ÚNICA porta para o SSW é o envelope `lancarSswPortal` (idempotência em
// acoes_executadas_ssw + tripé CTRC/NF/Localização + conta de serviço ai.salex).
// A vazão é contada no banco (RPC ponte_operacao_reservar_lancamentos): chamar
// esta função N vezes num minuto não passa de 3 lançamentos (INV-159).
// Lógica em _shared/ponte-operacao-worker.ts (testada com repositório falso).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { lancarSswPortal } from "../_shared/lancar-ssw-portal.ts";
import { type BastaoClient, createBastaoClient, readBastaoEnvFromProcess } from "../_shared/bastao-client.ts";
import { OCS_CLIENTE } from "../_shared/bastao-rules.ts";
import { resolverCamposAtribuicaoDoCard } from "../_shared/operador-resolver.ts";
import { json } from "../_shared/ponte-operacao-comum.ts";
import { criarRepoWorker } from "../_shared/ponte-operacao-repo.ts";
import { type DepsWorker, type PendenciaBastaoMin, rodarWorkerPedidos } from "../_shared/ponte-operacao-worker.ts";

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ ok: false, erro: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  let bastao: BastaoClient | null = null;
  const deps: DepsWorker = {
    repo: criarRepoWorker(supabase),
    async buscarPendenciaPorCtrc(ctrc) {
      bastao ??= createBastaoClient({ env: readBastaoEnvFromProcess(env) });
      return (await bastao.fetchPendenciaByCtrc(ctrc)) as PendenciaBastaoMin | null;
    },
    resolverAtribuicao: (p) =>
      resolverCamposAtribuicaoDoCard(supabase, {
        responsavelNome: p.responsavel_relacionamento,
        cnpjPagador: p.cnpj_pagador,
        segmentoCodigo: p.segmento_cliente,
      }),
    ocsCliente: OCS_CLIENTE,
    // Sem todoId: a idempotência do pedido é o pedidoId (claim atômico na RPC de
    // reserva); o envelope continua gravando acoes_executadas_ssw (INV-014).
    lancar: ({ card, codigoSsw, texto }) => lancarSswPortal({ supabase, env, card, codigoSsw, texto }),
  };

  try {
    const resumo = await rodarWorkerPedidos(deps);
    return json({ ok: resumo.erros.length === 0, ...resumo, duration_ms: Date.now() - startedAt }, 200);
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - startedAt }, 500);
  }
});
