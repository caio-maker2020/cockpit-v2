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

    // Resolve operador autenticado pelo JWT do request (pra usar Gmail OAuth dele)
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUser = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userInfo } = await supabaseUser.auth.getUser();
    if (!userInfo?.user?.id) {
      return json({ ok: false, error: "Operador não autenticado" }, 401);
    }
    const userId = userInfo.user.id;

    // Pega operador_id do user_id
    const supabaseService = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: operador } = await supabaseService
      .from("operadores")
      .select("id, nome")
      .eq("user_id", userId)
      .maybeSingle();
    if (!operador?.id) {
      return json({ ok: false, error: "Operador não encontrado em public.operadores" }, 403);
    }

    // Envia email pra cada destinatário (TO único + Cc se >1; ou 1 envio múltiplo via Cc).
    // Decisão Caio (memória feedback_email_outbound_unico_envio): 1 envio com TO+Cc,
    // não múltiplos POSTs separados.
    const destinatarioPrincipal = destinatarios[0]!;
    const cc = destinatarios.slice(1);

    // Converte corpo HTML pra texto simples (Gmail aceita HTML no body via Content-Type;
    // o helper sendGmailMessage envia texto cru. Mantém HTML inline.)
    const result = await sendGmailMessage({
      supabase: supabaseService,
      operadorId: operador.id as string,
      destinatario: destinatarioPrincipal,
      cc: cc.length > 0 ? cc : null,
      subject: assunto,
      texto: corpoHtml,
      fromName: operador.nome as string,
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
      enviado_por: userId,
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
