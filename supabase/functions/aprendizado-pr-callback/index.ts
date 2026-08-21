// =============================================================================
// aprendizado-pr-callback — o GitHub Actions liga de volta (Fase 4, 21/08).
//
// Dois eventos:
//   • pr_aberta  → grava detalhes.pr_url no learning_log e manda o E-MAIL DE
//     APROVAÇÃO pro Caio no padrão dele (o que era / o que mudou / taxa antes /
//     taxa projetada / link da PR / passo a passo).
//   • mergeada   → grava detalhes.mergeado_em + status='aplicado' — o MARCO do
//     antes×depois (v_melhorias_impacto, Gestão Agentes D5).
//
// Auth: header x-cb-secret == secret APRENDIZADO_CB_SECRET (mesmo valor vive
// como secret do GitHub). Sem secret configurado → 503 (nunca fail-open).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { enviarEmailInterno, montarEmailAprovacaoPR } from "../_shared/email-interno.ts";

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Sugestão de ocorrência",
  "interpretador-resposta-cliente": "Leitura da resposta do cliente",
  "agente-oc13-autonomo": "Exceções oc 13",
  "scan-email-pre-card": "Varredura de e-mail",
  "robo-intranet-wurth": "Robô da intranet Würth",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const segredo = Deno.env.get("APRENDIZADO_CB_SECRET");
  if (!segredo) return json({ ok: false, error: "APRENDIZADO_CB_SECRET não configurado" }, 503);
  if (req.headers.get("x-cb-secret") !== segredo) return json({ ok: false, error: "não autorizado" }, 401);

  const body = await req.json().catch(() => null) as
    | { melhoria_id?: string; evento?: string; pr_url?: string }
    | null;
  if (!body?.melhoria_id || !body.evento) return json({ ok: false, error: "melhoria_id e evento obrigatórios" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: row } = await supabase
    .from("learning_log")
    .select("id, titulo, resumo, agente_alvo, detalhes")
    .eq("id", body.melhoria_id)
    .maybeSingle();
  if (!row) return json({ ok: false, error: "melhoria não encontrada" }, 404);

  const det = (row.detalhes ?? {}) as Record<string, unknown>;

  if (body.evento === "pr_aberta") {
    if (!body.pr_url) return json({ ok: false, error: "pr_url obrigatório em pr_aberta" }, 400);
    await supabase
      .from("learning_log")
      .update({ detalhes: { ...det, pr_url: body.pr_url } })
      .eq("id", body.melhoria_id);

    const agente = (row.agente_alvo as string | null) ?? "";
    const taxaAntes = typeof det["taxa_hoje_pct"] === "number" ? det["taxa_hoje_pct"] as number : null;
    const taxaProj = typeof det["taxa_projetada_pct"] === "number" ? det["taxa_projetada_pct"] as number : null;
    const nCasos = typeof det["n_casos_testados"] === "number" ? det["n_casos_testados"] as number : null;

    const emailOk = await enviarEmailInterno({
      ...montarEmailAprovacaoPR({
        agenteAmigavel: AGENTE_AMIGAVEL[agente] ?? agente,
        titulo: (row.titulo as string | null) ?? "melhoria",
        oQueEra: taxaAntes != null
          ? `O agente "${AGENTE_AMIGAVEL[agente] ?? agente}" acertava ${taxaAntes}% neste padrão — o operador corrigia o resto na mão.`
          : `O agente "${AGENTE_AMIGAVEL[agente] ?? agente}" vinha divergindo do operador neste padrão.`,
        oQueMudou: (det["regra"] as string | undefined) ?? (row.resumo as string | null) ?? "Regra ensinada pela Isadora na conversa do Aprendizado.",
        taxaAntesPct: taxaAntes,
        taxaProjetadaPct: taxaProj,
        nCasos,
        prUrl: body.pr_url,
      }),
      tag: "cockpit-aprovacao-pr",
    });
    return json({ ok: true, evento: "pr_aberta", email: emailOk });
  }

  if (body.evento === "mergeada") {
    await supabase
      .from("learning_log")
      .update({
        status: "aplicado",
        detalhes: { ...det, mergeado_em: new Date().toISOString(), pr_url: det["pr_url"] ?? body.pr_url ?? null },
      })
      .eq("id", body.melhoria_id);
    return json({ ok: true, evento: "mergeada" });
  }

  return json({ ok: false, error: `evento desconhecido: ${body.evento}` }, 400);
});
