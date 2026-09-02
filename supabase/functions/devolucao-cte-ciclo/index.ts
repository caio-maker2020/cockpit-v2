// =============================================================================
// devolucao-cte-ciclo — o "tick" diário dos ciclos de devolução com CT-e.
//
// Faz três coisas, todas dirigidas por `devolucoes_cte.status` e NUNCA por
// `cards.state`:
//   1. COBRA o cliente que não mandou o CT-e (1 lembrete, 2 dias úteis);
//   2. ESCALONA pra MARIA quando o teto de lembretes passou sem retorno;
//   3. VIGIA ciclo aberto e PARADO — o item que impede o caso de virar
//      invisível enquanto o card está em TRANSFERIDO por causa da oc 56.
//
// POR QUE NÃO RELIGAR O CRON ANTIGO (decisão nº 12 do Caio):
// `cobranca-cliente-aguardando-daily` está `active = false` em produção
// (medido). Religar faria a 1ª execução varrer TODO o backlog acumulado e
// disparar e-mail EXTERNO em volume sobre casos antigos — irreversível. Cron
// dormente não é neutro.
//
// POR QUE NÃO CHAMAR `cobrar-cliente-aguardando` (verificado no código, não
// suposto): (a) o texto dela é FIXO e não aceita texto próprio, e o lembrete
// daqui tem de dizer que falta o CT-e; (b) ela EXIGE
// `card.state = 'AGUARDANDO_CLIENTE'` (linha 90) — exatamente a dependência que
// a decisão nº 12 proíbe, porque qualquer oc de relacionamento ≠54 tira o card
// desse estado (INV-019) e mataria a cobrança pra sempre. Reusamos as PEÇAS de
// envio (`sendGmailMessage`, `garantirPrefixoReply`), não a função.
//
// A DECISÃO é pura e testada em `_shared/devolucao-cte-ciclo.ts` (19 casos).
// Aqui só se executa.
// =============================================================================
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { ehChamadaServiceRole } from "../_shared/service-auth.ts";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";
import { garantirPrefixoReply } from "../_shared/email-threading.ts";
import {
  type CicloTick,
  type ConfigTick,
  decidirTickCiclo,
  montarLembreteCte,
} from "../_shared/devolucao-cte-ciclo.ts";

/** Teto de ciclos por execução — cron diário, população pequena. */
const LOTE = 200;

interface Resumo {
  ciclos_lidos: number;
  cobrados: number;
  escalonados: number;
  alertados: number;
  nada: number;
  erros: Array<{ ciclo_id: string; erro: string }>;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (!(await ehChamadaServiceRole(Deno.env.get("SUPABASE_URL")!, req.headers.get("Authorization")))) {
    return jsonResp({ ok: false, error: "service role only" }, 401);
  }
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const resumo: Resumo = {
    ciclos_lidos: 0,
    cobrados: 0,
    escalonados: 0,
    alertados: 0,
    nada: 0,
    erros: [],
  };

  // --- config da feature ----------------------------------------------------
  const { data: cfg } = await supabase
    .from("devolucao_cte_config")
    .select("lembrete_dias_uteis, lembretes_teto, escalonar_dias_uteis, vigia_dias_uteis")
    .eq("id", 1)
    .maybeSingle();
  if (!cfg) return jsonResp({ ok: false, error: "devolucao_cte_config (id=1) ausente" }, 500);
  const config: ConfigTick = {
    lembrete_dias_uteis: Number(cfg.lembrete_dias_uteis),
    lembretes_teto: Number(cfg.lembretes_teto),
    escalonar_dias_uteis: Number(cfg.escalonar_dias_uteis),
    vigia_dias_uteis: Number(cfg.vigia_dias_uteis),
  };

  // --- a flag da COBRANÇA é separada: só ela manda e-mail EXTERNO ----------
  // O vigia e o escalonamento são internos (card_event) e rodam sempre — não há
  // risco de vazar nada pra fora, e são justamente o que impede o caso de ficar
  // invisível. Ciclo só existe se a feature já esteve ligada, então população
  // zero enquanto os degraus não subirem.
  const { data: flagCobranca } = await supabase
    .from("feature_flags").select("enabled").eq("key", "devolucao_cte_cobranca").maybeSingle();
  const cobrancaLigada = flagCobranca?.enabled === true;

  // --- feriados (mesma tabela que o resto do projeto usa) ------------------
  const feriados = new Set<string>();
  {
    const { data: fs } = await supabase.from("feriados").select("data");
    for (const f of (fs ?? []) as Array<{ data: string }>) {
      if (typeof f.data === "string") feriados.add(f.data.slice(0, 10));
    }
  }

  // --- ciclos ABERTOS -------------------------------------------------------
  const { data: ciclos, error: ciclosErr } = await supabase
    .from("devolucoes_cte")
    .select(
      "id, card_id, nf, ctrc_origem, status, aguardando_cte_desde, cobrancas_feitas, " +
        "ultima_cobranca_em, escalonado_para_humano_em, alerta_parado_em, updated_at, encerrado_em",
    )
    .is("encerrado_em", null)
    .order("updated_at", { ascending: true })
    .limit(LOTE);
  if (ciclosErr) return jsonResp({ ok: false, error: `SELECT devolucoes_cte: ${ciclosErr.message}` }, 500);

  const agora = new Date();
  resumo.ciclos_lidos = (ciclos ?? []).length;

  // Cast via `unknown`: o client sem tipos gerados infere GenericStringError[]
  // pro select montado por concatenação, e o TS recusa a conversão direta.
  const linhas = (ciclos ?? []) as unknown as Array<Record<string, unknown>>;
  for (const row of linhas) {
    const cicloId = row["id"] as string;
    try {
      const ciclo: CicloTick = {
        id: cicloId,
        status: (row["status"] as string) ?? "",
        aguardando_cte_desde: (row["aguardando_cte_desde"] as string | null) ?? null,
        cobrancas_feitas: (row["cobrancas_feitas"] as number | null) ?? 0,
        ultima_cobranca_em: (row["ultima_cobranca_em"] as string | null) ?? null,
        escalonado_para_humano_em: (row["escalonado_para_humano_em"] as string | null) ?? null,
        alerta_parado_em: (row["alerta_parado_em"] as string | null) ?? null,
        updated_at: (row["updated_at"] as string | null) ?? null,
        encerrado_em: (row["encerrado_em"] as string | null) ?? null,
      };
      const d = decidirTickCiclo({ ciclo, config, agora, feriados });
      const cardId = row["card_id"] as string | null;

      if (d.acao === "nada") {
        resumo.nada++;
        continue;
      }

      // ── ALERTA DE CICLO PARADO ─────────────────────────────────────────
      if (d.acao === "alertar_parado") {
        await supabase.from("devolucoes_cte")
          .update({ alerta_parado_em: agora.toISOString() })
          .eq("id", cicloId);
        if (cardId) {
          await supabase.from("card_events").insert({
            card_id: cardId,
            event_type: "DevolucaoCteCicloParado",
            actor_type: "agent",
            actor_id: "devolucao-cte-ciclo",
            payload: {
              devolucao_cte_id: cicloId,
              status: ciclo.status,
              dias_uteis_parado: d.diasUteis,
              motivo: d.motivo,
              // O texto que a MARIA lê. Sem isto o alerta é um código.
              aviso:
                `Devolução da NF ${row["nf"]} está parada há ${d.diasUteis} dia(s) útil(eis) ` +
                `em "${ciclo.status}". O card pode estar fora do painel (a oc 56 manda pra ` +
                `TRANSFERIDO) — confira se falta documento ou retorno da unidade.`,
            },
          });
        }
        resumo.alertados++;
        continue;
      }

      // ── ESCALONAR PRA MARIA (para de cobrar) ───────────────────────────
      if (d.acao === "escalonar") {
        await supabase.from("devolucoes_cte")
          .update({ escalonado_para_humano_em: agora.toISOString(), proxima_cobranca_em: null })
          .eq("id", cicloId);
        if (cardId) {
          await supabase.from("card_events").insert({
            card_id: cardId,
            event_type: "DevolucaoCteEscalonadaParaHumano",
            actor_type: "agent",
            actor_id: "devolucao-cte-ciclo",
            payload: {
              devolucao_cte_id: cicloId,
              cobrancas_feitas: ciclo.cobrancas_feitas,
              dias_uteis_sem_retorno: d.diasUteis,
              aviso:
                `O cliente não enviou o CT-e da NF ${row["nf"]} depois do lembrete. ` +
                `A cobrança automática PAROU (teto de ${config.lembretes_teto}). ` +
                `Trate manualmente.`,
            },
          });
        }
        resumo.escalonados++;
        continue;
      }

      // ── COBRAR O CLIENTE (único caminho com e-mail EXTERNO) ────────────
      if (d.acao === "cobrar") {
        if (!cobrancaLigada) {
          resumo.nada++;
          continue;
        }
        if (!cardId) {
          resumo.erros.push({ ciclo_id: cicloId, erro: "ciclo sem card_id — não dá pra cobrar" });
          continue;
        }
        const enviado = await cobrarClienteDoCiclo(supabase, {
          cardId,
          cicloId,
          nf: String(row["nf"] ?? ""),
          ctrc: String(row["ctrc_origem"] ?? ""),
        });
        if (!enviado.ok) {
          // Falha de envio NÃO incrementa o contador nem move o relógio: na
          // próxima passada tenta de novo. Contar um lembrete que não saiu
          // levaria o ciclo direto pro escalonamento sem o cliente ter sido
          // avisado uma única vez.
          await supabase.from("card_events").insert({
            card_id: cardId,
            event_type: "DevolucaoCteCobrancaFalhou",
            actor_type: "agent",
            actor_id: "devolucao-cte-ciclo",
            payload: { devolucao_cte_id: cicloId, motivo: enviado.motivo },
          });
          resumo.erros.push({ ciclo_id: cicloId, erro: enviado.motivo });
          continue;
        }
        await supabase.from("devolucoes_cte")
          .update({
            cobrancas_feitas: (ciclo.cobrancas_feitas ?? 0) + 1,
            ultima_cobranca_em: agora.toISOString(),
          })
          .eq("id", cicloId);
        await supabase.from("card_events").insert({
          card_id: cardId,
          event_type: "DevolucaoCteClienteCobrado",
          actor_type: "agent",
          actor_id: "devolucao-cte-ciclo",
          payload: {
            devolucao_cte_id: cicloId,
            lembrete_numero: (ciclo.cobrancas_feitas ?? 0) + 1,
            teto: config.lembretes_teto,
            dias_uteis: d.diasUteis,
            gmail_message_id: enviado.gmailMessageId ?? null,
          },
        });
        resumo.cobrados++;
      }
    } catch (e) {
      resumo.erros.push({
        ciclo_id: cicloId,
        erro: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    }
  }

  return jsonResp({ ok: true, cobranca_ligada: cobrancaLigada, ...resumo });
});

/**
 * Manda o lembrete ao cliente em REPLY da última conversa do card.
 *
 * Sem outbound anterior NÃO inventa conversa nova: um lembrete que chega fora do
 * fio, sem o cliente ter recebido o pedido original, é ruído. O desenho garante
 * que a 54 do Fluxo 4 sai com e-mail (R10), então o outbound existe — se não
 * existir, é sinal de que algo antes falhou, e isso tem de aparecer.
 */
async function cobrarClienteDoCiclo(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  p: { cardId: string; cicloId: string; nf: string; ctrc: string },
): Promise<{ ok: true; gmailMessageId: string | null } | { ok: false; motivo: string }> {
  const { data: card } = await supabase
    .from("cards")
    .select("id, nf, assigned_operator_id")
    .eq("id", p.cardId)
    .maybeSingle();
  if (!card?.assigned_operator_id) return { ok: false, motivo: "card_sem_operador" };

  const { data: outbound } = await supabase
    .from("cards_emails_outbound")
    .select("subject, to_email, from_email, gmail_message_id, gmail_thread_id, message_id_header")
    .eq("card_id", p.cardId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!outbound?.to_email || !outbound?.gmail_thread_id) {
    return { ok: false, motivo: "sem_outbound_anterior_para_responder" };
  }

  const { data: op } = await supabase
    .from("operadores")
    .select("id, nome, email_relacionamento")
    .eq("id", card.assigned_operator_id)
    .maybeSingle();
  if (!op) return { ok: false, motivo: "operador_nao_encontrado" };

  const { texto } = montarLembreteCte({ nf: p.nf, ctrc: p.ctrc });
  const subject = garantirPrefixoReply(
    (outbound.subject as string | null) ?? `Devolução - NF ${p.nf}`,
  );

  const msgIdOrigem = (outbound.message_id_header as string | null) ??
    (outbound.gmail_message_id as string | null);
  const extraHeaders: Record<string, string> = {};
  if (msgIdOrigem) {
    const comAngulo = msgIdOrigem.startsWith("<") ? msgIdOrigem : `<${msgIdOrigem}>`;
    extraHeaders["In-Reply-To"] = comAngulo;
    extraHeaders["References"] = comAngulo;
  }

  const r = await sendGmailMessage({
    supabase,
    operadorId: op.id as string,
    destinatario: outbound.to_email as string,
    cc: [],
    subject,
    texto,
    fromName: op.nome as string | null,
    attachments: [],
    extraHeaders,
    threadId: outbound.gmail_thread_id as string,
  });
  if (!r.ok) return { ok: false, motivo: `gmail_send_falhou:${r.error ?? "?"}` };

  // Este É e-mail ao cliente, então ENTRA em cards_emails_outbound — ao
  // contrário do e-mail interno ao setor de Devolução, que fica fora de
  // propósito (INV-125). São coisas diferentes e o registro reflete isso.
  if (r.messageId && r.threadId) {
    await supabase.from("cards_emails_outbound").upsert(
      {
        card_id: p.cardId,
        operadora_id: op.id,
        gmail_message_id: r.messageId,
        gmail_thread_id: r.threadId,
        from_email: (op.email_relacionamento as string | null) ??
          (outbound.from_email as string | null),
        to_email: outbound.to_email,
        subject,
        corpo_renderizado: texto,
      },
      { onConflict: "gmail_message_id" },
    );
  }
  return { ok: true, gmailMessageId: r.messageId ?? null };
}
