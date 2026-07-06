// =============================================================================
// admin-operadores — painel administrativo SÓ do Caio (caio@salexpress.com.br).
//
// Permite listar operadores e trocar login (e-mail) / senha de qualquer um via
// Supabase Auth Admin API (service_role). O front (Lovable) só mostra o painel
// pro super-admin, mas a AUTORIZAÇÃO REAL é aqui: a função valida que o caller
// logado é o super-admin antes de qualquer ação. verify_jwt=true (default) já
// exige um JWT de usuário válido; aqui reconfirmamos o e-mail.
//
// Ações (POST JSON { action, ... }):
//   - { action: "listar" }
//       -> { ok, operadores: [{ id, nome, email, papel, cockpit_ativo, tem_login }] }
//   - { action: "set_credenciais", operador_id, novo_email?, nova_senha? }
//       cria login (se operador não tinha) OU atualiza e-mail/senha do existente.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Quem pode usar o painel. Lista pra facilitar extensão futura sem mudar código
// em vários lugares. Caio (2026-06-25) liberou a gerente de relacionamento
// Isadora Baldoni com acesso admin igual ao dele.
const SUPER_ADMINS = ["caio@salexpress.com.br", "isadora.baldoni@salexpress.com.br"];

const SENHA_MIN = 8;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function emailValido(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  try {
    const env = Deno.env.toObject();
    const SUPABASE_URL = env["SUPABASE_URL"]!;
    const SERVICE_ROLE = env["SUPABASE_SERVICE_ROLE_KEY"]!;
    const ANON = env["SUPABASE_ANON_KEY"]!;

    // 1. Autentica o caller e confirma que é super-admin.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "Authorization Bearer obrigatório" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes } = await userClient.auth.getUser();
    const callerEmail = userRes?.user?.email?.toLowerCase() ?? null;
    if (!callerEmail || !SUPER_ADMINS.includes(callerEmail)) {
      return json({ ok: false, error: "Acesso restrito ao administrador." }, 403);
    }

    const svc = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;

    // ---- LISTAR --------------------------------------------------------------
    if (action === "listar") {
      const { data, error } = await svc
        .from("operadores")
        .select("id, nome, email, papel, cockpit_ativo, user_id")
        .order("nome");
      if (error) return json({ ok: false, error: error.message }, 500);
      const operadores = (data ?? []).map((o) => ({
        id: o.id,
        nome: o.nome,
        email: o.email,
        papel: o.papel,
        cockpit_ativo: o.cockpit_ativo,
        tem_login: o.user_id != null,
      }));
      return json({ ok: true, operadores });
    }

    // ---- SET CREDENCIAIS ------------------------------------------------------
    if (action === "set_credenciais") {
      const operadorId = body?.operador_id as string | undefined;
      const novoEmailRaw = (body?.novo_email as string | undefined)?.trim();
      const novaSenha = body?.nova_senha as string | undefined;
      const novoEmail = novoEmailRaw ? novoEmailRaw.toLowerCase() : undefined;

      if (!operadorId) return json({ ok: false, error: "operador_id obrigatório" }, 400);
      if (!novoEmail && !novaSenha) {
        return json({ ok: false, error: "Informe novo e-mail e/ou nova senha." }, 400);
      }
      if (novoEmail && !emailValido(novoEmail)) {
        return json({ ok: false, error: "E-mail inválido." }, 400);
      }
      if (novaSenha && novaSenha.length < SENHA_MIN) {
        return json({ ok: false, error: `Senha precisa de ao menos ${SENHA_MIN} caracteres.` }, 400);
      }

      const { data: op, error: opErr } = await svc
        .from("operadores")
        .select("id, nome, email, user_id")
        .eq("id", operadorId)
        .maybeSingle();
      if (opErr) return json({ ok: false, error: opErr.message }, 500);
      if (!op) return json({ ok: false, error: "Operador não encontrado." }, 404);

      const eventos: Array<{ tipo: string; detalhe: Record<string, unknown> }> = [];

      // Operador sem login: cria a conta de auth (exige e-mail + senha).
      if (!op.user_id) {
        const emailParaCriar = novoEmail ?? op.email;
        if (!emailParaCriar || !emailValido(emailParaCriar)) {
          return json({ ok: false, error: "Operador sem login: informe um novo_email válido." }, 400);
        }
        if (!novaSenha) {
          return json({ ok: false, error: "Operador sem login: informe nova_senha pra criar o acesso." }, 400);
        }
        const { data: created, error: createErr } = await svc.auth.admin.createUser({
          email: emailParaCriar,
          password: novaSenha,
          email_confirm: true,
        });
        if (createErr || !created?.user) {
          return json({ ok: false, error: `Falha ao criar login: ${createErr?.message}` }, 400);
        }
        const { error: linkErr } = await svc
          .from("operadores")
          .update({ user_id: created.user.id, email: emailParaCriar })
          .eq("id", operadorId);
        if (linkErr) return json({ ok: false, error: `Login criado mas falha ao vincular: ${linkErr.message}` }, 500);
        eventos.push({ tipo: "admin_criou_login", detalhe: { email: emailParaCriar } });
      } else {
        // Operador com login: atualiza e-mail e/ou senha.
        if (novoEmail) {
          const { error: upErr } = await svc.auth.admin.updateUserById(op.user_id, {
            email: novoEmail,
            email_confirm: true,
          });
          if (upErr) return json({ ok: false, error: `Falha ao trocar e-mail: ${upErr.message}` }, 400);
          // Mantém operadores.email em sincronia (lookup de login/reset usa ele).
          const { error: opUpErr } = await svc
            .from("operadores").update({ email: novoEmail }).eq("id", operadorId);
          if (opUpErr) return json({ ok: false, error: `E-mail trocado no auth mas falhou em operadores: ${opUpErr.message}` }, 500);
          eventos.push({ tipo: "admin_set_login", detalhe: { email_anterior: op.email, email_novo: novoEmail } });
        }
        if (novaSenha) {
          const { error: pwErr } = await svc.auth.admin.updateUserById(op.user_id, { password: novaSenha });
          if (pwErr) return json({ ok: false, error: `Falha ao trocar senha: ${pwErr.message}` }, 400);
          eventos.push({ tipo: "admin_set_senha", detalhe: {} });
        }
      }

      // Auditoria (sem senha em claro).
      if (eventos.length > 0) {
        await svc.from("operador_credencial_eventos").insert(
          eventos.map((e) => ({
            operador_id: operadorId,
            tipo: e.tipo,
            ator_email: callerEmail,
            detalhe: e.detalhe,
          })),
        );
      }

      return json({ ok: true, operador_id: operadorId, acoes: eventos.map((e) => e.tipo) });
    }

    return json({ ok: false, error: `Ação desconhecida: ${action}` }, 400);
  } catch (e) {
    return json({ ok: false, error: `Erro interno: ${(e as Error).message}` }, 500);
  }
});
