// =============================================================================
// resposta-thread-nova — admissão de e-mail NÃO-CASADO no pipeline (Ingrid,
// Dimensional/Nortel, Caio 2026-08-11).
//
// O sistema do cliente (b2c.srv.br) responde SEMPRE num e-mail NOVO — sem
// In-Reply-To, sem thread, NF só no corpo ("Nota fiscal: 1599966"). Hoje o
// gmail-poll DESCARTA e-mail que não casa por thread/assunto. Esta admissão
// abre a porta pro pipeline existente APENAS para remetentes marcados
// (`contatos_cliente.responde_em_thread_nova`): o e-mail entra em
// messages_inbox e o resto é estrada asfaltada — triador extrai a NF do
// corpo, vinculador acha o card ATIVO da NF e o acionamento roda pela fonte
// única (INV-067). Vale para TODO ciclo (cada recusa nova = e-mail novo).
//
// Módulo puro + loader com cache TTL (padrão operador-resolver).
// =============================================================================

/** "Gabriela Moura <gabriela.moura@b2c.srv.br>" → "gabriela.moura@b2c.srv.br" */
export function extrairEmailPuro(fromHeader: string | null | undefined): string | null {
  if (!fromHeader) return null;
  const angulo = fromHeader.match(/<([^<>\s]+@[^<>\s]+)>/);
  const cru = angulo?.[1] ?? fromHeader.trim();
  const m = cru.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Decide se um e-mail não-casado deve ser ADMITIDO no pipeline.
 * Pura — recebe tudo resolvido (flag, conjunto de marcados, dedupe).
 */
export function deveAdmitirEmailNaoCasado(p: {
  flagLigada: boolean;
  fromHeader: string | null | undefined;
  emailsMarcados: ReadonlySet<string>;
  jaExisteNoInbox: boolean;
}): { admitir: boolean; remetente: string | null; motivo: string } {
  const remetente = extrairEmailPuro(p.fromHeader);
  if (!p.flagLigada) return { admitir: false, remetente, motivo: "flag_off" };
  if (!remetente) return { admitir: false, remetente, motivo: "sem_remetente" };
  if (!p.emailsMarcados.has(remetente)) {
    return { admitir: false, remetente, motivo: "remetente_nao_marcado" };
  }
  if (p.jaExisteNoInbox) return { admitir: false, remetente, motivo: "dedupe_message_id" };
  return { admitir: true, remetente, motivo: "contato_thread_nova" };
}

// ── loader com cache (o conjunto é minúsculo; poll roda a cada 5min) ─────────
// unknown + cast interno: tipo estrutural comparado ao SupabaseClient real
// explode TS2589 nos callers (mesma lição do trava-visualizacao, 2026-08-10).
type SupabaseLike = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: boolean) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

let cacheEmails: { set: Set<string>; em: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function carregarEmailsThreadNova(
  supabaseClient: unknown,
): Promise<Set<string>> {
  const supabase = supabaseClient as SupabaseLike;
  if (cacheEmails && Date.now() - cacheEmails.em < CACHE_TTL_MS) return cacheEmails.set;
  // coluna real do e-mail em contatos_cliente é `identificador` (tipo='email')
  const { data, error } = await supabase
    .from("contatos_cliente")
    .select("identificador, tipo, ativo")
    .eq("responde_em_thread_nova", true);
  if (error) {
    console.warn(`carregarEmailsThreadNova: ${error.message} — usando cache/vazio`);
    return cacheEmails?.set ?? new Set();
  }
  const set = new Set<string>(
    ((data ?? []) as Array<{ identificador?: string | null; tipo?: string | null; ativo?: boolean | null }>)
      .filter((r) => (r.tipo ?? "email") === "email" && r.ativo !== false)
      .map((r) => (r.identificador ?? "").trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
  cacheEmails = { set, em: Date.now() };
  return set;
}

export function __resetCacheThreadNovaForTest(): void {
  cacheEmails = null;
}
