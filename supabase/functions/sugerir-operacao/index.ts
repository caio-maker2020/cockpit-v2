// =============================================================================
// sugerir-operacao — camada 2 da sugestão da Operação (agente de IA) e o
// encaminhamento ao Relacionamento (ADR 0041 D10/D11; INV-188/189).
// Cron (mig 437, aplicada só na hora de ligar). Só service_role (probe por
// capacidade, igual ao materializador).
//
//   - promove encaminhamentos com a janela de desfazer vencida (a RPC confere a
//     flag dos pedidos da ponte e a cerca);
//   - flag `operacao_sugestao_ia` OFF → nenhuma chamada à Anthropic;
//   - flag `operacao_encaminhar_auto` OFF → nada é encaminhado sozinho.
// Nada é lançado aqui. Lógica em _shared/operacao-sugerir-ia.ts e
// _shared/operacao-agente-sugestao.ts (testadas com fetch falso).
//
// Env: ANTHROPIC_API_KEY (só lida se a flag de IA estiver ON),
//      OPERACAO_AGENTE_MODELO (opcional; lista fechada — padrão claude-haiku-5-5),
//      OPERACAO_ENCAMINHAR_AUTO_LIMIAR (opcional; padrão 0.9, piso 0.8),
//      OPERACAO_ENCAMINHAR_AUTO_JANELA_MIN (opcional; padrão 30, piso 10).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { logAnthropicUsage } from "../_shared/anthropic-usage-logger.ts";
import {
  chamarAgenteOperacao,
  ENV_MODELO_AGENTE,
  montarEntradaAgente,
  resolverModeloAgente,
} from "../_shared/operacao-agente-sugestao.ts";
import { json } from "../_shared/operacao-comum.ts";
import { criarRepoSugestaoIa, ehServiceRoleOperacao } from "../_shared/operacao-repo.ts";
import { resolverJanelaAuto, resolverLimiarAuto, rodarSugestaoIa } from "../_shared/operacao-sugerir-ia.ts";
import { historicoDoEstado } from "../_shared/operacao-sugestao.ts";

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
  const modelo = resolverModeloAgente(env[ENV_MODELO_AGENTE]);
  try {
    const resumo = await rodarSugestaoIa({
      repo: criarRepoSugestaoIa(supabase),
      limiarAuto: resolverLimiarAuto(env["OPERACAO_ENCAMINHAR_AUTO_LIMIAR"]),
      janelaAutoMin: resolverJanelaAuto(env["OPERACAO_ENCAMINHAR_AUTO_JANELA_MIN"]),
      agente: async (c, ctx) => {
        const apiKey = env["ANTHROPIC_API_KEY"];
        if (!apiKey) {
          return {
            status: "falha", sugestao: null, motivo: "ANTHROPIC_API_KEY ausente", modelo, versao_prompt: "",
            tokens_entrada: 0, tokens_saida: 0, duracao_ms: 0,
          };
        }
        return await chamarAgenteOperacao({
          apiKey,
          modelo,
          opItemId: c.op_item_id,
          codigosLancaveisAtivos: ctx.lancaveis,
          entrada: montarEntradaAgente({
            item: c,
            codigosOperacao: ctx.codigosOperacao,
            descricaoOcAtual: ctx.descricoes.get(c.cod_ultima_ocorrencia) ?? null,
            historico: historicoDoEstado(ctx.regrasAprendidas, c),
            agoraMs: Date.now(),
          }),
          onUsage: (rec) => logAnthropicUsage(supabase, rec),
        });
      },
    });
    return json({ ok: resumo.erros.length === 0, ...resumo, modelo, duration_ms: Date.now() - inicio }, 200);
  } catch (e) {
    return json({ ok: false, erro: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - inicio }, 500);
  }
});
