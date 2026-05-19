// =============================================================================
// sync-prioridades-ai-do-bastao — importa cards do Bastão pra PRIORIDADES AI
//
// Caio 2026-05-19: oc=13 e oc=21 NÃO estão em OCORRENCIAS_DE_RELACIONAMENTO,
// então sync-bastao (Pass A) não puxa essas pendências. Mas o kanban
// PRIORIDADES AI precisa de TODOS os cards parados em oc=13/21 (mesmo
// TRANSFERIDOS — é o estado típico pós-lançamento).
//
// Esta função:
//   1. Query direta no Bastão pra pendências cod_ultima_ocorrencia IN (13, 21)
//   2. INSERT em cards (Cockpit) pra NFs faltantes, state='TRANSFERIDO' + dados
//      básicos. Resolve operador via resolverCamposAtribuicaoDoCard.
//   3. UPDATE pra cards existentes onde Bastão tem dados mais frescos
//   4. Chama sync-kanban-status-prioridades pra popular kanban_status
//
// Roda sob demanda + cron diário (futuro).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolverCamposAtribuicaoDoCard } from "../_shared/operador-resolver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BastaoPendencia {
  id: string;
  filial: string | null;
  ctrc: string | null;
  nf: string | null;
  cnpj_remetente: string | null;
  remetente: string | null;
  cnpj_pagador: string | null;
  pagador: string | null;
  cnpj_destinatario: string | null;
  destinatario: string | null;
  uf_destino: string | null;
  cidade_destino: string | null;
  base_destino: string | null;
  unidade_atual: string | null;
  cod_ultima_ocorrencia: number | null;
  instrucao_ultima_ocorrencia: string | null;
  data_ultima_ocorrencia: string | null;
  responsavel_relacionamento: string | null;
  atraso_original: number | null;
  previsao_entrega: string | null;
  segmento_cliente: string | null;
  importante_acompanhar: boolean | null;
  tipo_documento: string | null;
  qtd_volumes: number | null;
}

const SELECT_FIELDS = [
  "id","filial","ctrc","nf","cnpj_remetente","remetente","cnpj_pagador","pagador",
  "cnpj_destinatario","destinatario","uf_destino","cidade_destino","base_destino",
  "unidade_atual","cod_ultima_ocorrencia","instrucao_ultima_ocorrencia",
  "data_ultima_ocorrencia","responsavel_relacionamento","atraso_original",
  "previsao_entrega","segmento_cliente","importante_acompanhar","tipo_documento",
  "qtd_volumes",
].join(",");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const bastaoUrl = env["BASTAO_SUPABASE_URL"];
    const bastaoKey = env["BASTAO_SUPABASE_ANON_KEY"];
    if (!bastaoUrl || !bastaoKey) {
      return json({ ok: false, error: "BASTAO_SUPABASE_URL/ANON_KEY ausentes" }, 500);
    }

    // 1. Query Bastão: pendências com cod_ultima_ocorrencia IN (13, 21)
    //    SOMENTE de operadores ativos no Cockpit (cockpit_ativo=true).
    //    Caio 2026-05-19: evita criar cards de operadores dormentes
    //    (Camila/Ingrid/etc) que ficariam órfãos no banco.
    const { data: operadoresAtivos } = await supabase
      .from("operadores")
      .select("nome")
      .eq("ativo", true)
      .eq("cockpit_ativo", true);
    const nomesAtivos = (operadoresAtivos ?? [])
      .map((o) => (o as { nome: string }).nome)
      .filter(Boolean);
    if (nomesAtivos.length === 0) {
      return json({ ok: false, error: "Nenhum operador cockpit_ativo=true" }, 500);
    }

    const params = new URLSearchParams();
    params.set("select", SELECT_FIELDS);
    params.set("cod_ultima_ocorrencia", "in.(13,21)");
    params.set("responsavel_relacionamento", `in.(${nomesAtivos.join(",")})`);
    const bastaoFetch = await fetch(
      `${bastaoUrl.replace(/\/$/, "")}/rest/v1/pendencias?${params.toString()}`,
      {
        headers: {
          "apikey": bastaoKey,
          "Authorization": `Bearer ${bastaoKey}`,
          "Range": "0-4999",
          "Prefer": "count=exact",
        },
      },
    );
    if (!bastaoFetch.ok) {
      return json({ ok: false, error: `Bastão fetch ${bastaoFetch.status}: ${await bastaoFetch.text()}` }, 500);
    }
    const pendencias = (await bastaoFetch.json()) as BastaoPendencia[];

    // 2. NFs que já estão no Cockpit
    const nfs = pendencias.map((p) => p.nf).filter((nf): nf is string => !!nf);
    const { data: existentes } = await supabase
      .from("cards")
      .select("id, nf, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia, state, bastao_pendencia_id")
      .in("nf", nfs);
    const existentesMap = new Map<string, { id: string; cod_ultima_ocorrencia: number | null; bastao_data_ultima_ocorrencia: string | null; state: string; bastao_pendencia_id: string | null }>();
    for (const c of (existentes ?? []) as Array<{ id: string; nf: string; cod_ultima_ocorrencia: number | null; bastao_data_ultima_ocorrencia: string | null; state: string; bastao_pendencia_id: string | null }>) {
      existentesMap.set(c.nf, c);
    }

    let criados = 0;
    let atualizados = 0;
    let pulados = 0;
    const ignoradosSemNf: string[] = [];

    for (const p of pendencias) {
      if (!p.nf) {
        ignoradosSemNf.push(p.id);
        continue;
      }

      const existente = existentesMap.get(p.nf);

      // Resolve operador via cascata (carteira > nome > segmento)
      const atribuicao = await resolverCamposAtribuicaoDoCard(supabase, {
        responsavelNome: p.responsavel_relacionamento,
        cnpjPagador: p.cnpj_pagador,
        segmentoCodigo: p.segmento_cliente,
      });

      const snapshotAgent = {
        bastao_pendencia_id: p.id,
        cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
        instrucao_ultima_ocorrencia: p.instrucao_ultima_ocorrencia,
        data_ultima_ocorrencia: p.data_ultima_ocorrencia,
        cnpj_remetente: p.cnpj_remetente,
        cnpj_pagador: p.cnpj_pagador,
        cnpj_destinatario: p.cnpj_destinatario,
        destinatario: p.destinatario,
        remetente: p.remetente,
        uf_destino: p.uf_destino,
        cidade_destino: p.cidade_destino,
        base_destino: p.base_destino,
        unidade_atual: p.unidade_atual,
        dias_atraso: p.atraso_original,
        previsao_entrega: p.previsao_entrega,
        segmento_cliente: p.segmento_cliente,
        importante_acompanhar: p.importante_acompanhar,
        tipo_cte: p.tipo_documento,
        qtde_volumes: p.qtd_volumes,
        responsavel_relacionamento: atribuicao.responsavel_relacionamento,
        criado_via: "sync-prioridades-ai-do-bastao",
        bastao_synced_at: new Date().toISOString(),
      };

      if (!existente) {
        // INSERT card novo em TRANSFERIDO (oc=13/21 não é relacionamento)
        const { error: insErr } = await supabase.from("cards").insert({
          nf: p.nf,
          ctrc: p.ctrc,
          canal_origem: "sistema",
          empresa_cliente: p.pagador,
          pagador: p.pagador,
          base_destino: p.base_destino,
          responsavel_relacionamento: atribuicao.responsavel_relacionamento,
          assigned_operator_id: atribuicao.assigned_operator_id,
          state: "TRANSFERIDO",
          tipo: null,
          risco: "baixo",
          assigned_agent: null,
          bastao_pendencia_id: p.id,
          cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
          bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
          bastao_synced_at: new Date().toISOString(),
          tipo_cte: p.tipo_documento,
          qtde_volumes: p.qtd_volumes,
          agent_state: snapshotAgent,
        });
        if (insErr) {
          console.warn(`INSERT card nf=${p.nf} falhou: ${insErr.message}`);
          continue;
        }
        criados++;
      } else {
        // UPDATE se mudou cod_ultima_ocorrencia OU bastao_data_ultima_ocorrencia
        const mudou =
          existente.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia ||
          existente.bastao_data_ultima_ocorrencia !== p.data_ultima_ocorrencia;
        if (mudou) {
          await supabase
            .from("cards")
            .update({
              cod_ultima_ocorrencia: p.cod_ultima_ocorrencia,
              bastao_data_ultima_ocorrencia: p.data_ultima_ocorrencia,
              bastao_synced_at: new Date().toISOString(),
              bastao_pendencia_id: p.id,
            })
            .eq("id", existente.id);
          atualizados++;
        } else {
          pulados++;
        }
      }
    }

    // 3. Roda sync-kanban-status-prioridades pra povoar kanban_status
    let kanbanResult: unknown = null;
    try {
      const r = await fetch(`${env["SUPABASE_URL"]}/functions/v1/sync-kanban-status-prioridades`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
          "apikey": env["SUPABASE_SERVICE_ROLE_KEY"]!,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      kanbanResult = await r.json();
    } catch (e) {
      kanbanResult = { erro: e instanceof Error ? e.message : String(e) };
    }

    return json({
      ok: true,
      bastao_pendencias_oc13_oc21: pendencias.length,
      cockpit_criados: criados,
      cockpit_atualizados: atualizados,
      cockpit_pulados_sem_mudanca: pulados,
      ignorados_sem_nf: ignoradosSemNf.length,
      kanban_sync: kanbanResult,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sync-prioridades-ai-do-bastao fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
