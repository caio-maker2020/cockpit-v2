// =============================================================================
// cerebro-veto-dossie — o CÉREBRO semanal do loop de aprendizado do veto
// (Caio 26/08: "pode construir"). Cron semanal (mig 358) ou invoke manual.
//
// Pipeline: cancelamentos + correções capturadas + edições da janela →
// classifica "o que leu errado" na taxonomia fixa (HAIKU — triagem, conv. 7)
// → separa vetos sem divergência (INV-103: não treinam o agente) → agrupa
// padrões → padrão com n≥2 ganha PROPOSTA de regra (SONNET — especialista)
// → grava 1 learning_log por padrão (diff_proposto, card_ids,
// metrica_snapshot, status aberto) + dossiê consolidado como CONVERSA no
// chat do Aprendizado (aprendizado_chat_sessoes/mensagens) — o canal que o
// agente-chefe já usa. NADA vira regra sozinho: replay nos gabaritos +
// ordem do Caio continuam obrigatórios.
//
// POST body opcional: { dias?: number (default 7), dry?: boolean }
// dry=true → monta e retorna o dossiê SEM gravar nada.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import {
  agruparPadroes,
  CATEGORIAS_VETO,
  divergenciaDoVeto,
  montarDossieMd,
  montarPromptClassificacao,
  montarPromptProposta,
  resumirEdicoes,
  SYSTEM_CLASSIFICACAO,
  SYSTEM_PROPOSTA,
  type CategoriaVeto,
  type VetoClassificado,
} from "../_shared/cerebro-veto.ts";

serve(async (req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.includes(serviceKey)) {
    return new Response(JSON.stringify({ ok: false, error: "service role only" }), { status: 401 });
  }
  let body: { dias?: number; dry?: boolean } = {};
  try { body = await req.json(); } catch { /* body vazio ok */ }
  const dias = Math.min(Math.max(body.dias ?? 7, 1), 31);
  const dry = body.dry === true;
  const desde = new Date(Date.now() - dias * 24 * 3600_000).toISOString();

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Coleta ──────────────────────────────────────────────────────────────
  const { data: cancelamentos } = await supabase
    .from("cancelamentos_acao_autonoma")
    .select("id, card_id, agent_name, acao_key, ciclo, respostas, correcao_capturada, created_at, operador:operadores(nome), card:cards(nf)")
    .gte("created_at", desde)
    .order("created_at");
  const { data: edicoesRaw } = await supabase
    .from("edicoes_acao_autonoma")
    .select("acao_key, campo, valor_antes, valor_depois")
    .gte("created_at", desde);

  const cancels = (cancelamentos ?? []) as Array<Record<string, any>>;
  if (cancels.length === 0 && (edicoesRaw ?? []).length === 0) {
    return new Response(JSON.stringify({ ok: true, vazio: true, msg: `sem vetos/edições nos últimos ${dias}d` }), { status: 200 });
  }

  // ── 2. Classificação (Haiku) — 1 chamada por veto; erro → 'outro' ─────────
  const anthropic = createAnthropicClient({ env: readAnthropicEnvFromProcess(Deno.env.toObject()) });
  const vetos: VetoClassificado[] = [];
  for (const c of cancels) {
    const r = (c["respostas"] ?? {}) as Record<string, any>;
    let categoria: CategoriaVeto = "outro";
    try {
      const out = await anthropic.completeJson<{ categoria?: string }>({
        model: "claude-haiku-4-5",
        system: SYSTEM_CLASSIFICACAO,
        maxTokens: 100,
        messages: [{
          role: "user",
          content: montarPromptClassificacao({
            acaoKey: c["acao_key"],
            leuErrado: r["o_que_leu_errado"] ?? "",
            ondeOlhou: Array.isArray(r["onde_olhou"]) ? r["onde_olhou"] : [],
            infoNoCockpit: r["info_existe_no_cockpit"] ?? null,
            excecaoCliente: r["excecao_cliente"] === true,
            excecaoQual: r["excecao_qual"] ?? null,
          }),
        }],
        meta: { functionName: "cerebro-veto-dossie", agentName: "cerebro-veto", cardId: c["card_id"] },
      });
      if (out.categoria && (CATEGORIAS_VETO as string[]).includes(out.categoria)) {
        categoria = out.categoria as CategoriaVeto;
      }
    } catch (e) {
      console.warn(`classificação falhou (${c["id"]}): ${e instanceof Error ? e.message : e}`);
    }
    const correcao = (c["correcao_capturada"]?.["acao_key"] as string | undefined) ?? null;
    vetos.push({
      cardId: c["card_id"],
      nf: c["card"]?.["nf"] ?? null,
      agente: c["agent_name"],
      acaoKey: c["acao_key"],
      ciclo: c["ciclo"] ?? null,
      operador: c["operador"]?.["nome"] ?? "?",
      categoria,
      leuErrado: r["o_que_leu_errado"] ?? "",
      infoNoCockpit: r["info_existe_no_cockpit"] ?? null,
      excecaoCliente: r["excecao_cliente"] === true,
      correcaoAcaoKey: correcao,
      divergencia: divergenciaDoVeto(c["acao_key"], correcao),
    });
  }

  // ── 3. Agrupamento + propostas (Sonnet) só pra padrão com n≥2 ─────────────
  const padroes = agruparPadroes(vetos);
  const comProposta: Array<ReturnType<typeof agruparPadroes>[number] & { proposta?: string | null }> = [];
  for (const p of padroes) {
    let proposta: string | null = null;
    if (p.n >= 2) {
      try {
        const res = await anthropic.complete({
          model: "claude-sonnet-4-6",
          system: SYSTEM_PROPOSTA,
          maxTokens: 600,
          messages: [{ role: "user", content: montarPromptProposta(p) }],
          meta: { functionName: "cerebro-veto-dossie", agentName: "cerebro-veto" },
        });
        proposta = res.text?.trim() ?? null;
      } catch (e) {
        console.warn(`proposta falhou (${p.agente}/${p.acaoKey}): ${e instanceof Error ? e.message : e}`);
      }
    }
    comProposta.push({ ...p, proposta });
  }

  const semDivergencia = vetos
    .filter((v) => v.divergencia === "sem_divergencia")
    .map((v) => ({ operador: v.operador, nf: v.nf, acaoKey: v.acaoKey }));
  const pendentes = vetos.filter((v) => v.divergencia === "pendente").length;
  const edicoes = resumirEdicoes(
    ((edicoesRaw ?? []) as Array<Record<string, any>>).map((e) => ({
      acaoKey: e["acao_key"],
      campo: e["campo"],
      antes: typeof e["valor_antes"]?.["descricao"] === "string" ? e["valor_antes"]["descricao"] : JSON.stringify(e["valor_antes"])?.slice(0, 160) ?? null,
      depois: typeof e["valor_depois"]?.["descricao"] === "string" ? e["valor_depois"]["descricao"] : JSON.stringify(e["valor_depois"])?.slice(0, 160) ?? null,
    })),
  );

  const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const periodo = `${fmt(new Date(Date.parse(desde) - 3 * 3600_000))}–${fmt(new Date(Date.now() - 3 * 3600_000))}`;
  const dossie = montarDossieMd({
    periodo, totalVetos: vetos.length, padroes: comProposta, semDivergencia, pendentes, edicoes,
  });

  if (dry) {
    return new Response(JSON.stringify({ ok: true, dry: true, dossie, padroes: comProposta.length }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // ── 4. Persistência: learning_log (1/padrão com proposta) + conversa ──────
  const logIds: string[] = [];
  for (const p of comProposta) {
    if (!p.proposta) continue;
    const { data: log } = await supabase.from("learning_log").insert({
      agente: "cerebro-veto-dossie",
      tipo: "padrao_veto_cancelamentos",
      severidade: p.n >= 4 ? "alta" : "media",
      titulo: `Veto recorrente: ${p.acaoKey} · ${p.categoria} (${p.n}x)`,
      resumo: p.exemplos[0] ?? "",
      detalhes: { categoria: p.categoria, exemplos: p.exemplos, correcoes: p.correcoes, nfs: p.nfs, pendentes: p.pendentes },
      card_ids: p.cardIds,
      agente_alvo: p.agente,
      diff_proposto: p.proposta,
      metrica_snapshot: { n: p.n, periodo_dias: dias },
      status: "aberto",
    }).select("id").single();
    if (log) logIds.push((log as { id: string }).id);
  }

  // conversa no chat do Aprendizado (mesmo canal do agente-chefe)
  const { data: sess } = await supabase
    .from("aprendizado_chat_sessoes")
    .insert({ tipo: "agente_iniciou", titulo: `Dossiê da janela de veto — ${periodo}` })
    .select("id").single();
  if (sess) {
    await supabase.from("aprendizado_chat_mensagens").insert({
      sessao_id: (sess as { id: string }).id,
      papel: "agente",
      conteudo: dossie,
      dados: { origem: "cerebro-veto-dossie", learning_log_ids: logIds, periodo_dias: dias },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, vetos: vetos.length, padroes: comProposta.length, propostas: logIds.length, sessao: (sess as { id: string } | null)?.id ?? null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
