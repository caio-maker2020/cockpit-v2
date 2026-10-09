// =============================================================================
// exigir-membro-relacionamento — porta de entrada das edges do Relacionamento
// que agem sobre card/cliente (INV-190, docs/OPERACAO-SEPARACAO-RLS.md seção E).
//
// Furo que fecha: várias edges (verify_jwt=false ou não) aceitavam QUALQUER
// usuário logado — e `bloquearSeModoVisualizacao` é fail-open para "sem
// operador". Com os logins da Operação (que NÃO estão em `operadores`), isso
// deixaria a Operação mexer em card, cobrar cliente e mandar WhatsApp.
//
// Regra:
//   - service_role (cron, edge-to-edge, scripts do trilho) passa. Reconhecido
//     por (1) igualdade com SUPABASE_SERVICE_ROLE_KEY do runtime (o que todos os
//     chamadores internos mandam hoje) ou, se não bater, (2) CAPACIDADE: o
//     token consegue usar a Admin API do Auth (só chave service do projeto
//     consegue — vale para chave legacy, nova ou rotacionada; ver
//     service-auth.ts sobre por que igualdade sozinha já quebrou uma vez).
//   - usuário: JWT verificado pelo Auth (`auth.getUser(token)` — assinatura
//     conferida no servidor, nada de decodificar à mão) E linha ATIVA em
//     `operadores` com o `user_id` dele. Gestor está em `operadores` e passa.
//   - resto: 401 (sem token / token inválido) ou 403 (logado mas não é do
//     Relacionamento). Falha ao consultar `operadores` → 503 (fail-CLOSED).
//
// Uso no handler, depois do preflight CORS:
//   const porta = await exigirMembroRelacionamento(req, { corsHeaders });
//   if (!porta.ok) return porta.resposta;
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export interface OperadorDoUsuario {
  id: string;
  papel: string | null;
  ativo: boolean | null;
}

export type Chamador =
  | { tipo: "service_role" }
  | { tipo: "membro"; userId: string; operadorId: string; papel: string | null };

export interface DepsMembroRelacionamento {
  /** SUPABASE_SERVICE_ROLE_KEY do runtime (igualdade = caminho rápido). */
  serviceRoleKey?: string;
  /** Verifica o JWT no Auth; devolve o user id ou null se inválido. */
  verificarUsuario: (token: string) => Promise<string | null>;
  /** Prova de capacidade: o token é credencial service deste projeto? */
  ehServiceRole: (token: string) => Promise<boolean>;
  /** Linha ativa de `operadores` do user_id (null se não houver). Lança em erro. */
  buscarOperadorAtivo: (userId: string) => Promise<OperadorDoUsuario | null>;
}

export type ResultadoPorta =
  | { ok: true; chamador: Chamador }
  | { ok: false; resposta: Response };

export const CODIGO_NAO_MEMBRO = "NAO_MEMBRO_RELACIONAMENTO";

function negar(
  status: number,
  codigo: string,
  mensagem: string,
  corsHeaders: Record<string, string>,
): ResultadoPorta {
  return {
    ok: false,
    resposta: new Response(JSON.stringify({ ok: false, codigo, error: mensagem }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

export function tokenDoRequest(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

/** Dependências reais (rede). Os testes injetam as suas. */
export function depsPadrao(): DepsMembroRelacionamento {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const opts = { auth: { autoRefreshToken: false, persistSession: false } };
  return {
    serviceRoleKey,
    verificarUsuario: async (token) => {
      try {
        const { data, error } = await createClient(url, serviceRoleKey, opts).auth.getUser(token);
        if (error || !data?.user?.id) return null;
        return data.user.id;
      } catch {
        return null;
      }
    },
    ehServiceRole: async (token) => {
      try {
        const { error } = await createClient(url, token, opts).auth.admin.listUsers({
          page: 1,
          perPage: 1,
        });
        return !error;
      } catch {
        return false;
      }
    },
    buscarOperadorAtivo: async (userId) => {
      const { data, error } = await createClient(url, serviceRoleKey, opts)
        .from("operadores")
        .select("id, papel, ativo")
        .eq("user_id", userId)
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as OperadorDoUsuario | null) ?? null;
    },
  };
}

export async function exigirMembroRelacionamento(
  req: Request,
  opts: { corsHeaders?: Record<string, string>; deps?: DepsMembroRelacionamento } = {},
): Promise<ResultadoPorta> {
  const cors = opts.corsHeaders ?? {};
  const deps = opts.deps ?? depsPadrao();
  const token = tokenDoRequest(req);
  if (!token) return negar(401, "SEM_TOKEN", "login obrigatório", cors);

  if (deps.serviceRoleKey && token === deps.serviceRoleKey) {
    return { ok: true, chamador: { tipo: "service_role" } };
  }

  const userId = await deps.verificarUsuario(token);
  if (!userId) {
    // Não é sessão de usuário: só passa se for credencial service de fato.
    if (await deps.ehServiceRole(token)) return { ok: true, chamador: { tipo: "service_role" } };
    return negar(401, "TOKEN_INVALIDO", "sessão inválida ou expirada", cors);
  }

  let operador: OperadorDoUsuario | null;
  try {
    operador = await deps.buscarOperadorAtivo(userId);
  } catch {
    return negar(503, "CONFERENCIA_INDISPONIVEL", "não foi possível conferir o usuário; tente de novo", cors);
  }
  if (!operador || operador.ativo === false) {
    return negar(
      403,
      CODIGO_NAO_MEMBRO,
      "ação exclusiva do Relacionamento: seu usuário não é operador ativo",
      cors,
    );
  }
  return {
    ok: true,
    chamador: { tipo: "membro", userId, operadorId: operador.id, papel: operador.papel ?? null },
  };
}

/** send-whatsapp-message: usuário comum só envia pela PRÓPRIA instância.
 *  service_role e gestor podem escolher o operador. null = liberado. */
export function negarSeOperadorAlheio(
  chamador: Chamador,
  operadorIdDoCorpo: string | undefined,
  corsHeaders: Record<string, string> = {},
): Response | null {
  if (chamador.tipo === "service_role") return null;
  if (chamador.papel === "gestor") return null;
  if (operadorIdDoCorpo && operadorIdDoCorpo === chamador.operadorId) return null;
  return new Response(
    JSON.stringify({
      ok: false,
      codigo: "OPERADOR_ALHEIO",
      error: "operador_id do corpo tem de ser o seu (só gestor envia por outro operador)",
    }),
    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
