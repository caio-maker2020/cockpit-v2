// =============================================================================
// agente-aprendizado — orquestrador do Loop de Aprendizado (Fase 1).
//
// Spec: docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md
// Plano: docs/superpowers/plans/2026-07-17-loop-aprendizado-implementacao.md
//
// READ-ONLY no operacional (lê v_agent_feedback_unificado, v_sinal_ouro_
// metricas_diarias, ocorrencias_dicionario). ESCREVE somente em learning_log.
// Nunca toca cards/todos/SSW/e-mail. Nunca altera prompt/código — só observa,
// pergunta e propõe (envelope da spec §5).
//
// Modos (body JSON):
//   {"modo":"diario"}  — agrupa divergências dos últimos 30 dias, gera até
//                        MAX_PERGUNTAS_POR_RODADA perguntas novas (dedup por
//                        chave_padrao — nunca re-pergunta) + heartbeat
//                        metrica_snapshot (atestado de vida pro watchdog).
//   {"modo":"semanal"} — tudo do diário + relatório semanal (números da semana
//                        vs anterior, perguntas abertas, narrativa Sonnet
//                        BEST-EFFORT — sem LLM o relatório sai igual, com
//                        texto determinístico).
//
// "As perguntas são riqueza" (Caio, spec §3): pergunta ancorada em evidência,
// respondível em 1 clique, nunca repetida.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  createAnthropicClient,
  readAnthropicEnvFromProcess,
} from "../_shared/anthropic-client.ts";
import { logAnthropicUsage } from "../_shared/anthropic-usage-logger.ts";
import { finishAgentRun, startAgentRun } from "../_shared/agent-runs-logger.ts";
import {
  agruparPorSugestao,
  chavePergunta,
  compararSemanas,
  medirImpactoResposta,
  montarPergunta,
  parseChavePadrao,
  selecionarPerguntas,
  type MetricaAgenteSemana,
  type ParFeedback,
} from "../_shared/aprendizado-regras.ts";
import {
  APRENDIZADO_MODEL,
  APRENDIZADO_NARRATIVA_SYSTEM,
} from "../_shared/prompts/agente-aprendizado.ts";

const AGENT_NAME = "agente-aprendizado";
const JANELA_DIAS = 30;
const MAX_PERGUNTAS_POR_RODADA = 3;
const MAX_PERGUNTAS_ABERTAS = 5;
const MAX_PARES = 20_000;
const COOLDOWN_REJEITADA_DIAS = 28;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const supabaseUrl = env["SUPABASE_URL"];
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL/SERVICE_ROLE_KEY ausentes" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json().catch(() => ({}));
  const modo: "diario" | "semanal" = body?.modo === "semanal" ? "semanal" : "diario";

  const run = startAgentRun({ agentName: AGENT_NAME, stepName: modo });

  try {
    // ---------- 1. Carrega pares da janela (view unificada = Sinal de Ouro)
    // PAGINADO: o PostgREST corta em 1.000 linhas por request (bug pego na
    // estreia manual de 17/07 — a janela real tinha mais e a view UNION
    // devolvia um agente inteiro primeiro, enviesando os clusters).
    const desde = new Date(Date.now() - JANELA_DIAS * 24 * 3600 * 1000).toISOString();
    const PAGINA = 1000;
    const pares: ParFeedback[] = [];
    for (let offset = 0; offset < MAX_PARES; offset += PAGINA) {
      const { data: paresRaw, error: paresErr } = await supabase
        .from("v_agent_feedback_unificado")
        .select(
          "agent_name,veredito,origem,oc_card,oc_sugerida,oc_executada,reason_text,operador_card,nf,decidido_em",
        )
        .gte("decidido_em", desde)
        .order("decidido_em", { ascending: false })
        .range(offset, offset + PAGINA - 1);
      if (paresErr) throw new Error(`v_agent_feedback_unificado: ${paresErr.message}`);
      const page = (paresRaw ?? []) as ParFeedback[];
      pares.push(...page);
      if (page.length < PAGINA) break;
    }

    // ---------- 2. Nomes das ocorrências (linguagem simples, spec §6)
    const { data: dicRaw } = await supabase
      .from("ocorrencias_dicionario")
      .select("codigo,descricao");
    const nomesOc: Record<number, string> = {};
    for (const d of dicRaw ?? []) nomesOc[d.codigo as number] = d.descricao as string;

    // ---------- 3. Chaves já perguntadas (nunca re-perguntar — spec §3)
    //   abertas/respondidas: bloqueiam pra sempre;
    //   rejeitadas: bloqueiam por COOLDOWN_REJEITADA_DIAS.
    const cooldown = new Date(
      Date.now() - COOLDOWN_REJEITADA_DIAS * 24 * 3600 * 1000,
    ).toISOString();
    const { data: antigasRaw } = await supabase
      .from("learning_log")
      .select("detalhes,status,created_at")
      .eq("agente", AGENT_NAME)
      .eq("tipo", "pergunta");
    const chavesBloqueadas = new Set<string>();
    let perguntasAbertas = 0;
    for (const a of antigasRaw ?? []) {
      const chave = (a.detalhes as Record<string, unknown> | null)?.["chave_padrao"];
      if (typeof chave !== "string") continue;
      const st = a.status as string;
      if (st === "rejeitado") {
        if ((a.created_at as string) >= cooldown) chavesBloqueadas.add(chave);
      } else {
        chavesBloqueadas.add(chave);
        if (st === "aberto") perguntasAbertas += 1;
      }
    }

    // ---------- 4. Agrupa e seleciona perguntas novas
    const grupos = agruparPorSugestao(pares);
    const vagas = Math.max(
      0,
      Math.min(MAX_PERGUNTAS_POR_RODADA, MAX_PERGUNTAS_ABERTAS - perguntasAbertas),
    );
    const escolhidos = selecionarPerguntas(grupos, {
      maxPerguntas: vagas,
      chavesJaPerguntadas: chavesBloqueadas,
    });

    const perguntasCriadas: string[] = [];
    for (const g of escolhidos) {
      const p = montarPergunta(g, nomesOc);

      // Casos recentes do padrão COM o porquê da IA (Caio 2026-07-17: a
      // pergunta já traz os casos e o raciocínio que levou à sugestão).
      let casosQuery = supabase
        .from("v_sinal_ouro_casos")
        .select(
          "nf,card_id,decidido_em,oc_card,oc_executada,operador_card,empresa_cliente,motivo_correcao,decisao_ia",
        )
        .eq("agent_name", g.agentName)
        .eq("veredito", "corrigida")
        .order("decidido_em", { ascending: false })
        .limit(5);
      casosQuery = g.ocSugerida === null
        ? casosQuery.is("oc_sugerida", null)
        : casosQuery.eq("oc_sugerida", g.ocSugerida);
      const { data: casosRaw } = await casosQuery;
      const casosDetalhe = (casosRaw ?? []).map(
        (c: Record<string, unknown>) => {
          const dec = (c.decisao_ia ?? {}) as Record<string, unknown>;
          return {
            nf: c.nf ?? null,
            card_id: c.card_id,
            quando: c.decidido_em,
            oc_card: c.oc_card ?? null,
            oc_executada: c.oc_executada ?? null,
            operador: c.operador_card ?? null,
            cliente: c.empresa_cliente ?? null,
            motivo_correcao: c.motivo_correcao ?? null,
            por_que_ia: {
              observacao: dec["observacao_orquestrador"] ?? dec["motivo"] ?? null,
              motivo_extraido: dec["motivo_extraido"] ?? null,
              confianca: dec["confianca"] ?? null,
              foto_classificacao: dec["foto_classificacao"] ?? null,
              ressalva_texto: dec["ressalva_texto"] ?? null,
            },
          };
        },
      );
      const { error: insErr } = await supabase.from("learning_log").insert({
        agente: AGENT_NAME,
        tipo: "pergunta",
        severidade: "info",
        titulo: p.titulo,
        resumo: p.oQueAconteceu,
        agente_alvo: p.agenteAlvo,
        status: "aberto",
        detalhes: {
          chave_padrao: p.chavePadrao,
          o_que_sugiro: p.oQueSugiro,
          pergunta: p.pergunta,
          opcoes: p.opcoes,
          opcoes_v2: p.opcoesV2,
          casos_ancora: p.casosAncora,
          casos_detalhe: casosDetalhe,
          numeros: p.numeros,
          detalhe_tecnico: {
            janela_dias: JANELA_DIAS,
            trocas: g.trocas,
            operadores_top: g.operadoresTop,
            motivos_registrados: g.motivosRegistrados,
          },
        },
      });
      if (insErr) throw new Error(`insert pergunta: ${insErr.message}`);
      perguntasCriadas.push(p.chavePadrao);
    }

    // ---------- 5. Heartbeat (atestado de vida pro watchdog — sempre grava)
    const totais = {
      pares_janela_30d: pares.length,
      seguidas: pares.filter((p) => p.veredito === "seguida").length,
      corrigidas: pares.filter((p) => p.veredito === "corrigida").length,
      abstencoes: pares.filter((p) => p.veredito === "abstencao").length,
      perguntas_novas: perguntasCriadas.length,
      perguntas_abertas: perguntasAbertas + perguntasCriadas.length,
    };
    const { error: hbErr } = await supabase.from("learning_log").insert({
      agente: AGENT_NAME,
      tipo: "metrica_snapshot",
      severidade: "info",
      titulo: `Rodada ${modo} concluída`,
      resumo:
        `Analisei ${totais.pares_janela_30d} pares dos últimos ${JANELA_DIAS} dias; ` +
        `${perguntasCriadas.length} pergunta(s) nova(s).`,
      status: "observacao",
      metrica_snapshot: totais,
      detalhes: { modo, chaves_novas: perguntasCriadas },
    });
    if (hbErr) throw new Error(`insert heartbeat: ${hbErr.message}`);

    // ---------- 5.5 Impacto das respostas (Caio 2026-07-23: "monitorar se
    // os inputs da Isadora estão de fato melhorando os agentes"). Pra cada
    // resposta com 7+ dias e ainda sem medição: taxa de correção do padrão
    // 14d ANTES vs DEPOIS da resposta. Só conclui com volume mínimo.
    const impactosNovos = await medirImpactoDasRespostas(supabase, pares, nomesOc);

    // ---------- 6. Relatório semanal (modo semanal)
    let relatorio: Record<string, unknown> | null = null;
    if (modo === "semanal") {
      relatorio = await montarRelatorioSemanal(supabase, nomesOc);
    }

    await finishAgentRun(supabase, run, {
      status: "success",
      output: { modo, ...totais, impactos_novos: impactosNovos, relatorio: relatorio ? true : false },
    });
    return json({
      ok: true,
      modo,
      ...totais,
      impactos_novos: impactosNovos,
      perguntas: perguntasCriadas,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishAgentRun(supabase, run, { status: "error", errorMessage: msg });
    return json({ ok: false, error: msg }, 500);
  }
});

// =============================================================================

const IMPACTO_JANELA_ANTES_DIAS = 14;
const IMPACTO_MATURACAO_DIAS = 7;
const IMPACTO_DESISTE_DIAS = 45;

async function medirImpactoDasRespostas(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  pares: ParFeedback[],
  nomesOc: Record<number, string>,
): Promise<number> {
  const agora = Date.now();
  const desde = new Date(agora - IMPACTO_DESISTE_DIAS * 24 * 3600 * 1000).toISOString();

  const { data: respostasRaw } = await supabase
    .from("learning_log")
    .select("id,titulo,revisado_em,detalhes")
    .eq("agente", "agente-aprendizado")
    .eq("tipo", "resposta_admin")
    .gte("created_at", desde);
  const respostas = (respostasRaw ?? []) as Array<{
    id: string;
    titulo: string;
    revisado_em: string | null;
    detalhes: Record<string, unknown> | null;
  }>;
  if (respostas.length === 0) return 0;

  const { data: impactosRaw } = await supabase
    .from("learning_log")
    .select("parent_id")
    .eq("agente", "agente-aprendizado")
    .eq("tipo", "impacto_medido");
  const jaMedidas = new Set(
    ((impactosRaw ?? []) as Array<{ parent_id: string | null }>)
      .map((i) => i.parent_id)
      .filter(Boolean),
  );

  let criados = 0;
  for (const r of respostas) {
    if (jaMedidas.has(r.id)) continue;
    const quando = new Date(r.revisado_em ?? 0).getTime();
    if (!quando || agora - quando < IMPACTO_MATURACAO_DIAS * 24 * 3600 * 1000) continue;
    const padrao = parseChavePadrao(
      (r.detalhes?.["chave_padrao"] as string | undefined) ?? null,
    );
    if (!padrao) continue;

    const inicioAntes = quando - IMPACTO_JANELA_ANTES_DIAS * 24 * 3600 * 1000;
    const doPadrao = pares.filter((p) =>
      p.agent_name === padrao.agentName &&
      (p.oc_sugerida ?? null) === padrao.ocSugerida &&
      (p.veredito === "seguida" || p.veredito === "corrigida")
    );
    const conta = (deMs: number, ateMs: number) => {
      let seguidas = 0, corrigidas = 0;
      for (const p of doPadrao) {
        const t = new Date(p.decidido_em).getTime();
        if (t < deMs || t >= ateMs) continue;
        if (p.veredito === "seguida") seguidas += 1;
        else corrigidas += 1;
      }
      return { seguidas, corrigidas };
    };
    const impacto = medirImpactoResposta(
      conta(inicioAntes, quando),
      conta(quando, agora),
    );
    if (impacto.status === "cedo_demais") continue; // tenta de novo amanhã

    const agenteNome = padrao.agentName;
    const ocTxt = padrao.ocSugerida !== null
      ? `${padrao.ocSugerida} — ${nomesOc[padrao.ocSugerida] ?? ""}`.trim()
      : "(sem código)";
    const leitura = impacto.status === "melhorou"
      ? `MELHOROU: o time corrigia ${impacto.taxaAntesPct}% e agora corrige ${impacto.taxaDepoisPct}% (${impacto.deltaPts} pontos).`
      : impacto.status === "piorou"
      ? `PIOROU: a correção subiu de ${impacto.taxaAntesPct}% pra ${impacto.taxaDepoisPct}% (+${impacto.deltaPts} pontos) — a resposta ainda não virou melhoria no agente.`
      : `ESTÁVEL: correção foi de ${impacto.taxaAntesPct}% pra ${impacto.taxaDepoisPct}% — sem mudança relevante ainda.`;

    const { error } = await supabase.from("learning_log").insert({
      agente: "agente-aprendizado",
      tipo: "impacto_medido",
      severidade: impacto.status === "piorou" ? "warning" : "info",
      titulo: `Impacto da resposta — sugestão "${ocTxt}"`,
      resumo:
        `Depois da resposta sobre o padrão do ${agenteNome} (sugerindo ${ocTxt}): ${leitura}`,
      status: "observacao",
      parent_id: r.id,
      agente_alvo: padrao.agentName,
      metrica_snapshot: {
        chave_padrao: r.detalhes?.["chave_padrao"] ?? null,
        ...impacto,
      },
    });
    if (!error) criados += 1;
  }
  return criados;
}

async function montarRelatorioSemanal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  nomesOc: Record<number, string>,
): Promise<Record<string, unknown>> {
  const hoje = new Date();
  const d7 = new Date(hoje.getTime() - 7 * 24 * 3600 * 1000);
  const d14 = new Date(hoje.getTime() - 14 * 24 * 3600 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  async function metricasJanela(de: Date, ate: Date): Promise<MetricaAgenteSemana[]> {
    const { data, error } = await supabase
      .from("v_sinal_ouro_metricas_diarias")
      .select("agent_name,pares,seguidas,corrigidas,abstencoes")
      .gte("dia", iso(de))
      .lt("dia", iso(ate));
    if (error) throw new Error(`metricas ${iso(de)}..${iso(ate)}: ${error.message}`);
    const acc = new Map<string, MetricaAgenteSemana>();
    for (const r of data ?? []) {
      const cur = acc.get(r.agent_name) ??
        { agentName: r.agent_name, pares: 0, seguidas: 0, corrigidas: 0, abstencoes: 0 };
      cur.pares += r.pares ?? 0;
      cur.seguidas += r.seguidas ?? 0;
      cur.corrigidas += r.corrigidas ?? 0;
      cur.abstencoes += r.abstencoes ?? 0;
      acc.set(r.agent_name, cur);
    }
    return [...acc.values()];
  }

  const [semanaAtual, semanaAnterior] = await Promise.all([
    metricasJanela(d7, hoje),
    metricasJanela(d14, d7),
  ]);
  const comparativo = compararSemanas(semanaAtual, semanaAnterior);

  // Perguntas abertas (entram no relatório como "o que preciso que respondam")
  const { data: abertas } = await supabase
    .from("learning_log")
    .select("id,titulo,detalhes")
    .eq("agente", AGENT_NAME)
    .eq("tipo", "pergunta")
    .eq("status", "aberto")
    .order("created_at", { ascending: true });

  // Narrativa em linguagem simples — BEST-EFFORT (sem LLM o relatório sai
  // com texto determinístico; Anthropic fora do ar nunca bloqueia o loop).
  let narrativa = comparativo
    .map((c) =>
      `${c.agenteAmigavel}: ${c.pctAcertoAtual ?? "sem dados"}% de sugestões seguidas` +
      (c.deltaPontos !== null
        ? ` (${c.deltaPontos > 0 ? "+" : ""}${c.deltaPontos} pontos vs semana anterior)`
        : "")
    )
    .join(". ");
  let narrativaFonte = "deterministica";
  try {
    const anthropic = createAnthropicClient({
      env: readAnthropicEnvFromProcess(Deno.env.toObject()),
      onUsage: (rec) => logAnthropicUsage(supabase, rec),
    });
    const resp = await anthropic.complete({
      model: APRENDIZADO_MODEL,
      system: APRENDIZADO_NARRATIVA_SYSTEM,
      maxTokens: 600,
      temperature: 0.2,
      messages: [{
        role: "user",
        content: JSON.stringify({
          comparativo_semanal: comparativo,
          perguntas_abertas: (abertas ?? []).map((a: { titulo: string }) => a.titulo),
        }),
      }],
      meta: { functionName: AGENT_NAME, agentName: AGENT_NAME },
    });
    if (resp.text?.trim()) {
      narrativa = resp.text.trim();
      narrativaFonte = "sonnet";
    }
  } catch (e) {
    console.warn("[agente-aprendizado] narrativa LLM falhou (segue determinística):", e);
  }

  const detalhes = {
    semana_de: iso(d7),
    semana_ate: iso(hoje),
    comparativo,
    perguntas_abertas: (abertas ?? []).map((
      a: { id: string; titulo: string; detalhes: Record<string, unknown> },
    ) => ({
      id: a.id,
      titulo: a.titulo,
      pergunta: a.detalhes?.["pergunta"],
      opcoes: a.detalhes?.["opcoes"],
    })),
    narrativa_fonte: narrativaFonte,
    nomes_oc_usados: Object.keys(nomesOc).length,
  };

  const { error: relErr } = await supabase.from("learning_log").insert({
    agente: AGENT_NAME,
    tipo: "relatorio_semanal",
    severidade: "info",
    titulo: `Relatório da semana ${iso(d7)} a ${iso(hoje)}`,
    resumo: narrativa,
    status: "aberto",
    detalhes,
  });
  if (relErr) throw new Error(`insert relatorio: ${relErr.message}`);
  return detalhes;
}
