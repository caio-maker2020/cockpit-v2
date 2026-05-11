// =============================================================================
// r-evidencia — entrega a FOTO da evidência da oc específica do token.
//
// Histórico de bugs / fixes:
//
// Bug 1 (Caio 2026-05-06): redirect cego pro trackingpag público mostrava
// foto de qualquer oc visível. Fix: scrape autenticado + parse keyword + proxy
// do binário (obterFotoBinarioEvidencia).
//
// Bug 2 (Caio 2026-05-11, NF 920161): trackingpag público OCULTA 31 ocs
// internas (49/56/44/...) — fotos dessas ocs nunca aparecem no HTML que o
// scraper recebe (mesmo autenticado com cnpjpag+chave). Fix:
//   - oc bloqueada (∈ ocorrencias_bloqueadas_tracking) → modo INTERNO via
//     login operador SSW (ssw-internal-client.ts), portal mostra tudo
//   - oc não-bloqueada → modo tracking público atual (preservado)
// Cliente continua vendo apenas a foto, sem cair em portal SSW.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { obterFotoBinarioEvidencia } from "../_shared/verificar-evidencia.ts";
import { loadOcsBloqueadasTracking } from "../_shared/ocs-bloqueadas-tracking.ts";
import { obterFotoDaOc, readSswInternalEnv } from "../_shared/ssw-internal-client.ts";

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
    .select("id, cnpj_pagador, nf, cod_ocorrencia, expira_em, total_acessos")
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

  const cnpjPagador = tokenRow.cnpj_pagador as string;
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

  // 3. Roteamento: oc bloqueada → modo interno; senão → tracking público
  const ocsBloqueadas = await loadOcsBloqueadasTracking(supabase);
  const usarInterno = ocsBloqueadas.has(codOcorrencia);

  const debug = url.searchParams.get("debug") === "1";

  if (usarInterno) {
    const envInterno = readSswInternalEnv(Deno.env.toObject());
    const resultadoInterno = await obterFotoDaOc(envInterno, nf, codOcorrencia);

    if (debug) {
      const view: Record<string, unknown> = {
        modo: "ssw_interno",
        token_cod_ocorrencia: codOcorrencia,
        status: resultadoInterno.status,
      };
      if (resultadoInterno.status === "ok") {
        view.content_type = resultadoInterno.content_type;
        view.size = resultadoInterno.binary.byteLength;
        view.oc_descricao = resultadoInterno.oc_descricao;
        view.picture_src_preview = resultadoInterno.picture_src.slice(0, 120) + "...";
      } else if (resultadoInterno.status === "oc_nao_encontrada") {
        view.ocs_disponiveis = resultadoInterno.ocs_disponiveis;
      } else if (resultadoInterno.status === "oc_sem_foto") {
        view.descricao = resultadoInterno.descricao;
      } else if (resultadoInterno.status === "erro_ssw") {
        view.motivo = resultadoInterno.motivo;
      }
      return new Response(JSON.stringify(view, null, 2), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    if (resultadoInterno.status === "ok") {
      return new Response(resultadoInterno.binary, {
        status: 200,
        headers: {
          "Content-Type": resultadoInterno.content_type,
          "Cache-Control": "private, max-age=3600",
          "X-Robots-Tag": "noindex, nofollow",
          "Content-Disposition": "inline",
        },
      });
    }

    if (resultadoInterno.status === "oc_sem_foto") {
      return errorPage(
        "Evidência ainda não disponível",
        "A foto desta ocorrência ainda não foi anexada no sistema da transportadora. Tente novamente em algumas horas ou contate a equipe Sal Express.",
      );
    }

    if (resultadoInterno.status === "oc_nao_encontrada") {
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
  }

  // === modo tracking público (oc NÃO bloqueada) — caminho original ===
  const resultado = await obterFotoBinarioEvidencia(
    supabase,
    nf,
    cnpjPagador,
    codOcorrencia,
  );

  if (debug) {
    const debugView: Record<string, unknown> = {
      modo: "tracking_publico",
      token_cod_ocorrencia: codOcorrencia,
      status: resultado.status,
    };
    if (resultado.status === "ok") {
      debugView.foto_url = resultado.foto_url;
      debugView.content_type = resultado.content_type;
      debugView.size = resultado.binary.byteLength;
    } else if (resultado.status === "ambiguo_foto_em_outra_oc") {
      debugView.titulo_linha_foto = resultado.titulo_linha_foto;
      debugView.todas_fotos_titulos = resultado.todas_fotos_titulos;
    } else if (resultado.status === "scrape_indisponivel") {
      debugView.motivo = resultado.motivo;
    }
    return new Response(JSON.stringify(debugView, null, 2), {
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

  if (resultado.status === "sem_btn_foto") {
    return errorPage(
      "Evidência ainda não disponível",
      "A foto da ocorrência ainda não foi anexada no sistema da transportadora. Tente novamente em algumas horas ou contate a equipe Sal Express.",
    );
  }
  if (resultado.status === "ambiguo_foto_em_outra_oc") {
    return errorPage(
      "Evidência indisponível",
      "Não foi possível localizar a foto exata desta ocorrência. A equipe Sal Express foi notificada.",
    );
  }
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
