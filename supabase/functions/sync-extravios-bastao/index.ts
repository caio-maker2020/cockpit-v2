// =============================================================================
// sync-extravios-bastao — Edge Function (Deno)
//
// Caio 2026-06-17: traz EXTRAVIOS (oc 6/9/16 = responsabilidade Perdas) pro
// Cockpit, dando VISÃO ao time de Relacionamento na aba EXTRAVIOS (kanban por
// dias úteis). FASE 1: teste só no operador DUILIO.
//
// Cria cards em state EXTRAVIO_MONITORADO (separados das abas de relacionamento)
// + 3 propostas (todos) por card:
//   1. email + oc 54  (lancar_oc_e_enviar_email)         → notifica + aguarda retorno
//   2. só email       (front chama responder-email-cliente) → notifica sem oc
//   3. lançar oc 49   (lancar_oc_e_enviar_email skipEmail) → "PRAZO DE PERDAS EXPIRADO"
//
// Quando o operador aprova 49/54, o executor move o card pro fluxo normal
// (ACAO_EXECUTADA → AGUARDANDO_CLIENTE/AGUARDANDO_VALIDACAO_HUMANA) e ele aparece
// na aba TRATATIVAS. Quando o Perdas localiza (oc=20) ou estoura prazo (49), o
// sync-bastao normal (que puxa ocs de relacionamento da carteira do Duilio)
// assume o card e ele sai do kanban de extravios.
//
// Gated por feature_flags.extravios_cockpit_enabled (OFF por padrão).
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
  type BastaoPendencia,
} from "../_shared/bastao-client.ts";

const FLAG_KEY = "extravios_cockpit_enabled";
const OPERADOR_NOME = "DUILIO"; // FASE 1: só o Duilio
const OCS_EXTRAVIO = new Set([6, 9, 16]);

function normalizeNf(nf: string | null | undefined): string | null {
  if (!nf) return null;
  const t = String(nf).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}

/** Remove marcadores SSWMOBILE/GPS da instrução (compacto, espelha o agente). */
function limparInstrucao(s: string): string {
  return s
    .replace(/\(SSWMOBILE\)/gi, " ")
    .replace(/GPS\s*\([^)]*\)/gi, " ")
    .replace(/\bGPS\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Quantos volumes faltam, a partir da instrução da oc 6/9/16. Espelha
 *  extrairQtdVolumesExtraviados do agente-sugere-ocs-padrao. */
function extrairQtdVolumes(
  instrucao: string | null | undefined,
): { total: true } | { qtd: number } | null {
  if (!instrucao) return null;
  const limpa = limparInstrucao(instrucao).toUpperCase();
  if (!limpa) return null;
  if (/\b(EXTRAVIO\s+TOTAL|PERDA\s+TOTAL|TOTAL)\b/.test(limpa)) return { total: true };
  const m = limpa.match(
    /(?:FALTA(?:M)?|QTDE?|QTD\.?)\s*(\d{1,3})|\b(\d{1,3})\s*(?:VOL|VOLUMES?|VOLS?)\b/,
  );
  if (m) {
    const qtd = parseInt(m[1] ?? m[2] ?? "", 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  if (/^\d{1,3}\s*\.?\s*$/.test(limpa)) {
    const qtd = parseInt(limpa, 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  return null;
}

/** Decide template de extravio + quantidades (pra aviso_alteracao_oc → preview). */
function analisarExtravio(p: BastaoPendencia): {
  template: "EXTRAVIO_PARCIAL" | "EXTRAVIO_TOTAL_PEDIR_ROMANEIO";
  qtdExtraviados: string | null;
  qtdNf: string | null;
} {
  const qtd = extrairQtdVolumes(p.instrucao_ultima_ocorrencia);
  const isTotal = !qtd || "total" in qtd ||
    (p.qtd_volumes != null && "qtd" in qtd && qtd.qtd >= p.qtd_volumes);
  const nVolFalta = qtd && "qtd" in qtd ? qtd.qtd : null;
  return {
    template: isTotal ? "EXTRAVIO_TOTAL_PEDIR_ROMANEIO" : "EXTRAVIO_PARCIAL",
    qtdExtraviados: nVolFalta != null ? String(nVolFalta) : null,
    qtdNf: p.qtd_volumes != null ? String(p.qtd_volumes) : null,
  };
}

interface AcaoExtravio {
  acao: string;
  descricao_todo: string;
  proposta_payload: Record<string, unknown>;
}

/**
 * 3 propostas (mesma estrutura canônica das de relacionamento → renderizam
 * idênticas no detalhe, com editor de e-mail/template):
 *  1) lançar 49 (SEMPRE com instrução "PRAZO DE PERDAS EXPIRADO" no SSW)
 *  2) só e-mail ao cliente (skip_oc — não lança oc; card fica em Extravios)
 *  3) notificar cliente + lançar 54 (aguarda retorno)
 * As de e-mail levam template_id + email_destino + meta.tinha_intencao_email=true
 * pra o front abrir o editor de e-mail (preview via preview_email_todo, editável).
 */
function montarPropostas(
  p: BastaoPendencia,
  nf: string,
  emailDestino: string | null,
  template: string,
): AcaoExtravio[] {
  const cnpjRemetente = p.cnpj_remetente ?? p.cnpj_pagador ?? null;
  const metaBase = { origem: "extravio_cockpit" };

  return [
    {
      acao: "lancar_49",
      descricao_todo: 'Lançar oc 49 no SSW — "PRAZO DE PERDAS EXPIRADO"',
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 49,
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "PRAZO DE PERDAS EXPIRADO",
          extras: { enviar_email: false, texto_descricao: "PRAZO DE PERDAS EXPIRADO" },
        },
        rationale: "Extravio sem localização: lançar oc 49 (prazo de perdas expirado) → segue pra Relacionamento.",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: false, modo: "sem_email", acao: "lancar_49" },
      },
    },
    {
      acao: "email_sem_oc",
      descricao_todo: "Notificar cliente por e-mail (sem lançar ocorrência)",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          nf,
          cnpj_remetente: cnpjRemetente,
          descricao: "Notificação de extravio ao cliente",
          template_id: template,
          email_destino: emailDestino,
          extras: { skip_oc: true },
        },
        rationale: "Extravio: notificar o cliente por e-mail, sem comprometer com oc 54.",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: true, modo: "completo", acao: "email_sem_oc" },
      },
    },
    {
      acao: "email_mais_54",
      descricao_todo: "Notificar cliente + lançar oc 54 (aguardar retorno: seguir parcial ou devolver)",
      proposta_payload: {
        tool: "lancar_oc_e_enviar_email",
        args: {
          codigo_ssw: 54,
          nf,
          chave_cte: null,
          cnpj_remetente: cnpjRemetente,
          descricao: "Extravio — cliente notificado, aguardando retorno",
          template_id: template,
          email_destino: emailDestino,
        },
        rationale: "Extravio (oc 6/9/16): notificar cliente e aguardar retorno (parcial/devolução).",
        texto: null,
        meta: { ...metaBase, tinha_intencao_email: true, modo: "completo", acao: "email_mais_54" },
      },
    },
  ];
}

function snapshotExtravio(p: BastaoPendencia): Record<string, unknown> {
  return {
    origem: "extravio_perdas",
    bastao_pendencia_id: p.id,
    bastao_updated_at: p.updated_at,
    cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
    instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
    data_ultima_ocorrencia: p.data_ultima_ocorrencia,
    cnpj_remetente: p.cnpj_remetente,
    remetente: p.remetente,
    cnpj_pagador: p.cnpj_pagador,
    cnpj_destinatario: p.cnpj_destinatario,
    destinatario: p.destinatario,
    uf_destino: p.uf_destino,
    cidade_destino: p.cidade_destino,
    base_destino: p.base_destino,
    unidade_atual: p.unidade_atual,
    dias_atraso: p.atraso_original,
    previsao_entrega: p.previsao_entrega,
    segmento_cliente: p.segmento_cliente,
    qtde_volumes: p.qtd_volumes,
    bastao_synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Gate: feature flag.
  const { data: flag } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG_KEY).maybeSingle();
  if (!(flag as { enabled?: boolean } | null)?.enabled) {
    return jsonResp({ ok: true, skipped: "flag_off" }, 200);
  }

  // Operador DUILIO (ativo + cockpit_ativo) + carteira.
  const { data: op } = await supabase
    .from("operadores")
    .select("id, nome, carteira")
    .eq("nome", OPERADOR_NOME).eq("ativo", true).eq("cockpit_ativo", true)
    .maybeSingle();
  const operador = op as { id: string; nome: string; carteira: string[] | null } | null;
  if (!operador) return jsonResp({ ok: false, error: `operador ${OPERADOR_NOME} não encontrado/ativo` }, 404);
  const carteira = (operador.carteira ?? []).filter((c) => !!c);
  if (carteira.length === 0) return jsonResp({ ok: true, skipped: "carteira_vazia" }, 200);

  // Pull extravios (oc 6/9/16) da carteira do Duilio.
  const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(Deno.env.toObject()) });
  const pendencias = await bastao.fetchExtraviosDoBastao(carteira);

  const resumo = { criados: 0, atualizados: 0, ignorados: 0, erros: [] as string[] };

  for (const pRaw of pendencias) {
    const nf = normalizeNf(pRaw.nf);
    if (!nf) { resumo.ignorados++; continue; }
    if (pRaw.cod_ultima_ocorrencia == null || !OCS_EXTRAVIO.has(pRaw.cod_ultima_ocorrencia)) {
      resumo.ignorados++; continue;
    }
    try {
      // Template + qtd (pro aviso_alteracao_oc → preview_email_todo preencher
      // {n_volumes_falta}/{qtde_volumes}) + e-mail do cliente cadastrado.
      const ext = analisarExtravio(pRaw);
      const emailDestino = await resolverEmailDestino(supabase, pRaw.cnpj_pagador);
      const avisoExtravio = {
        tipo: "extravio_email_sugerido",
        template_email_sugerido: ext.template,
        qtd_volumes_extraviados: ext.qtdExtraviados,
        qtd_volumes_nf: ext.qtdNf,
      };

      // Lookup por NF (mesma chave uniq_cards_nf_active).
      const { data: existRows } = await supabase
        .from("cards")
        .select("id, state, cod_ultima_ocorrencia")
        .eq("nf", nf).order("created_at", { ascending: false }).limit(1);
      const existing = (existRows?.[0] ?? null) as
        | { id: string; state: string; cod_ultima_ocorrencia: number | null } | null;

      // Card TERMINAL (RESOLVIDO/CANCELADO) não bloqueia — extravio que
      // re-ocorre cria card novo (uniq_cards_nf_active libera terminais).
      const ehTerminal = existing &&
        (existing.state === "RESOLVIDO" || existing.state === "CANCELADO");
      if (existing && !ehTerminal) {
        // Card ATIVO. Só mexe se já for nosso card de extravio; card de
        // relacionamento/outro ativo → não toca (dono é o sync-bastao normal).
        if (existing.state === "EXTRAVIO_MONITORADO") {
          await supabase.from("cards").update({
            cod_ultima_ocorrencia: pRaw.cod_ultima_ocorrencia,
            bastao_data_ultima_ocorrencia: pRaw.data_ultima_ocorrencia,
            agent_state: snapshotExtravio(pRaw),
            aviso_alteracao_oc: avisoExtravio,
            bastao_synced_at: new Date().toISOString(),
          }).eq("id", existing.id);
          await upsertPropostas(supabase, existing.id, pRaw, nf, emailDestino, ext.template);
          resumo.atualizados++;
        } else {
          resumo.ignorados++;
        }
        continue;
      }
      // existing terminal OU inexistente → cria card novo (segue abaixo).

      // INSERT novo card de extravio.
      const { data: ins, error: insErr } = await supabase.from("cards").insert({
        nf,
        ctrc: pRaw.ctrc,
        canal_origem: "sistema",
        empresa_cliente: pRaw.pagador,
        pagador: pRaw.pagador,
        base_destino: pRaw.base_destino,
        responsavel_relacionamento: operador.nome,
        assigned_operator_id: operador.id,
        state: "EXTRAVIO_MONITORADO",
        lock_aguardando_validacao: false,
        risco: "baixo",
        cod_ultima_ocorrencia: pRaw.cod_ultima_ocorrencia,
        bastao_data_ultima_ocorrencia: pRaw.data_ultima_ocorrencia,
        bastao_synced_at: new Date().toISOString(),
        tipo_cte: pRaw.tipo_documento,
        qtde_volumes: pRaw.qtd_volumes,
        agent_state: snapshotExtravio(pRaw),
        aviso_alteracao_oc: avisoExtravio,
      }).select("id").single();
      if (insErr) {
        // 23505 = corrida com sync-bastao normal (uniq_cards_nf_active). Skip.
        if ((insErr as { code?: string }).code === "23505") { resumo.ignorados++; continue; }
        throw new Error(`INSERT cards: ${insErr.message}`);
      }
      const cardId = (ins as { id: string }).id;

      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "ExtravioImportado",
        actor_type: "system",
        actor_id: "sync-extravios-bastao",
        payload: snapshotExtravio(pRaw),
      });
      await upsertPropostas(supabase, cardId, pRaw, nf, emailDestino, ext.template);
      resumo.criados++;
    } catch (e) {
      resumo.erros.push(`NF ${nf}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return jsonResp({
    ok: true,
    duration_ms: Date.now() - startedAt,
    pendencias: pendencias.length,
    ...resumo,
  }, 200);
});

/** E-mail do cliente cadastrado (mesma RPC das propostas de relacionamento). */
async function resolverEmailDestino(
  supabase: ReturnType<typeof createClient>,
  cnpjPagador: string | null,
): Promise<string | null> {
  if (!cnpjPagador) return null;
  const { data } = await supabase.rpc("resolver_email_cobranca_cliente", {
    p_documento_cliente: cnpjPagador,
    p_tipo_uso: "logistico",
  });
  return typeof data === "string" ? data : null;
}

/** Cria as 3 propostas do card de extravio (idempotente por meta.acao ativo). */
async function upsertPropostas(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  p: BastaoPendencia,
  nf: string,
  emailDestino: string | null,
  template: string,
): Promise<void> {
  const { data: existing } = await supabase
    .from("todos").select("proposta_payload, status").eq("card_id", cardId);
  const STATUS_ATIVOS = new Set(["pendente", "aprovado"]);
  const acoesJa = new Set<string>();
  for (const t of (existing ?? []) as Array<Record<string, unknown>>) {
    const pp = t["proposta_payload"] as Record<string, unknown> | null;
    const meta = pp?.["meta"] as Record<string, unknown> | undefined;
    const acao = meta?.["acao"] as string | undefined;
    const st = t["status"] as string | undefined;
    if (acao && st && STATUS_ATIVOS.has(st)) acoesJa.add(acao);
  }
  for (const prop of montarPropostas(p, nf, emailDestino, template)) {
    if (acoesJa.has(prop.acao)) continue;
    await supabase.from("todos").insert({
      card_id: cardId,
      action_id: crypto.randomUUID(),
      descricao: prop.descricao_todo,
      status: "pendente",
      proposta_payload: prop.proposta_payload,
    });
  }
}

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
