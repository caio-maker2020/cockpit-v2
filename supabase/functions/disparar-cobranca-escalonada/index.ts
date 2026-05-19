// =============================================================================
// disparar-cobranca-escalonada — envia 1 cobrança (email OU whatsapp) e audita
//
// Caio 2026-05-19 (PRIORIDADES AI):
// Operador (ou cron futuro) dispara. Lookup contato → gera/usa texto →
// envia → INSERT cobrancas_disparadas → atualiza prioridades_kanban_status.
//
// Input: { card_id, papel, canal, texto_final?, assunto_final? }
//   - texto_final/assunto_final: se ausentes, gera via sugerir-cobranca-ai
// Output: { ok, cobranca_id, status_kanban_novo, message_id?, contato_destino }
//
// Transições kanban (cards.prioridades_kanban_status):
//   - papel=gerente_base + status ∈ (NULL, 'parada') → 'cobrado'
//   - papel ∈ (coord, gerente_relac) + status ∈ (NULL, 'parada', 'cobrado') → 'escalado'
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  gerarTextoCobrancaEscalonada,
  type Papel,
  type Canal,
} from "../_shared/gerar-texto-cobranca-escalonada.ts";
import {
  readEvolutionEnv,
  enviarWhatsApp,
} from "../_shared/evolution-outbound.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface InputBody {
  card_id?: string;
  papel?: Papel;
  canal?: Canal;
  texto_final?: string;
  assunto_final?: string;
}

function humanizarPapel(p: Papel): string {
  if (p === "gerente_base") return "Gerente da Base";
  if (p === "coordenador_entrega") return "Coordenador de Entrega";
  return "Gerente de Relacionamento";
}

function novoStatusKanban(papel: Papel, statusAtual: string | null): string | null {
  if (papel === "gerente_base") {
    if (statusAtual === null || statusAtual === "parada") return "cobrado";
    return statusAtual; // se já cobrado/escalado, mantém (re-cobrança gerente base não rebaixa)
  }
  // coordenador_entrega ou gerente_relacionamento
  if (statusAtual === null || statusAtual === "parada" || statusAtual === "cobrado") return "escalado";
  return statusAtual;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.card_id || !body?.papel || !body?.canal) {
      return json({ ok: false, error: "card_id, papel, canal obrigatórios" }, 400);
    }
    if (!["gerente_base", "coordenador_entrega", "gerente_relacionamento"].includes(body.papel)) {
      return json({ ok: false, error: "papel inválido" }, 400);
    }
    if (!["email", "whatsapp"].includes(body.canal)) {
      return json({ ok: false, error: "canal inválido" }, 400);
    }

    // Resolve operador autenticado (pra disparado_por + assinatura + nome canônico)
    const auth = req.headers.get("Authorization") ?? "";
    const userJwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let operadorNome = "Operador";
    let operadorId: string | null = null;
    if (userJwt) {
      const supabaseAuth = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
        global: { headers: { Authorization: auth } },
      });
      const { data: u } = await supabaseAuth.auth.getUser(userJwt);
      if (u?.user) {
        const { data: op } = await supabase
          .from("operadores")
          .select("id, nome")
          .eq("user_id", u.user.id)
          .maybeSingle();
        operadorNome = (op as { nome?: string } | null)?.nome ?? "Operador";
        operadorId = (op as { id?: string } | null)?.id ?? null;
      }
    }

    // Carrega card via view (oc origem + dias parados)
    const { data: prio } = await supabase
      .from("v_prioridades_ai")
      .select("*")
      .eq("card_id", body.card_id)
      .maybeSingle();
    if (!prio) {
      return json({ ok: false, error: "card não está em v_prioridades_ai" }, 404);
    }

    const ocOrigem = (prio as { oc_origem: number }).oc_origem as 13 | 21;
    const base = (prio as { base: string | null }).base;

    // Lookup contato — match exato base+cargo, fallback global
    const { data: contatos } = await supabase
      .from("contatos_escalonamento")
      .select("id, nome, telefone, email, base")
      .eq("cargo", body.papel)
      .eq("ativo", true)
      .or(`base.eq.${base ?? ""},base.is.null`);

    const contato = (contatos ?? []).sort((a, b) => {
      const aGlobal = a.base == null ? 1 : 0;
      const bGlobal = b.base == null ? 1 : 0;
      return aGlobal - bGlobal;
    })[0] ?? null;

    if (!contato) {
      return json({ ok: false, error: "sem_contato", papel: body.papel, base }, 400);
    }

    const contatoDestino = body.canal === "email" ? contato.email : contato.telefone;
    if (!contatoDestino) {
      return json({
        ok: false,
        error: "contato_sem_destino_para_canal",
        canal: body.canal,
        contato_nome: contato.nome,
      }, 400);
    }

    // Gera ou usa texto fornecido
    let texto: string;
    let assunto: string;
    if (body.texto_final && body.texto_final.trim().length > 0) {
      texto = body.texto_final.trim();
      assunto = (body.assunto_final ?? "").trim();
    } else {
      const { data: cobAnt } = await supabase
        .from("cobrancas_disparadas")
        .select("papel, canal, disparado_em, contato_nome")
        .eq("card_id", body.card_id)
        .order("disparado_em", { ascending: true });
      const out = await gerarTextoCobrancaEscalonada(env, {
        papel: body.papel,
        canal: body.canal,
        oc_origem: ocOrigem,
        nf: (prio as { nf: string }).nf,
        ctrc: (prio as { ctrc: string | null }).ctrc,
        base,
        empresa_cliente: (prio as { empresa_cliente: string | null }).empresa_cliente,
        dias_uteis_parados: Number((prio as { dias_uteis_parados: number | null }).dias_uteis_parados ?? 0),
        contato_destinatario_nome: contato.nome,
        contato_destinatario_cargo_humanizado: humanizarPapel(body.papel),
        operador_nome: operadorNome,
        cobrancas_anteriores: (cobAnt ?? []).map((c) => ({
          papel: c.papel as Papel,
          canal: c.canal as Canal,
          disparado_em: c.disparado_em as string,
          contato_nome: (c.contato_nome ?? null) as string | null,
        })),
      });
      texto = out.texto;
      assunto = out.assunto;
    }

    // Envia
    let status: "enviado" | "falhou" = "enviado";
    let erro: string | null = null;
    let evolutionMessageId: string | null = null;
    let gmailMessageId: string | null = null;

    try {
      if (body.canal === "whatsapp") {
        const evEnv = readEvolutionEnv(env, operadorNome);
        const r = await enviarWhatsApp(evEnv, contatoDestino, texto);
        evolutionMessageId = r.messageId || null;
      } else {
        // canal=email — usa edge enviar-cobranca-base (Gmail OAuth)
        const resp = await fetch(`${env["SUPABASE_URL"]}/functions/v1/enviar-cobranca-base`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
            "apikey": env["SUPABASE_SERVICE_ROLE_KEY"]!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            card_id: body.card_id,
            assunto,
            corpo_html: textoHtmlSimples(texto, operadorNome),
            email_destino: contatoDestino,
            destinatario_nome: contato.nome,
            // overrides de operador via nome canônico
            operador_id_override: operadorId,
            origem: `cobranca_escalonada_${body.papel}`,
          }),
        });
        if (!resp.ok) {
          throw new Error(`enviar-cobranca-base ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
        const json = await resp.json().catch(() => ({}));
        gmailMessageId = (json as { gmail_message_id?: string })?.gmail_message_id ?? null;
      }
    } catch (e) {
      status = "falhou";
      erro = e instanceof Error ? e.message : String(e);
    }

    // INSERT cobrancas_disparadas
    const { data: cob, error: insErr } = await supabase
      .from("cobrancas_disparadas")
      .insert({
        card_id: body.card_id,
        papel: body.papel,
        canal: body.canal,
        contato_escal_id: contato.id,
        contato_nome: contato.nome,
        contato_destino: contatoDestino,
        texto_enviado: texto,
        assunto: assunto || null,
        status,
        erro,
        oc_no_disparo: ocOrigem,
        dias_parados_no_disparo: (prio as { dias_uteis_parados: number | null }).dias_uteis_parados,
        evolution_message_id: evolutionMessageId,
        gmail_message_id: gmailMessageId,
        disparado_por: operadorId,
      })
      .select("id")
      .single();

    if (insErr) {
      return json({ ok: false, error: `insert cobrancas_disparadas: ${insErr.message}` }, 500);
    }

    // Atualiza kanban_status se envio teve sucesso
    let statusKanbanNovo: string | null = null;
    if (status === "enviado") {
      const statusAtual = (prio as { coluna_kanban: string | null }).coluna_kanban;
      const novo = novoStatusKanban(body.papel, statusAtual);
      if (novo && novo !== statusAtual) {
        await supabase
          .from("cards")
          .update({
            prioridades_kanban_status: novo,
            prioridades_kanban_atualizado_em: new Date().toISOString(),
          })
          .eq("id", body.card_id);
        statusKanbanNovo = novo;
      } else {
        statusKanbanNovo = statusAtual;
      }
    }

    // card_event audit
    await supabase.from("card_events").insert({
      card_id: body.card_id,
      event_type: "CobrancaEscalonadaDisparada",
      actor_type: operadorId ? "operator" : "system",
      actor_id: operadorId ?? "disparar-cobranca-escalonada",
      payload: {
        papel: body.papel,
        canal: body.canal,
        status,
        erro,
        cobranca_id: (cob as { id: string }).id,
        contato_nome: contato.nome,
        kanban_status_anterior: (prio as { coluna_kanban: string | null }).coluna_kanban,
        kanban_status_novo: statusKanbanNovo,
        oc_origem: ocOrigem,
      },
    });

    return json({
      ok: status === "enviado",
      cobranca_id: (cob as { id: string }).id,
      status,
      status_kanban_novo: statusKanbanNovo,
      contato_nome: contato.nome,
      contato_destino: contatoDestino,
      evolution_message_id: evolutionMessageId,
      gmail_message_id: gmailMessageId,
      erro,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("disparar-cobranca-escalonada fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function textoHtmlSimples(texto: string, operadorNome: string): string {
  const esc = texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${
    esc.replace(/\n/g, "<br>")
  }</div>`;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
