// =============================================================================
// r-evidencia — entrega a FOTO da evidência da oc específica do token.
//
// Caio 2026-05-13 (Fase 3 plano "hoje-usamos-o-bastao", ADR 0005):
// UNIFICADO no SSW INTERNO (opção 101). Antes tinha 2 modos (público pra ocs
// 10/11/35 + interno pra ocs bloqueadas 49/56/44/...). Agora todas as ocs
// passam por `obterFotoDaOc` do ssw-internal-client.ts — login Sal cobre TUDO,
// sem precisar de tracking_credentials (senha cliente). Eliminada a
// dependência da tabela `tracking_credentials` neste fluxo.
//
// Tokens criados antes da migração continuam funcionando (mesmo formato).
// O cliente clica no link do email exatamente como antes e vê a foto direto.
//
// Histórico:
// - 2026-05-06: scrape autenticado + parse keyword + proxy do binário
//   (substitui redirect cego pro trackingpag público).
// - 2026-05-11 (NF 920161): modo INTERNO criado pra ocs bloqueadas.
// - 2026-05-13 (Fase 3): modo PÚBLICO removido. Interno cobre 100%.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { obterFotoDaOc, loadSswInternalEnvForCard } from "../_shared/ssw-internal-client.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");

  if (!token) return errorPage("Link inválido", "Token ausente.");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 1. Valida token
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("tokens_evidencia")
    .select("id, nf, cod_ocorrencia, expira_em, total_acessos, card_id")
    .eq("id", token)
    .maybeSingle();

  if (tokenErr || !tokenRow) {
    return errorPage(
      "Link inválido ou expirado",
      "Token não encontrado. Solicite um novo link à equipe Sal Express.",
    );
  }

  if (new Date(tokenRow.expira_em as string) < new Date()) {
    return errorPage(
      "Link expirado",
      "Este link de rastreio expirou (vale por 7 dias após o envio). Solicite um novo à equipe Sal Express.",
    );
  }

  const nf = tokenRow.nf as string;
  const codOcorrencia = tokenRow.cod_ocorrencia as number | null;

  if (codOcorrencia == null) {
    return errorPage(
      "Evidência indisponível",
      "Esse link não tem ocorrência associada. Solicite um novo à equipe Sal Express.",
    );
  }

  // 2. Atualiza contador (best-effort)
  supabase
    .from("tokens_evidencia")
    .update({
      ultimo_acesso: new Date().toISOString(),
      total_acessos: (((tokenRow as Record<string, unknown>).total_acessos as number) ?? 0) + 1,
    })
    .eq("id", token)
    .then(() => {});

  // 3. Busca CTRC do card (necessário pra NFs com múltiplos CTRCs no SSW —
  // reentrega/complementar. Caio 2026-05-13 NF 20761).
  const cardId = (tokenRow as Record<string, unknown>)["card_id"] as string | null;
  let ctrcEsperado: string | null = null;
  if (cardId) {
    const { data: cardRow } = await supabase
      .from("cards")
      .select("ctrc")
      .eq("id", cardId)
      .maybeSingle();
    ctrcEsperado = (cardRow as { ctrc?: string | null } | null)?.ctrc ?? null;
  }

  // 4. Busca foto via SSW interno (cobre TODAS as ocs)
  const debug = url.searchParams.get("debug") === "1";

  // Caio 2026-05-15 (multi-operador): credenciais SSW interno do operador
  // atribuído ao card (Larissa, Duilio, etc). Fallback pro env genérico se
  // card não tiver operador resolvível.
  const envInterno = await loadSswInternalEnvForCard(supabase, Deno.env.toObject(), cardId);
  const resultado = await obterFotoDaOc(envInterno, nf, codOcorrencia, { ctrcEsperado });

  if (debug) {
    const view: Record<string, unknown> = {
      modo: "ssw_interno_unificado",
      token_cod_ocorrencia: codOcorrencia,
      status: resultado.status,
    };
    if (resultado.status === "ok") {
      view.content_type = resultado.content_type;
      view.size = resultado.binary.byteLength;
      view.oc_descricao = resultado.oc_descricao;
      view.picture_src_preview = resultado.picture_src.slice(0, 120) + "...";
    } else if (resultado.status === "oc_nao_encontrada") {
      view.ocs_disponiveis = resultado.ocs_disponiveis;
    } else if (resultado.status === "oc_sem_foto") {
      view.descricao = resultado.descricao;
    } else if (resultado.status === "erro_ssw") {
      view.motivo = resultado.motivo;
    }
    return new Response(JSON.stringify(view, null, 2), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  if (resultado.status === "ok") {
    return new Response(resultado.binary, {
      status: 200,
      headers: {
        "Content-Type": resultado.content_type,
        "Cache-Control": "private, max-age=3600",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Disposition": "inline",
      },
    });
  }

  if (resultado.status === "oc_sem_foto") {
    return errorPage(
      "Evidência ainda não disponível",
      "A foto desta ocorrência ainda não foi anexada no sistema da transportadora. Tente novamente em algumas horas ou contate a equipe Sal Express.",
    );
  }

  if (resultado.status === "oc_nao_encontrada") {
    return errorPage(
      "Evidência indisponível",
      "Não foi possível localizar a ocorrência. A equipe Sal Express foi notificada.",
    );
  }

  // erro_ssw
  return errorPage(
    "Não foi possível abrir a evidência",
    "Tente novamente em alguns minutos. Se o problema persistir, contate a equipe Sal Express.",
  );
});

function errorPage(titulo: string, msg: string): Response {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${titulo} — Sal Express</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 24px; text-align: center; color: #1a1a1a; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #c1272d; }
    p { font-size: 14px; color: #555; line-height: 1.5; }
    .logo { font-weight: 700; color: #c1272d; font-size: 12px; letter-spacing: 1px; margin-bottom: 32px; }
  </style>
</head>
<body>
  <div class="logo">SAL EXPRESS</div>
  <h1>${titulo}</h1>
  <p>${msg}</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
