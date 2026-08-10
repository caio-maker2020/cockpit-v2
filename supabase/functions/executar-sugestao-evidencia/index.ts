// =============================================================================
// executar-sugestao-evidencia — Operador clica "EXECUTAR SUGESTÃO IA" após
// INTERPRETAR EVIDÊNCIA. Esta função:
//   1. Lê cache cards.ia_sugestao_evidencia[codigo_oc] (criado pelo interpretador)
//   2. Se oc_sugerida=54: baixa foto SSW + upload bucket email_anexos
//   3. Cria todo pendente IDÊNTICO ao da auto-proposta "Lançar 54 + email"
//      (tool=lancar_oc_e_enviar_email com template + email_destino) com
//      texto_sugerido pré-preenchido pela IA + anexo_ids da foto
//   4. Move card pra AGUARDANDO_VALIDACAO_HUMANA + lock=true
//
// Operador depois clica APROVAR no card (fluxo existente) → modal abre com
// email editável + foto anexada → envia → executor lança oc + manda email.
//
// Regra GLOBAL (todos operadores). Caio 2026-05-14.
//
// Cenários:
//   - oc_sugerida=54: tool=lancar_oc_e_enviar_email, template + email + anexo foto
//   - oc_sugerida=56: tool=lancar_ocorrencia (só lançamento, sem email cliente —
//                     foto ilegível vai pra Operação)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  obterTodasFotosDaOc,
  loadSswInternalEnvForCard,
} from "../_shared/ssw-internal-client.ts";

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

interface IaAnalise {
  oc_sugerida?: number;
  template_email_sugerido?: string | null;
  corpo_email_sugerido?: string | null;
  motivo_sugestao?: string;
  confianca?: number;
  resumo_situacao?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  const env = Deno.env.toObject();
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUser = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_ANON_KEY"]!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const supabaseSvc = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let body: { card_id?: string; codigo_oc?: number };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400);
  }
  if (!body.card_id || typeof body.codigo_oc !== "number") {
    return json({ ok: false, error: "{ card_id, codigo_oc } obrigatórios" }, 400);
  }

  // 1. Carrega card via RLS (operador só executa em cards visíveis a ele)
  const { data: card, error: cardErr } = await supabaseUser
    .from("cards")
    .select("id, nf, ctrc, pagador, assigned_operator_id, ia_sugestao_evidencia, agent_state")
    .eq("id", body.card_id)
    .maybeSingle();
  if (cardErr) return json({ ok: false, error: `SELECT card: ${cardErr.message}` }, 500);
  if (!card) return json({ ok: false, error: "card não encontrado ou sem acesso" }, 404);
  if (!card.nf) return json({ ok: false, error: "card sem NF" }, 400);

  // 2. Pega análise IA do cache (interpretador deve ter rodado antes)
  const cache = (card.ia_sugestao_evidencia ?? {}) as Record<string, {
    analise?: IaAnalise;
  }>;
  const entry = cache[String(body.codigo_oc)];
  const analise = entry?.analise;
  if (!analise || typeof analise.oc_sugerida !== "number") {
    return json({
      ok: false,
      error: "Sem sugestão IA cacheada pra essa oc. Clique em INTERPRETAR EVIDÊNCIA antes.",
    }, 404);
  }

  const ocSugerida = analise.oc_sugerida;
  if (ocSugerida !== 54 && ocSugerida !== 56) {
    return json({ ok: false, error: `oc_sugerida inesperada: ${ocSugerida}. IA só sugere 54 ou 56.` }, 400);
  }

  // 3. Pega chave_cte + CNPJs do agent_state (executor precisa).
  // Caio 2026-05-14: cards.pagador é o NOME do cliente, NÃO o CNPJ.
  // CNPJ canônico vem de agent_state.cnpj_pagador (igual auto-proposta em
  // regras-auto-acao.ts:359). Sem isso, resolver_email_cobranca_cliente não
  // acha o email do cliente e degradamos pra "sem email" incorretamente.
  const agentState = (card.agent_state ?? {}) as Record<string, unknown>;
  const chaveCte = (agentState["chave_cte"] as string | null | undefined) ?? null;
  if (!chaveCte) {
    return json({
      ok: false,
      error: "Card sem chave_cte resolvida. Aguarde Pass F ou rode chave-cte-resolver manualmente.",
    }, 409);
  }
  const cnpjPagador = (agentState["cnpj_pagador"] as string | null | undefined) ?? null;
  const cnpjRemetente = (agentState["cnpj_remetente"] as string | null | undefined)
    ?? cnpjPagador;

  // 4. Idempotência: se já tem todo pendente "EXECUTAR sugestão IA" pra essa oc,
  //    devolve ele em vez de criar duplicata.
  const { data: existing } = await supabaseSvc
    .from("todos")
    .select("id, status, proposta_payload")
    .eq("card_id", body.card_id)
    .eq("status", "pendente")
    .filter("proposta_payload->meta->>origem", "eq", "executar_sugestao_evidencia");
  const matchExistente = (existing ?? []).find((t: Record<string, unknown>) => {
    const meta = ((t["proposta_payload"] as Record<string, unknown>)?.["meta"] ?? {}) as Record<string, unknown>;
    return meta["codigo_oc_analise"] === body.codigo_oc;
  });
  if (matchExistente) {
    return json({
      ok: true,
      todo_id: matchExistente["id"],
      reused: true,
      oc: ocSugerida,
      message: "Já existia todo pendente dessa sugestão — reutilizando.",
    });
  }

  // 5. Resolve email destino (só se oc_sugerida=54 com template definido)
  let emailDestino: string | null = null;
  let templateOk = false;
  let templateId: string | null = null;
  if (ocSugerida === 54 && analise.template_email_sugerido) {
    templateId = analise.template_email_sugerido;
    const { data: tpl } = await supabaseSvc
      .from("templates_email")
      .select("id, ativo")
      .eq("id", templateId)
      .maybeSingle();
    templateOk = !!tpl && (tpl as Record<string, unknown>)["ativo"] === true;
    if (templateOk && cnpjPagador) {
      const { data: emailRpc } = await supabaseSvc.rpc("resolver_email_cobranca_cliente", {
        p_documento_cliente: cnpjPagador,
        p_tipo_uso: "logistico",
        p_cnpj_remetente: (agentState["cnpj_remetente"] as string | undefined) ?? null, // mig 320
      });
      if (typeof emailRpc === "string") emailDestino = emailRpc;
    }
  }

  // 6. Pra oc_sugerida=54: baixa foto SSW + upload bucket email_anexos.
  //    Caio 2026-05-14: anexo automático com possibilidade do operador remover
  //    no modal antes de enviar.
  // Caio 2026-06-18 (NF 355283 oc=49): antes anexávamos só a 1ª foto SSW
  // (obterFotoDaOc) — o cliente recebia 1 de N evidências. Agora baixamos
  // TODAS (paginação 01/02/03 + múltiplas linhas) e anexamos cada uma.
  const anexoIds: string[] = [];
  let anexoErr: string | null = null;
  if (ocSugerida === 54) {
    try {
      // Caio 2026-05-15 (multi-operador): credenciais SSW interno do operador
      // atribuído ao card.
      const sswEnv = await loadSswInternalEnvForCard(supabaseSvc, env, card.id as string);
      const fotos = await obterTodasFotosDaOc(
        sswEnv,
        card.nf as string,
        body.codigo_oc,
        { ctrcEsperado: card.ctrc ?? null },
      );
      if (fotos.status === "ok") {
        for (const foto of fotos.fotos) {
          const bytes = foto.binary;
          const ext = foto.content_type.includes("png") ? "png" : "jpg";
          // idx no nome evita colisão quando há 2+ fotos da mesma oc.
          const sufixo = fotos.fotos.length > 1 ? `-${foto.idx + 1}` : "";
          const filename = `evidencia-oc${body.codigo_oc}-nf${card.nf}${sufixo}.${ext}`;
          const storagePath = `card-${card.id}/${crypto.randomUUID()}-${filename}`;
          const { error: upErr } = await supabaseSvc.storage
            .from("email_anexos")
            .upload(storagePath, bytes, {
              contentType: foto.content_type,
              upsert: false,
            });
          if (upErr) {
            anexoErr = `upload bucket (foto ${foto.idx + 1}): ${upErr.message}`;
            continue;
          }
          const { data: anexoRow, error: metaErr } = await supabaseSvc
            .from("email_anexos")
            .insert({
              card_id: card.id,
              uploaded_by: card.assigned_operator_id, // pode ser null
              storage_path: storagePath,
              filename,
              mime_type: foto.content_type,
              size_bytes: bytes.byteLength,
              origem: "outbound",
            })
            .select("id")
            .single();
          if (metaErr) {
            anexoErr = `INSERT email_anexos (foto ${foto.idx + 1}): ${metaErr.message}`;
            continue;
          }
          anexoIds.push(anexoRow.id as string);
        }
      } else {
        anexoErr = `foto SSW indisponível (status=${fotos.status})`;
      }
    } catch (err) {
      anexoErr = `obterTodasFotosDaOc: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // 7. Monta proposta — formato IDÊNTICO ao auto-proposta "lançar 54 + email"
  //    em regras-auto-acao.ts pra reutilizar 100% o fluxo do executor + modal.
  const propostaArgs: Record<string, unknown> = {
    codigo_ssw: ocSugerida,
    nf: card.nf,
    chave_cte: chaveCte,
    cnpj_remetente: cnpjRemetente,
    descricao: ocSugerida === 54
      ? `Notificação ao pagador via sugestão IA (${analise.template_email_sugerido ?? "sem template"})`
      : "Falta info operacional — Operação providencia foto/dados",
  };
  if (templateOk && emailDestino) {
    propostaArgs["template_id"] = templateId;
    propostaArgs["email_destino"] = emailDestino;
  }
  // Anexos no proposta_payload.args.anexos_ids — executor pega de extras quando
  // operador aprova; pré-preencher aqui faz front carregar os anexos no modal.
  if (anexoIds.length > 0) {
    propostaArgs["anexos_ids"] = anexoIds;
  }

  const temEmailCompleto = templateOk && !!emailDestino;
  const tool = (ocSugerida === 54 && temEmailCompleto)
    ? "lancar_oc_e_enviar_email"
    : "lancar_ocorrencia";

  const descricaoTodo = ocSugerida === 54
    ? (temEmailCompleto
        ? `Lançar oc 54 + email pro cliente (sugestão IA, evidência oc=${body.codigo_oc})`
        : `Lançar oc 54 — sugestão IA (sem email: ${templateOk ? "cliente sem email cadastrado" : "template indisponível"})`)
    : `Lançar oc 56 — sugestão IA (foto oc=${body.codigo_oc} ilegível ou registro operacional)`;

  const { data: newTodo, error: todoErr } = await supabaseSvc
    .from("todos")
    .insert({
      card_id: card.id,
      action_id: crypto.randomUUID(),
      descricao: descricaoTodo,
      status: "pendente",
      proposta_payload: {
        tool,
        args: propostaArgs,
        rationale: analise.motivo_sugestao
          ?? "Sugestão gerada pelo interpretador-evidencia-foto (Claude Vision).",
        texto: ocSugerida === 54 ? (analise.corpo_email_sugerido ?? null) : null,
        meta: {
          origem: "executar_sugestao_evidencia",
          codigo_oc_analise: body.codigo_oc,
          oc_sugerida: ocSugerida,
          template_id: templateId,
          tinha_intencao_email: ocSugerida === 54,
          modo: temEmailCompleto ? "completo" : "sem_email",
          tem_anexo_evidencia: anexoIds.length > 0,
          anexos_total: anexoIds.length,
          anexo_erro: anexoErr,
          confianca_ia: analise.confianca,
        },
      },
    })
    .select("id")
    .single();
  if (todoErr) return json({ ok: false, error: `INSERT todo: ${todoErr.message}` }, 500);

  // Vincula anexos ao todo recém-criado (pra trace + RLS por todo_id)
  if (anexoIds.length > 0) {
    await supabaseSvc
      .from("email_anexos")
      .update({ todo_id: newTodo.id })
      .in("id", anexoIds);
  }

  // 8. Move card pra AGUARDANDO_VALIDACAO_HUMANA + lock=true (IGUAL auto-proposta)
  await supabaseSvc
    .from("cards")
    .update({
      state: "AGUARDANDO_VALIDACAO_HUMANA",
      lock_aguardando_validacao: true,
    })
    .eq("id", card.id);

  // 9. Audit
  await supabaseSvc.from("card_events").insert({
    card_id: card.id,
    event_type: "EvidenciaSugestaoExecutadaCriada",
    actor_type: "system",
    actor_id: "executar-sugestao-evidencia",
    payload: {
      todo_id: newTodo.id,
      codigo_oc_analise: body.codigo_oc,
      oc_sugerida: ocSugerida,
      template_id: templateId,
      tem_email: temEmailCompleto,
      anexos_ids: anexoIds,
      anexo_erro: anexoErr,
      confianca_ia: analise.confianca,
    },
  });

  return json({
    ok: true,
    todo_id: newTodo.id,
    oc: ocSugerida,
    tem_email: temEmailCompleto,
    email_destino: emailDestino,
    anexos_ids: anexoIds,
    anexo_erro: anexoErr,
    confianca_ia: analise.confianca,
  });
});
