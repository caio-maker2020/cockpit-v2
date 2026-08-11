// =============================================================================
// encaminhar-alerta-bug — o operador confirma "aconteceu mesmo" e o caso vai
// pro corretor oficial de bugs (Caio 2026-08-11).
//
// Chamada pelo botão da conversa do agente no Cockpit, com JWT do OPERADOR.
// Fluxo: valida o JWT → RPC encaminhar_alerta_operador_bug (que já checa dono,
// carimba e grava card_event) → e-mail ao corretor com o diagnóstico técnico
// no ritual do projeto (sintoma / evidências / causa / fix sugerido / validar).
//
// O e-mail NÃO é o mesmo que o operador recebe: pro operador o texto é de
// operação; aqui é de engenharia, com ponteiros de arquivo.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  type CasoFiscal,
  type DiagnosticoTecnico,
  montarDiagnosticoTecnico,
  montarEmailCorretorTexto,
} from "../_shared/fiscal-resposta-cliente.ts";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";

const CORRETOR_EMAIL = "caio@salexpress.com.br";
const FROM_EMAIL = "cockpit@salexpress.com.br";
const COCKPIT_URL = "https://cockpit-aisalexpress.vercel.app";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const url = env["SUPABASE_URL"]!;
  const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"]!;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bloqueio = await bloquearSeModoVisualizacao(req, admin, corsHeaders);
  if (bloqueio) return bloqueio;

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "use POST" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return json({ ok: false, error: "sem Authorization" }, 401);

  const body = await req.json().catch(() => null) as
    | { alerta_id?: string; observacao?: string | null }
    | null;
  if (!body?.alerta_id) return json({ ok: false, error: "alerta_id obrigatório" }, 400);

  // A RPC roda com o JWT DO USUÁRIO: é ela que garante que o alerta é dele
  // (ou que ele é gestor) e que o modo visualização não passa.
  const comoUsuario = createClient(url, env["SUPABASE_ANON_KEY"]!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { error: errRpc } = await comoUsuario.rpc("encaminhar_alerta_operador_bug", {
    p_alerta_id: body.alerta_id,
    p_observacao: body.observacao ?? null,
  });
  if (errRpc) {
    const negado = /insufficient_privilege|MODO_VISUALIZACAO|outro operador/i.test(errRpc.message);
    return json({ ok: false, error: errRpc.message }, negado ? 403 : 500);
  }

  // Carrega o alerta (service_role: já passou pela autorização acima).
  const { data: alerta } = await admin
    .from("alertas_operador")
    .select("id, card_id, nf, tipo, titulo, relatorio, encaminhado_obs, operador_id")
    .eq("id", body.alerta_id)
    .maybeSingle();
  if (!alerta) return json({ ok: false, error: "alerta não encontrado" }, 404);

  const a = alerta as {
    card_id: string | null;
    nf: string | null;
    titulo: string;
    relatorio: { diagnostico_tecnico?: DiagnosticoTecnico } | null;
    encaminhado_obs: string | null;
    operador_id: string;
  };

  const { data: card } = a.card_id
    ? await admin.from("cards").select("state, responsavel_relacionamento").eq("id", a.card_id).maybeSingle()
    : { data: null };
  const { data: op } = await admin
    .from("operadores").select("nome").eq("id", a.operador_id).maybeSingle();

  const caso: CasoFiscal = {
    card_id: a.card_id ?? "(sem card)",
    nf: a.nf,
    state: (card as { state?: string } | null)?.state ?? "(desconhecido)",
    capturada_em: new Date().toISOString(),
    operador_id: a.operador_id,
    operador_nome: (op as { nome?: string } | null)?.nome ?? null,
  };
  // Usa o diagnóstico gravado pelo fiscal; se o alerta for antigo/sem ele,
  // reconstrói na hora (o corretor nunca recebe e-mail vazio).
  const dt = a.relatorio?.diagnostico_tecnico ?? montarDiagnosticoTecnico(caso, Date.now());

  const postmark = env["POSTMARK_SERVER_TOKEN"];
  if (!postmark) return json({ ok: true, encaminhado: true, email: "sem_postmark_token" });

  const texto = montarEmailCorretorTexto(
    caso,
    dt,
    a.encaminhado_obs,
    a.card_id ? `${COCKPIT_URL}/cards/${a.card_id}` : null,
  );

  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": postmark,
    },
    body: JSON.stringify({
      From: `Cockpit <${FROM_EMAIL}>`,
      To: CORRETOR_EMAIL,
      ReplyTo: CORRETOR_EMAIL,
      Subject: `Cockpit · bug confirmado por operador — ${a.titulo}`,
      TextBody: texto,
      MessageStream: "outbound",
      Tag: "cockpit-bug-confirmado",
      Metadata: { nf: a.nf ?? "", alerta_id: body.alerta_id },
      Headers: [
        { Name: "Auto-Submitted", Value: "auto-generated" },
        { Name: "X-Auto-Response-Suppress", Value: "All" },
      ],
    }),
  });
  if (!r.ok) {
    console.error(`postmark ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return json({ ok: true, encaminhado: true, email: "falhou" });
  }
  return json({ ok: true, encaminhado: true, email: "enviado" });
});
