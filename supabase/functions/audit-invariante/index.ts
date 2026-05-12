// =============================================================================
// audit-invariante — Camada 4 do plano "invariante NF de relacionamento".
//
// Roda independente do sync-bastao. Compara:
//   - Bastão: pendências com oc ∈ OCORRENCIAS_DE_RELACIONAMENTO + responsável
//             ∈ operadores.cockpit_ativo
//   - Cockpit: cards ativos (state ∉ {RESOLVIDO, CANCELADO, TRANSFERIDO})
//
// Pra cada NF do Bastão:
//   - Sem card ativo no Cockpit                       → tipo='card_ausente'
//   - Com card mas oc diverge                          → tipo='oc_divergente'
//   - Com card em state incoerente com oc relacionamento → tipo='state_invalido'
//
// Resultado vai pra invariante_violacoes (insert se nova, update resolved_at
// se já existe e agora bateu). Se houver violações abertas, dispara alerts.
//
// Cron: */5 minutos. Independente do sync-bastao — se sync travar, esse
// continua detectando.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createBastaoClient,
  readBastaoEnvFromProcess,
} from "../_shared/bastao-client.ts";

interface Violacao {
  tipo: "card_ausente" | "oc_divergente" | "state_invalido";
  nf: string;
  oc_bastao: number;
  oc_cockpit: number | null;
  state_cockpit: string | null;
  responsavel: string | null;
  detalhes: Record<string, unknown>;
}

const STATES_ATIVOS_VALIDOS = new Set([
  "AGUARDANDO_AGENTE",
  "AGUARDANDO_VALIDACAO_HUMANA",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_CONTEXTO",
  "AGUARDANDO_VINCULACAO",
  "EM_TRIAGEM",
  "RECEBIDO",
  "EXECUTANDO_ACAO",
  "ACAO_EXECUTADA",
  "TRATATIVA_PENDENTE",
  "BLOQUEADO_POR_ERRO",
  "ESCALADO_HUMANO",
]);

const STATES_INATIVOS = new Set(["RESOLVIDO", "CANCELADO", "TRANSFERIDO"]);

serve(async (_req) => {
  const startedAt = Date.now();

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(
      env["SUPABASE_URL"]!,
      env["SUPABASE_SERVICE_ROLE_KEY"]!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const bastao = createBastaoClient({ env: readBastaoEnvFromProcess(env) });

    // 1. Operadores ativos no Cockpit
    const { data: ops } = await supabase
      .from("operadores")
      .select("nome")
      .eq("cockpit_ativo", true)
      .eq("ativo", true);
    const nomesOperadores = (ops ?? [])
      .map((r) => (r as { nome: string }).nome)
      .filter((n): n is string => !!n);

    // 2. Pendências relevantes do Bastão
    const pendencias = await bastao.fetchPendenciasDoCockpit({ operadores: nomesOperadores });
    console.log(`[audit] Bastão: ${pendencias.length} pendências relevantes.`);

    // 3. Cards no Cockpit (todas as NFs do Bastão, qualquer state)
    const nfs = pendencias
      .map((p) => (p.nf ?? "").replace(/^0+/, ""))
      .filter((n) => n.length > 0);
    const nfsUnicas = Array.from(new Set(nfs));

    const cardsMap = new Map<string, { id: string; state: string; cod_ultima_ocorrencia: number | null }>();
    // Em chunks pra evitar URL gigante
    const CHUNK = 200;
    for (let i = 0; i < nfsUnicas.length; i += CHUNK) {
      const chunk = nfsUnicas.slice(i, i + CHUNK);
      const { data } = await supabase
        .from("cards")
        .select("id, nf, state, cod_ultima_ocorrencia")
        .in("nf", chunk);
      for (const c of (data ?? []) as Array<{ id: string; nf: string; state: string; cod_ultima_ocorrencia: number | null }>) {
        cardsMap.set(c.nf, c);
      }
    }

    // 4. Diff
    const violacoesAtuais: Violacao[] = [];
    for (const p of pendencias) {
      const nf = (p.nf ?? "").replace(/^0+/, "");
      if (!nf || p.cod_ultima_ocorrencia == null) continue;
      const card = cardsMap.get(nf);

      if (!card) {
        violacoesAtuais.push({
          tipo: "card_ausente",
          nf,
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_cockpit: null,
          state_cockpit: null,
          responsavel: p.responsavel_relacionamento,
          detalhes: { ctrc: p.ctrc, pagador: p.pagador },
        });
        continue;
      }

      // Card inativo (TRANSFERIDO/RESOLVIDO/CANCELADO) com Bastão dizendo
      // que NF é de relacionamento atual = state inválido pra invariante
      if (STATES_INATIVOS.has(card.state)) {
        violacoesAtuais.push({
          tipo: "state_invalido",
          nf,
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_cockpit: card.cod_ultima_ocorrencia,
          state_cockpit: card.state,
          responsavel: p.responsavel_relacionamento,
          detalhes: { card_id: card.id, motivo: "card inativo com Bastão ativo em relacionamento" },
        });
        continue;
      }

      // State não reconhecido
      if (!STATES_ATIVOS_VALIDOS.has(card.state)) {
        violacoesAtuais.push({
          tipo: "state_invalido",
          nf,
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_cockpit: card.cod_ultima_ocorrencia,
          state_cockpit: card.state,
          responsavel: p.responsavel_relacionamento,
          detalhes: { card_id: card.id, motivo: "state desconhecido" },
        });
        continue;
      }

      // OC diverge
      if (card.cod_ultima_ocorrencia !== p.cod_ultima_ocorrencia) {
        violacoesAtuais.push({
          tipo: "oc_divergente",
          nf,
          oc_bastao: p.cod_ultima_ocorrencia,
          oc_cockpit: card.cod_ultima_ocorrencia,
          state_cockpit: card.state,
          responsavel: p.responsavel_relacionamento,
          detalhes: { card_id: card.id },
        });
      }
    }

    console.log(`[audit] Violações detectadas: ${violacoesAtuais.length}`);

    // 5. Resolve violações antigas que sumiram + insere novas (NF tem
    // unique index quando resolved_at IS NULL, então upsert seguro)
    const nfsAtuais = new Set(violacoesAtuais.map((v) => v.nf));

    const { data: abertas } = await supabase
      .from("invariante_violacoes")
      .select("id, nf, tipo_violacao")
      .is("resolved_at", null);
    const abertasArr = (abertas ?? []) as Array<{ id: string; nf: string; tipo_violacao: string }>;

    // Marca como resolvidas as que sumiram
    const idsResolver = abertasArr
      .filter((v) => !nfsAtuais.has(v.nf))
      .map((v) => v.id);
    let resolved_count = 0;
    if (idsResolver.length > 0) {
      const { error } = await supabase
        .from("invariante_violacoes")
        .update({ resolved_at: new Date().toISOString() })
        .in("id", idsResolver);
      if (!error) resolved_count = idsResolver.length;
    }

    // Insere novas (que não estavam abertas)
    const nfsAbertasMap = new Map(abertasArr.map((v) => [v.nf, v.tipo_violacao]));
    const novas = violacoesAtuais.filter(
      (v) => !nfsAbertasMap.has(v.nf) || nfsAbertasMap.get(v.nf) !== v.tipo,
    );

    let inseridas = 0;
    if (novas.length > 0) {
      // Pra NFs cujo tipo mudou, marca a anterior como resolvida primeiro
      const nfsTipoMudou = novas
        .filter((v) => nfsAbertasMap.has(v.nf))
        .map((v) => v.nf);
      if (nfsTipoMudou.length > 0) {
        await supabase
          .from("invariante_violacoes")
          .update({ resolved_at: new Date().toISOString() })
          .in("nf", nfsTipoMudou)
          .is("resolved_at", null);
      }

      const rows = novas.map((v) => ({
        tipo_violacao: v.tipo,
        nf: v.nf,
        oc_bastao: v.oc_bastao,
        oc_cockpit: v.oc_cockpit,
        state_cockpit: v.state_cockpit,
        responsavel_relacionamento: v.responsavel,
        detalhes: v.detalhes,
      }));
      const { error } = await supabase.from("invariante_violacoes").insert(rows);
      if (error) {
        console.error(`[audit] insert violações: ${error.message}`);
      } else {
        inseridas = rows.length;
      }
    }

    // 6. Alerta se houver violações novas
    if (inseridas > 0) {
      await supabase.from("alerts").insert({
        tipo: "invariante_violada",
        severidade: "error",
        mensagem: `${inseridas} NF(s) de relacionamento sem card ativo no Cockpit (total aberto: ${violacoesAtuais.length}).`,
        metadata: {
          inseridas,
          total_abertas: violacoesAtuais.length,
          amostra: novas.slice(0, 5),
        },
      });
    }

    const summary = {
      pendencias_bastao: pendencias.length,
      violacoes_atuais: violacoesAtuais.length,
      inseridas,
      resolved_count,
      duration_ms: Date.now() - startedAt,
    };

    console.log("[audit] done:", JSON.stringify(summary));
    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[audit] fatal:", message);
    return new Response(
      JSON.stringify({ error: message, duration_ms: Date.now() - startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
