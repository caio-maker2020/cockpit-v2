// =============================================================================
// registrar-contato-cliente — Caio 2026-06-23 (NF 59354, MEDH 18917657000183)
//
// Auto-cadastra o e-mail logístico de um cliente em `contatos_cliente` quando a
// operadora envia um e-mail pra um pagador que ainda não tinha contato — pra que
// o `resolver_email_cobranca_cliente` passe a achar nos PRÓXIMOS cards (fim do
// fallback "sem email" pros ~62 clientes sem contato cadastrado).
//
// Garantias:
//   - FK: `contatos_cliente.documento_cliente` → `clientes.cnpj_cpf`. A função
//     garante o cliente (insert mínimo se faltar) antes de inserir o contato.
//   - `ordem >= 1` (CHECK) — usa max(ordem)+1 do cliente.
//   - Sem UNIQUE na tabela → dedup explícito por e-mail (case-insensitive).
//   - Best-effort: retorna `{registrado}` em vez de lançar. O caller (executor)
//     NUNCA deve deixar isso quebrar o lançamento SSW.
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export interface RegistrarContatoArgs {
  /** cnpj_pagador do card (mesmo valor que o resolver usa). */
  cnpjPagador: string | null;
  /** e-mail TO que a operadora enviou. */
  email: string | null;
  /** operadores.id de quem aprovou (vai pra operador_responsavel_id). */
  operadorId?: string | null;
  cardId: string;
  nf?: string | null;
  /** nome do cliente pra criar a linha em `clientes` se faltar (FK). */
  nomeClienteFallback?: string | null;
  /** actor do card_event. Default: "executor". */
  actorId?: string;
}

export interface RegistrarContatoResultado {
  registrado: boolean;
  motivo?: string;
}

export async function registrarContatoLogisticoSeNovo(
  supabase: SupabaseClient,
  args: RegistrarContatoArgs,
): Promise<RegistrarContatoResultado> {
  const cnpj = (args.cnpjPagador ?? "").replace(/\D/g, "");
  const email = (args.email ?? "").trim().toLowerCase();
  if (!cnpj) return { registrado: false, motivo: "sem cnpj_pagador" };
  if (!email || !email.includes("@")) return { registrado: false, motivo: "email inválido" };

  // FK: garante o cliente antes (insert mínimo se faltar).
  const { data: cli } = await supabase
    .from("clientes")
    .select("cnpj_cpf")
    .eq("cnpj_cpf", cnpj)
    .maybeSingle();
  if (!cli) {
    const nome = (args.nomeClienteFallback ?? "").trim() || cnpj;
    const { error: cliErr } = await supabase
      .from("clientes")
      .insert({ cnpj_cpf: cnpj, nome, ativo: true });
    if (cliErr) {
      return { registrado: false, motivo: `cliente ausente + insert falhou: ${cliErr.message}` };
    }
  }

  // Dedup: e-mail já cadastrado (qualquer tipo_uso) → nada a fazer.
  const { data: existentes } = await supabase
    .from("contatos_cliente")
    .select("id, identificador, ordem")
    .eq("documento_cliente", cnpj)
    .eq("tipo", "email");
  const arr = (existentes ?? []) as Array<{ identificador?: string; ordem?: number }>;
  if (arr.some((c) => (c.identificador ?? "").trim().toLowerCase() === email)) {
    return { registrado: false, motivo: "email já cadastrado" };
  }
  const proximaOrdem = Math.max(0, ...arr.map((c) => Number(c.ordem ?? 0))) + 1; // CHECK ordem >= 1

  const insertRow: Record<string, unknown> = {
    documento_cliente: cnpj,
    tipo: "email",
    identificador: email,
    tipo_uso: "logistico",
    ordem: proximaOrdem,
    ativo: true,
    observacao:
      `Cadastrado automaticamente pelo Cockpit ao enviar e-mail${args.nf ? ` (NF ${args.nf})` : ""}. Origem: composer da operadora.`,
  };
  if (args.operadorId) insertRow["operador_responsavel_id"] = args.operadorId;

  const { error: insErr } = await supabase.from("contatos_cliente").insert(insertRow);
  if (insErr) return { registrado: false, motivo: `insert contato falhou: ${insErr.message}` };

  await supabase.from("card_events").insert({
    card_id: args.cardId,
    event_type: "ContatoClienteCadastradoAutomaticamente",
    actor_type: "system",
    actor_id: args.actorId ?? "executor",
    payload: {
      documento_cliente: cnpj,
      email,
      tipo_uso: "logistico",
      ordem: proximaOrdem,
      motivo:
        "Operadora enviou e-mail a cliente sem contato logístico — cadastrado pra resolver automático nos próximos cards.",
    },
  });

  return { registrado: true };
}
