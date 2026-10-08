// =============================================================================
// materializar-fila-operacao — a fila da Operação nasce do Bastão (ADR 0041, D4).
// Cron (mig 432). Só service_role (probe por capacidade). Flag operacao_fila OFF
// → `skipped: flag_off` antes de ler o Bastão.
//
// Fonte: o BastaoClient de hoje (Bastão Lovable) + fetchPendenciasDaOperacao
// (responsavel_atual = operacao, ou dicionário 'Operação' quando vazio).
// Exclui finalizadoras 1/30/32, documentais 2/34 e CTRC com card ATIVO do
// Relacionamento; unidade por op_regra_unidade_por_oc; guard INV-040.
// SEM SSW. Lógica em _shared/operacao-materializar.ts (testada com fakes).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { readBastaoEnvFromProcess } from "../_shared/bastao-client.ts";
import { type BastaoOperacaoClient, createBastaoOperacaoClient } from "../_shared/bastao-operacao-client.ts";
import { json } from "../_shared/operacao-comum.ts";
import { type PendenciaOperacao, rodarMaterializacao } from "../_shared/operacao-materializar.ts";
import { criarRepoMaterializacao, ehServiceRoleOperacao } from "../_shared/operacao-repo.ts";

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
  let bastao: BastaoOperacaoClient | null = null;
  try {
    const resumo = await rodarMaterializacao({
      repo: criarRepoMaterializacao(supabase),
      bastao: {
        async fetchPendenciasDaOperacao(opts) {
          bastao ??= createBastaoOperacaoClient({ env: readBastaoEnvFromProcess(env) });
          const r = await bastao.fetchPendenciasDaOperacao(opts);
          return { ...r, pendencias: r.pendencias as unknown as PendenciaOperacao[] };
        },
      },
    });
    return json({ ...resumo, duration_ms: Date.now() - inicio }, 200);
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - inicio }, 500);
  }
});
