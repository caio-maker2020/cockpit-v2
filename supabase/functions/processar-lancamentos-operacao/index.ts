// =============================================================================
// processar-lancamentos-operacao — leva ao SSW o que a Operação pediu (ADR 0041, D7).
// Cron de 1 min (mig 433). Só service_role (probe por capacidade). Flag
// operacao_lancar_ssw OFF → `skipped: flag_off` antes de qualquer outra coisa.
//
// A ÚNICA porta para o SSW é o envelope `lancarSswPortalOperacao` (idempotência em
// op_acoes_executadas_ssw + tripé CTRC/NF/localização + conta de serviço ai.salex).
// Vazão contada no banco (op_reservar_lancamentos: advisory lock, teto 3/min,
// janela global junto com a ponte, quarentena 30 min). Confirmação pelo SSW só
// depois de 90 min sem o Bastão mostrar a oc; nunca relança.
// Lógica em _shared/operacao-lancamentos-worker.ts (testada com fakes).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { criarRepoAcoesOperacao, lancarSswPortalOperacao, lerUltimaOcOperacao } from "../_shared/lancar-ssw-portal-operacao.ts";
import { json } from "../_shared/operacao-comum.ts";
import { type DepsWorkerOp, rodarWorkerLancamentosOperacao } from "../_shared/operacao-lancamentos-worker.ts";
import { criarRepoLancamentosOp, ehServiceRoleOperacao } from "../_shared/operacao-repo.ts";

Deno.serve(async (req) => {
  const inicio = Date.now();
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const key = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) return json({ ok: false, erro: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  if (!(await ehServiceRoleOperacao(url, req.headers.get("Authorization")))) {
    return json({ ok: false, erro: "nao_autorizado" }, 401);
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const repoAcoes = criarRepoAcoesOperacao(supabase);
  const deps: DepsWorkerOp = {
    repo: criarRepoLancamentosOp(supabase),
    lancar: (a) => lancarSswPortalOperacao({ env, repo: repoAcoes, ...a }),
    lerUltimaOc: (nf, ctrc) => lerUltimaOcOperacao(nf, ctrc, env),
    usuarioServico: env["SSW_LANCAMENTO_USUARIO"] ?? null,
  };
  try {
    const resumo = await rodarWorkerLancamentosOperacao(deps);
    return json({ ok: resumo.falhas.length === 0, ...resumo, duration_ms: Date.now() - inicio }, 200);
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - inicio }, 500);
  }
});
