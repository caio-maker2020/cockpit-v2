// =============================================================================
// atualizar-batch-prioridades-ai — força refresh de histórico SSW em batch
//
// Caio 2026-05-20: botão "🔄 Atualizar geral" do kanban PRIORIDADES AI. Bastão
// tem latência; operador quer forçar leitura SSW real pra todos os cards.
//
// Input: { card_ids: string[] } — até 10 por chamada
// Output: { ok, resultados: [{ card_id, status, mudou?, oc_atual?, saiu_kanban? }] }
//
// Estratégia: front lista cards do operador (via v_prioridades_ai com RLS),
// divide em batches de 5, chama este endpoint N vezes em sequência mostrando
// progresso "5/12". Pra cada card no batch, processa em PARALELO chamando
// puxar-historico-ssw-card (que atualiza cards.historico_ssw).
//
// Após atualizar histórico, a view v_prioridades_ai já reflete (filtra cards
// que tiveram oc nova ≠ 13/21 posterior). Cards que saíram do kanban somem
// automaticamente sem precisar mexer em prioridades_kanban_status.
//
// RLS: card só é processado se o operador autenticado tem acesso (checa via
// SELECT em cards usando o JWT do caller).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface InputBody {
  card_ids?: string[];
}

interface ResultadoCard {
  card_id: string;
  status: "atualizado" | "falhou" | "sem_acesso";
  total_ocorrencias?: number;
  erro?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  try {
    const env = Deno.env.toObject();
    const auth = req.headers.get("Authorization") ?? "";
    const userJwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    const body = (await req.json().catch(() => null)) as InputBody | null;
    const cardIds = (body?.card_ids ?? []).filter((id): id is string => typeof id === "string");
    if (cardIds.length === 0) return json({ ok: false, error: "card_ids vazio" }, 400);
    if (cardIds.length > 10) return json({ ok: false, error: "máximo 10 card_ids por chamada" }, 400);

    // Valida RLS: usa client autenticado pelo JWT do caller pra confirmar acesso
    if (userJwt && env["SUPABASE_ANON_KEY"]) {
      const supabaseAuth = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
        global: { headers: { Authorization: auth } },
      });
      const { data: visiveis } = await supabaseAuth
        .from("cards")
        .select("id")
        .in("id", cardIds);
      const idsVisiveis = new Set((visiveis ?? []).map((c) => (c as { id: string }).id));
      const semAcesso = cardIds.filter((id) => !idsVisiveis.has(id));

      // Processa só os com acesso
      const idsParaProcessar = cardIds.filter((id) => idsVisiveis.has(id));
      const resultados: ResultadoCard[] = [];

      // Adiciona os sem acesso primeiro
      for (const id of semAcesso) {
        resultados.push({ card_id: id, status: "sem_acesso" });
      }

      // Processa os autorizados em paralelo
      const promises = idsParaProcessar.map(async (cardId): Promise<ResultadoCard> => {
        try {
          const r = await fetch(`${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
              "apikey": env["SUPABASE_SERVICE_ROLE_KEY"]!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ card_id: cardId }),
            signal: AbortSignal.timeout(45_000),
          });
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            return { card_id: cardId, status: "falhou", erro: `HTTP ${r.status}: ${txt.slice(0, 150)}` };
          }
          const data = await r.json();
          if (data?.ok) {
            return {
              card_id: cardId,
              status: "atualizado",
              total_ocorrencias: data.total ?? data.total_ocorrencias,
            };
          }
          return { card_id: cardId, status: "falhou", erro: data?.error ?? "sem ok=true" };
        } catch (e) {
          return { card_id: cardId, status: "falhou", erro: e instanceof Error ? e.message : String(e) };
        }
      });

      const settled = await Promise.allSettled(promises);
      for (const s of settled) {
        if (s.status === "fulfilled") resultados.push(s.value);
        else resultados.push({ card_id: "?", status: "falhou", erro: String(s.reason) });
      }

      return json({
        ok: true,
        total: cardIds.length,
        processados: idsParaProcessar.length,
        sem_acesso: semAcesso.length,
        resultados,
      }, 200);
    }

    return json({ ok: false, error: "Autenticação requerida (JWT)" }, 401);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("atualizar-batch-prioridades-ai fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
