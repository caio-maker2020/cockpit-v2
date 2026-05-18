// =============================================================================
// enviar-cobranca-base — envia cobrança/relatório de indicador via canal
// escolhido (email no MVP, whatsapp futuro). Usado pelo botão "Enviar como
// está" / "Enviar relatório agora" na aba INDICADORES.
//
// Login do operador: Gmail OAuth via _shared/gmail-sender.ts (mesmo padrão
// dos outros emails do Cockpit).
//
// Caio 2026-05-18.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";

interface InputBody {
  destinatarios?: string[];
  assunto?: string;
  corpo_html?: string;
  canal?: "email" | "whatsapp";
  indicador_tipo?: string;
  sugerido_por_ia?: boolean;
  /** Caio 2026-05-18: usado por crons que rodam como service_role e precisam
   * enviar email com OAuth de um operador específico (ex: alerta proativo SLA
   * usa OAuth do responsavel_relacionamento do card). Ignorado quando o caller
   * tem JWT de usuário (segurança — operador autenticado só envia como ele). */
  operador_id_override?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const body = await req.json().catch(() => ({})) as InputBody;

    // Valida input
    const destinatarios = (body.destinatarios ?? []).filter((d) => typeof d === "string" && d.includes("@"));
    if (destinatarios.length === 0) {
      return json({ ok: false, error: "destinatarios obrigatório (array com pelo menos 1 email)" }, 400);
    }
    const assunto = (body.assunto ?? "").trim();
    if (!assunto) return json({ ok: false, error: "assunto obrigatório" }, 400);
    const corpoHtml = (body.corpo_html ?? "").trim();
    if (!corpoHtml) return json({ ok: false, error: "corpo_html obrigatório" }, 400);
    const canal = body.canal ?? "email";
    const indicadorTipo = body.indicador_tipo ?? "erros_lancamento_base";
    const sugeridoPorIa = body.sugerido_por_ia === true;

    if (canal === "whatsapp") {
      // TODO Caio: integrar com Evolution API. Por enquanto retorna 501.
      return json({
        ok: false,
        error: "Canal whatsapp ainda não implementado. Use email por enquanto.",
      }, 501);
    }

    // Resolve operador: 2 caminhos
    //   1. JWT do usuário (chamada via Lovable/cliente) → resolve operador via user_id
    //   2. service_role + operador_id_override (chamada via cron/edge-to-edge) → usa override
    // Override ignorado se houver JWT de usuário (segurança — user só envia como ele mesmo).
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseService = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const supabaseUser = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userInfo } = await supabaseUser.auth.getUser();
    const userId = userInfo?.user?.id ?? null;

    let operador: { id: string; nome: string } | null = null;

    let userIdResolvido: string | null = userId;

    if (userId) {
      // Caminho 1: usuário autenticado
      const { data: op } = await supabaseService
        .from("operadores")
        .select("id, nome")
        .eq("user_id", userId)
        .maybeSingle();
      operador = op as typeof operador;
    } else if (body.operador_id_override) {
      // Caminho 2: service_role com override (cron). Resolve também o user_id
      // do operador pra preencher enviado_por (NOT NULL na auditoria).
      const { data: op } = await supabaseService
        .from("operadores")
        .select("id, nome, user_id")
        .eq("id", body.operador_id_override)
        .maybeSingle();
      if (op) {
        const opObj = op as Record<string, unknown>;
        operador = { id: opObj.id as string, nome: opObj.nome as string };
        userIdResolvido = (opObj.user_id as string | null) ?? null;
      }
    }

    if (!operador?.id) {
      return json({
        ok: false,
        error: userId
          ? "Operador não encontrado em public.operadores"
          : "Sem JWT de usuário e sem operador_id_override válido — cron deve passar operador_id_override",
      }, 403);
    }
    const operadorResolvido = operador as { id: string; nome: string };

    // Envia email pra cada destinatário (TO único + Cc se >1; ou 1 envio múltiplo via Cc).
    // Decisão Caio (memória feedback_email_outbound_unico_envio): 1 envio com TO+Cc,
    // não múltiplos POSTs separados.
    const destinatarioPrincipal = destinatarios[0]!;
    const cc = destinatarios.slice(1);

    // Caio 2026-05-18: cobranças vêm com HTML (IA gera <p>, <strong>, <br>).
    // Passa htmlBody + fallback text/plain derivado do HTML (strip tags).
    // Gmail manda multipart/alternative — clients renderizam o HTML.
    const fallbackTexto = corpoHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const result = await sendGmailMessage({
      supabase: supabaseService,
      operadorId: operadorResolvido.id,
      destinatario: destinatarioPrincipal,
      cc: cc.length > 0 ? cc : null,
      subject: assunto,
      texto: fallbackTexto,
      htmlBody: corpoHtml,
      fromName: operadorResolvido.nome,
    });

    if (!result.ok) {
      return json({ ok: false, error: `Falha Gmail: ${result.error}`, httpStatus: result.httpStatus }, 502);
    }

    // Auditoria
    await supabaseService.from("cobrancas_enviadas").insert({
      indicador_tipo: indicadorTipo,
      canal,
      destinatarios,
      assunto,
      corpo_html: corpoHtml,
      sugerido_por_ia: sugeridoPorIa,
      enviado_por: userIdResolvido,
      resposta_canal: {
        gmail_message_id: result.messageId,
        thread_id: result.threadId,
        from: result.from,
      },
    });

    return json({
      ok: true,
      mensagem: `Email enviado pra ${destinatarios.length} destinatário(s)`,
      gmail_message_id: result.messageId,
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
