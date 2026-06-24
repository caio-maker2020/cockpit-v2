// =============================================================================
// agente-sugere-ocs-padrao — orquestrador IA pra cards oc=10/11/19/35
// (TODOS os clientes/operadores). Cron 5min. Caio 2026-05-23.
//
// SEM ação autônoma. Apenas analisa evidência + sugere próximo passo
// (oc=54+template_email OU oc=56) pro operador aprovar manualmente.
//
// Regras por oc:
//   10 (RECUSA TOTAL):    precisa ressalva escrita motivo → 54 + RECUSA_TOTAL
//                         senão → 56
//   11 (PROBLEMAS ENDEREÇO): GPS na instrução: <=4km → 54 + PROBLEMAS_COM_ENDERECO
//                         >4km ou sem GPS → 56 (com alerta no banner)
//   19 (FALTA VOLUMES):   precisa ressalva escrita volumes → 54 + FALTA_DE_VOLUME
//                         senão → 56
//   35 (RECUSA PARCIAL):  ressalva manuscrita válida → 54 + ENTREGA_PARCIAL_APOS_FALTA_VOLUME
//                         (email pergunta se o cliente autoriza a devolução do volume recusado)
//                         sem ressalva → 56
//                         NÃO consulta CT-e de devolução: a reversa só nasce DEPOIS do cliente
//                         autorizar + oc=44 — ausência aqui é o estado normal (Caio 2026-06-20).
//
// INV-001: usa SSW interno via interpretador-evidencia-foto + puxar-historico.
// Nunca tracking público.
// INV-009: verify_jwt=false.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sanitizarTextoSsw, extrairGpsMetrosDaInstrucao, ehMotivoSswGenerico, removerMarcadoresSswmobile } from "../_shared/sanitizar-texto-ssw.ts";
import { categorizarErroSsw, ehCategoriaTransiente, resetarFalhasTransientesSeHorarioOk } from "../_shared/categorizar-erro-ssw.ts";
import { isHorarioComercialBRT } from "../_shared/horario-comercial.ts";
import { startAgentRun, finishAgentRun, classifyStatus } from "../_shared/agent-runs-logger.ts";
import { proporAutoAcaoSeAplicavel } from "../_shared/regras-auto-acao.ts";
import { recusaOriginadaDeExtravioNaoNotificada } from "../_shared/recusa-por-extravio.ts";

const BATCH_LIMIT = 20;
const MAX_TENTATIVAS = 3;
const RETRY_INTERVAL_MIN = 10;
// Janela ampla pra cobrir backlog — MAX_TENTATIVAS controla custo
const CRIADO_HA_NO_MAX_HORAS = 24 * 30;
const OC11_GPS_THRESHOLD_METROS_DEFAULT = 4000;

// MOTIVOS_GENERICOS movido pra _shared/sanitizar-texto-ssw.ts (helper
// ehMotivoSswGenerico — agora detecta SSWMOBILE/SEFAZ/GPS).

interface OcorrenciaHistorico {
  codigo: number | null;
  descricao: string | null;
  instrucao: string | null;
  data: string | null;
  filial: string | null;
  usuario: string | null;
  tem_foto: boolean;
}

interface DecisaoSugestao {
  // null = "sem sugestão" (agente não destaca, operador escolhe manual)
  proposta_destacada: 54 | 56 | null;
  template_email_sugerido: string | null;
  corpo_email_sugerido: string | null;
  motivo_extraido: string | null;
  foto_classificacao: string | null;
  tem_ressalva: boolean;
  ressalva_texto: string | null;
  ressalva_tipo: string | null;
  gps_distancia_metros: number | null;          // só oc=11
  gps_dentro_threshold: boolean | null;         // só oc=11
  // DEPRECADO (Caio 2026-06-20): oc=35 não consulta mais CT-e de devolução.
  // Mantidos só pra não quebrar o shape do JSONB consumido pelo front. Sempre null.
  tem_cte_devolucao: boolean | null;
  cte_devolucao_numero: string | null;
  // Caio 2026-05-27: IA Vision detecta indicação de "falta de itens em
  // caixa lacrada" na foto/ressalva (oc=35). Quando true, banner mostra
  // alerta pro operador rever — pode não ter devolução real, apenas
  // ressarcimento de itens faltantes dentro de embalagem íntegra.
  // Optional pra não quebrar returns das outras ocs.
  alerta_caixa_lacrada?: boolean | null;
  alerta_caixa_lacrada_motivo?: string | null;
  // URL pra ver a foto direto no banner (sem ir em HISTÓRICO SSW)
  evidencia_url?: string | null;
  // Caio 2026-05-29 (agente oc=49): campos específicos dos 3 casos predominantes.
  // Optional pra não quebrar returns das outras ocs.
  caso_oc49?:
    | "extravio_total"
    | "extravio_parcial"
    | "extravio_sem_qtd"
    | "cobranca_retorno"
    | "devolucao_pos_56"
    | "nao_reconhecido"
    | null;
  qtd_volumes_extraviados?: number | null;
  qtd_volumes_nf?: number | null;
  cobrada_no_wpp?: boolean | null;
  cobrada_em?: string | null;
  acao_lateral?: "cobrar_retorno_mesma_thread" | null;
  thread_id_alvo?: string | null;
  texto_prefixo_sugerido?: string | null;
  cod_ocorrencia_para_token?: number | null;
  // Caio 2026-06-24 (NF 148558): recusa/falta no destino (oc 10/19/35) CAUSADA
  // por extravio anterior (oc 6/9/16) que o cliente ainda NÃO foi notificado
  // (não há 20/54/49 lançada depois do extravio). Quando true, o front mostra
  // banner de CONFLITO DE CONTEXTO e o template sugerido já é o combinado
  // (devolver/seguir + romaneio + descrição + valor pra ressarcimento).
  contexto_recusa_por_extravio?: boolean | null;
  extravio_anterior_oc?: number | null;
  extravio_anterior_data?: string | null;
  confianca: number;
  observacao_orquestrador: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ ok: false, error: "POST/GET esperado" }, 405);
  }

  const env = Deno.env.toObject();
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const limiteCriacao = new Date(Date.now() - CRIADO_HA_NO_MAX_HORAS * 60 * 60 * 1000).toISOString();
  const limiteRetry = new Date(Date.now() - RETRY_INTERVAL_MIN * 60 * 1000).toISOString();
  const gpsThreshold = parseInt(env["OC11_GPS_THRESHOLD_METROS"] ?? "") || OC11_GPS_THRESHOLD_METROS_DEFAULT;

  // Caio 2026-05-23: body pode passar { card_id: "uuid" } pra forçar análise
  // de um card específico (bypass do filtro 6h + tentativas). Útil pra debug
  // e pra testar feature em cards antigos.
  let cardIdOverride: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.card_id === "string") cardIdOverride = body.card_id;
  } catch { /* sem body é ok pro cron */ }

  // Self-healing: cards travados em falhou por categoria transiente
  // (ssw_fora_horario_acesso, ssw_login_falhou, ssw_offline, ...) voltam
  // pra pendente assim que o cron rodar dentro do horário comercial BRT.
  // Caio 2026-05-24: cobre cards que falharam na madrugada/fim de semana.
  let resetados = 0;
  let invalidadosStale = 0;
  if (!cardIdOverride) {
    resetados = await resetarFalhasTransientesSeHorarioOk(supabase, isHorarioComercialBRT, {
      statusCol: "analise_padrao_status",
      tentativasCol: "analise_padrao_tentativas",
      resultadoCol: "analise_padrao_resultado",
      atualizadoEmCol: "analise_padrao_atualizado_em",
      avisoTipoAguardando: "ia_ocs_padrao_aguardando",
    });

    // Caio 2026-05-27 (NF 2308644): se a oc do card mudou DESDE a última
    // análise, invalida pra re-analisar com a oc nova. Cards evoluem
    // (10→54→21→19) e antes ficavam com análise stale apontando pra oc
    // antiga (template errado, motivo errado).
    //
    // Detecção:
    //   a) Resultado novo (com codigo_oc_card): comparação direta
    //   b) Resultado antigo (sem codigo_oc_card): heurística via template
    //      esperado pra oc atual
    const { data: staleIds } = await supabase
      .from("cards")
      .select("id, cod_ultima_ocorrencia, analise_padrao_resultado")
      .eq("analise_padrao_status", "concluida")
      .in("cod_ultima_ocorrencia", [10, 11, 19, 35, 49])
      .not("state", "in", "(RESOLVIDO,CANCELADO)");

    const TEMPLATE_ESPERADO_POR_OC: Record<number, string[]> = {
      10: ["RECUSA_TOTAL"],
      11: ["PROBLEMAS_COM_ENDERECO"],
      19: ["ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"],
      35: ["ENTREGA_PARCIAL_APOS_FALTA_VOLUME", "RECUSA_PARCIAL"], // RECUSA_PARCIAL legado
      49: ["FALTA_DE_VOLUME", "FALTA_DE_VOLUME_TOTAL"],
    };
    const idsStale = ((staleIds ?? []) as Array<{
      id: string;
      cod_ultima_ocorrencia: number;
      analise_padrao_resultado: { codigo_oc_card?: number; template_email_sugerido?: string | null } | null;
    }>)
      .filter((c) => {
        const oc = c.cod_ultima_ocorrencia;
        const res = c.analise_padrao_resultado;
        if (!res) return false;
        // (a) Comparação direta se assinatura existe
        if (typeof res.codigo_oc_card === "number") {
          return res.codigo_oc_card !== oc;
        }
        // (b) Heurística via template (resultados pré-2026-05-27)
        const templatesEsperados = TEMPLATE_ESPERADO_POR_OC[oc] ?? [];
        const templateAtual = res.template_email_sugerido ?? null;
        if (templatesEsperados.length === 0) return false;
        // null aceitável (oc=49 sem PRAZO EXPIRADO p.ex.)
        if (templateAtual === null) return false;
        return !templatesEsperados.includes(templateAtual);
      })
      .map((c) => c.id);

    if (idsStale.length > 0) {
      const { error: invErr } = await supabase
        .from("cards")
        .update({
          analise_padrao_status: "pendente",
          analise_padrao_tentativas: 0,
          analise_padrao_atualizado_em: new Date().toISOString(),
        })
        .in("id", idsStale);
      if (!invErr) invalidadosStale = idsStale.length;
    }
  }

  let candidatos: Record<string, unknown>[] | null = null;
  let selErr: { message: string } | null = null;

  if (cardIdOverride) {
    const res = await supabase
      .from("cards")
      .select("id, nf, ctrc, agent_state, responsavel_relacionamento, " +
              "assigned_operator_id, pagador, segmento_codigo, qtde_volumes, " +
              "analise_padrao_status, analise_padrao_tentativas, analise_padrao_atualizado_em, " +
              "historico_ssw, created_at, state, lock_aguardando_validacao, cod_ultima_ocorrencia")
      .eq("id", cardIdOverride)
      .in("cod_ultima_ocorrencia", [10, 11, 19, 35, 49]);
    candidatos = res.data;
    selErr = res.error;
  } else {
    const res = await supabase
      .from("cards")
      .select("id, nf, ctrc, agent_state, responsavel_relacionamento, " +
              "assigned_operator_id, pagador, segmento_codigo, qtde_volumes, " +
              "analise_padrao_status, analise_padrao_tentativas, analise_padrao_atualizado_em, " +
              "historico_ssw, created_at, state, lock_aguardando_validacao, cod_ultima_ocorrencia")
      .eq("state", "AGUARDANDO_VALIDACAO_HUMANA")
      .eq("lock_aguardando_validacao", true)
      .in("cod_ultima_ocorrencia", [10, 11, 19, 35, 49])
      .gt("created_at", limiteCriacao)
      .lt("analise_padrao_tentativas", MAX_TENTATIVAS)
      .or(`analise_padrao_status.is.null,analise_padrao_status.in.(pendente,falhou),and(analise_padrao_status.eq.analisando,analise_padrao_atualizado_em.lt.${limiteRetry})`)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);
    candidatos = res.data;
    selErr = res.error;
  }
  if (selErr) return json({ ok: false, error: `SELECT cards: ${selErr.message}` }, 500);

  const stats = { processados: 0, sugestoes_54: 0, sugestoes_56: 0, falhas: 0 };

  for (const card of candidatos ?? []) {
    stats.processados++;
    const cardId = card.id as string;
    const codigoOc = card.cod_ultima_ocorrencia as number;
    const novaTent = (card.analise_padrao_tentativas as number ?? 0) + 1;

    await supabase
      .from("cards")
      .update({
        analise_padrao_status: "analisando",
        analise_padrao_tentativas: novaTent,
        analise_padrao_atualizado_em: new Date().toISOString(),
      })
      .eq("id", cardId);

    const runHandle = startAgentRun({
      agentName: "agente-sugere-ocs-padrao",
      stepName: `oc=${codigoOc} tent=${novaTent}`,
      cardId,
      input: { codigo_oc: codigoOc, tentativa: novaTent, max_tentativas: MAX_TENTATIVAS },
    });

    try {
      // 1. Puxa histórico SSW
      const histRes = await fetch(`${env["SUPABASE_URL"]}/functions/v1/puxar-historico-ssw-card`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
          apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_id: cardId }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!histRes.ok) {
        const errBody = await histRes.text();
        const cat = categorizarErroSsw("puxar-historico", histRes.status, errBody);
        throw new ClassifiedError(cat.categoria, `puxar-historico ${histRes.status}: ${errBody.slice(0, 200)}`, cat.mensagem_operador);
      }
      const histJson = await histRes.json() as { ocorrencias?: OcorrenciaHistorico[] };
      const ocorrencias = histJson.ocorrencias ?? [];
      const linhasOc = ocorrencias.filter((o) => o.codigo === codigoOc);
      if (linhasOc.length === 0) {
        throw new ClassifiedError("historico_sem_oc", `histórico SSW não tem oc=${codigoOc}`);
      }
      const linhaOc = linhasOc[0]!; // mais recente primeiro

      // 2. Aplica regra por oc
      const decisao = await decidir(env, card, linhaOc, ocorrencias, gpsThreshold, codigoOc);

      // 3. Persiste resultado + banner
      // Caio 2026-05-27 (NF 2308644): salva codigo_oc_card NO RESULTADO (não
      // só no aviso). Assinatura usada pelo filtro do próximo cron pra
      // detectar análises stale quando card evolui de oc (ex: 10→54→21→19).
      const decisaoComAssinatura = { ...decisao, codigo_oc_card: codigoOc };
      await supabase
        .from("cards")
        .update({
          analise_padrao_status: "concluida",
          analise_padrao_resultado: decisaoComAssinatura,
          analise_padrao_atualizado_em: new Date().toISOString(),
          aviso_alteracao_oc: {
            tipo: "ia_sugestao_ocs_padrao",
            codigo_oc_card: codigoOc,
            proposta_destacada: decisao.proposta_destacada,
            template_email_sugerido: decisao.template_email_sugerido,
            motivo_extraido: decisao.motivo_extraido,
            // Caio 2026-05-27: transcrição literal da ressalva manuscrita
            // (lida pela IA Vision). Front renderiza em bloco destacado
            // pra operador não precisar abrir a foto.
            tem_ressalva: decisao.tem_ressalva,
            ressalva_texto: decisao.ressalva_texto,
            confianca: decisao.confianca,
            observacao_orquestrador: decisao.observacao_orquestrador,
            gps_distancia_metros: decisao.gps_distancia_metros,
            gps_dentro_threshold: decisao.gps_dentro_threshold,
            tem_cte_devolucao: decisao.tem_cte_devolucao,
            // Caio 2026-05-27 (oc=35): flag pro front mostrar chip amarelo
            // "⚠️ Evidência indica caixa lacrada" no banner.
            alerta_caixa_lacrada: decisao.alerta_caixa_lacrada ?? null,
            alerta_caixa_lacrada_motivo: decisao.alerta_caixa_lacrada_motivo ?? null,
            // Caio 2026-05-27: URL pra abrir a foto direto no banner
            // (sem ir em HISTÓRICO SSW). Edge `foto-oc-card` resolve no front.
            evidencia_foto_url: `${env["SUPABASE_URL"]}/functions/v1/foto-oc-card?card_id=${cardId}&codigo_oc=${codigoOc}`,
            // Caio 2026-05-29 (agente oc=49): campos específicos dos 3 casos.
            // null pras demais ocs — front renderiza condicional.
            caso_oc49: decisao.caso_oc49 ?? null,
            // Caio 2026-06-24 (NF 148558): banner de conflito de contexto —
            // recusa (10/19/35) originada de extravio anterior ainda não
            // notificado. Front mostra chip "⚠️ Recusa por extravio" + texto.
            contexto_recusa_por_extravio: decisao.contexto_recusa_por_extravio ?? null,
            extravio_anterior_oc: decisao.extravio_anterior_oc ?? null,
            extravio_anterior_data: decisao.extravio_anterior_data ?? null,
            qtd_volumes_extraviados: decisao.qtd_volumes_extraviados ?? null,
            qtd_volumes_nf: decisao.qtd_volumes_nf ?? null,
            cobrada_no_wpp: decisao.cobrada_no_wpp ?? null,
            cobrada_em: decisao.cobrada_em ?? null,
            acao_lateral: decisao.acao_lateral ?? null,
            thread_id_alvo: decisao.thread_id_alvo ?? null,
            texto_prefixo_sugerido: decisao.texto_prefixo_sugerido ?? null,
            cod_ocorrencia_para_token: decisao.cod_ocorrencia_para_token ?? null,
            atualizado_em: new Date().toISOString(),
          },
        })
        .eq("id", cardId);

      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AgenteOcsPadraoDecisao",
        actor_type: "agent",
        actor_id: "agente-sugere-ocs-padrao",
        payload: {
          codigo_oc_card: codigoOc,
          decisao,
        },
      });

      // Caio 2026-06-17: cria as OPÇÕES (propostas) NO MESMO run da sugestão, em
      // vez de esperar o sync-bastao (cron 30min, que defere a proposta atrás da
      // reconciliação SSW cara → opções demoravam até ~30min após a oc entrar).
      // Aqui a oc JÁ foi confirmada pelo puxar-historico-ssw-card acima, então
      // não há risco de propor na oc errada (proteção NF 761333 satisfeita).
      // proporAutoAcaoSeAplicavel é idempotente (só cria se não há pendente/
      // aprovado) → convive sem duplicar com a proposta deferida do sync-bastao.
      // Best-effort: falha aqui NÃO invalida a sugestão (banner) já persistida.
      try {
        await proporAutoAcaoSeAplicavel(supabase, {
          cardId,
          cardNf: card.nf as string,
          cardCtrc: (card.ctrc as string | null) ?? null,
          codUltimaOc: codigoOc,
          agentState: (card.agent_state ?? {}) as Record<string, unknown>,
          cardState: card.state as string,
          cardLock: card.lock_aguardando_validacao as boolean,
          // excecoesOc13 omitido: o agente trata só oc 10/11/19/35/49, nunca 13.
        });
      } catch (propErr) {
        console.warn(
          `[agente-ocs-padrao] proporAutoAcao best-effort falhou (card ${cardId}): ${
            propErr instanceof Error ? propErr.message : String(propErr)
          }`,
        );
      }

      if (decisao.proposta_destacada === 54) stats.sugestoes_54++;
      else if (decisao.proposta_destacada === 56) stats.sugestoes_56++;
      // Caio 2026-05-29 (agente oc=49): proposta_destacada pode ser null
      // (Casos 1c WPP, 2 cobrança, catch-all). Não conta como sugestão 54/56
      // mas processou OK — stats.processados já incrementado.

      await finishAgentRun(supabase, runHandle, {
        status: "success",
        output: {
          proposta_destacada: decisao.proposta_destacada ?? null,
          template_email_sugerido: decisao.template_email_sugerido ?? null,
          confianca: decisao.confianca ?? null,
          caso_oc49: decisao.caso_oc49 ?? null,
        },
      });
    } catch (err) {
      const categoria = err instanceof ClassifiedError ? err.categoria : "erro_desconhecido";
      const mensagemOperador = err instanceof ClassifiedError
        ? (err.mensagemOperador ?? "Falha inesperada na análise IA — tentando novamente.")
        : "Falha inesperada na análise IA — tentando novamente.";
      const msg = err instanceof Error ? err.message : String(err);
      stats.falhas++;

      // Erro TRANSIENTE (fora horário, login flake, SSW offline, timeout IA)
      // → não vira falha definitiva. Rollback do contador pra cron tentar de
      //   novo no próximo ciclo. Cooldown garantido por RETRY_INTERVAL_MIN no
      //   filtro do SELECT (analise_padrao_atualizado_em < limiteRetry).
      const transiente = ehCategoriaTransiente(categoria);
      const statusFinal = transiente ? "pendente" : "falhou";
      const tentativaFinal = transiente ? Math.max(0, novaTent - 1) : novaTent;

      await supabase
        .from("cards")
        .update({
          analise_padrao_status: statusFinal,
          analise_padrao_tentativas: tentativaFinal,
          analise_padrao_resultado: {
            erro_msg: msg.slice(0, 500),
            categoria,
            mensagem_operador: mensagemOperador,
            transiente,
            tentativa: novaTent,
            max_tentativas: MAX_TENTATIVAS,
          },
          aviso_alteracao_oc: {
            tipo: transiente ? "ia_ocs_padrao_aguardando" : "ia_ocs_padrao_falhou",
            categoria,
            mensagem_operador: mensagemOperador,
            erro_msg: msg.slice(0, 300),
            tentativa: novaTent,
            max_tentativas: MAX_TENTATIVAS,
            atualizado_em: new Date().toISOString(),
          },
          analise_padrao_atualizado_em: new Date().toISOString(),
        })
        .eq("id", cardId);

      await supabase.from("card_events").insert({
        card_id: cardId,
        event_type: "AgenteOcsPadraoFalhou",
        actor_type: "agent",
        actor_id: "agente-sugere-ocs-padrao",
        payload: { categoria, erro: msg.slice(0, 500), tentativa: novaTent, codigo_oc: codigoOc },
      });

      await finishAgentRun(supabase, runHandle, {
        status: classifyStatus(err),
        errorMessage: `[${categoria}] ${msg.slice(0, 500)}`,
        output: { categoria, transiente, tentativa: novaTent, max_tentativas: MAX_TENTATIVAS },
      });
    }
  }

  return json({ ok: true, ...stats, candidatos: candidatos?.length ?? 0, resetados_horario_comercial: resetados, invalidados_stale: invalidadosStale }, 200);
});

// ---------------------------------------------------------------------------
// decidir — aplica árvore de decisão por código de oc
// ---------------------------------------------------------------------------

async function decidir(
  env: Record<string, string>,
  card: Record<string, unknown>,
  linhaOc: OcorrenciaHistorico,
  todasOcorrencias: OcorrenciaHistorico[],
  gpsThreshold: number,
  codigoOc: number,
): Promise<DecisaoSugestao> {
  const cardId = card.id as string;
  const nf = card.nf as string;
  // Caio 2026-05-23 (NF 1494821): sanitiza HTML/comentários do portal SSW
  const instrucao = sanitizarTextoSsw(linhaOc.instrucao);
  const temFoto = linhaOc.tem_foto === true;

  // --- OC 49: árvore de 3 casos predominantes (Caio 2026-05-29) ---
  // Substitui o gate antigo "PRAZO EXPIRADO → FALTA_DE_VOLUME" por análise
  // contextual: extravio (Caso 1), cobrança de retorno (Caso 2), devolução
  // pós-oc=56 (Caso 3). Catch-all pede operador descrever via RPC.
  if (codigoOc === 49) {
    return await decidirOc49(env, card, linhaOc, todasOcorrencias);
  }

  // --- OC 11: GPS é primeira via de validação ---
  if (codigoOc === 11) {
    const gpsM = extrairGpsMetrosDaInstrucao(instrucao);
    if (gpsM !== null) {
      if (gpsM <= gpsThreshold) {
        return {
          proposta_destacada: 54,
          template_email_sugerido: "PROBLEMAS_COM_ENDERECO",
          corpo_email_sugerido: gerarCorpoEmail("PROBLEMAS_COM_ENDERECO", {
            nf,
            motivo: null,
            gps_metros: gpsM,
          }),
          motivo_extraido: `GPS da baixa a ${gpsM}m do endereço (dentro de ${gpsThreshold}m)`,
          foto_classificacao: null,
          tem_ressalva: false,
          ressalva_texto: null,
          ressalva_tipo: null,
          gps_distancia_metros: gpsM,
          gps_dentro_threshold: true,
          tem_cte_devolucao: null,
          cte_devolucao_numero: null,
          confianca: 0.9,
          observacao_orquestrador:
            `Motorista estava a ${gpsM}m do endereço do CT-e (≤ ${gpsThreshold}m). Evidência sólida — sugere notificar cliente pra confirmar/orientar endereço.`,
        };
      }
      // GPS > threshold → 56
      return {
        proposta_destacada: 56,
        template_email_sugerido: null,
        corpo_email_sugerido: null,
        motivo_extraido: `GPS da baixa a ${gpsM}m do endereço (>${gpsThreshold}m — desvio grande)`,
        foto_classificacao: null,
        tem_ressalva: false,
        ressalva_texto: null,
        ressalva_tipo: null,
        gps_distancia_metros: gpsM,
        gps_dentro_threshold: false,
        tem_cte_devolucao: null,
        cte_devolucao_numero: null,
        confianca: 0.85,
        observacao_orquestrador:
          `Motorista estava a ${gpsM}m do endereço do CT-e (>${gpsThreshold}m). Provável baixa em local errado (motorista pode ter dado oc=11 longe da entrega real). Sugere oc=56 pra operação revisar — não notificar cliente sem ter certeza.`,
      };
    }
    // Sem GPS na instrução → 56 conservador
    return {
      proposta_destacada: 56,
      template_email_sugerido: null,
      corpo_email_sugerido: null,
      motivo_extraido: null,
      foto_classificacao: null,
      tem_ressalva: false,
      ressalva_texto: null,
      ressalva_tipo: null,
      gps_distancia_metros: null,
      gps_dentro_threshold: null,
      tem_cte_devolucao: null,
      cte_devolucao_numero: null,
      confianca: 0.7,
      observacao_orquestrador:
        "oc=11 sem texto 'GPS (Xm)' na instrução do motorista. Sem dado de geolocalização, sugere oc=56 pra operação revisar.",
    };
  }

  // --- OC 10/19/35: precisa ressalva escrita ---
  // 1. Lê interpretador (foto) se tiver foto
  let foto = {
    foto_classificacao: null as string | null,
    tem_ressalva_na_foto: false,
    ressalva_texto: null as string | null,
    ressalva_tipo: null as string | null,
    confianca: 0,
    // Caio 2026-05-27 (oc=35): IA Vision pode sinalizar evidência de falta
    // em caixa lacrada — operador rever pq pode não ter devolução.
    alerta_caixa_lacrada: false,
    alerta_caixa_lacrada_motivo: null as string | null,
  };

  if (temFoto) {
    const interpRes = await fetch(`${env["SUPABASE_URL"]}/functions/v1/interpretador-evidencia-foto`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env["SUPABASE_SERVICE_ROLE_KEY"]}`,
        apikey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ card_id: cardId, codigo_oc: codigoOc }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!interpRes.ok) {
      const errText = (await interpRes.text()).slice(0, 300);
      if (interpRes.status === 502 && /Anthropic/i.test(errText)) {
        throw new ClassifiedError("timeout_anthropic", errText);
      }
      if (/oc_sem_foto|oc_nao_encontrada/i.test(errText)) {
        // sem foto válida — segue só com instrução
      } else {
        const cat = categorizarErroSsw("interpretador", interpRes.status, errText);
        throw new ClassifiedError(cat.categoria, `interpretador ${interpRes.status}: ${errText}`, cat.mensagem_operador);
      }
    } else {
      const interpJson = await interpRes.json() as { ok?: boolean; analise?: Record<string, unknown> };
      if (interpJson.ok && interpJson.analise) {
        foto = {
          foto_classificacao: (interpJson.analise["foto_classificacao"] as string) ?? null,
          tem_ressalva_na_foto: interpJson.analise["tem_ressalva_na_foto"] === true,
          ressalva_texto: ((interpJson.analise["ressalva_texto"] as string | null) ?? "")?.trim() || null,
          ressalva_tipo: (interpJson.analise["ressalva_tipo"] as string | null) ?? null,
          confianca: typeof interpJson.analise["confianca"] === "number" ? interpJson.analise["confianca"] as number : 0,
          // Caio 2026-05-27: alerta de caixa lacrada (oc=35) — só consumido
          // quando codigoOc===35 (gate aplicado depois ao montar DecisaoSugestao).
          alerta_caixa_lacrada: interpJson.analise["alerta_caixa_lacrada"] === true,
          alerta_caixa_lacrada_motivo: ((interpJson.analise["alerta_caixa_lacrada_motivo"] as string | null) ?? "")?.trim() || null,
        };
      }
    }
  }

  // 2. Consolida motivo
  //
  // Caio 2026-05-27 (NF 182149 CARLOS): regra estrita pra oc=10/19/35.
  // SSWMOBILE preenche AUTOMATICAMENTE a instrução do motorista com os
  // títulos das ocs:
  //   - oc=10: "RECUSA TOTAL DA ENTREGA"
  //   - oc=19: "ENTREGA REALIZADA COM FALTA DE VOLUMES"
  //   - oc=35: "ENTREGA REALIZADA COM RECUSA PARCIAL"
  // Esses textos NÃO comprovam motivo real — só dizem "qual oc foi lançada".
  // ehMotivoSswGenerico (sanitizar-texto-ssw.ts) agora bloqueia esses 3
  // títulos. Pra essas 3 ocs, motivo válido = APENAS ressalva manuscrita
  // na foto. Sem ressalva real → sugere 56 (operação revisa).
  //
  // Antes (até 2026-05-26): oc=10/35 ainda usava instrução do motorista
  // como fallback — bug NF 182149 sugeriu "recusa por falta de volume"
  // quando ressalva real dizia "Conforme combinado com distribuidora".
  const instrEhGenerico = ehMotivoSswGenerico(instrucao);
  const ressalvaTextoLimpo = (foto.ressalva_texto ?? "").trim();
  const ressalvaEhGenerica = ehMotivoSswGenerico(ressalvaTextoLimpo);
  const ressalvaValida = foto.tem_ressalva_na_foto && !ressalvaEhGenerica && ressalvaTextoLimpo.length > 0;

  // Caio 2026-05-23 (NF 2299043): limpa marcadores SSWMOBILE/GPS/SEFAZ antes
  // de salvar — não polui motivo_extraido nem corpo do email pro cliente.
  let motivoRaw: string | null;
  if (codigoOc === 10 || codigoOc === 19 || codigoOc === 35) {
    // oc=10/19/35: motivo SÓ via ressalva da foto. Instrução do motorista é
    // título automático SSWMOBILE — bloqueado em ehMotivoSswGenerico.
    motivoRaw = ressalvaValida ? ressalvaTextoLimpo : null;
  } else {
    // oc=49 e outras: motivo via instrução motorista (PRAZO EXPIRADO etc) OU ressalva.
    motivoRaw = !instrEhGenerico
      ? instrucao
      : (ressalvaValida ? ressalvaTextoLimpo : null);
  }
  const motivoConsolidado: string | null = motivoRaw ? removerMarcadoresSswmobile(motivoRaw) || null : null;

  // 3. oc=35 (RECUSA PARCIAL): NÃO se consulta CT-e de devolução aqui.
  // Caio 2026-06-20: o CT-e de devolução (CTRC reversa) só passa a existir DEPOIS
  // que o cliente AUTORIZA a devolução e a oc=44 é lançada. No momento da oc=35 a
  // ausência de reversa é o estado NORMAL e esperado — não é sinal de evidência
  // fraca nem motivo pra rebaixar confiança ou pedir validação com a operação.
  // A tratativa correta é oc=54 + email perguntando ao cliente se autoriza a
  // devolução do(s) volume(s) recusado(s). (Removido o checarCteDevolucao/reversa.)

  // 4. Decide proposta

  // Caio 2026-05-25 (NF 222710 DURAFA): oc=10 SEMPRE precisa de anexo de foto
  // E ESSA FOTO precisa ter sido interpretada com sucesso. Sem foto válida
  // classificada, mesmo com instrução escrita, NÃO pode sugerir 54+email
  // (cliente teria que confiar em texto sem comprovação visual). Vai pra 56
  // pra operação revisar evidência antes de notificar cliente.
  //
  // Foto "válida" = classificação que comprova tentativa (destinatario_com_ressalva
  // ou destinatario_sem_ressalva). Classificações aleatoria/ilegivel/null
  // são insuficientes pro padrão RECUSA TOTAL.
  const FOTO_CLASSIFICACOES_VALIDAS_OC10 = new Set([
    "destinatario_com_ressalva",
    "destinatario_sem_ressalva",
    "destinatario", // formato curto retornado em algumas chamadas
  ]);
  const fotoValidaOc10 =
    temFoto &&
    foto.foto_classificacao != null &&
    FOTO_CLASSIFICACOES_VALIDAS_OC10.has(foto.foto_classificacao);

  if (codigoOc === 10 && !fotoValidaOc10) {
    const detalheFoto = !temFoto
      ? "oc=10 SEM ANEXO de foto — regra Sal Express exige foto pra notificar cliente"
      : foto.foto_classificacao == null
        ? "oc=10 com anexo mas IA Vision não conseguiu classificar (sem cookie SSW na hora ou foto corrompida)"
        : `oc=10 com foto classificada como "${foto.foto_classificacao}" — insuficiente pra comprovar tentativa pro cliente`;
    return {
      proposta_destacada: 56,
      template_email_sugerido: null,
      corpo_email_sugerido: null,
      motivo_extraido: motivoConsolidado, // mantém pro operador ver
      foto_classificacao: foto.foto_classificacao,
      tem_ressalva: foto.tem_ressalva_na_foto,
      ressalva_texto: foto.ressalva_texto,
      ressalva_tipo: foto.ressalva_tipo,
      gps_distancia_metros: null,
      gps_dentro_threshold: null,
      tem_cte_devolucao: null,
      cte_devolucao_numero: null,
      confianca: 0.85,
      observacao_orquestrador:
        `${detalheFoto}. Sugere oc=56 pra operação anexar/corrigir evidência antes de notificar cliente.`,
    };
  }

  if (!motivoConsolidado) {
    return {
      proposta_destacada: 56,
      template_email_sugerido: null,
      corpo_email_sugerido: null,
      motivo_extraido: null,
      foto_classificacao: foto.foto_classificacao,
      tem_ressalva: foto.tem_ressalva_na_foto,
      ressalva_texto: foto.ressalva_texto,
      ressalva_tipo: foto.ressalva_tipo,
      gps_distancia_metros: null,
      gps_dentro_threshold: null,
      tem_cte_devolucao: null, // deprecado (Caio 2026-06-20)
      cte_devolucao_numero: null,
      confianca: 0.75,
      observacao_orquestrador:
        `oc=${codigoOc} sem motivo escrito (nem na instrução do motorista, nem como ressalva na foto). Evidência incompleta — sugere oc=56 pra operação revisar antes de notificar cliente.`,
    };
  }

  // motivoConsolidado existe → sugere 54
  //
  // Caio 2026-05-27 (revisão definitiva): cada oc tem 1 template default.
  // Operador pode trocar livremente no dropdown universal.
  //
  //   - oc=10 → RECUSA_TOTAL (recusa total da entrega)
  //   - oc=11 → PROBLEMAS_COM_ENDERECO (tratado mais acima via GPS)
  //   - oc=19 → ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (entregue com falta,
  //     cliente já autorizou parcial — pede romaneio + descrição pra
  //     abrir ressarcimento via oc=33 depois)
  //   - oc=35 → ENTREGA_PARCIAL_APOS_FALTA_VOLUME (recusa parcial —
  //     cliente recusou parte da carga no destino por falta de volume)
  //   - oc=49 + instrução "PRAZO DE PERDAS/LOCALIZAÇÃO EXPIRADO"
  //     → FALTA_DE_VOLUME (parcial default; operador escolhe TOTAL no
  //     dropdown se for o caso)
  //   - oc=49 sem instrução qualificadora → não sugere (8 propostas padrão)
  const templateMap: Record<number, string> = {
    10: "RECUSA_TOTAL",
    19: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
    35: "ENTREGA_PARCIAL_APOS_FALTA_VOLUME",
    49: "FALTA_DE_VOLUME",
  };
  const template = templateMap[codigoOc] ?? "RECUSA_TOTAL";
  let confianca = 0.85;
  let observacao = `oc=${codigoOc} com motivo escrito identificado (${
    instrEhGenerico ? "ressalva na foto" : "instrução do motorista"
  }). Evidência boa — sugere notificar cliente (oc=54 + ${template}).`;

  if (codigoOc === 35) {
    // oc=35 (RECUSA PARCIAL) com ressalva manuscrita válida = evidência boa (0.85).
    // O email pergunta ao cliente se autoriza a devolução do volume recusado; o
    // CT-e de devolução (reversa) só nasce DEPOIS dessa autorização + oc=44, então
    // sua ausência aqui é o esperado e NÃO rebaixa a confiança.
    observacao = `oc=35 (recusa parcial) com motivo identificado na ressalva manuscrita da foto. Evidência boa — sugere oc=54 + email perguntando ao cliente se autoriza a devolução do(s) volume(s) recusado(s).`;
    if (foto.alerta_caixa_lacrada) {
      confianca = Math.min(confianca, 0.6);
      observacao = `⚠️ EVIDÊNCIA INDICA CAIXA LACRADA — ${foto.alerta_caixa_lacrada_motivo ?? "embalagem aparentemente íntegra com indicação de falta de itens internos"}. Pode não haver devolução real — apenas ressarcimento dos itens faltantes. Revise o template e o conteúdo do email antes de aprovar.`;
    }
  }

  const alertaCaixaLacrada = codigoOc === 35 ? foto.alerta_caixa_lacrada : null;
  const alertaCaixaLacradaMotivo = codigoOc === 35 ? foto.alerta_caixa_lacrada_motivo : null;

  // Caio 2026-06-24 (NF 148558): se a recusa/falta (oc 10/19/35) foi CAUSADA por
  // extravio anterior (6/9/16) e o cliente ainda NÃO foi notificado da falta
  // (sem 20/54/49 lançada depois do extravio), troca pro template COMBINADO
  // (devolver x seguir + romaneio + descrição + valor pra ressarcimento) e
  // sinaliza o conflito de contexto pro operador no banner.
  let templateFinal = template;
  const contextoExtravio = recusaOriginadaDeExtravioNaoNotificada(todasOcorrencias);
  if (contextoExtravio) {
    templateFinal = "RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR";
    observacao =
      `⚠️ CONFLITO DE CONTEXTO: a recusa (oc=${codigoOc}) foi originada de um extravio ` +
      `anterior (oc=${contextoExtravio.codigo}${contextoExtravio.data ? ` em ${contextoExtravio.data}` : ""}) ` +
      `do qual o cliente ainda NÃO foi notificado. Sugere oc=54 + e-mail combinado: ` +
      `notifica a falta, pergunta devolução x nova entrega E pede romaneio + descrição + valor ` +
      `dos itens pra abrir o ressarcimento (futuro combo 33+44).`;
  }

  return {
    proposta_destacada: 54,
    template_email_sugerido: templateFinal,
    corpo_email_sugerido: gerarCorpoEmail(templateFinal, {
      nf,
      motivo: motivoConsolidado,
    }),
    motivo_extraido: motivoConsolidado,
    foto_classificacao: foto.foto_classificacao,
    tem_ressalva: foto.tem_ressalva_na_foto,
    ressalva_texto: foto.ressalva_texto,
    ressalva_tipo: foto.ressalva_tipo,
    gps_distancia_metros: null,
    gps_dentro_threshold: null,
    tem_cte_devolucao: null, // deprecado: oc=35 não consulta mais CT-e reversa (Caio 2026-06-20)
    cte_devolucao_numero: null,
    alerta_caixa_lacrada: alertaCaixaLacrada,
    alerta_caixa_lacrada_motivo: alertaCaixaLacradaMotivo,
    contexto_recusa_por_extravio: contextoExtravio ? true : null,
    extravio_anterior_oc: contextoExtravio?.codigo ?? null,
    extravio_anterior_data: contextoExtravio?.data ?? null,
    confianca,
    observacao_orquestrador: observacao,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ClassifiedError extends Error {
  categoria: string;
  mensagemOperador: string | null;
  constructor(categoria: string, msg: string, mensagemOperador: string | null = null) {
    super(msg);
    this.categoria = categoria;
    this.mensagemOperador = mensagemOperador;
  }
}

// Helper extrairDistanciaGpsMetros movido pra _shared/sanitizar-texto-ssw.ts
// (extrairGpsMetrosDaInstrucao) — Caio 2026-05-23 NF 1494821

// ehMotivoGenerico foi substituído por ehMotivoSswGenerico em _shared/
// sanitizar-texto-ssw.ts (Caio 2026-05-23, NF 1494821) — agora detecta
// padrões automáticos SSWMOBILE/SEFAZ/GPS.

// checarCteDevolucao (consulta de CTRC reversa pra oc=35) REMOVIDO em 2026-06-20.
// Motivo: o CT-e de devolução só existe DEPOIS do cliente autorizar a devolução
// e da oc=44 ser lançada — sua ausência no momento da oc=35 é o estado normal,
// nunca foi sinal de evidência fraca. A oc=35 com ressalva válida segue direto
// pra oc=54 + email perguntando ao cliente se autoriza a devolução.

function gerarCorpoEmail(
  template: string,
  ctx: {
    nf: string;
    motivo: string | null;
    gps_metros?: number | null;
    cte_devolucao?: string | null;
    // Caio 2026-05-29 (templates extravio): qtd extraviada + total da NF
    n_volumes_falta?: number | null;
    qtde_volumes?: number | null;
  },
): string {
  switch (template) {
    case "RECUSA_TOTAL":
      return `Identificamos que a NF {nf} foi recusada totalmente pelo destinatário. Motivo informado pela equipe da entrega: "${ctx.motivo ?? ""}". Solicitamos por gentileza orientação sobre o destino da mercadoria — prosseguir com retorno/devolução ou aguardar nova instrução de vocês.`;
    case "RECUSA_PARCIAL":
      return `Identificamos que a NF {nf} foi parcialmente recusada pelo destinatário. Motivo informado: "${ctx.motivo ?? ""}".${
        ctx.cte_devolucao ? ` CT-e de devolução já emitido: ${ctx.cte_devolucao}.` : ""
      } Aguardamos sua orientação sobre como prosseguir com os volumes recusados.`;
    case "FALTA_DE_VOLUME":
      return `O destinatário da NF {nf} confirmou recebimento mas registrou falta de volumes. Anotação do recebedor: "${ctx.motivo ?? ""}". Pode confirmar pra gente como deseja prosseguir — abertura de RPA, ressarcimento, ou outra orientação?`;
    case "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO":
      return `A NF {nf} foi entregue no destino final com falta de volume(s) — ressalva coletada no momento da entrega: "${ctx.motivo ?? ""}". Pra dar sequência ao processo de ressarcimento, gentileza encaminhar o romaneio de coleta assinado da NF + descrição/valor dos itens faltantes.`;
    case "FALTA_DE_VOLUME_TOTAL":
      return `Identificamos o extravio TOTAL dos volumes referentes à NF {nf}. Buscas internas iniciadas. Pra evitar impacto no destinatário, orientamos envio de pedido de reposição — caso os volumes sejam localizados, fazemos devolução isenta. Aguardamos sua orientação.`;
    case "ENTREGA_PARCIAL_APOS_FALTA_VOLUME":
      // Caio 2026-05-27 (NF 182149): NÃO assumir "por falta de volume" — a
      // recusa parcial pode ter vários motivos (acordo com remetente,
      // divergência produto, qualidade, etc). Apenas reportar o que está
      // escrito na ressalva — operador decide.
      return `Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino. Anotação registrada na ressalva: "${ctx.motivo ?? ""}". Se preferir, podemos compartilhar informações detalhadas da recusa pra avaliar a melhor tratativa: seguir com devolução, nova tentativa de entrega ou aguardar.`;
    case "PROBLEMAS_COM_ENDERECO":
      return `Não conseguimos localizar o endereço de entrega da NF {nf}.${
        ctx.gps_metros != null ? ` Nossa equipe esteve a ${ctx.gps_metros}m da localização cadastrada.` : ""
      } Pode confirmar o endereço correto ou orientar uma referência pra próxima tentativa?`;
    case "EXTRAVIO_PARCIAL":
      // Caio 2026-05-29 (agente oc=49 Caso 1b): qtd extraviada extraída por
      // regex da instrução de oc=6/9/16 anterior. Cliente decide entre seguir
      // parcial OU devolver tudo.
      return `Identificamos que durante o transporte da NF {nf} houve extravio de ${
        ctx.n_volumes_falta ?? "{n_volumes_falta}"
      } de ${
        ctx.qtde_volumes ?? "{qtde_volumes}"
      } volumes. Localizamos o restante. Pra prosseguirmos, poderia nos orientar: (a) seguir com a entrega parcial dos volumes localizados, OU (b) realizar a devolução total? Poderão ser aplicadas cobranças de armazenagem caso aguardemos retorno por longo período.`;
    case "EXTRAVIO_TOTAL_PEDIR_ROMANEIO":
      // Caio 2026-05-29 (agente oc=49 Caso 1a): TODOS os volumes extraviados.
      // Pede romaneio assinado pra continuar processo de indenização.
      return `Lamentamos informar que todos os volumes da NF {nf} foram extraviados durante o transporte e não foram localizados dentro do prazo padrão de busca. Pra darmos continuidade ao processo de indenização, solicitamos o envio do romaneio assinado e demais documentos pertinentes.`;
    case "RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR":
      // Caio 2026-06-24 (NF 148558): recusa no destino CAUSADA por extravio
      // anterior. Num e-mail só: notifica a falta + pergunta devolver x nova
      // entrega + pede romaneio + descrição + valor pra abrir ressarcimento.
      return `Na entrega da NF {nf}, o destinatário recusou o recebimento por falta de volume(s) — parte da carga foi extraviada durante o transporte.${
        ctx.motivo ? ` Ressalva registrada: "${ctx.motivo}".` : ""
      } Pedimos a gentileza de nos orientar: (a) deseja a DEVOLUÇÃO dos volumes ou prefere uma NOVA ENTREGA? E, para o ressarcimento dos itens faltantes, encaminhe o romaneio de coleta assinado, a descrição dos itens faltantes e o valor a ser indenizado.`;
    default:
      return `Identificamos uma intercorrência na entrega da NF {nf}. Motivo: "${ctx.motivo ?? ""}". Aguardamos sua orientação.`;
  }
}

// =============================================================================
// OC=49 — agente de sugestões (Caio 2026-05-29)
//
// Árvore de decisão em 4 ramos (ordem de avaliação importa):
//   Caso 3 (mais específico): histórico tem oc=56 lançada pelo Cockpit antes
//                             → devolução pós-56 (sugere oc=54 + template
//                             da oc cluster original)
//   Caso 2: instrução tem "FALTA DE RETORNO / CARGA PARADA / DEMORA NA
//           TRATATIVA" E há RespostaEnviada oc=54 anterior pelo Cockpit
//           → cobrança de retorno na mesma thread (acao_lateral)
//   Caso 1: usuário da oc=49 está em usuarios_ssw_perdas OR instrução tem
//           "EXTRAVIO / PERDA / NÃO LOCALIZADO" → extravio
//           1a (TOTAL): EXTRAVIO_TOTAL_PEDIR_ROMANEIO
//           1b (PARCIAL com qtd): EXTRAVIO_PARCIAL + n_volumes_falta
//           1c (PARCIAL sem qtd): dispara WPP autônomo ao time_ressarcimento
//   Catch-all: 'nao_reconhecido' (banner com textarea + RPC feedback)
// =============================================================================

const OCS_EXTRAVIO_ANTERIOR: ReadonlySet<number> = new Set([6, 9, 16]);

type ParseQtd = { total: true } | { qtd: number } | null;

function extrairQtdVolumesExtraviados(instrucao: string | null | undefined): ParseQtd {
  if (!instrucao) return null;
  // Caio 2026-06-01 (NF 23142): instrução pode vir como "1 (SSWMOBILE) GPS (21.302m)."
  // — o "1" no início é a qtd real lançada pelo motorista, e o resto é metadado
  // automático do SSWMOBILE. sanitizarTextoSsw NÃO limpa (SSWMOBILE)/GPS, então
  // o regex catch-all `/^\d+$/` falhava. removerMarcadoresSswmobile resolve.
  const limpa = removerMarcadoresSswmobile(instrucao).trim().toUpperCase();
  if (!limpa) return null;
  // TOTAL antes de tudo (pode aparecer como "EXTRAVIO TOTAL", "PERDA TOTAL", "TOTAL")
  if (/\b(EXTRAVIO\s+TOTAL|PERDA\s+TOTAL|TOTAL)\b/.test(limpa)) return { total: true };
  // "FALTA 2 VOLUMES", "FALTAM 2 VOLUMES", "FALTA 2 VOL", "QTDE 2", "QTD. 2"
  // OU "2 VOLUMES", "2 VOL"
  const m = limpa.match(/(?:FALTA(?:M)?|QTDE?|QTD\.?)\s*(\d{1,3})|\b(\d{1,3})\s*(?:VOL|VOLUMES?|VOLS?)\b/);
  if (m) {
    const qtd = parseInt(m[1] ?? m[2] ?? "", 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  // Instrução é APENAS um número, possivelmente com ponto/espaço residual
  // (ex: "2", "1 ." após remover (SSWMOBILE) GPS) — caso NF 347131, NF 23142
  if (/^\d{1,3}\s*\.?\s*$/.test(limpa)) {
    const qtd = parseInt(limpa, 10);
    if (qtd > 0 && qtd < 1000) return { qtd };
  }
  return null;
}

function acharOcAnteriorDoTipo(
  historico: OcorrenciaHistorico[],
  tipos: ReadonlySet<number>,
): OcorrenciaHistorico | null {
  for (const o of historico) {
    if (o.codigo != null && tipos.has(o.codigo)) return o;
  }
  return null;
}

function deduzirTemplateDoCluster(historico: OcorrenciaHistorico[]): string | null {
  // Procura oc cluster (10/19/35) anterior pra deduzir qual template usar no
  // Caso 3 (devolução pós-56). O cluster define o tom do email pro cliente.
  for (const o of historico) {
    if (o.codigo === 10) return "RECUSA_TOTAL";
    if (o.codigo === 19) return "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO";
    if (o.codigo === 35) return "ENTREGA_PARCIAL_APOS_FALTA_VOLUME";
  }
  return null;
}

async function usuarioEstaNaListaPerdas(
  supabase: ReturnType<typeof createClient>,
  usuario: string | null | undefined,
): Promise<boolean> {
  if (!usuario) return false;
  const { data } = await supabase
    .from("usuarios_ssw_perdas")
    .select("login")
    .eq("login", usuario.trim())
    .eq("ativo", true)
    .maybeSingle();
  return !!data;
}

async function houveAcaoExecutadaCockpit(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  codigoOc: number,
): Promise<boolean> {
  // True se há AcaoExecutada do executor pra essa oc nesse card (ou seja,
  // oc lançada via Cockpit, não direto no SSW).
  const { data } = await supabase
    .from("card_events")
    .select("id")
    .eq("card_id", cardId)
    .eq("event_type", "AcaoExecutada")
    .filter("payload->>codigo_ssw", "eq", String(codigoOc))
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function ultimaRespostaEnviadaComOc(
  supabase: ReturnType<typeof createClient>,
  cardId: string,
  codigoOc: number,
): Promise<{ gmail_thread_id: string | null; sent_at: string | null } | null> {
  // Lê última RespostaEnviada pro card. Não filtra por codigo_oc na resposta
  // (payload nem sempre tem) — usa o AcaoExecutada irmão pra confirmar oc.
  const { data: events } = await supabase
    .from("card_events")
    .select("payload, created_at")
    .eq("card_id", cardId)
    .eq("event_type", "RespostaEnviada")
    .order("created_at", { ascending: false })
    .limit(5);
  if (!events || events.length === 0) return null;
  for (const ev of events) {
    const p = (ev as { payload?: Record<string, unknown> }).payload ?? {};
    const tid = (p["gmail_thread_id"] as string | null) ?? null;
    if (tid) {
      // Aceita primeira que tem thread_id; se houver filtro estrito por
      // codigo_oc desejado, o caller checa via houveAcaoExecutadaCockpit.
      const hasAcao = await houveAcaoExecutadaCockpit(supabase, cardId, codigoOc);
      if (hasAcao) {
        return {
          gmail_thread_id: tid,
          sent_at: (ev as { created_at?: string }).created_at ?? null,
        };
      }
    }
  }
  return null;
}

// Caio 2026-05-29: dispararWppRessarcimento foi removido daqui. Agente
// não envia WPP autônomo no Caso 1c — só sinaliza. Disparo manual fica na
// edge `cobrar-ressarcimento-wpp` chamada pelo botão do front.

async function decidirOc49(
  env: Record<string, string>,
  card: Record<string, unknown>,
  linhaOc: OcorrenciaHistorico,
  todasOcorrencias: OcorrenciaHistorico[],
): Promise<DecisaoSugestao> {
  const supabase = createClient(
    env["SUPABASE_URL"]!,
    env["SUPABASE_SERVICE_ROLE_KEY"]!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const cardId = card.id as string;
  const nf = (card.nf as string | null) ?? "";
  const qtdeVolumesNf = (card.qtde_volumes as number | null) ?? null;
  const instrucao49 = sanitizarTextoSsw(linhaOc.instrucao);
  const usuario49 = linhaOc.usuario;

  // Defaults pros campos que outras ocs preenchem mas oc=49 não usa
  const baseNull = {
    foto_classificacao: null,
    tem_ressalva: false,
    ressalva_texto: null,
    ressalva_tipo: null,
    gps_distancia_metros: null,
    gps_dentro_threshold: null,
    tem_cte_devolucao: null,
    cte_devolucao_numero: null,
  } as const;

  // ---------- CASO 3 — Devolução pós-oc=56 (mais específico, avalia primeiro)
  const linha56Anterior = todasOcorrencias.find((o) => o.codigo === 56) ?? null;
  if (linha56Anterior) {
    const foiCockpit = await houveAcaoExecutadaCockpit(supabase, cardId, 56);
    if (foiCockpit) {
      const pedidoOc56 = sanitizarTextoSsw(linha56Anterior.instrucao);
      const vinculo = instrucao49.length > 20; // alguma info textual veio na 49
      if (vinculo) {
        const templateCluster = deduzirTemplateDoCluster(todasOcorrencias);
        return {
          ...baseNull,
          proposta_destacada: 54,
          template_email_sugerido: templateCluster,
          corpo_email_sugerido: templateCluster
            ? gerarCorpoEmail(templateCluster, { nf, motivo: instrucao49 })
            : null,
          motivo_extraido: instrucao49 || null,
          confianca: 0.85,
          caso_oc49: "devolucao_pos_56",
          cod_ocorrencia_para_token: 49,
          observacao_orquestrador:
            `oc=56 anterior pediu "${pedidoOc56.slice(0, 80)}" — a oc=49 atual trouxe a evidência/info pedida. ` +
            `Sugere notificar cliente (oc=54 + ${templateCluster ?? "template do cluster original"}).`,
        };
      }
    }
  }

  // ---------- CASO 2 — Cobrança de retorno
  if (/FALTA\s+DE\s+RETORNO|CARGA\s+PARADA|DEMORA\s+NA\s+TRATATIVA|SEM\s+RETORNO/i.test(instrucao49)) {
    const oc54AntCockpit = await ultimaRespostaEnviadaComOc(supabase, cardId, 54);
    if (oc54AntCockpit?.gmail_thread_id) {
      return {
        ...baseNull,
        proposta_destacada: null,
        template_email_sugerido: null,
        corpo_email_sugerido: null,
        motivo_extraido: instrucao49 || null,
        confianca: 0.80,
        caso_oc49: "cobranca_retorno",
        acao_lateral: "cobrar_retorno_mesma_thread",
        thread_id_alvo: oc54AntCockpit.gmail_thread_id,
        texto_prefixo_sugerido:
          `Boa tarde,\n\nAinda aguardamos seu retorno sobre a tratativa da NF ${nf}. Poderia, por gentileza, nos orientar?`,
        cod_ocorrencia_para_token: 54,
        observacao_orquestrador:
          `Operação cobrou retorno via oc=49 (${instrucao49.slice(0, 60)}…). ` +
          `Cliente já foi notificado em ${oc54AntCockpit.sent_at ?? "data desconhecida"} via oc=54. ` +
          `Sugere cobrar novamente na MESMA thread Gmail (botão "Cobrar de novo" reusa enviar-retificacao-evidencia).`,
      };
    }
  }

  // ---------- CASO 1 — Extravio
  const usuarioPerdas = await usuarioEstaNaListaPerdas(supabase, usuario49);
  const instrucaoTemPalavraChave =
    /\bEXTRAVIO|PERDA|N[ÃA]O\s+LOCALIZAD/i.test(instrucao49);
  if (usuarioPerdas || instrucaoTemPalavraChave) {
    const ocExtravioAnterior = acharOcAnteriorDoTipo(todasOcorrencias, OCS_EXTRAVIO_ANTERIOR);
    const instrExtravio = ocExtravioAnterior
      ? sanitizarTextoSsw(ocExtravioAnterior.instrucao)
      : null;
    const qtdParsed = extrairQtdVolumesExtraviados(instrExtravio);

    if (qtdParsed && "total" in qtdParsed) {
      return {
        ...baseNull,
        proposta_destacada: 54,
        template_email_sugerido: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
        corpo_email_sugerido: gerarCorpoEmail("EXTRAVIO_TOTAL_PEDIR_ROMANEIO", {
          nf,
          motivo: instrExtravio,
        }),
        motivo_extraido: instrExtravio ?? instrucao49,
        confianca: 0.90,
        caso_oc49: "extravio_total",
        cod_ocorrencia_para_token: 49,
        observacao_orquestrador:
          `Extravio TOTAL detectado na oc=${ocExtravioAnterior?.codigo} (${ocExtravioAnterior?.data ?? "?"}). ` +
          `Sugere oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO pra dar continuidade ao processo de indenização.`,
      };
    }

    if (qtdParsed && "qtd" in qtdParsed) {
      const qtd = qtdParsed.qtd;
      // Caio 2026-06-01: qtd_extraida >= qtd_nf vira TOTAL (era "parcial baixa
      // confiança"). NF mono-volume com qtd=1 era classificada parcial errado.
      // Caso real NF 758127 BCN (CT-e 1 volume, oc=6 com qtd numérica genérica).
      if (qtdeVolumesNf != null && qtd >= qtdeVolumesNf) {
        return {
          ...baseNull,
          proposta_destacada: 54,
          template_email_sugerido: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
          corpo_email_sugerido: gerarCorpoEmail("EXTRAVIO_TOTAL_PEDIR_ROMANEIO", {
            nf,
            motivo: instrExtravio,
          }),
          motivo_extraido: instrExtravio ?? instrucao49,
          confianca: 0.90,
          caso_oc49: "extravio_total",
          qtd_volumes_extraviados: qtd,
          qtd_volumes_nf: qtdeVolumesNf,
          cod_ocorrencia_para_token: 49,
          observacao_orquestrador:
            `Extravio TOTAL inferido: ${qtd} extraviado(s) de ${qtdeVolumesNf} da NF na oc=${ocExtravioAnterior?.codigo}. ` +
            `Sugere oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO.`,
        };
      }
      return {
        ...baseNull,
        proposta_destacada: 54,
        template_email_sugerido: "EXTRAVIO_PARCIAL",
        corpo_email_sugerido: gerarCorpoEmail("EXTRAVIO_PARCIAL", {
          nf,
          motivo: instrExtravio,
          n_volumes_falta: qtd,
          qtde_volumes: qtdeVolumesNf,
        }),
        motivo_extraido: instrExtravio ?? instrucao49,
        confianca: 0.90,
        caso_oc49: "extravio_parcial",
        qtd_volumes_extraviados: qtd,
        qtd_volumes_nf: qtdeVolumesNf,
        cod_ocorrencia_para_token: 49,
        observacao_orquestrador:
          `Extravio parcial: ${qtd} de ${qtdeVolumesNf ?? "?"} volumes na oc=${ocExtravioAnterior?.codigo}. ` +
          `Operadora valida e envia.`,
      };
    }

    // Caio 2026-06-01 (NF 758127): qtd não extraída numericamente, MAS NF tem
    // 1 volume só (mono-volume) E há indício de extravio → infere TOTAL. Não
    // pode ser parcial com 1 volume. Evita cair em extravio_sem_qtd toda vez
    // que a instrução for genérica tipo "EXTRAVIO NA TRANSFERENCIA".
    if (qtdeVolumesNf === 1) {
      return {
        ...baseNull,
        proposta_destacada: 54,
        template_email_sugerido: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
        corpo_email_sugerido: gerarCorpoEmail("EXTRAVIO_TOTAL_PEDIR_ROMANEIO", {
          nf,
          motivo: instrExtravio,
        }),
        motivo_extraido: instrExtravio ?? instrucao49,
        confianca: 0.88,
        caso_oc49: "extravio_total",
        qtd_volumes_extraviados: 1,
        qtd_volumes_nf: 1,
        cod_ocorrencia_para_token: 49,
        observacao_orquestrador:
          `Extravio TOTAL inferido: NF mono-volume (1 vol) com indício de extravio na oc=${ocExtravioAnterior?.codigo ?? "?"}. ` +
          `Sugere oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO.`,
      };
    }

    // Caso 1c — qtd não extraída. Caio 2026-05-29 (refinamento pós-deploy):
    // NÃO dispara WPP autônomo. Banner mostra botão "COBRAR RESSARCIMENTO"
    // que o operador clica → edge `cobrar-ressarcimento-wpp` resolve contatos
    // + envia + marca cobrada_no_wpp=true. Controle no operador (decide
    // horário, se outro canal, etc).
    return {
      ...baseNull,
      proposta_destacada: null,
      template_email_sugerido: null,
      corpo_email_sugerido: null,
      motivo_extraido: instrExtravio ?? instrucao49 ?? null,
      confianca: 0.95,
      caso_oc49: "extravio_sem_qtd",
      cobrada_no_wpp: false,
      cobrada_em: null,
      observacao_orquestrador:
        `Não consegui identificar qtd de volumes extraviados no SSW. ` +
        `Clique "📱 COBRAR RESSARCIMENTO" pra disparar mensagem pro time via WhatsApp ` +
        `(cadastre o contato em Configurações > Contatos de escalonamento > Time Ressarcimento).`,
    };
  }

  // ---------- Catch-all
  return {
    ...baseNull,
    proposta_destacada: null,
    template_email_sugerido: null,
    corpo_email_sugerido: null,
    motivo_extraido: instrucao49 || null,
    confianca: 0.0,
    caso_oc49: "nao_reconhecido",
    observacao_orquestrador:
      `oc=49 não bate com nenhum dos 3 casos predominantes (extravio / cobrança retorno / devolução pós-56). ` +
      `Operador escolhe manual + descreve o caso real no banner pra agente aprender (RPC registrar_feedback_oc49_caso_desconhecido).`,
  };
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
