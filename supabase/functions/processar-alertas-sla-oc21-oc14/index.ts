// =============================================================================
// processar-alertas-sla-oc21-oc14 — cron horário que detecta cards com oc=21
// lançada há >24h SEM oc=14 e dispara alerta automático pro gerente da base.
//
// Fluxo por card:
//   1. Card já tem oc=14 no histórico → marca alerta como cancelado_oc14_chegou
//   2. Card já tem alerta enviado pra (card_id, data_oc21) → skip (idempotente)
//   3. Resolve base esperada → contato em contatos_bases_ssw → sem contato: log + skip
//   4. Sonnet 4.6 gera assunto + corpo HTML personalizado
//   5. enviar-cobranca-base envia via Gmail OAuth do operador responsavel_relacionamento
//   6. INSERT em alertas_sla_oc21_oc14 (status='enviado' ou 'falhou')
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
const SLA_HORAS = 24;

const SYSTEM_PROMPT = `Você é um agente que escreve emails curtos e profissionais pra gerentes de bases SSW (transportadora Sal Express) quando uma reentrega solicitada (oc=21) passou de 24h sem a base lançar oc=14 (saída pra entrega).

Tom: profissional, direto, sem rodeios. Português brasileiro. Foco em ação.

Receba o contexto do card e retorne EXCLUSIVAMENTE JSON neste schema (sem markdown):

{
  "assunto": "string ≤80 chars",
  "corpo_html": "string HTML simples com parágrafos curtos (<p>), negrito em pontos chave (<strong>). Cite NF, CTRC, horas paradas, base. Solicite ação clara (lançar oc=14) e prazo (ex: até hoje 18h)."
}

Não invente dados. Use SÓ os campos do contexto.`;

interface CardComOc21 {
  id: string;
  nf: string;
  ctrc: string | null;
  responsavel_relacionamento: string | null;
  base_destino: string | null;
  historico_ssw: HistoricoOc[] | null;
  nome_cliente?: string | null;
  empresa_cliente?: string | null;
}

interface HistoricoOc {
  codigo: number | null;
  descricao?: string;
  data: string;
  filial?: string;
  usuario?: string;
}

interface Summary {
  cards_avaliados: number;
  alertas_enviados: number;
  alertas_falhou: number;
  sem_contato: number;
  ja_alertados: number;
  cancelados_oc14_chegou: number;
  erros: Array<{ card_id: string; message: string }>;
  duration_ms: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const start = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const summary: Summary = {
    cards_avaliados: 0,
    alertas_enviados: 0,
    alertas_falhou: 0,
    sem_contato: 0,
    ja_alertados: 0,
    cancelados_oc14_chegou: 0,
    erros: [],
    duration_ms: 0,
  };

  // 1. Lista cards candidatos: têm historico_ssw com oc=21, last_event_at <= 30d
  const { data: cards } = await supabase
    .from("cards")
    .select("id, nf, ctrc, responsavel_relacionamento, base_destino, historico_ssw, nome_cliente, empresa_cliente")
    .not("historico_ssw", "is", null)
    .gte("last_event_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .limit(2000);

  const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(env) });

  for (const card of (cards ?? []) as CardComOc21[]) {
    summary.cards_avaliados++;
    try {
      const historico = card.historico_ssw ?? [];
      const eventos = historico
        .filter((o) => o.codigo === 21 || o.codigo === 14)
        .map((o) => ({ ...o, dataParsed: parseDataSsw(o.data) }))
        .filter((o) => o.dataParsed !== null)
        .sort((a, b) => a.dataParsed!.getTime() - b.dataParsed!.getTime());

      // Pega ÚLTIMA oc=21 e checa se tem oc=14 depois
      const ultima21 = [...eventos].reverse().find((e) => e.codigo === 21);
      if (!ultima21) continue;

      const data21 = ultima21.dataParsed!;
      const horasDesdeOc21 = (Date.now() - data21.getTime()) / (60 * 60 * 1000);
      if (horasDesdeOc21 < SLA_HORAS) continue; // ainda dentro do SLA

      const tem14Depois = eventos.some(
        (e) => e.codigo === 14 && e.dataParsed!.getTime() > data21.getTime(),
      );

      // Cancela alerta pendente se oc=14 chegou
      if (tem14Depois) {
        const { error } = await supabase
          .from("alertas_sla_oc21_oc14")
          .update({ status: "cancelado_oc14_chegou" })
          .eq("card_id", card.id)
          .eq("data_oc21", data21.toISOString())
          .eq("status", "enviado");
        if (!error) summary.cancelados_oc14_chegou++;
        continue;
      }

      // Já existe alerta pra esse par? skip
      const { data: jaAlertado } = await supabase
        .from("alertas_sla_oc21_oc14")
        .select("id")
        .eq("card_id", card.id)
        .eq("data_oc21", data21.toISOString())
        .maybeSingle();
      if (jaAlertado) {
        summary.ja_alertados++;
        continue;
      }

      // Resolve base esperada: prioridade → última filial não-Cockpit antes da 21 → base_destino
      const baseEsperada = resolverBaseEsperada(eventos, ultima21, card);
      if (!baseEsperada) {
        summary.sem_contato++;
        continue;
      }

      // Lookup contato
      const { data: contato } = await supabase
        .from("contatos_bases_ssw")
        .select("email, nome_contato")
        .eq("base", baseEsperada)
        .eq("ativo", true)
        .maybeSingle();

      if (!contato?.email) {
        summary.sem_contato++;
        // Não inserimos alerta (pra retentar quando contato for cadastrado)
        continue;
      }

      // Resolve operador pra usar Gmail OAuth dele
      const operadorNome = card.responsavel_relacionamento;
      if (!operadorNome) {
        summary.erros.push({ card_id: card.id, message: "card sem responsavel_relacionamento" });
        continue;
      }
      const { data: operador } = await supabase
        .from("operadores")
        .select("id")
        .ilike("nome", operadorNome)
        .eq("ativo", true)
        .maybeSingle();
      if (!operador?.id) {
        summary.erros.push({ card_id: card.id, message: `operador "${operadorNome}" não encontrado em operadores` });
        continue;
      }

      // IA gera mensagem
      const horasParadas = Math.floor(horasDesdeOc21);
      const userPrompt = `Contexto:
- NF: ${card.nf}
- CTRC: ${card.ctrc ?? "(sem ctrc)"}
- Cliente: ${card.empresa_cliente ?? card.nome_cliente ?? "(sem nome)"}
- Base responsável: ${baseEsperada}
- Gerente: ${contato.nome_contato}
- Data oc=21 (reentrega solicitada): ${data21.toISOString()}
- Horas paradas sem oc=14: ${horasParadas}h
- SLA: ${SLA_HORAS}h
- Operador relacionamento: ${operadorNome}

Gere o assunto + corpo_html do email pro gerente cobrando lançamento de oc=14.`;

      let mensagem: { assunto: string; corpo_html: string };
      try {
        const completion = await anthropic.complete({
          model: MODEL,
          maxTokens: 1024,
          temperature: 0.4,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        });
        const limpo = completion.text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, "");
        mensagem = JSON.parse(limpo);
      } catch (e) {
        summary.erros.push({ card_id: card.id, message: `IA falhou: ${e instanceof Error ? e.message : String(e)}` });
        // Fallback: mensagem template fixa
        mensagem = {
          assunto: `Ação SLA: oc=14 pendente há ${horasParadas}h — NF ${card.nf}`,
          corpo_html: `<p>Prezado(a) ${contato.nome_contato},</p>
<p>A NF <strong>${card.nf}</strong> (CTRC ${card.ctrc ?? "?"}) está parada há <strong>${horasParadas} horas</strong> aguardando lançamento de oc=14 (saída pra entrega) na base <strong>${baseEsperada}</strong>.</p>
<p>O cliente solicitou reentrega (oc=21) e nosso SLA de 24h já foi ultrapassado. Solicito o lançamento da oc=14 e saída da carga ainda hoje.</p>
<p>Qualquer dúvida, contate ${operadorNome}.</p>
<p>Atenciosamente,<br><strong>Equipe Sal Express</strong></p>`,
        };
      }

      // Envia via enviar-cobranca-base com operador_id_override
      const handlerUrl = `${env["SUPABASE_URL"]}/functions/v1/enviar-cobranca-base`;
      const envioRes = await fetch(handlerUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
          apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          destinatarios: [contato.email],
          assunto: mensagem.assunto,
          corpo_html: mensagem.corpo_html,
          canal: "email",
          indicador_tipo: "alerta_sla_oc21_oc14",
          sugerido_por_ia: true,
          operador_id_override: operador.id,
        }),
      });
      const envioBody = await envioRes.json().catch(() => null) as Record<string, unknown> | null;

      const sucesso = envioRes.ok && envioBody?.ok === true;
      await supabase.from("alertas_sla_oc21_oc14").insert({
        card_id: card.id,
        data_oc21: data21.toISOString(),
        base_oc14_esperada: baseEsperada,
        destinatario_email: contato.email,
        canal: "email",
        mensagem_assunto: mensagem.assunto,
        mensagem_html: mensagem.corpo_html,
        sugerido_por_ia: true,
        status: sucesso ? "enviado" : "falhou",
        motivo_falha: sucesso ? null : (envioBody?.error as string | undefined ?? `HTTP ${envioRes.status}`),
      });

      if (sucesso) summary.alertas_enviados++;
      else summary.alertas_falhou++;
    } catch (err) {
      summary.erros.push({ card_id: card.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  summary.duration_ms = Date.now() - start;
  console.log("processar-alertas-sla-oc21-oc14:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

function resolverBaseEsperada(
  eventos: Array<{ codigo: number | null; filial?: string; dataParsed: Date | null }>,
  oc21: { dataParsed: Date | null },
  card: CardComOc21,
): string | null {
  // 1ª prioridade: última filial NÃO-Cockpit (operador) antes da 21
  const operadorNomeLower = (card.responsavel_relacionamento ?? "").toLowerCase();
  const antesD21 = eventos
    .filter((e) => e.codigo !== 21 && e.codigo !== 14 && e.dataParsed!.getTime() < oc21.dataParsed!.getTime())
    .reverse();
  for (const e of antesD21) {
    const filial = (e.filial ?? "").trim();
    if (filial && !filial.toLowerCase().includes(operadorNomeLower)) {
      return filial;
    }
  }
  // 2ª prioridade: base_destino do card
  return (card.base_destino ?? "").trim() || null;
}

function parseDataSsw(s: string): Date | null {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const yy = 2000 + Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  return new Date(Date.UTC(yy, mm, dd, hh + 3, mi));
}
