// =============================================================================
// listar-contatos-cobranca — devolve contatos disponíveis pra cobrar a base
// de um card (PRIORIDADES AI). Front usa pra popular dropdown quando há
// múltiplos contatos do mesmo cargo na mesma base (ex.: 2 coordenadores
// de entrega em Pouso Alegre).
//
// Caio 2026-05-20.
//
// Input:
//   { card_id?: uuid }  → resolve base via v_prioridades_ai
//   OU
//   { base: string }    → busca direto pela base normalizada
//
// Output:
//   {
//     ok: true,
//     base: string | null,
//     contatos: [
//       {
//         id, nome, telefone, email, cargo, base, observacao,
//         label: "Mirella (Coordenador de Entrega)"   // pronto pro front
//       },
//       ...
//     ]
//   }
//
// Ordenação: gerente_base > coordenador_entrega > gerente_relacionamento
// (escalonamento natural), depois alfabético por nome.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface InputBody {
  card_id?: string;
  base?: string;
}

const ORDEM_CARGO: Record<string, number> = {
  gerente_base: 0,
  coordenador_entrega: 1,
  gerente_relacionamento: 2,
};

function humanizarCargo(cargo: string): string {
  if (cargo === "gerente_base") return "Gerente da Base";
  if (cargo === "coordenador_entrega") return "Coordenador de Entrega";
  if (cargo === "gerente_relacionamento") return "Gerente de Relacionamento";
  return cargo;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body: InputBody = {};
  try {
    body = (await req.json()) as InputBody;
  } catch {
    return jsonResp({ ok: false, error: "JSON inválido" }, 400);
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env.SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Resolve base — sempre UPPER pra match consistente. View v_prioridades_ai
  // espelha Bastão que vem em MAIÚSCULO; contatos podem ter sido cadastrados
  // com case diferente. Normalizar nos 2 lados elimina o mismatch.
  let base: string | null = body.base?.trim().toUpperCase() ?? null;

  if (!base && body.card_id) {
    const { data: prio } = await supabase
      .from("v_prioridades_ai")
      .select("base")
      .eq("card_id", body.card_id)
      .maybeSingle();
    const rawBase = (prio as { base: string | null } | null)?.base ?? null;
    base = rawBase ? rawBase.trim().toUpperCase() : null;
  }

  // Busca contatos: específicos da base (case-insensitive via ilike) +
  // globais (base IS NULL).
  const query = supabase
    .from("contatos_escalonamento")
    .select("id, nome, telefone, email, cargo, base, observacao")
    .eq("ativo", true);

  const { data, error } = base
    ? await query.or(`base.ilike.${base},base.is.null`)
    : await query.is("base", null);

  if (error) {
    return jsonResp({ ok: false, error: error.message }, 500);
  }

  type Row = {
    id: string; nome: string; telefone: string | null; email: string | null;
    cargo: string; base: string | null; observacao: string | null;
  };

  const contatos = ((data ?? []) as Row[])
    .sort((a, b) => {
      const ca = ORDEM_CARGO[a.cargo] ?? 99;
      const cb = ORDEM_CARGO[b.cargo] ?? 99;
      if (ca !== cb) return ca - cb;
      // base específica antes de global
      const ag = a.base == null ? 1 : 0;
      const bg = b.base == null ? 1 : 0;
      if (ag !== bg) return ag - bg;
      return a.nome.localeCompare(b.nome, "pt-BR");
    })
    .map((c) => ({
      ...c,
      cargo_humanizado: humanizarCargo(c.cargo),
      label: c.observacao
        ? `${c.nome} (${humanizarCargo(c.cargo)} — ${c.observacao})`
        : `${c.nome} (${humanizarCargo(c.cargo)})`,
    }));

  return jsonResp({ ok: true, base, contatos });
});
