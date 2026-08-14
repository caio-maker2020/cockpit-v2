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
  enxertarInstrucaoReentrega,
  loginPorPrefixoCtrc,
  mapearEfeito,
  normalizarNfWurth,
  type LinhaRetornoWurth,
  type LoginWurth,
} from "../_shared/wurth-intranet.ts";
import {
  avaliarCicloRetornoWurth,
  resolverGatilhoCiclo,
  type GatilhoCiclo,
  type OcorrenciaSswHistorico,
} from "../_shared/wurth-ciclo.ts";
import {
  avaliarSilencioParaDevolucao,
  DIAS_SILENCIO_PARA_DEVOLUCAO,
} from "../_shared/wurth-devolucao-silencio.ts";
import { comprimirInstrucaoWurth } from "../_shared/instrucao-ssw-wurth.ts";
import { criarPropostaCceSeAplicavel } from "../_shared/cce-wurth.ts";
import { invokeNext } from "../_shared/invoke-next.ts";
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
  // Guard de ciclo (Caio 2026-08-14, NF 677750): âncora temporal da tratativa.
  historico_ssw: OcorrenciaSswHistorico[] | null;
  bastao_oc_no_lancamento: number | null;
  cod_ultima_ocorrencia: number | null;
  bastao_data_ultima_ocorrencia: string | null;
};

/**
 * Âncora temporal do ciclo (Caio 2026-08-14, NF 677750). A hora só existe no
 * histórico SSW — o Bastão dá `data_ultima_ocorrencia` SEM hora, e no caso real
 * a resposta antiga (12/08 08:39) e a recusa nova (12/08 23:26) são no MESMO
 * dia. Por isso, quando o card ainda não tem histórico (46 dos 61 cards Würth
 * ativos em 14/08), puxa 1x por rodada antes de decidir. Falha na puxada =
 * fail-open (guard não aplicado, registrado no evento) — nunca cega o robô.
 */
async function resolverGatilhoComHistorico(
  env: Record<string, string>,
  card: CardAlvo,
  jaPuxou: Set<string>,
): Promise<GatilhoCiclo> {
  const resolver = () =>
    resolverGatilhoCiclo({
      historicoSsw: card.historico_ssw,
      bastaoOcNoLancamento: card.bastao_oc_no_lancamento,
      codUltimaOcorrencia: card.cod_ultima_ocorrencia,
      dataUltimaOcorrencia: card.bastao_data_ultima_ocorrencia,
    });

  const g = resolver();
  if (g.fonte === "historico_ssw" || jaPuxou.has(card.id)) return g;
  jaPuxou.add(card.id);
  try {
    const r = await fetch(`${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
        apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ card_id: card.id }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return g;
    const j = await r.json() as { ocorrencias?: OcorrenciaSswHistorico[] };
    if ((j.ocorrencias ?? []).length === 0) return g;
    card.historico_ssw = j.ocorrencias!;
    return resolver();
  } catch (_e) {
    return g; // fail-open
  }
}

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
    // literal única: o supabase-js infere os tipos do texto do select (string
    // concatenada quebra a inferência e o cast abaixo vira erro TS2352).
    .select("id, nf, ctrc, state, cliente_respondeu_em, agent_state, historico_ssw, bastao_oc_no_lancamento, cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia")
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
  // Modo botão (Caio 2026-08-13): distinguir os desfechos pra a operadora.
  // `encontrouLinha` = havia linha da NF na intranet; `jaProcessado` = havia,
  // mas a dedupe já tinha registrado (sem sugestão nova).
  let encontrouLinha = false;
  let jaProcessado = false;
  // Guard de ciclo: linhas da NF que são resposta de um ciclo ANTERIOR.
  const descartados: Array<Record<string, unknown>> = [];
  const historicoPuxado = new Set<string>();
  // R1 devolução por silêncio (Caio 2026-08-14): materiais coletados na
  // varredura — TODAS as linhas por NF (não só as com card), o HTML cru de
  // cada consulta (evidência) e quais logins consultaram OK (fail-closed:
  // sem consulta OK do login do card, não dá pra afirmar silêncio).
  const linhasPorNf = new Map<string, LinhaRetornoWurth[]>();
  const htmlPorLogin = new Map<LoginWurth, string>();
  const loginsOk = new Set<LoginWurth>();
  let linhasTotalConsulta = 0;

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
      // R1: guarda os materiais da evidência de silêncio.
      loginsOk.add(login);
      htmlPorLogin.set(login, r.html);
      linhasTotalConsulta += r.linhas.length;
      for (const l of r.linhas) {
        const k = normalizarNfWurth(l.nf);
        if (!k) continue;
        const arr = linhasPorNf.get(k) ?? [];
        arr.push(l);
        linhasPorNf.set(k, arr);
      }
    } catch (err) {
      erros.push({ login, passo: "login", erro: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const linha of linhas) {
      const card = porNf.get(normalizarNfWurth(linha.nf));
      if (!card) continue;
      encontrouLinha = true; // há retorno pra este card na intranet

      // ── Guard de CICLO (Caio 2026-08-14, raiz da NF 677750) ────────────────
      // A intranet responde por NF, não por ciclo: a mesma NF acumula recusa →
      // reentrega → nova recusa, e a consulta devolve a linha antiga do mesmo
      // jeito. Se a `Data Solução` da Würth for ANTERIOR à ocorrência SAL que
      // gerou esta tratativa, o retorno é de outro ciclo — descarta antes de
      // qualquer efeito (21/44/CCE). Âncora é a ocorrência-gatilho e NÃO a 54:
      // a Würth recebe a ocorrência por EDI quase na hora do lançamento; a 54 é
      // formalização posterior e ancorar nela mataria retorno legítimo.
      const gatilho = await resolverGatilhoComHistorico(env, card, historicoPuxado);
      const ciclo = avaliarCicloRetornoWurth(linha.dataSolucao, gatilho);
      if (ciclo.descartar) {
        descartados.push({ nf: linha.nf, data_solucao: linha.dataSolucao, motivo: ciclo.motivo });
        // NÃO grava na dedupe: o descarte é decisão contextual e reversível (se
        // o guard errar, basta corrigir o código — a próxima rodada reavalia).
        // Pra não poluir a timeline 2x/dia, o evento sai só na 1ª vez.
        const { data: jaLogado } = await supabase
          .from("card_events")
          .select("id")
          .eq("card_id", card.id)
          .eq("event_type", "RetornoIntranetWurthDescartado")
          .eq("payload->linha->>data_solucao", linha.dataSolucao)
          .limit(1)
          .maybeSingle();
        if (!jaLogado) {
          await supabase.from("card_events").insert({
            card_id: card.id,
            event_type: "RetornoIntranetWurthDescartado",
            actor_type: "system",
            actor_id: "robo-intranet-wurth",
            payload: {
              login,
              via: cardIdAlvo ? "botao_buscar_intranet" : "cron",
              linha: {
                nf: linha.nf,
                solucao: linha.solucao,
                data_solucao: linha.dataSolucao,
                data_inclusao: linha.data,
                obs: linha.obs,
                emp: linha.emp,
              },
              guard_ciclo: { ...ciclo, gatilho },
            },
          });
        }
        continue;
      }

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
      if (!ins) {
        jaProcessado = true; // linha existe, mas já registrada antes
        continue; // já processada em rodada anterior
      }

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
            data_inclusao: linha.data,
            obs: linha.obs,
            emp: linha.emp,
          },
          efeito: efeito.tipo,
          // Por que este retorno foi aceito como do ciclo corrente (auditoria).
          guard_ciclo: { ...ciclo, gatilho },
        },
      });

      if (efeito.tipo === "ignorar") {
        resultados.push({ nf: linha.nf, efeito: "ignorado", motivo: efeito.motivo });
        continue;
      }
      if (efeito.tipo === "aguardar_cce") {
        // CCE indicada na intranet (Caio 2026-08-12): o robô SUGERE a oc 21 com
        // aviso de trocar o endereço E dispara a busca ATIVA da carta no Gmail
        // da Ingrid pra anexar no card + dar as 2 mensagens. Card acorda.
        await criarPropostaCceSeAplicavel(supabase, {
          cardId: card.id,
          messageId: null,
          subject: `Intranet Würth: CCE — NF ${linha.nf}`,
          corpo: `CCE ENVIADA (intranet). Obs: ${linha.obs}`,
        });
        // acorda o card pra CLIENTE RESPONDEU (a operadora precisa agir)
        const updCce: Record<string, unknown> = { cliente_respondeu_em: new Date().toISOString() };
        if (card.state !== "AGUARDANDO_VALIDACAO_HUMANA") {
          updCce.state = "AGUARDANDO_VALIDACAO_HUMANA";
          updCce.lock_aguardando_validacao = true;
        }
        await supabase.from("cards").update(updCce).eq("id", card.id);
        // busca ativa da carta no Gmail (fire-and-forget)
        invokeNext({
          functionName: "buscar-cce-gmail",
          supabaseUrl: Deno.env.get("SUPABASE_URL")!,
          serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          body: { card_id: card.id, nf: linha.nf },
        });
        resultados.push({ nf: linha.nf, efeito: "aguardar_cce", busca_cce_disparada: true });
        continue;
      }

      const codigo = efeito.tipo === "sugerir_21" ? 21 : 44;
      const acaoKey = `lancar_ocorrencia:${codigo}`;
      const instrucao = efeito.tipo === "sugerir_21" ? efeito.instrucao : null;
      // Texto que de fato vai pro SSW (≤70, sem cortesia/boilerplate).
      const textoSswReentrega = instrucao ? comprimirInstrucaoWurth(instrucao) : null;

      // Idempotência de proposta: não duplica se já existe pendente igual.
      type TodoRow = { id: string; status: string; proposta_payload: Record<string, unknown> | null };
      const { data: existentes } = await supabase
        .from("todos").select("id, status, proposta_payload").eq("card_id", card.id);
      const pendentesMesmaOc = ((existentes ?? []) as TodoRow[]).filter(
        (t) =>
          ["pendente", "aguardando_aprovacao"].includes(t.status) &&
          (t.proposta_payload as { acao_key?: string } | null)?.acao_key === acaoKey,
      );
      const jaTem = pendentesMesmaOc.length > 0;

      // Enxerto da instrução (Caio 2026-08-12): quando a oc 21 JÁ está no menu, o
      // robô grava a Obs da intranet em args.descricao da proposta que a operadora
      // vai aprovar — senão a instrução nunca chegava ao SSW (ver
      // enxertarInstrucaoReentrega). Só oc 21; a 44 coleta volumes/motivo no modal.
      let propostaMergeada = false;
      if (!jaTem) {
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
              // `descricao` VIRA a Instrução do SSW e é cortada em 70 chars —
              // nada de boilerplate aqui (Caio 2026-08-13, NF 669899). Só a oc
              // 21 leva texto; a 44 monta a descrição com os extras do modal.
              descricao: codigo === 21
                ? (textoSswReentrega ||
                  "Cliente autorizou reentrega via intranet Würth")
                : "Cliente autorizou devolução via intranet Würth — modal pede volumes/base/motivo (padrão)",
            },
            rationale:
              `Retorno na intranet Würth em ${linha.dataSolucao}: Solução "${linha.solucao}"` +
              (linha.obs ? ` · Obs: "${linha.obs}"` : ""),
            texto: textoSswReentrega,
            meta: {
              origem: "robo-intranet-wurth",
              texto_ssw_sugerido: textoSswReentrega,
              obs_intranet_original: instrucao,
              tinha_intencao_email: false,
              modo: "sem_email",
            },
          },
        });
      } else if (efeito.tipo === "sugerir_21" && instrucao) {
        for (const t of pendentesMesmaOc) {
          const novoPayload = enxertarInstrucaoReentrega(t.proposta_payload, instrucao, linha);
          await supabase.from("todos").update({ proposta_payload: novoPayload }).eq("id", t.id);
          propostaMergeada = true;
        }
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

      resultados.push({
        nf: linha.nf,
        efeito: efeito.tipo,
        proposta_criada: !jaTem,
        instrucao_enxertada: propostaMergeada,
      });
    }
  }

  // ── R1: DEVOLUÇÃO POR SILÊNCIO (Caio 2026-08-14) ──────────────────────────
  // oc 11 + 54 lançada + 10 dias corridos sem NENHUM retorno (e-mail e
  // intranet) → sugere oc 44 RECOMENDADA com EVIDÊNCIA do silêncio. NUNCA
  // lança sozinho — a Ingrid aprova. Só na varredura do cron (o botão do card
  // consulta 1 login e serve pra retorno, não pra afirmar silêncio).
  //
  // Flag `wurth_devolucao_sugestao_enabled` OFF = dry-run: grava evidência
  // (modo dry_run) + card_event, SEM criar todo nem mover card — pro Caio
  // revisar a lista antes de ligar. Ligar a flag "promove" a evidência
  // dry_run existente pra ativo e aí sim sugere.
  const silencio = { avaliados: 0, sugeridos: 0, dry_run: 0, ja_sugeridos: 0, sem_cobertura: 0 };
  if (!cardIdAlvo) {
    const { data: flagR1 } = await supabase
      .from("feature_flags").select("enabled").eq("key", "wurth_devolucao_sugestao_enabled").maybeSingle();
    const r1Ativa = (flagR1 as { enabled?: boolean } | null)?.enabled === true;

    for (const card of cards) {
      if (card.state !== "AGUARDANDO_CLIENTE") continue;
      const nfn = normalizarNfWurth(card.nf);
      if (!nfn) continue;

      // Fail-closed de cobertura: precisa da consulta OK do login do card
      // (prefixo desconhecido → exige os DOIS logins). Evidência de silêncio
      // sem ter consultado o login certo seria prova falsa.
      const loginDoCard = loginPorPrefixoCtrc(card.ctrc);
      const cobertura = loginDoCard ? loginsOk.has(loginDoCard) : (loginsOk.has("sal") && loginsOk.has("ampla"));
      if (!cobertura) {
        silencio.sem_cobertura++;
        continue;
      }

      silencio.avaliados++;
      // garante o histórico SSW (a HORA só existe nele) — mesmo helper do guard
      await resolverGatilhoComHistorico(env, card, historicoPuxado);
      const veredicto = avaliarSilencioParaDevolucao(
        {
          historicoSsw: card.historico_ssw,
          bastaoOcNoLancamento: card.bastao_oc_no_lancamento,
          codUltimaOcorrencia: card.cod_ultima_ocorrencia,
          dataUltimaOcorrencia: card.bastao_data_ultima_ocorrencia,
          clienteRespondeuEm: card.cliente_respondeu_em,
        },
        linhasPorNf.get(nfn) ?? [],
        Date.now(),
      );
      if (!veredicto.sugerir) continue;

      const gatilhoIso = new Date(veredicto.gatilho.ts!).toISOString();
      const modo = r1Ativa ? "ativo" : "dry_run";

      // Idempotência POR CICLO: UNIQUE(card_id, gatilho_ts). Já existe →
      // ativo = já sugerido (operadora decidiu; não re-sugere); dry_run +
      // flag agora ON = promove e segue pro todo/move.
      const { data: evidNova } = await supabase
        .from("wurth_evidencias_intranet")
        .upsert(
          {
            card_id: card.id,
            nf: nfn,
            logins_usados: [...loginsOk],
            gatilho_oc: veredicto.gatilho.codigo,
            gatilho_ts: gatilhoIso,
            data_54_ts: new Date(veredicto.data54Ts).toISOString(),
            linhas_total: linhasTotalConsulta,
            linhas_da_nf: veredicto.linhasCicloAnterior,
            veredicto: "sem_retorno",
            modo,
          },
          { onConflict: "card_id,gatilho_ts", ignoreDuplicates: true },
        )
        .select("id")
        .maybeSingle();

      let evidenciaId = (evidNova as { id?: string } | null)?.id ?? null;
      if (!evidenciaId) {
        const { data: evidExistente } = await supabase
          .from("wurth_evidencias_intranet")
          .select("id, modo")
          .eq("card_id", card.id)
          .eq("gatilho_ts", gatilhoIso)
          .maybeSingle();
        const ex = evidExistente as { id: string; modo: string } | null;
        if (!ex) continue;
        if (ex.modo === "ativo" || !r1Ativa) {
          silencio.ja_sugeridos++;
          continue; // ciclo já tratado (ou segue em dry-run) — não repete
        }
        // dry_run → flag ligou: promove e sugere de fato
        await supabase.from("wurth_evidencias_intranet").update({ modo: "ativo" }).eq("id", ex.id);
        evidenciaId = ex.id;
      } else {
        // evidência nova: sobe o snapshot HTML (prova visual íntegra)
        const partes: string[] = [];
        for (const [lg, html] of htmlPorLogin) {
          partes.push(`<!-- consulta login=${lg} em ${new Date().toISOString()} — NF ${nfn}: sem retorno posterior a ${gatilhoIso} -->\n${html}`);
        }
        const path = `${card.id}/${veredicto.gatilho.ts}.html`;
        const up = await supabase.storage
          .from("wurth_evidencias")
          .upload(path, new Blob([partes.join("\n\n")], { type: "text/html" }), { upsert: true });
        if (!up.error) {
          await supabase.from("wurth_evidencias_intranet").update({ html_path: path }).eq("id", evidenciaId);
        }
      }

      let todoId: string | null = null;
      if (r1Ativa) {
        // texto do SSW: o útil primeiro, ≤70 (INV-076 — nada de boilerplate)
        const d54 = new Date(veredicto.data54Ts - 3 * 60 * 60 * 1000);
        const p2 = (n: number) => String(n).padStart(2, "0");
        const textoSsw = `SEM RETORNO WURTH ${DIAS_SILENCIO_PARA_DEVOLUCAO}D POS 54 DE ${p2(d54.getUTCDate())}/${p2(d54.getUTCMonth() + 1)} - DEVOLUCAO AUTORIZADA`;

        // todo 44: patcha pendente existente ou cria — nunca duplica
        type TodoRow44 = { id: string; status: string; proposta_payload: Record<string, unknown> | null };
        const { data: existentes44 } = await supabase
          .from("todos").select("id, status, proposta_payload").eq("card_id", card.id);
        const pendente44 = ((existentes44 ?? []) as TodoRow44[]).find(
          (t) =>
            ["pendente", "aguardando_aprovacao"].includes(t.status) &&
            (t.proposta_payload as { acao_key?: string } | null)?.acao_key === "lancar_ocorrencia:44",
        );
        const rationaleR1 = `⏱️ ${veredicto.motivo}. Evidência da intranet anexada — clique em VER EVIDÊNCIA.`;
        if (pendente44) {
          const pp = (pendente44.proposta_payload ?? {}) as Record<string, unknown>;
          const argsAnt = (pp["args"] as Record<string, unknown> | undefined) ?? {};
          const metaAnt = (pp["meta"] as Record<string, unknown> | undefined) ?? {};
          await supabase.from("todos").update({
            proposta_payload: {
              ...pp,
              recomendada: true,
              rationale: rationaleR1,
              args: { ...argsAnt, descricao: textoSsw },
              meta: { ...metaAnt, origem: "robo-intranet-wurth", regra: "devolucao_sem_retorno_10d", evidencia_id: evidenciaId },
            },
          }).eq("id", pendente44.id);
          todoId = pendente44.id;
        } else {
          const { data: novoTodo } = await supabase.from("todos").insert({
            card_id: card.id,
            action_id: crypto.randomUUID(),
            descricao: `Lançar oc 44 no SSW — ${DIAS_SILENCIO_PARA_DEVOLUCAO} dias sem retorno da Würth (devolução autorizada por processo)`,
            status: "pendente",
            proposta_payload: {
              tool: "lancar_ocorrencia",
              acao_key: "lancar_ocorrencia:44",
              recomendada: true,
              args: { codigo_ssw: 44, nf: card.nf, descricao: textoSsw },
              rationale: rationaleR1,
              meta: {
                origem: "robo-intranet-wurth",
                regra: "devolucao_sem_retorno_10d",
                evidencia_id: evidenciaId,
                tinha_intencao_email: false,
                modo: "sem_email",
              },
            },
          }).select("id").maybeSingle();
          todoId = (novoTodo as { id?: string } | null)?.id ?? null;
        }

        // acorda o card SEM fingir resposta: NÃO seta cliente_respondeu_em
        // (não houve retorno — o silêncio É o gatilho).
        const updR1: Record<string, unknown> = {
          ia_sugestao_oc_resposta: {
            oc_sugerida: 44,
            confianca: 0.95,
            contexto: "wurth_devolucao_silencio",
            motivo: veredicto.motivo,
            titulo: `Würth sem retorno há ${veredicto.diasSemRetorno} dias — devolução autorizada (lançar oc 44)`,
            sugerido_em: new Date().toISOString(),
            acao_tool: "lancar_ocorrencia",
            acao_codigo_ssw: 44,
            evidencia_id: evidenciaId,
          },
        };
        // fase filtra state === AGUARDANDO_CLIENTE — o move é incondicional
        updR1.state = "AGUARDANDO_VALIDACAO_HUMANA";
        updR1.lock_aguardando_validacao = true;
        await supabase.from("cards").update(updR1).eq("id", card.id);
        silencio.sugeridos++;
      } else {
        silencio.dry_run++;
      }

      await supabase.from("card_events").insert({
        card_id: card.id,
        event_type: "WurthDevolucaoSemRetornoSugerida",
        actor_type: "system",
        actor_id: "robo-intranet-wurth",
        payload: {
          modo,
          evidencia_id: evidenciaId,
          todo_id: todoId,
          motivo: veredicto.motivo,
          dias_sem_retorno: veredicto.diasSemRetorno,
          gatilho: { oc: veredicto.gatilho.codigo, ts: gatilhoIso },
          data_54_ts: new Date(veredicto.data54Ts).toISOString(),
          linhas_ciclo_anterior: veredicto.linhasCicloAnterior.length,
        },
      });
    }
  }

  // Telemetria da VARREDURA (Caio 2026-08-12): só o cron alimenta o indicador de
  // "última rodada" no card; buscas via botão dão feedback na hora (toast), não
  // contam como rodada. Best-effort — falha no log NUNCA quebra a varredura.
  if (!cardIdAlvo) {
    try {
      await supabase.from("wurth_robo_execucoes").insert({
        started_at: new Date(t0).toISOString(),
        finished_at: new Date().toISOString(),
        origem: "cron",
        cards_wurth_ativos: cards.length,
        retornos_aplicados: resultados.length,
        erros: erros.length,
        duration_ms: Date.now() - t0,
      });
    } catch (_e) { /* telemetria best-effort */ }
  }

  return json({
    ok: true,
    alvo: cardIdAlvo ?? "varredura",
    cards_wurth_ativos: cards.length,
    retornos_aplicados: resultados,
    retornos_descartados_ciclo_anterior: descartados,
    devolucao_por_silencio: cardIdAlvo ? undefined : silencio,
    erros,
    duration_ms: Date.now() - t0,
    // Modo botão: desfecho pra a operadora (Parte B). 5 casos no front:
    // aplicados>0 → sugestão criada; descartados>0 → retorno é de ciclo antigo;
    // encontrou&&ja_processado → já registrado; erros>0 → falha na consulta
    // (detalha); senão → sem retorno pra esta NF.
    resumo: cardIdAlvo
      ? {
        encontrou: encontrouLinha,
        aplicados: resultados.length,
        ja_processado: jaProcessado,
        descartados_ciclo_anterior: descartados.length,
        descarte_motivo: (descartados[0]?.["motivo"] as string | undefined) ?? null,
      }
      : undefined,
  });
});
