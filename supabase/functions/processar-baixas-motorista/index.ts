// =============================================================================
// processar-baixas-motorista — worker da baixa do motorista (ADR 0040).
// Cron de 1 min (mig 421). Flag baixa_motorista_receber OFF → `skipped: flag_off`
// antes de qualquer outra leitura.
//
// A ÚNICA porta para o SSW é o envelope `lancarSswBaixa` (verdade do SSW antes
// de gravar + tripé CTRC/NF/Localização + conta de serviço ai.salex + hora real).
// A vazão é contada no banco (RPC baixa_motorista_reservar): chamar esta função
// N vezes num minuto não passa de 3 lançamentos (INV-159).
// Lógica em _shared/baixa-motorista-worker.ts (testada com repositório falso).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { lancarSswBaixa } from "../_shared/lancar-ssw-baixa.ts";
import { baixarEvidencia, lerEnvEvidencia } from "../_shared/baixa-motorista-evidencia.ts";
import { json } from "../_shared/ponte-operacao-comum.ts";
import { criarRepoWorkerBaixas } from "../_shared/baixa-motorista-repo.ts";
import { type DepsWorkerBaixas, rodarWorkerBaixas } from "../_shared/baixa-motorista-worker.ts";

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ ok: false, erro: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const envEvidencia = lerEnvEvidencia(env);
  const deps: DepsWorkerBaixas = {
    repo: criarRepoWorkerBaixas(supabase),
    baixarEvidencia: (id) => baixarEvidencia(id, envEvidencia),
    lancar: ({ canal, baixa, evidencia }) => lancarSswBaixa({ env, canal, baixa, evidencia }),
  };

  try {
    const resumo = await rodarWorkerBaixas(deps);
    return json({ ok: resumo.erros.length === 0, ...resumo, duration_ms: Date.now() - startedAt }, 200);
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - startedAt }, 500);
  }
});
