// =============================================================================
// analisar-indicador-tempo-oc21-oc14 — agente IA Sonnet 4.6 que interpreta
// os dados do indicador "Tempo médio oc=21→14 por base" e produz análise
// estruturada com sugestões + cobranças prontas pra enviar.
//
// Mesmo padrão e schema do analisar-indicador-erros-lancamento.
// Cache 24h via analises_ia_indicadores.
//
// Caio 2026-05-18.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";

const MODEL = "claude-sonnet-4-6";
const INDICADOR_TIPO = "tempo_oc21_oc14";
const CACHE_TTL_HORAS = 24;
const SLA_MINUTOS = 24 * 60;

const SYSTEM_PROMPT = `Você é um agente de análise de indicadores operacionais de uma transportadora (Sal Express). Seu papel é interpretar dados de tempo entre oc=21 (reentrega solicitada pelo operador de relacionamento) e oc=14 (saída pra entrega, lançada pela base operacional). SLA esperado: 24 horas (1440 minutos).

Quanto mais demora pra base lançar oc=14 após o operador lançar oc=21, mais a carga fica parada e o cliente espera. Bases consistentemente fora do SLA são gargalos operacionais críticos.

Produza:

1. **Resumo executivo** — 2-3 frases sobre saúde geral do SLA no período (% dentro SLA, tendência).
2. **Métricas-chave** com delta vs período anterior. Inclua: tempo médio global (em h), % dentro SLA, base mais rápida, base mais lenta.
3. **Destaques de melhoria** — bases que reduziram tempo médio ou aumentaram % dentro SLA.
4. **Destaques de piora** — bases com aumento de tempo médio ou queda de % dentro SLA. Severidade alta se base ultrapassa 48h ou tem <50% dentro SLA.
5. **Sugestões de melhoria** — ações operacionais concretas (revisão de processo de separação, alinhamento entre relacionamento e operação, checklist diário) com base-alvo + prioridade.
6. **Sugestões de automação** — workflows que reduziriam tempo (notificação automática ao gerente quando passa N horas, integração com WMS, etc.).
7. **Cobranças recomendadas** — emails prontos pra enviar pros gerentes das bases consistentemente fora do SLA. Inclua \`destinatario_sugerido\`, \`assunto_sugerido\`, \`corpo_sugerido\` (HTML simples, parágrafos curtos, tom direto e profissional, com números específicos). Use \`urgencia\` ∈ {baixa, média, alta} baseado em severidade.

Tom: profissional, direto, sem rodeios. Português brasileiro. Foco em ação.

Retorne EXCLUSIVAMENTE JSON válido neste schema (não adicione markdown):

{
  "resumo_geral": "string",
  "metricas_chave": [
    { "label": "string", "valor": "string", "delta_pct": number|null, "tendencia": "melhorando"|"piorando"|"estavel" }
  ],
  "melhoria_destaques": [
    { "base": "string", "descricao": "string", "evidencia": "string" }
  ],
  "piora_destaques": [
    { "base": "string", "descricao": "string", "evidencia": "string", "severidade": "alta"|"media"|"baixa" }
  ],
  "sugestoes_melhoria": [
    { "titulo": "string", "descricao": "string", "base_alvo": "string", "prioridade": "alta"|"media"|"baixa" }
  ],
  "sugestoes_automacao": [
    { "titulo": "string", "descricao": "string", "escopo": "preventivo"|"reativo"|"comunicacao", "dificuldade": "baixa"|"media"|"alta" }
  ],
  "cobrancas_recomendadas": [
    {
      "destinatario_sugerido": "string (email ou nome+contexto)",
      "assunto_sugerido": "string ≤80 chars",
      "corpo_sugerido": "string HTML com parágrafos curtos",
      "urgencia": "alta"|"media"|"baixa",
      "canal": "email"
    }
  ]
}

Se não houver dados suficientes pra alguma seção, retorne array vazio []. Sempre retorne TODAS as chaves do schema.`;

interface InputBody {
  filtro_periodo_dias?: number;
  filtro_bases?: string[];
  forcar_refresh?: boolean;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json().catch(() => ({})) as InputBody;
    const periodoDias = body.filtro_periodo_dias ?? 30;
    const bases = (body.filtro_bases ?? []).filter((b) => typeof b === "string" && b.trim().length > 0);
    const forcarRefresh = body.forcar_refresh === true;

    const filtros = { periodo_dias: periodoDias, bases: bases.slice().sort() };

    // Cache
    if (!forcarRefresh) {
      const limiarTtl = new Date(Date.now() - CACHE_TTL_HORAS * 60 * 60 * 1000).toISOString();
      const { data: cache } = await supabase
        .from("analises_ia_indicadores")
        .select("id, resultado, gerado_em")
        .eq("indicador_tipo", INDICADOR_TIPO)
        .gte("gerado_em", limiarTtl)
        .filter("filtros", "eq", JSON.stringify(filtros))
        .order("gerado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cache?.resultado) {
        return json({ ok: true, resultado: cache.resultado, gerado_em: cache.gerado_em, cache: true });
      }
    }

    // Dados período atual + anterior
    const inicioAtual = new Date(Date.now() - periodoDias * 24 * 60 * 60 * 1000);
    const inicioAnterior = new Date(Date.now() - 2 * periodoDias * 24 * 60 * 60 * 1000);
    const fimAnterior = inicioAtual;

    const queryPeriodo = (inicio: Date, fim: Date | null) => {
      let q = supabase
        .from("tempo_oc21_para_oc14")
        .select("base_oc14, delta_minutos, dentro_sla, data_oc14")
        .gte("data_oc14", inicio.toISOString());
      if (fim) q = q.lt("data_oc14", fim.toISOString());
      if (bases.length > 0) q = q.in("base_oc14", bases);
      return q;
    };

    const [{ data: atualRaw }, { data: anteriorRaw }] = await Promise.all([
      queryPeriodo(inicioAtual, null),
      queryPeriodo(inicioAnterior, fimAnterior),
    ]);

    const agregar = (rows: Array<Record<string, unknown>>) => {
      const map = new Map<string, { base: string; total: number; soma_min: number; dentro_sla: number; max: number; min: number }>();
      for (const r of rows ?? []) {
        const b = r.base_oc14 as string;
        const dm = r.delta_minutos as number;
        const ds = r.dentro_sla as boolean;
        const ex = map.get(b);
        if (ex) {
          ex.total++;
          ex.soma_min += dm;
          if (ds) ex.dentro_sla++;
          if (dm > ex.max) ex.max = dm;
          if (dm < ex.min) ex.min = dm;
        } else {
          map.set(b, { base: b, total: 1, soma_min: dm, dentro_sla: ds ? 1 : 0, max: dm, min: dm });
        }
      }
      return [...map.values()].map((v) => ({
        base: v.base,
        total_pares: v.total,
        media_minutos: Math.round(v.soma_min / v.total),
        dentro_sla: v.dentro_sla,
        fora_sla: v.total - v.dentro_sla,
        pct_dentro_sla: Math.round((100 * v.dentro_sla) / v.total),
        max_minutos: v.max,
        min_minutos: v.min,
      })).sort((a, b) => b.media_minutos - a.media_minutos);
    };

    const periodoAtual = agregar((atualRaw ?? []) as Array<Record<string, unknown>>);
    const periodoAnterior = agregar((anteriorRaw ?? []) as Array<Record<string, unknown>>);

    if (periodoAtual.length === 0 && periodoAnterior.length === 0) {
      const vazio = {
        resumo_geral: "Sem pares (oc=21 → oc=14) capturados no período. Quando operadores começarem a lançar oc=21 nos cards e as bases lançarem oc=14 em seguida, o indicador vai popular.",
        metricas_chave: [{ label: `Total de pares (${periodoDias}d)`, valor: "0", delta_pct: null, tendencia: "estavel" }],
        melhoria_destaques: [],
        piora_destaques: [],
        sugestoes_melhoria: [],
        sugestoes_automacao: [],
        cobrancas_recomendadas: [],
      };
      return json({ ok: true, resultado: vazio, gerado_em: new Date().toISOString(), cache: false });
    }

    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });
    const userPrompt = `**Indicador:** Tempo médio entre oc=21 (reentrega solicitada) e oc=14 (saída pra entrega) por base
**SLA:** 24h (1440 min)
**Período atual:** últimos ${periodoDias} dias
**Período anterior:** ${periodoDias} dias anteriores
**Filtro bases:** ${bases.length > 0 ? bases.join(", ") : "todas"}

## Dados período ATUAL (agregado por base)
${JSON.stringify(periodoAtual, null, 2)}

## Dados período ANTERIOR (mesma agregação)
${JSON.stringify(periodoAnterior, null, 2)}

Analise os dados e retorne o JSON estruturado conforme o schema do system prompt. Foque em comparar bases entre si e vs período anterior. Cobranças devem ter datas concretas (ex: "até sexta-feira").`;

    const completion = await anthropic.complete({
      model: MODEL,
      maxTokens: 4096,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    let resultado: Record<string, unknown>;
    try {
      const limpo = completion.text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, "");
      resultado = JSON.parse(limpo);
    } catch (e) {
      throw new Error(`Falha ao parsear JSON da IA: ${e instanceof Error ? e.message : String(e)}. Resposta: ${completion.text.slice(0, 500)}`);
    }

    const { data: cached } = await supabase
      .from("analises_ia_indicadores")
      .insert({ indicador_tipo: INDICADOR_TIPO, filtros, resultado, modelo: MODEL })
      .select("gerado_em")
      .single();

    return json({
      ok: true,
      resultado,
      gerado_em: cached?.gerado_em ?? new Date().toISOString(),
      cache: false,
      sla_minutos: SLA_MINUTOS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
