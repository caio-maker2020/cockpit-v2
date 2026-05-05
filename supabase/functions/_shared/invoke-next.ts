// =============================================================================
// invoke-next — dispara próxima Edge Function da pipeline em fire-and-forget.
//
// Por que existe: o cron de 1min era a única forma do triador/vinculador serem
// acordados. Latência percebida: até 2min entre email entrar e card aparecer
// (1min triador + 1min vinculador). Inaceitável pra UX de operador.
//
// Solução: depois de enfileirar em pgmq, a função emissora dispara HTTP POST
// pra função consumidora SEM aguardar resposta. EdgeRuntime.waitUntil garante
// que a Edge Function não é congelada antes do POST sair, mas a request
// original retorna imediatamente.
//
// Cron continua agendado como FALLBACK — se o invoke HTTP falhar (timeout,
// rate limit, função fria), a próxima passada do cron pega a fila.
// =============================================================================

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

interface InvokeOpts {
  /** Nome da Edge Function (ex: "triador", "vinculador"). */
  functionName: string;
  /** SUPABASE_URL do projeto (env). */
  supabaseUrl: string;
  /** SUPABASE_SERVICE_ROLE_KEY pra auth — chama com service_role pra bypass RLS. */
  serviceRoleKey: string;
  /** Body opcional. Default: {} (cron-like trigger sem payload). */
  body?: unknown;
}

/**
 * Dispara HTTP POST pra próxima função na pipeline. Não aguarda resposta.
 *
 * Uso típico no fim de uma Edge Function:
 *   invokeNext({ functionName: "triador", supabaseUrl: env.SUPABASE_URL!, ... });
 *   return jsonResponse(200, { ok: true });
 *
 * Erros são logados mas NÃO propagam — caller já completou seu trabalho
 * (mensagem persistida + enfileirada). Se o invoke falhar, cron pega depois.
 */
export function invokeNext(opts: InvokeOpts): void {
  const url = `${opts.supabaseUrl.replace(/\/$/, "")}/functions/v1/${opts.functionName}`;
  const promise = fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body ?? {}),
    // Timeout curto: se a próxima função demorar, deixa o cron pegar.
    signal: AbortSignal.timeout(60_000),
  })
    .then((res) => {
      if (!res.ok) {
        console.warn(`invokeNext ${opts.functionName}: HTTP ${res.status}`);
      } else {
        console.log(`invokeNext ${opts.functionName}: ${res.status}`);
      }
    })
    .catch((err) => {
      // Não throw — caller já fez seu trabalho. Cron é fallback.
      console.warn(`invokeNext ${opts.functionName} falhou: ${String(err)}`);
    });

  // Garante que o runtime não congele antes do fetch sair.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(promise);
  }
}
