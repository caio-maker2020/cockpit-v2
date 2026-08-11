// =============================================================================
// robo-intranet-wurth — coleta os retornos da intranet Würth e SUGERE no card
// (Ingrid, Caio 2026-08-11). NUNCA lança sozinho — a Ingrid aprova.
//
// Disparo: cron 2x/dia (08h/16h BRT) OU botão BUSCAR INTRANET no card
// (body {card_id}). Flag master: wurth_intranet_enabled.
//
// Fluxo: logins (sal=Cotia WTC/ARP; ampla=Betim AMB/WTB — mesmos da Ingrid)
// → consulta "Pendência na Transportadora" (Incluídos E Tratadas 01/01→hoje,
// Solucionado Würth) → match NF × card ativo da carteira Würth → dedupe por
// (nf, data_solucao, solucao) → efeito:
//   Reentrega        → todo 21 RECOMENDADO com a Obs (instrução da operação)
//   Devolver a Würth → todo 44 recomendado (modal padrão pede volumes/base)
//   Obs com CCE      → só card_event (a sugestão nasce do e-mail da carta)
// Card acorda (cliente_respondeu_em + AVH + lock) com ia_sugestao contextual.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao, claimsDoBearer } from "../_shared/trava-visualizacao.ts";
import {
  chaveDedupe,
  loginPorPrefixoCtrc,
  mapearEfeito,
  normalizarNfWurth,
  type LinhaRetornoWurth,
  type LoginWurth,
} from "../_shared/wurth-intranet.ts";
import {
  consultarPendencias,
  loginWurth,
  readWurthEnv,
} from "../_shared/wurth-intranet-client.ts";

const FLAG = "wurth_intranet_enabled";
const ESTADOS_ACIONAVEIS = [
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_VALIDACAO_HUMANA",
  "ACAO_EXECUTADA",
  "AGUARDANDO_AGENTE",
];

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type CardAlvo = {
  id: string;
  nf: string | null;
  ctrc: string | null;
  state: string;
  cliente_respondeu_em: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  const env = Deno.env.toObject();
  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false },
  });

  // Auth: service_role (cron) ou operador autenticado (botão). Trava do modo
  // visualização vale pro botão (João/Isadora não disparam busca).
  const { role, sub } = claimsDoBearer(req);
  if (role !== "service_role" && !sub) return json({ ok: false, error: "não autenticado" }, 401);
  const bloqueio = await bloquearSeModoVisualizacao(req, supabase, corsHeaders);
  if (bloqueio) return bloqueio;

  const { data: flagRow } = await supabase
    .from("feature_flags").select("enabled").eq("key", FLAG).maybeSingle();
  if (!(flagRow as { enabled?: boolean } | null)?.enabled) {
    return json({ ok: true, skipped: "flag_off" });
  }

  const body = await req.json().catch(() => ({})) as { card_id?: string };
  const cardIdAlvo = body.card_id ?? null;

  // CNPJs Würth vêm da config (nunca hardcode)
  const { data: cfgs } = await supabase
    .from("cliente_config").select("cnpj_pagador").eq("intranet_wurth", true).eq("ativo", true);
  const cnpjs = ((cfgs ?? []) as Array<{ cnpj_pagador: string }>).map((c) => c.cnpj_pagador);
  if (cnpjs.length === 0) return json({ ok: true, skipped: "sem_cliente_intranet_wurth" });

  // Cards-alvo: ativos da carteira Würth (ou só o do botão)
  let q = supabase
    .from("cards")
    .select("id, nf, ctrc, state, cliente_respondeu_em, agent_state")
    .in("state", ESTADOS_ACIONAVEIS);
  if (cardIdAlvo) q = q.eq("id", cardIdAlvo);
  const { data: cardsRaw, error: errCards } = await q;
  if (errCards) return json({ ok: false, error: `cards: ${errCards.message}` }, 500);

  const cards: CardAlvo[] = [];
  for (const c of (cardsRaw ?? []) as Array<CardAlvo & { agent_state: Record<string, unknown> | null }>) {
    const pag = String(c.agent_state?.["cnpj_pagador"] ?? "").replace(/\D/g, "");
    if (cnpjs.includes(pag)) cards.push(c);
  }
  if (cards.length === 0) {
    return json({
      ok: true,
      casos: 0,
      motivo: cardIdAlvo ? "card não é Würth ou não está acionável" : "sem cards Würth ativos",
    });
  }
  const porNf = new Map<string, CardAlvo>();
  for (const c of cards) {
    const nfn = normalizarNfWurth(c.nf);
    if (nfn) porNf.set(nfn, c);
  }

  // Logins a consultar: botão com prefixo conhecido → só o dele; senão os dois.
  let logins: LoginWurth[] = ["ampla", "sal"];
  if (cardIdAlvo) {
    const l = loginPorPrefixoCtrc(cards[0]?.ctrc);
    if (l) logins = [l];
  }

  const resultados: Array<Record<string, unknown>> = [];
  const erros: Array<Record<string, unknown>> = [];

  for (const login of logins) {
    const creds = readWurthEnv(env, login);
    if (!creds) {
      erros.push({ login, erro: "credenciais ausentes (secrets WURTH_INTRANET_*)" });
      continue;
    }
    let linhas: LinhaRetornoWurth[];
    try {
      const sessao = await loginWurth(creds, login);
      const r = await consultarPendencias(sessao);
      if (!r.ok) {
        erros.push({ login, passo: r.passo, erro: r.detalhe });
        continue;
      }
      linhas = r.linhas;
    } catch (err) {
      erros.push({ login, passo: "login", erro: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const linha of linhas) {
      const card = porNf.get(normalizarNfWurth(linha.nf));
      if (!card) continue;

      // Dedupe: INSERT com ON CONFLICT — linha já vista não sugere de novo.
      const chave = chaveDedupe(linha);
      const { data: ins, error: errDedupe } = await supabase
        .from("wurth_retornos_processados")
        .upsert(
          { ...chave, observacao: linha.obs, card_id: card.id, login_usado: login },
          { onConflict: "nf,data_solucao,solucao", ignoreDuplicates: true },
        )
        .select("id")
        .maybeSingle();
      if (errDedupe) {
        erros.push({ nf: linha.nf, erro: `dedupe: ${errDedupe.message}` });
        continue;
      }
      if (!ins) continue; // já processada em rodada anterior

      const efeito = mapearEfeito(linha);
      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "RetornoIntranetWurth",
        actor_type: "system",
        actor_id: "robo-intranet-wurth",
        payload: {
          login,
          via: cardIdAlvo ? "botao_buscar_intranet" : "cron",
          linha: {
            nf: linha.nf,
            solucao: linha.solucao,
            data_solucao: linha.dataSolucao,
            obs: linha.obs,
            emp: linha.emp,
          },
          efeito: efeito.tipo,
        },
      });

      if (efeito.tipo === "ignorar") {
        resultados.push({ nf: linha.nf, efeito: "ignorado", motivo: efeito.motivo });
        continue;
      }
      if (efeito.tipo === "aguardar_cce") {
        resultados.push({ nf: linha.nf, efeito: "aguardar_cce" });
        continue;
      }

      const codigo = efeito.tipo === "sugerir_21" ? 21 : 44;
      const acaoKey = `lancar_ocorrencia:${codigo}`;

      // Idempotência de proposta: não duplica se já existe pendente igual.
      const { data: existentes } = await supabase
        .from("todos").select("id, status, proposta_payload").eq("card_id", card.id);
      const jaTem = ((existentes ?? []) as Array<{ status: string; proposta_payload: { acao_key?: string } | null }>)
        .some((t) => ["pendente", "aguardando_aprovacao"].includes(t.status) && t.proposta_payload?.acao_key === acaoKey);

      if (!jaTem) {
        const instrucao = efeito.tipo === "sugerir_21" ? efeito.instrucao : null;
        await supabase.from("todos").insert({
          card_id: card.id,
          action_id: crypto.randomUUID(),
          descricao: codigo === 21
            ? "Lançar oc 21 no SSW — reentrega autorizada pelo cliente (intranet Würth)"
            : "Lançar oc 44 no SSW — devolução autorizada pelo cliente (intranet Würth)",
          status: "pendente",
          proposta_payload: {
            tool: "lancar_ocorrencia",
            acao_key: acaoKey,
            recomendada: true,
            args: {
              codigo_ssw: codigo,
              nf: card.nf,
              descricao: codigo === 21
                ? `Cliente autorizou reentrega via intranet Würth${instrucao ? ` — instrução: ${instrucao}` : ""}`
                : "Cliente autorizou devolução via intranet Würth — modal pede volumes/base/motivo (padrão)",
            },
            rationale:
              `Retorno na intranet Würth em ${linha.dataSolucao}: Solução "${linha.solucao}"` +
              (linha.obs ? ` · Obs: "${linha.obs}"` : ""),
            texto: instrucao,
            meta: {
              origem: "robo-intranet-wurth",
              texto_ssw_sugerido: instrucao,
              tinha_intencao_email: false,
              modo: "sem_email",
            },
          },
        });
      }

      // Acorda o card: retorno da intranet = "cliente respondeu" (fora do e-mail).
      const upd: Record<string, unknown> = {
        cliente_respondeu_em: new Date().toISOString(),
        ia_sugestao_oc_resposta: {
          oc_sugerida: codigo,
          confianca: 0.95,
          contexto: "intranet_wurth",
          motivo: `Intranet Würth (${linha.dataSolucao}): ${linha.solucao}${linha.obs ? ` — ${linha.obs}` : ""}`,
          titulo: codigo === 21
            ? "Würth autorizou a reentrega — lançar oc 21 com a instrução"
            : "Würth autorizou a devolução — lançar oc 44",
          sugerido_em: new Date().toISOString(),
          acao_tool: "lancar_ocorrencia",
          acao_codigo_ssw: codigo,
        },
      };
      if (card.state !== "AGUARDANDO_VALIDACAO_HUMANA") {
        upd.state = "AGUARDANDO_VALIDACAO_HUMANA";
        upd.lock_aguardando_validacao = true;
      }
      await supabase.from("cards").update(upd).eq("id", card.id);

      resultados.push({ nf: linha.nf, efeito: efeito.tipo, proposta_criada: !jaTem });
    }
  }

  return json({
    ok: true,
    alvo: cardIdAlvo ?? "varredura",
    cards_wurth_ativos: cards.length,
    retornos_aplicados: resultados,
    erros,
    duration_ms: Date.now() - t0,
  });
});
