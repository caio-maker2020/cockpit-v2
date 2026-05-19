// =============================================================================
// gerar-cobranca-oc14-individual — IA Sonnet 4.6 gera mensagem personalizada
// pra cobrar a base de UM card específico que tem oc=21 sem oc=14 ainda.
//
// Usado pelo bloco "Pendentes" da aba INDICADORES quando operador clica
// "📤 Cobrar base agora" numa linha individual. Distinto do cron horário que
// dispara automático após 24h — esse aqui é manual, pode acionar antes.
//
// Não envia — só GERA. Operador revisa e dispara via enviar-cobranca-base.
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

const SYSTEM_PROMPT = `Você escreve emails curtos e profissionais pra gerentes de bases SSW (transportadora Sal Express) quando uma reentrega solicitada (oc=21) está pendente de saída pra entrega (oc=14).

Tom: profissional, direto, sem rodeios. Português brasileiro. Foco em ação.

Receba o contexto e retorne EXCLUSIVAMENTE JSON (sem markdown):

{
  "assunto": "string ≤80 chars",
  "corpo_html": "string HTML simples (<p>, <strong>, <br>). Cite NF, CTRC, horas paradas, base. Solicite lançamento de oc=14 + prazo claro (ex: até hoje 18h se ainda dentro do SLA; imediato se já fora). Tom mais urgente se fora SLA."
}

Não invente dados. Use SÓ os campos do contexto.`;

interface InputBody {
  card_id?: string;
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
    if (!body.card_id) return json({ ok: false, error: "card_id obrigatório" }, 400);

    // Carrega linha da view (já tem todo contexto enriquecido)
    const { data: linha, error: selErr } = await supabase
      .from("v_oc21_aguardando_oc14")
      .select("*")
      .eq("card_id", body.card_id)
      .maybeSingle();

    if (selErr) throw new Error(`SELECT v_oc21: ${selErr.message}`);
    if (!linha) return json({ ok: false, error: "Card não está em pendência oc=21 sem oc=14" }, 404);

    const l = linha as Record<string, unknown>;
    const baseEsperada = (l.alerta_base_destino as string | null) ?? (l.base_destino as string | null) ?? (l.filial_oc21 as string | null) ?? "(base desconhecida)";

    // Busca contato cadastrado se houver
    const { data: contato } = await supabase
      .from("contatos_bases_ssw")
      .select("email, nome_contato")
      .eq("base", baseEsperada)
      .eq("ativo", true)
      .maybeSingle();

    const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });
    const userPrompt = `Contexto:
- NF: ${l.nf}
- CTRC: ${l.ctrc ?? "(sem ctrc)"}
- Base responsável: ${baseEsperada}
- Gerente cadastrado: ${contato?.nome_contato ?? "(não cadastrado)"}
- Operador relacionamento: ${l.responsavel_relacionamento ?? "(sem operador)"}
- Data oc=21: ${l.data_oc21}
- Dias úteis parados: ${l.dias_uteis_parados ?? "?"} dia(s) útil(eis)
- Horas corridas: ${l.horas_paradas}h
- Status SLA: ${l.dentro_sla ? "dentro do SLA (1 dia útil)" : "FORA do SLA (>1 dia útil)"}

Gere assunto + corpo_html.`;

    const completion = await anthropic.complete({
      model: MODEL,
      maxTokens: 1024,
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    let mensagem: { assunto: string; corpo_html: string };
    try {
      const limpo = completion.text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, "");
      mensagem = JSON.parse(limpo);
    } catch (e) {
      throw new Error(`IA falhou ao parsear JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    return json({
      ok: true,
      assunto: mensagem.assunto,
      corpo_html: mensagem.corpo_html,
      destinatario_sugerido: contato?.email ?? "",
      contato_cadastrado: !!contato?.email,
      base_esperada: baseEsperada,
      contexto: {
        nf: l.nf,
        ctrc: l.ctrc,
        horas_paradas: l.horas_paradas,
        dentro_sla: l.dentro_sla,
      },
    });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
