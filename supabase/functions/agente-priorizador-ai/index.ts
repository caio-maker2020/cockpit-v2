// =============================================================================
// agente-priorizador-ai — Sonnet 4.6 ranqueia cards parados por operador
//
// Caio 2026-05-19 (PRIORIDADES AI):
// Cron 2×/dia (11h e 17h UTC = 08h e 14h BRT).
// Pra cada operador ativo:
//   1. Carrega cards do operador em v_prioridades_ai (oc=13 OU 21)
//   2. Pra cada card carrega: cobranças anteriores nos últimos 90d desse
//      mesmo cnpj_pagador (cliente já atrasou? padrão recorrente?)
//   3. Sonnet 4.6 ordena por prioridade + gera observação curta por card
//   4. UPSERT em analises_prioridades_ai (tipo='priorizador', expira_em=now+12h)
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";
const CACHE_TTL_HORAS = 12;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Você é um analista de operações da Sal Express. Recebe cards parados em oc=13/21 de UM operador específico, com dados históricos do cliente pagador (cobranças anteriores nos últimos 90 dias, padrões recorrentes).

TAREFA:
1. Ordene os cards por prioridade de cobrança considerando:
   - Dias parados (maior = mais urgente)
   - Padrão recorrente do cliente (já atrasou várias vezes = mais urgente)
   - Última oc tipo 21 (saída pra entrega bloqueada) vs 13 (mudança endereço — pode ser legítimo cliente)
   - Cobranças anteriores sem efetividade (escalação necessária)
2. Pra cada card, escreva 1 observação curta (≤140 chars) explicando o motivo da posição.

REGRAS:
- NUNCA invente dados — use só o que vem no contexto
- Português PT-BR direto
- Devolva EXCLUSIVAMENTE JSON: { "ranking": [ { "card_id", "rank", "observacao" }, ... ] }
  rank é 1..N (1 = mais prioritário)`;

interface RankingOutput {
  ranking: Array<{ card_id: string; rank: number; observacao: string }>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    // Lista operadores ativos no Cockpit
    const { data: operadores } = await supabase
      .from("operadores")
      .select("id, nome")
      .eq("ativo", true)
      .eq("cockpit_ativo", true);

    const resumo: Array<{ operador: string; cards: number; analisados: number; erro?: string }> = [];

    for (const op of (operadores ?? []) as Array<{ id: string; nome: string }>) {
      try {
        // Cards desse operador na view
        const { data: cards } = await supabase
          .from("v_prioridades_ai")
          .select("card_id, nf, ctrc, base, dias_uteis_parados, oc_origem, pagador_nome, cnpj_pagador, ult_cobranca")
          .eq("assigned_operator_id", op.id);

        if (!cards || cards.length === 0) {
          resumo.push({ operador: op.nome, cards: 0, analisados: 0 });
          continue;
        }

        // Pra cada cnpj, conta quantas vezes esse cliente teve cobranças nos últimos 90d
        const cnpjsUnicos = [...new Set(cards.map((c) => (c as { cnpj_pagador: string | null }).cnpj_pagador).filter(Boolean) as string[])];
        const cobrancasPorCnpj = new Map<string, number>();
        if (cnpjsUnicos.length > 0) {
          const { data: cobs } = await supabase
            .from("cobrancas_disparadas")
            .select("card_id, cards!inner(agent_state)")
            .gte("disparado_em", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
          // Conta por cnpj (extraindo do agent_state)
          for (const c of (cobs ?? []) as Array<{ cards?: { agent_state?: Record<string, unknown> } }>) {
            const cnpj = c.cards?.agent_state?.["cnpj_pagador"] as string | undefined;
            if (cnpj) cobrancasPorCnpj.set(cnpj, (cobrancasPorCnpj.get(cnpj) ?? 0) + 1);
          }
        }

        const cardsEnriquecidos = cards.map((c) => {
          const cnpj = (c as { cnpj_pagador: string | null }).cnpj_pagador;
          return {
            card_id: (c as { card_id: string }).card_id,
            nf: (c as { nf: string }).nf,
            ctrc: (c as { ctrc: string | null }).ctrc,
            base: (c as { base: string | null }).base,
            dias_uteis_parados: (c as { dias_uteis_parados: number | null }).dias_uteis_parados,
            oc_origem: (c as { oc_origem: number }).oc_origem,
            cliente: (c as { pagador_nome: string | null }).pagador_nome,
            cobrancas_90d_mesmo_cliente: cnpj ? (cobrancasPorCnpj.get(cnpj) ?? 0) : 0,
            ultima_cobranca: (c as { ult_cobranca: unknown }).ult_cobranca,
          };
        });

        const userPrompt = [
          `Operador: ${op.nome}`,
          `Total cards parados: ${cards.length}`,
          "",
          "Cards (JSON):",
          JSON.stringify(cardsEnriquecidos, null, 2),
          "",
          "Devolva ranking + observação por card.",
        ].join("\n");

        const out = await anthropic.completeJson<RankingOutput>({
          model: MODEL,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          maxTokens: 2000,
          temperature: 0.3,
        });

        const expira = new Date(Date.now() + CACHE_TTL_HORAS * 60 * 60 * 1000).toISOString();

        // UPSERT — apaga análises antigas tipo=priorizador desses cards primeiro
        const cardIds = (out.ranking ?? []).map((r) => r.card_id);
        if (cardIds.length > 0) {
          await supabase
            .from("analises_prioridades_ai")
            .delete()
            .eq("tipo", "priorizador")
            .in("card_id", cardIds);
        }

        const insertRows = (out.ranking ?? []).map((r) => ({
          card_id: r.card_id,
          tipo: "priorizador" as const,
          rank_priorizador: r.rank,
          observacao_priorizador: r.observacao.slice(0, 240),
          modelo: MODEL,
          analisado_em: new Date().toISOString(),
          expira_em: expira,
        }));

        if (insertRows.length > 0) {
          await supabase.from("analises_prioridades_ai").insert(insertRows);
        }

        resumo.push({ operador: op.nome, cards: cards.length, analisados: insertRows.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`priorizador operador=${op.nome} falhou:`, msg);
        resumo.push({ operador: op.nome, cards: 0, analisados: 0, erro: msg });
      }
    }

    return json({ ok: true, resumo, modelo: MODEL, cache_ttl_horas: CACHE_TTL_HORAS }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente-priorizador-ai fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
