// =============================================================================
// agente-monitor-efetividade-ai — Sonnet 4.6 monitora efetividade pós-cobrança
//
// Caio 2026-05-19 (PRIORIDADES AI):
// Cron 4×/dia (09h, 15h, 20h UTC; 01h UTC).
// Pra cada card com kanban_status ∈ ('cobrado','escalado') E ult_cobranca
// nas últimas 7 dias:
//   1. Invoca puxar-historico-ssw-card pra ter histórico fresh
//   2. Carrega cobranças disparadas + ocs no SSW pós primeira cobrança
//   3. Sonnet 4.6 classifica:
//        - 'efetiva'      → oc=14 OU finalizadora (01/30/32) detectada
//        - 'parcial'      → outra oc movimentou mas não 14/finalizadora
//        - 'sem_resposta' → sem oc nova desde cobrança
//        - 'sair_kanban'  → nova oc de relacionamento (49/56/etc)
//      + sugere próxima ação concreta
//   4. UPSERT analises_prioridades_ai (tipo='monitor', expira_em=now+6h)
//   5. Aplica transições kanban:
//        - efetiva → 'resolvido'
//        - sair_kanban → NULL (sai do kanban)
//        - parcial/sem_resposta → mantém status
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { OCORRENCIAS_DE_RELACIONAMENTO } from "../_shared/bastao-rules.ts";

const MODEL = "claude-sonnet-4-6";
const CACHE_TTL_HORAS = 6;
const JANELA_DIAS = 7;
const FINALIZADORAS = new Set([1, 30, 32]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Você é o Monitor de Efetividade da operação Sal Express. Recebe a sequência de cobranças feitas via Cockpit pra UM card (papel + canal + texto + data) e o histórico do SSW posterior à 1ª cobrança.

CATEGORIAS (escolha EXATAMENTE 1):
- 'efetiva'      → oc=14 OU finalizadora (01/30/32) veio depois da 1ª cobrança
- 'parcial'      → houve nova oc no SSW depois da cobrança mas NÃO é 14 nem finalizadora
- 'sem_resposta' → sem oc nova desde a 1ª cobrança E já passou >24h
- 'sair_kanban'  → nova oc de RELACIONAMENTO (49/56/44/55/etc — caso vira tratativa de relacionamento normal)

SUGESTÃO de próxima ação (1 frase ≤180 chars):
- Concreta e acionável (ex: "Re-cobrar gerente da base via WhatsApp", "Aguardar 24h", "Escalar pra coordenador agora")

REGRAS:
- NUNCA invente ocs ou datas
- Use só o que está no contexto
- Português PT-BR direto
- Devolva EXCLUSIVAMENTE JSON: { "veredito", "proxima_acao", "evidencias": [string,...] }`;

interface MonitorOutput {
  veredito: "efetiva" | "parcial" | "sem_resposta" | "sair_kanban";
  proxima_acao: string;
  evidencias: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

    // Cards no kanban com cobrança recente
    const cutoff = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();
    const { data: cobs } = await supabase
      .from("cobrancas_disparadas")
      .select("card_id")
      .gte("disparado_em", cutoff);
    const cardIds = [...new Set(((cobs ?? []) as Array<{ card_id: string }>).map((c) => c.card_id))];

    if (cardIds.length === 0) {
      return json({ ok: true, processados: 0, motivo: "sem cards cobrados na janela" }, 200);
    }

    const { data: cards } = await supabase
      .from("cards")
      .select("id, nf, ctrc, base_destino, historico_ssw, prioridades_kanban_status, responsavel_relacionamento")
      .in("id", cardIds)
      .in("prioridades_kanban_status", ["cobrado", "escalado"]);

    const resumo: Array<{ card_id: string; nf: string; veredito?: string; kanban_novo?: string | null; erro?: string }> = [];

    for (const card of (cards ?? []) as Array<{
      id: string;
      nf: string;
      ctrc: string | null;
      base_destino: string | null;
      historico_ssw: Array<Record<string, unknown>> | null;
      prioridades_kanban_status: string | null;
      responsavel_relacionamento: string | null;
    }>) {
      try {
        // Re-puxa histórico SSW fresh (best-effort)
        try {
          await fetch(`${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
              "apikey": env["SUPABASE_SERVICE_ROLE_KEY"]!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ card_id: card.id }),
            signal: AbortSignal.timeout(45_000),
          });
        } catch {
          // segue com histórico atual
        }

        // Re-carrega histórico atualizado
        const { data: cardFresh } = await supabase
          .from("cards")
          .select("historico_ssw")
          .eq("id", card.id)
          .maybeSingle();
        const historico = ((cardFresh as { historico_ssw?: Array<Record<string, unknown>> } | null)?.historico_ssw ?? []) as Array<Record<string, unknown>>;

        // Cobranças desse card
        const { data: cobCard } = await supabase
          .from("cobrancas_disparadas")
          .select("papel, canal, disparado_em, texto_enviado, status")
          .eq("card_id", card.id)
          .order("disparado_em", { ascending: true });
        const cobrancas = (cobCard ?? []) as Array<{ papel: string; canal: string; disparado_em: string; texto_enviado: string; status: string }>;

        if (cobrancas.length === 0) continue;
        const primeiraCobranca = cobrancas[0]!.disparado_em;

        // Sonnet analisa
        const userPrompt = [
          `NF: ${card.nf}`,
          `CTRC: ${card.ctrc ?? "?"}`,
          `Base: ${card.base_destino ?? "?"}`,
          "",
          `Cobranças disparadas (${cobrancas.length}):`,
          cobrancas.map((c, i) => `${i+1}. ${c.disparado_em} · ${c.papel} · ${c.canal} · status=${c.status}\n   texto: ${c.texto_enviado.slice(0, 300)}`).join("\n\n"),
          "",
          "Histórico SSW completo (do mais recente pro mais antigo):",
          JSON.stringify(historico.slice(0, 25), null, 2),
          "",
          `Primeira cobrança: ${primeiraCobranca}`,
          "Devolva veredito + próxima ação.",
        ].join("\n");

        const out = await anthropic.completeJson<MonitorOutput>({
          model: MODEL,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          maxTokens: 800,
          temperature: 0.2,
        });

        // Persiste análise
        const expira = new Date(Date.now() + CACHE_TTL_HORAS * 60 * 60 * 1000).toISOString();
        await supabase
          .from("analises_prioridades_ai")
          .delete()
          .eq("tipo", "monitor")
          .eq("card_id", card.id);
        await supabase.from("analises_prioridades_ai").insert({
          card_id: card.id,
          tipo: "monitor",
          veredito_monitor: out.veredito,
          proxima_acao_monitor: (out.proxima_acao ?? "").slice(0, 240),
          modelo: MODEL,
          payload_completo: out as unknown as Record<string, unknown>,
          analisado_em: new Date().toISOString(),
          expira_em: expira,
        });

        // Transição kanban
        let kanbanNovo: string | null = card.prioridades_kanban_status;
        if (out.veredito === "efetiva") {
          kanbanNovo = "resolvido";
        } else if (out.veredito === "sair_kanban") {
          kanbanNovo = null;
        } else {
          // Validação dura: se historico_ssw tem oc=14 ou finalizadora pós primeira_cobranca → força 'resolvido'
          // Se tem oc de relacionamento pós primeira_cobranca → força sair_kanban
          const primeira = new Date(primeiraCobranca).getTime();
          for (const h of historico) {
            const dataRaw = h["data"] as string | undefined;
            if (!dataRaw) continue;
            const m = dataRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}) (\d{1,2}):(\d{2})$/);
            if (!m) continue;
            const dataEvento = new Date(`20${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}T${m[4]!.padStart(2, "0")}:${m[5]}:00-03:00`).getTime();
            if (dataEvento <= primeira) continue;
            const cod = Number(h["codigo"]);
            if (cod === 14 || FINALIZADORAS.has(cod)) { kanbanNovo = "resolvido"; break; }
            if (OCORRENCIAS_DE_RELACIONAMENTO.has(cod)) { kanbanNovo = null; break; }
          }
        }

        if (kanbanNovo !== card.prioridades_kanban_status) {
          await supabase
            .from("cards")
            .update({
              prioridades_kanban_status: kanbanNovo,
              prioridades_kanban_atualizado_em: new Date().toISOString(),
            })
            .eq("id", card.id);
        }

        resumo.push({ card_id: card.id, nf: card.nf, veredito: out.veredito, kanban_novo: kanbanNovo });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`monitor card=${card.id} falhou:`, msg);
        resumo.push({ card_id: card.id, nf: card.nf, erro: msg });
      }
    }

    return json({
      ok: true,
      processados: resumo.length,
      janela_dias: JANELA_DIAS,
      cache_ttl_horas: CACHE_TTL_HORAS,
      resumo,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("agente-monitor-efetividade-ai fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
