// =============================================================================
// remetente-autorizado — decide se um remetente de email pode CRIAR card.
//
// Regra Sal Express (definida 2026-05-04):
//   - Bloqueia domínios SSW (sswemail@ssw.inf.br, *@ssw.com.br) — notificações
//     automáticas não viram card.
//   - Aceita domínio cadastrado em contatos_cliente.identificador (tipo='email').
//   - Aceita domínio cujo slug bate com nome de algum cliente em clientes.nome
//     (cobre colaborador novo do mesmo cliente que ainda não foi cadastrado).
//   - Tudo que não cair nessas regras: ignora.
//
// Threads Gmail anteriores (In-Reply-To linka card existente) são tratadas
// ANTES desse filtro pelo vinculador — então mesmo um remetente bloqueado pode
// passar se já tem contexto de thread.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface RemetenteAuthIndex {
  dominios: Set<string>;
  slugsClientes: string[];
}

const DOMINIOS_BLOCKED: ReadonlyArray<string> = [
  "ssw.inf.br",
  "ssw.com.br",
  "sswonline.com.br",
];

const PREFIXOS_BLOCKED: ReadonlyArray<string> = [
  "noreply@",
  "no-reply@",
  "notifications@",
  "notificacao@",
  "automatico@",
  "automatic@",
  "do-not-reply@",
];

export async function loadRemetenteAuthIndex(
  supabase: SupabaseClient,
): Promise<RemetenteAuthIndex> {
  const { data: emails } = await supabase
    .from("contatos_cliente")
    .select("identificador")
    .eq("tipo", "email")
    .eq("ativo", true);

  const dominios = new Set<string>();
  for (const row of (emails ?? [])) {
    const id = ((row as Record<string, unknown>).identificador as string | null)?.toLowerCase();
    if (!id) continue;
    const at = id.indexOf("@");
    if (at < 0) continue;
    const dom = id.slice(at + 1).trim();
    if (dom) dominios.add(dom);
  }

  const { data: clientes } = await supabase
    .from("clientes")
    .select("nome")
    .eq("ativo", true);

  const slugsClientes = (clientes ?? [])
    .map((c) => slugify((c as Record<string, unknown>).nome as string | null))
    .filter((s) => s && s.length >= 4);

  return { dominios, slugsClientes };
}

function slugify(s: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(ltda|s\/?a|me|eireli|epp|com|ind|farma|farmaceutica|medic|medicamentos|hospitalar|hospit|prod|cient|cientifica|esp|especiais|de|da|do|das|dos)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function extractEmail(remetenteRaw: string | null): string | null {
  if (!remetenteRaw) return null;
  const m = remetenteRaw.toLowerCase().match(/<?([a-z0-9._+\-]+@[a-z0-9.\-]+)>?/);
  return m?.[1] ?? null;
}

export function remetenteAutorizado(
  remetenteRaw: string | null,
  index: RemetenteAuthIndex,
): { ok: true } | { ok: false; motivo: string } {
  const email = extractEmail(remetenteRaw);
  if (!email) return { ok: false, motivo: "remetente_invalido" };

  for (const pref of PREFIXOS_BLOCKED) {
    if (email.startsWith(pref)) return { ok: false, motivo: `prefixo_bloqueado_${pref.replace("@", "")}` };
  }

  const dom = email.split("@")[1] ?? "";
  for (const blocked of DOMINIOS_BLOCKED) {
    if (dom === blocked || dom.endsWith(`.${blocked}`)) {
      return { ok: false, motivo: `dominio_bloqueado_${blocked}` };
    }
  }

  if (index.dominios.has(dom)) return { ok: true };

  // Match por slug do cliente: tira sufixo público (.com.br, .com, .br) e
  // checa se o "miolo" do domínio contém um slug cliente.
  const domBase = dom
    .replace(/\.com\.br$|\.com$|\.org$|\.net$|\.br$/, "")
    .replace(/[^a-z0-9]/g, "");
  for (const slug of index.slugsClientes) {
    if (!slug) continue;
    if (domBase.includes(slug) || slug.includes(domBase)) return { ok: true };
  }

  return { ok: false, motivo: "dominio_nao_cadastrado" };
}
