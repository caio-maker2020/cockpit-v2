// =============================================================================
// backfill-texto-ssw-56 — Edge Function (Deno runtime)
//
// Caio 2026-07-08: a feature "agente pré-preenche a instrução da oc=56" é
// going-forward — só cards analisados APÓS o deploy ganham `texto_ssw_sugerido`.
// Cards que já estavam no board (analisados antes, ou com o todo de 56 criado
// antes) ficaram sem o texto → prefill vazio no Lovable. Este backfill preenche
// RETROATIVAMENTE, sem re-rodar SSW/interpretador (caro): re-deriva a lacuna a
// partir do resultado JÁ salvo (derivarLacuna56Padrao / derivarLacuna56Oc13) e
// grava o texto em (i) analise_padrao_resultado / analise_oc13_resultado,
// (ii) aviso_alteracao_oc e (iii) meta do todo de 56 pendente.
//
// Alvo: cards que HOJE sugerem 56 —
//   - ocs-padrão: analise_padrao_resultado.proposta_destacada = 56
//   - oc=13:      analise_oc13_resultado.decisao = 'sugerir_56'
// e que ainda estão sem texto_ssw_sugerido. state ∉ (RESOLVIDO, CANCELADO).
//
// Body (opcional): { dry_run?: boolean, limit?: number, card_ids?: string[] }
// Idempotente: pula card que já tem texto. Reexecutar é seguro. NÃO cria/move
// todo, NÃO toca state/dedup — só preenche texto (extras.texto_descricao segue
// vindo da operadora no aprovar_e_executar).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  derivarLacuna56Oc13,
  derivarLacuna56Padrao,
  gerarTextoSsw56,
} from "../_shared/texto-ssw-56.ts";
import {
  listarFotosDaOcMetadata,
  loadSswInternalEnvForCard,
  obterFotoDaOc,
  obterSessao,
} from "../_shared/ssw-internal-client.ts";

// INATIVOS no Cockpit (audit-invariante STATES_INATIVOS): card fora do
// relacionamento — não aparece no board do operador. Não faz sentido backfillar
// nem listar como card de teste. TRANSFERIDO = transferido pra outro setor.
const STATES_FORA = "(RESOLVIDO,CANCELADO,TRANSFERIDO)";

type CardRow = {
  id: string;
  nf: string | null;
  responsavel_relacionamento: string | null;
  cod_ultima_ocorrencia: number | null;
  state: string;
  analise_padrao_resultado: Record<string, unknown> | null;
  analise_oc13_resultado: Record<string, unknown> | null;
  aviso_alteracao_oc: Record<string, unknown> | null;
};

function jaTemTexto(obj: Record<string, unknown> | null): boolean {
  const t = obj?.["texto_ssw_sugerido"];
  return typeof t === "string" && t.trim() !== "";
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    let body: { dry_run?: boolean; limit?: number; card_ids?: string[]; inspect_nf?: string } = {};
    try {
      body = await req.json();
    } catch (_) { /* sem body ok */ }

    // Modo inspeção: dump cru dos campos de texto de UM card (por NF) — pra
    // provar o que o front deveria estar lendo. Não escreve nada.
    if (typeof body.inspect_nf === "string" && body.inspect_nf) {
      const { data: card } = await supabase
        .from("cards")
        .select("id, nf, state, cod_ultima_ocorrencia, analise_padrao_resultado, analise_oc13_resultado, aviso_alteracao_oc")
        .eq("nf", body.inspect_nf)
        .maybeSingle();
      const cardRow = card as Record<string, unknown> | null;
      let todos56: unknown[] = [];
      if (cardRow) {
        const { data: tds } = await supabase
          .from("todos")
          .select("id, status, proposta_payload")
          .eq("card_id", cardRow["id"] as string)
          .eq("status", "pendente");
        todos56 = (tds ?? []).filter((t) => {
          const pl = (t.proposta_payload ?? {}) as Record<string, unknown>;
          const args = (pl["args"] ?? {}) as Record<string, unknown>;
          return Number(args["codigo_ssw"]) === 56;
        }).map((t) => ({
          id: (t as Record<string, unknown>)["id"],
          meta_texto: ((((t as Record<string, unknown>)["proposta_payload"] as Record<string, unknown>)?.["meta"]) as Record<string, unknown>)?.["texto_ssw_sugerido"] ?? null,
        }));
      }
      const apr = cardRow?.["analise_padrao_resultado"] as Record<string, unknown> | null;
      const a13 = cardRow?.["analise_oc13_resultado"] as Record<string, unknown> | null;
      const av = cardRow?.["aviso_alteracao_oc"] as Record<string, unknown> | null;
      return new Response(JSON.stringify({
        ok: true,
        found: !!cardRow,
        card_id: cardRow?.["id"] ?? null,
        nf: cardRow?.["nf"] ?? null,
        state: cardRow?.["state"] ?? null,
        oc: cardRow?.["cod_ultima_ocorrencia"] ?? null,
        analise_padrao_resultado_texto: apr?.["texto_ssw_sugerido"] ?? null,
        analise_padrao_proposta_destacada: apr?.["proposta_destacada"] ?? null,
        analise_oc13_texto: a13?.["texto_ssw_sugerido"] ?? null,
        aviso_tipo: av?.["tipo"] ?? null,
        aviso_texto: av?.["texto_ssw_sugerido"] ?? null,
        todos56_pendentes: todos56,
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // Sonda de tempo: mede cada etapa do carregamento de foto (foto-oc-card)
    // pra achar ONDE está o delay que trava o modal "Ver evidência". Não escreve.
    if (typeof (body as Record<string, unknown>)["probe_foto_nf"] === "string") {
      const nf = (body as Record<string, unknown>)["probe_foto_nf"] as string;
      const { data: card } = await supabase
        .from("cards")
        .select("id, nf, ctrc, cod_ultima_ocorrencia, responsavel_relacionamento")
        .eq("nf", nf)
        .maybeSingle();
      const c = card as Record<string, unknown> | null;
      if (!c) return new Response(JSON.stringify({ ok: false, error: "card não encontrado" }), { headers: { "Content-Type": "application/json" } });
      const probeOc = (body as Record<string, unknown>)["probe_oc"];
      const oc = typeof probeOc === "number" ? probeOc : Number(c["cod_ultima_ocorrencia"]);
      const ctrc = (c["ctrc"] as string | null) ?? null;
      const out: Record<string, unknown> = { nf, oc, responsavel: c["responsavel_relacionamento"] };
      const tEnv = Date.now();
      const env = await loadSswInternalEnvForCard(
        supabase as unknown as Parameters<typeof loadSswInternalEnvForCard>[0],
        Deno.env.toObject(),
        c["id"] as string,
      );
      out["load_env_ms"] = Date.now() - tEnv;
      try {
        const tS = Date.now();
        await obterSessao(env);
        out["login_ssw_ms"] = Date.now() - tS;
      } catch (e) { out["login_ssw_erro"] = e instanceof Error ? e.message : String(e); }
      try {
        const tM = Date.now();
        const meta = await listarFotosDaOcMetadata(env, c["nf"] as string, oc, { ctrcEsperado: ctrc });
        out["manifesto_ms"] = Date.now() - tM;
        out["manifesto_status"] = (meta as Record<string, unknown>)["status"] ?? "ok";
        out["fotos_total"] = (meta as Record<string, unknown>)["fotos_total"] ?? null;
      } catch (e) { out["manifesto_erro"] = e instanceof Error ? e.message : String(e); }
      try {
        const tB = Date.now();
        const bin = await obterFotoDaOc(env, c["nf"] as string, oc, { idx: 0, ctrcEsperado: ctrc });
        out["binario_ms"] = Date.now() - tB;
        out["binario_status"] = (bin as Record<string, unknown>)["status"];
        const b = (bin as Record<string, unknown>)["binary"];
        out["binario_bytes"] = b instanceof Uint8Array ? b.byteLength : null;
      } catch (e) { out["binario_erro"] = e instanceof Error ? e.message : String(e); }
      return new Response(JSON.stringify({ ok: true, probe: out }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // Sonda do ENDPOINT HTTP foto-oc-card (ponta a ponta, como o front chama):
    // chama list:true e depois idx:0 com o service_role como bearer, medindo
    // tempo/status/bytes de cada uma. Isola "endpoint lento/quebrado" (backend)
    // de "front não renderiza" (Lovable).
    if (typeof (body as Record<string, unknown>)["probe_http_nf"] === "string") {
      const nf = (body as Record<string, unknown>)["probe_http_nf"] as string;
      const probeOc2 = (body as Record<string, unknown>)["probe_oc"];
      const { data: card } = await supabase
        .from("cards")
        .select("id, cod_ultima_ocorrencia")
        .eq("nf", nf)
        .maybeSingle();
      const c = card as Record<string, unknown> | null;
      if (!c) return new Response(JSON.stringify({ ok: false, error: "card não encontrado" }), { headers: { "Content-Type": "application/json" } });
      const oc = typeof probeOc2 === "number" ? probeOc2 : Number(c["cod_ultima_ocorrencia"]);
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/foto-oc-card`;
      const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${svc}`, apikey: svc };
      const out: Record<string, unknown> = { nf, oc, endpoint: "foto-oc-card" };
      // manifesto
      try {
        const t = Date.now();
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ card_id: c["id"], codigo_oc: oc, list: true }) });
        const txt = await r.text();
        out["list_ms"] = Date.now() - t;
        out["list_status"] = r.status;
        out["list_ct"] = r.headers.get("content-type");
        out["list_body"] = txt.slice(0, 200);
      } catch (e) { out["list_erro"] = e instanceof Error ? e.message : String(e); }
      // binário
      try {
        const t = Date.now();
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ card_id: c["id"], codigo_oc: oc, idx: 0 }) });
        const ct = r.headers.get("content-type") ?? "";
        out["bin_ms"] = Date.now() - t;
        out["bin_status"] = r.status;
        out["bin_ct"] = ct;
        out["bin_cors"] = r.headers.get("access-control-allow-origin");
        if (ct.startsWith("image/")) {
          const buf = await r.arrayBuffer();
          out["bin_bytes"] = buf.byteLength;
        } else {
          out["bin_body"] = (await r.text()).slice(0, 300);
        }
      } catch (e) { out["bin_erro"] = e instanceof Error ? e.message : String(e); }
      return new Response(JSON.stringify({ ok: true, probe_http: out }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    const dryRun = body.dry_run === true;
    // force: re-deriva e SOBRESCREVE o texto mesmo se o card já tiver um (usado
    // quando o formato do texto muda — ex.: encurtar p/ ≤70 chars do campo SSW).
    const force = (body as Record<string, unknown>)["force"] === true;
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 1000;
    const cardIds = Array.isArray(body.card_ids)
      ? body.card_ids.filter((x) => typeof x === "string" && x.length > 0)
      : null;

    const SELECT =
      "id, nf, responsavel_relacionamento, cod_ultima_ocorrencia, state, analise_padrao_resultado, analise_oc13_resultado, aviso_alteracao_oc";

    // Q1 — ocs-padrão que destacam 56 E cuja oc ATUAL ainda sugere 56
    // (10/11/19/35). Sem esse filtro, pega análise STALE: card que sugeria 56
    // numa oc antiga mas já evoluiu (oc=44/54/33/...) → texto errado. A oc atual
    // fora do conjunto = análise stale (o cron re-analisa quando a oc muda).
    let qPadrao = supabase
      .from("cards")
      .select(SELECT)
      .eq("analise_padrao_resultado->>proposta_destacada", "56")
      .in("cod_ultima_ocorrencia", [10, 11, 19, 35])
      .not("state", "in", STATES_FORA)
      .limit(limit);
    // Q2 — oc=13 sugerir_56 (oc atual ainda 13).
    let qOc13 = supabase
      .from("cards")
      .select(SELECT)
      .eq("analise_oc13_resultado->>decisao", "sugerir_56")
      .eq("cod_ultima_ocorrencia", 13)
      .not("state", "in", STATES_FORA)
      .limit(limit);

    if (cardIds && cardIds.length > 0) {
      qPadrao = qPadrao.in("id", cardIds);
      qOc13 = qOc13.in("id", cardIds);
    }

    const [rP, rO] = await Promise.all([qPadrao, qOc13]);
    if (rP.error) throw rP.error;
    if (rO.error) throw rO.error;

    // Dedup por id (um card cai só numa das listas por oc, mas garante).
    const byId = new Map<string, { card: CardRow; fonte: "padrao" | "oc13" }>();
    for (const c of (rP.data ?? []) as CardRow[]) byId.set(c.id, { card: c, fonte: "padrao" });
    for (const c of (rO.data ?? []) as CardRow[]) if (!byId.has(c.id)) byId.set(c.id, { card: c, fonte: "oc13" });

    const stats = {
      candidatos: byId.size,
      cards_atualizados: 0,
      todos_atualizados: 0,
      ja_tinha: 0,
      stale_pulados: 0,
      sem_todo_pendente: 0,
      erros: [] as Array<{ card_id: string; erro: string }>,
      amostra: [] as Array<{ card_id: string; nf: string | null; responsavel: string | null; oc: number | null; state: string; texto: string }>,
    };

    for (const { card, fonte } of byId.values()) {
      try {
        const resultado = fonte === "padrao"
          ? card.analise_padrao_resultado
          : card.analise_oc13_resultado;

        // Texto efetivo pra listar/gravar: o já salvo (idempotência) ou o
        // re-derivado do resultado. `stale` só se aplica a quem ainda não tem.
        let texto: string;
        const temTexto = jaTemTexto(resultado);
        if (temTexto && !force) {
          texto = String(resultado?.["texto_ssw_sugerido"]);
        } else if (fonte === "padrao") {
          const ocCard = card.cod_ultima_ocorrencia ?? 0;
          // Freshness (mesma regra de stale do cron): quando a análise carrega
          // codigo_oc_card, ele TEM que bater com a oc atual — senão os campos do
          // resultado (gps/foto/motivo) são de outra oc → texto errado. Pula.
          const codOcAnalise = resultado?.["codigo_oc_card"] as number | undefined;
          if (codOcAnalise != null && codOcAnalise !== ocCard) {
            stats.stale_pulados++;
            continue;
          }
          const { lacuna, ctx } = derivarLacuna56Padrao(resultado ?? {}, ocCard);
          texto = gerarTextoSsw56(lacuna, ctx);
        } else {
          const { lacuna, ctx } = derivarLacuna56Oc13(resultado ?? {});
          texto = gerarTextoSsw56(lacuna, ctx);
        }

        if (stats.amostra.length < 40) {
          stats.amostra.push({ card_id: card.id, nf: card.nf, responsavel: card.responsavel_relacionamento, oc: card.cod_ultima_ocorrencia, state: card.state, texto });
        }
        if (temTexto && !force) {
          stats.ja_tinha++;
          continue;
        }
        if (dryRun) continue;

        // (i)+(ii) grava no resultado + aviso (read-modify-write dos JSONB).
        const colResultado = fonte === "padrao"
          ? "analise_padrao_resultado"
          : "analise_oc13_resultado";
        const novoResultado = { ...(resultado ?? {}), texto_ssw_sugerido: texto };
        const update: Record<string, unknown> = { [colResultado]: novoResultado };
        // Só carimba o aviso se ele for da própria sugestão (não sobrescreve
        // avisos de outro tipo que porventura estejam no card).
        const aviso = card.aviso_alteracao_oc;
        const avisoTipo = aviso?.["tipo"] as string | undefined;
        if (aviso && (avisoTipo === "ia_sugestao_ocs_padrao" || avisoTipo === "ia_sugestao_oc13_revisar")) {
          update["aviso_alteracao_oc"] = { ...aviso, texto_ssw_sugerido: texto };
        }
        const { error: upErr } = await supabase.from("cards").update(update).eq("id", card.id);
        if (upErr) throw upErr;
        stats.cards_atualizados++;

        // (iii) semeia meta.texto_ssw_sugerido no(s) todo(s) de 56 pendente(s).
        const { data: todos, error: tErr } = await supabase
          .from("todos")
          .select("id, proposta_payload")
          .eq("card_id", card.id)
          .eq("status", "pendente");
        if (tErr) throw tErr;
        const todos56 = (todos ?? []).filter((t) => {
          const pl = (t.proposta_payload ?? {}) as Record<string, unknown>;
          const args = (pl["args"] ?? {}) as Record<string, unknown>;
          return Number(args["codigo_ssw"]) === 56;
        });
        if (todos56.length === 0) {
          stats.sem_todo_pendente++;
        }
        for (const t of todos56) {
          const pl = ((t.proposta_payload ?? {}) as Record<string, unknown>);
          const meta = ((pl["meta"] ?? {}) as Record<string, unknown>);
          if (!force && typeof meta["texto_ssw_sugerido"] === "string" && (meta["texto_ssw_sugerido"] as string).trim() !== "") {
            continue; // idempotente por-todo (força sobrescreve)
          }
          const novoPayload = { ...pl, meta: { ...meta, texto_ssw_sugerido: texto } };
          const { error: tuErr } = await supabase
            .from("todos")
            .update({ proposta_payload: novoPayload })
            .eq("id", t.id as string);
          if (tuErr) throw tuErr;
          stats.todos_atualizados++;
        }
      } catch (e) {
        stats.erros.push({ card_id: card.id, erro: e instanceof Error ? e.message : String(e) });
      }
    }

    // Anota na amostra se o card tem todo de 56 PENDENTE (fluxo completo de
    // aprovar pelo banner/lista) — batch query única pelos ids da amostra.
    const amostraIds = stats.amostra.map((a) => a.card_id);
    let comTodo56 = new Set<string>();
    if (amostraIds.length > 0) {
      const { data: tds } = await supabase
        .from("todos")
        .select("card_id, proposta_payload")
        .in("card_id", amostraIds)
        .eq("status", "pendente");
      comTodo56 = new Set(
        (tds ?? [])
          .filter((t) => {
            const pl = (t.proposta_payload ?? {}) as Record<string, unknown>;
            const args = (pl["args"] ?? {}) as Record<string, unknown>;
            return Number(args["codigo_ssw"]) === 56;
          })
          .map((t) => t.card_id as string),
      );
    }
    const amostraAnotada = stats.amostra.map((a) => ({
      ...a,
      tem_todo_56_pendente: comTodo56.has(a.card_id),
    }));

    // Distribuição por state entre os candidatos (só ATIVOS agora) — pra achar
    // rapidamente os que aparecem no board do operador.
    const porState: Record<string, number> = {};
    for (const { card } of byId.values()) {
      porState[card.state] = (porState[card.state] ?? 0) + 1;
    }

    return new Response(
      JSON.stringify({ ok: true, dry_run: dryRun, ...stats, por_state: porState, amostra: amostraAnotada }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
