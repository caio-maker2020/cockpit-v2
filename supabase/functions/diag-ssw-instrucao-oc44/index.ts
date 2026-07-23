// =============================================================================
// diag-ssw-instrucao-oc44 — TEMPORÁRIO (Caio 2026-06-10)
//
// Confirma se o `observ` (Instrução textarea 500ch) chegou de fato no SSW
// pra oc=44 da NF 2161614 (card 6133fe6d). No print do histórico SSW só
// aparece "RETORNO DE CARGA" — preciso saber se:
//   (a) `observ` chegou vazio no SSW (bug de envio: encoding, body mangled)
//   (b) `observ` chegou completo MAS o portal viewer SSW está mostrando só
//        o título auto da oc na coluna resumo
//
// REMOVER após investigação.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  obterSessao,
  buscarNFInterno,
  loadSswInternalEnvForCard,
  listarOcorrenciasNF,
} from "../_shared/ssw-internal-client.ts";

const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST", { status: 405 });
  const env = Deno.env.toObject();

  let body: { card_id?: string };
  try {
    body = await req.json();
  } catch {
    return j({ ok: false, error: "bad json" }, 400);
  }
  const cardId = body.card_id ?? "6133fe6d-93ef-4be5-b216-251f73965cf5";

  const sb = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: card } = await sb.from("cards")
    .select("id, nf, ctrc, responsavel_relacionamento")
    .eq("id", cardId)
    .maybeSingle();
  if (!card) return j({ ok: false, error: "card not found" }, 404);

  try {
    const sswEnv = await loadSswInternalEnvForCard(sb, env, card.id as string);
    const sessao = await obterSessao(sswEnv);
    const detalhe = await buscarNFInterno(sessao, card.nf as string, {
      ctrcEsperado: (card.ctrc as string | null) ?? null,
    });

    const ocs = await listarOcorrenciasNF(sessao, detalhe);
    const oc44s = ocs.filter((o) => o.codigo === 44);

    return j({
      ok: true,
      nf: card.nf,
      ctrc: card.ctrc,
      seq_ctrc: detalhe.seq_ctrc,
      familia: detalhe.familia,
      total_ocorrencias: ocs.length,
      oc44s_encontradas: oc44s.length,
      oc44s,
      // Pra comparar: mostra também oc=54 e oc=10 desse mesmo card (que sabemos que TÊM texto na Instrução)
      ocs_comparacao: ocs.filter((o) => o.codigo === 54 || o.codigo === 10 || o.codigo === 44),
    }, 200);
  } catch (err) {
    return j({ ok: false, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 502);
  }
});

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
