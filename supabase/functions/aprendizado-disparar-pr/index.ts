// =============================================================================
// aprendizado-disparar-pr — dispara o repo-agent (GitHub Action melhoria-pr)
// quando uma melhoria fecha com replay MELHORA (Fase 4, ADR 0005).
//
// Inerte sem o secret GH_DISPATCH_TOKEN (fine-grained PAT, só este repo,
// só Contents:write — passos de criação no ADR). Sem o token: skip limpo,
// o fluxo segue (e-mail avisa que a PR fica pro /f6). Auth: service_role.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const REPO = "caio-maker2020/cockpit-v2";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  try {
    const env = Deno.env.toObject();
    const SERVICE_ROLE = env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claimRole = (() => {
      try {
        return JSON.parse(atob(token.split(".")[1] ?? ""))?.role as string | undefined ?? null;
      } catch {
        return null;
      }
    })();
    if (token !== SERVICE_ROLE && claimRole !== "service_role") {
      return json({ ok: false, error: "só chamada interna" }, 403);
    }

    const gh = env["GH_DISPATCH_TOKEN"];
    if (!gh) return json({ ok: true, skip: "sem GH_DISPATCH_TOKEN — PR fica pro /f6" });

    const body = await req.json().catch(() => null) as
      | { melhoria_id?: string; agente_alvo?: string; titulo?: string; regra?: string; laudo?: string }
      | null;
    if (!body?.melhoria_id || !body?.agente_alvo || !body?.regra) {
      return json({ ok: false, error: "melhoria_id, agente_alvo e regra obrigatórios" }, 400);
    }

    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    const r = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gh}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cockpit-loop-aprendizado",
      },
      body: JSON.stringify({
        event_type: "melhoria_aprendizado",
        client_payload: {
          melhoria_id: body.melhoria_id,
          agente_alvo: body.agente_alvo,
          titulo: (body.titulo ?? "melhoria do loop").slice(0, 80),
          regra_b64: b64(body.regra),
          laudo_b64: b64(body.laudo ?? ""),
          base: "master",
        },
      }),
    });
    if (r.status !== 204) {
      return json({ ok: false, error: `github dispatch ${r.status}: ${(await r.text()).slice(0, 200)}` }, 502);
    }
    return json({ ok: true, disparado: true, branch: `ai-melhoria/${body.melhoria_id}` });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
