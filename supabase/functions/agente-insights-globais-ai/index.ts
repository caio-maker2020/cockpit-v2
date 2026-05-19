// =============================================================================
// agente-insights-globais-ai — análise agregada do kanban PRIORIDADES AI
//
// Caio 2026-05-19: o painel "💡 Insights Globais" do front precisa de uma
// análise GERAL (não card por card). Onde os problemas concentram? Quais
// bases têm mais demora? Quais clientes recorrem? Padrões temporais? Causas
// prováveis?
//
// Roda sob demanda (operador clica "Insights Globais") OU em cron leve.
// Cache: 4h por operador (análise muda lento; cards entram/saem aos poucos).
//
// Input:  { operador_nome? } — se ausente, usa o operador do JWT
// Output: { ok, analise: { resumo, hotspots[], padroes[], recomendacoes[] },
//           total_cards, ttl_horas, modelo }
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";
const CACHE_TTL_HORAS = 4;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Você é um analista sênior de operações da Sal Express. Recebe a fotografia atual do KANBAN PRIORIDADES AI de UM operador (todas NFs paradas em oc=13/21).

TAREFA: gerar análise AGREGADA (não card por card). Identifique:

1. **Resumo executivo** (2-3 frases) — diagnóstico do estado atual do operador
2. **Hotspots** — bases/clientes/segmentos com maior concentração de cards parados
3. **Padrões** — recorrências (cliente X atrasou várias vezes; base Y é lenta; oc=21 X dias > oc=13 X dias; concentração por dia da semana, etc)
4. **Causas prováveis** — INFERIDAS dos dados (não invente; declare quando é hipótese vs evidência)
5. **Recomendações priorizadas** — 3-5 ações concretas que o operador deve fazer HOJE pra desafogar

REGRAS:
- NUNCA invente dados. Use SÓ o que vem no contexto
- Citações específicas (ex: "Base VGA tem 8 cards, 6 deles >5 dias parados")
- Tom direto: analista falando pro operador, não relatório formal
- Português PT-BR
- Devolva EXCLUSIVAMENTE JSON neste schema:
{
  "resumo": "string 2-3 frases",
  "hotspots": [
    { "tipo": "base"|"cliente"|"segmento", "nome": "string", "cards": int, "media_dias_parados": number, "observacao": "string" }
  ],
  "padroes": [ "string 1 linha", ... ],
  "causas_provaveis": [ "string 1 linha", ... ],
  "recomendacoes": [
    { "prioridade": 1|2|3, "acao": "string", "motivo": "string" }
  ]
}`;

interface InsightsOutput {
  resumo: string;
  hotspots: Array<{ tipo: string; nome: string; cards: number; media_dias_parados: number; observacao: string }>;
  padroes: string[];
  causas_provaveis: string[];
  recomendacoes: Array<{ prioridade: number; acao: string; motivo: string }>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    const body = await req.json().catch(() => ({})) as { operador_nome?: string; force?: boolean };
    let operadorNome = body.operador_nome ?? null;

    // Resolve operador do JWT se não passado
    if (!operadorNome) {
      const auth = req.headers.get("Authorization") ?? "";
      const userJwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (userJwt) {
        const supabaseAuth = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
          global: { headers: { Authorization: auth } },
        });
        const { data: u } = await supabaseAuth.auth.getUser(userJwt);
        if (u?.user) {
          const { data: op } = await supabase
            .from("operadores").select("nome").eq("user_id", u.user.id).maybeSingle();
          operadorNome = (op as { nome?: string } | null)?.nome ?? null;
        }
      }
    }

    if (!operadorNome) {
      return json({ ok: false, error: "operador_nome ausente (passar no body ou autenticar)" }, 400);
    }

    // Cache lookup (analises_prioridades_ai com tipo='insights_globais' + card_id null)
    // Como analises_prioridades_ai exige card_id, vou usar uma row sintética:
    // card_id = uuid determinístico pelo nome do operador.
    // Alternativa simples: usar tabela nova OU pular cache. Por enquanto, sem cache.
    // TODO: criar `analises_globais_prioridades_ai` futuramente. MVP: sempre regenera.

    // Carrega cards do operador na view (RLS bypassada pq service_role)
    const { data: cards } = await supabase
      .from("v_prioridades_ai")
      .select("nf, ctrc, base, pagador_nome, cnpj_pagador, empresa_cliente, oc_origem, dias_uteis_parados, coluna_kanban, ia_insight, ult_cobranca, card_state")
      .eq("responsavel_relacionamento", operadorNome);

    if (!cards || cards.length === 0) {
      return json({
        ok: true,
        operador: operadorNome,
        total_cards: 0,
        analise: {
          resumo: `${operadorNome} não tem cards parados em oc=13/21 no momento. Nada a priorizar.`,
          hotspots: [],
          padroes: [],
          causas_provaveis: [],
          recomendacoes: [],
        },
        modelo: MODEL,
        ttl_horas: CACHE_TTL_HORAS,
      }, 200);
    }

    // Compacta cards pra prompt
    const cardsResumidos = cards.map((c) => ({
      nf: (c as { nf: string }).nf,
      base: (c as { base: string | null }).base,
      cliente: (c as { pagador_nome: string | null }).pagador_nome,
      segmento: null, // segmento_cliente não está na view atual; pode adicionar
      oc: (c as { oc_origem: number }).oc_origem,
      dias_uteis_parados: Number((c as { dias_uteis_parados: number | null }).dias_uteis_parados ?? 0),
      kanban: (c as { coluna_kanban: string | null }).coluna_kanban,
      state: (c as { card_state: string }).card_state,
      ja_cobrado: ((c as { ult_cobranca: unknown }).ult_cobranca) != null,
    }));

    const userPrompt = [
      `Operador: ${operadorNome}`,
      `Total de cards parados em oc=13/21: ${cards.length}`,
      "",
      "Cards (JSON):",
      JSON.stringify(cardsResumidos, null, 2),
      "",
      "Gere análise agregada conforme schema.",
    ].join("\n");

    const out = await anthropic.completeJson<InsightsOutput>({
      model: MODEL,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 2500,
      temperature: 0.3,
    });

    return json({
      ok: true,
      operador: operadorNome,
      total_cards: cards.length,
      analise: out,
      modelo: MODEL,
      ttl_horas: CACHE_TTL_HORAS,
      gerado_em: new Date().toISOString(),
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente-insights-globais-ai fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
