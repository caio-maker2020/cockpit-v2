// =============================================================================
// comprovantes-operacao — a aba Comprovantes da Operação lê a fonte REAL
// (ADR 0042 D6): as views do projeto Supabase secundário do Pendências.
//
//   GET (ou POST sem corpo, do functions.invoke) com o JWT de quem está logado
//   → 200 { ok, linhas, entregues, ultimaAtualizacao, escopo, excluidas, geradoEm }
//   → 401 sem JWT · 403 sem_acesso/tela_desligada · 503 comprovantes_sem_credencial
//   → 502 fonte_falhou/sessao_indisponivel
//
// Quem vê o quê sai de `op_minha_sessao()` chamada COM O JWT DE QUEM CHAMOU (a
// mesma RPC da tela; nada de service_role aqui). SÓ LEITURA: GET/HEAD na fonte,
// nenhuma escrita em lugar nenhum. Lógica e testes em
// _shared/operacao-comprovantes.ts(.test.ts).
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (padrão do runtime),
//      COMPROVANTES_SUPABASE_URL, COMPROVANTES_SUPABASE_ANON_KEY (secrets; sem eles → 503).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { handleComprovantes, jsonComprovantes, type SessaoOpComprovantes } from "../_shared/operacao-comprovantes.ts";

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"];
  const anon = env["SUPABASE_ANON_KEY"];
  if (!url || !anon) return jsonComprovantes({ ok: false, erro: "falha_interna", mensagem: "SUPABASE_URL/ANON_KEY ausentes" }, 500);
  return await handleComprovantes(req, {
    env,
    fetch,
    agoraMs: () => Date.now(),
    sessao: async (authorization) => {
      const cliente = createClient(url, anon, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data, error } = await cliente.rpc("op_minha_sessao");
      if (error) throw new Error(error.message);
      return (data ?? null) as SessaoOpComprovantes | null;
    },
  });
});
