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
//   35 (RECUSA PARCIAL):  ressalva + CT-e devolução (REVERSA) → 54 + RECUSA_PARCIAL alta confiança
//                         só ressalva → 54 + RECUSA_PARCIAL média (alerta CT-e ausente)
//                         sem ressalva → 56
//
// INV-001: usa SSW interno via interpretador-evidencia-foto + puxar-historico
// + listarCTRCsDaNF. Nunca tracking público.
// INV-009: verify_jwt=false.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sanitizarTextoSsw, extrairGpsMetrosDaInstrucao, ehMotivoSswGenerico, removerMarcadoresSswmobile } from "../_shared/sanitizar-texto-ssw.ts";
import { categorizarErroSsw, ehCategoriaTransiente, resetarFalhasTransientesSeHorarioOk } from "../_shared/categorizar-erro-ssw.ts";
import { isHorarioComercialBRT } from "../_shared/horario-comercial.ts";

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
  tem_cte_devolucao: boolean | null;            // só oc=35
  cte_devolucao_numero: string | null;          // só oc=35
  // Caio 2026-05-27: IA Vision detecta indicação de "falta de itens em
  // caixa lacrada" na foto/ressalva (oc=35). Quando true, banner mostra
  // alerta pro operador rever — pode não ter devolução real, apenas
  // ressarcimento de itens faltantes dentro de embalagem íntegra.
  // Optional pra não quebrar returns das outras ocs.
  alerta_caixa_lacrada?: boolean | null;
  alerta_caixa_lacrada_motivo?: string | null;
  // URL pra ver a foto direto no banner (sem ir em HISTÓRICO SSW)
  evidencia_url?: string | null;
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
  if (!cardIdOverride) {
    resetados = await resetarFalhasTransientesSeHorarioOk(supabase, isHorarioComercialBRT, {
      statusCol: "analise_padrao_status",
      tentativasCol: "analise_padrao_tentativas",
      resultadoCol: "analise_padrao_resultado",
      atualizadoEmCol: "analise_padrao_atualizado_em",
      avisoTipoAguardando: "ia_ocs_padrao_aguardando",
    });
  }

  let candidatos: Record<string, unknown>[] | null = null;
  let selErr: { message: string } | null = null;

  if (cardIdOverride) {
    const res = await supabase
      .from("cards")
      .select("id, nf, ctrc, agent_state, responsavel_relacionamento, " +
              "assigned_operator_id, pagador, segmento_codigo, " +
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
              "assigned_operator_id, pagador, segmento_codigo, " +
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
      await supabase
        .from("cards")
        .update({
          analise_padrao_status: "concluida",
          analise_padrao_resultado: decisao,
          analise_padrao_atualizado_em: new Date().toISOString(),
          aviso_alteracao_oc: {
            tipo: "ia_sugestao_ocs_padrao",
            codigo_oc_card: codigoOc,
            proposta_destacada: decisao.proposta_destacada,
            template_email_sugerido: decisao.template_email_sugerido,
            motivo_extraido: decisao.motivo_extraido,
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

      if (decisao.proposta_destacada === 54) stats.sugestoes_54++;
      else stats.sugestoes_56++;
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
    }
  }

  return json({ ok: true, ...stats, candidatos: candidatos?.length ?? 0, resetados_horario_comercial: resetados }, 200);
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
  void todasOcorrencias;
  const cardId = card.id as string;
  const nf = card.nf as string;
  // Caio 2026-05-23 (NF 1494821): sanitiza HTML/comentários do portal SSW
  const instrucao = sanitizarTextoSsw(linhaOc.instrucao);
  const temFoto = linhaOc.tem_foto === true;

  // --- OC 49: gate de PRAZO EXPIRADO ---
  // Caio 2026-05-27: oc=49 só vira sugestão FALTA_DE_VOLUME quando setor
  // Perdas/Operação já bateu PRAZO. Instrução do motorista (na verdade,
  // do setor que lançou oc=49) precisa conter "PRAZO DE PERDAS EXPIRADO"
  // ou "PRAZO DE LOCALIZAÇÃO EXPIRADO" ou similar. Senão, agente NÃO
  // destaca proposta — card fica com 8 propostas padrão de oc=49 (regra
  // antiga preservada) sem sugestão IA.
  if (codigoOc === 49) {
    const instrLower = instrucao.toLowerCase();
    const indicaPrazoExpirado =
      /prazo\s+(de\s+)?(perdas?|localiza[cç][aã]o|buscas?)\s+(expirad[oa]|esgotad[oa]|excedid[oa]|encerrad[oa])/i.test(instrLower) ||
      /(perdas?|localiza[cç][aã]o|buscas?)\s+(expirad[oa]|esgotad[oa]|encerrad[oa])/i.test(instrLower) ||
      /(extravio|extraviad[oa])\s+(confirmad[oa]|definitivo|definitiv[oa])/i.test(instrLower);
    if (!indicaPrazoExpirado) {
      return {
        proposta_destacada: null,
        template_email_sugerido: null,
        corpo_email_sugerido: null,
        motivo_extraido: instrucao || null,
        foto_classificacao: null,
        tem_ressalva: false,
        ressalva_texto: null,
        ressalva_tipo: null,
        gps_distancia_metros: null,
        gps_dentro_threshold: null,
        tem_cte_devolucao: null,
        cte_devolucao_numero: null,
        confianca: 0.0,
        observacao_orquestrador:
          `oc=49 sem instrução qualificadora ("PRAZO DE PERDAS/LOCALIZAÇÃO EXPIRADO" ou similar). Setor de Perdas/Operação ainda tratando — agente IA não destaca nenhuma das 8 propostas; operador escolhe manual.`,
      };
    }
    // Tem PRAZO EXPIRADO → segue fluxo normal, vai cair no template FALTA_DE_VOLUME
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
  // Caio 2026-05-23: pra oc=19 (FALTA DE VOLUMES) a regra é mais rigorosa.
  // O SSWMOBILE preenche automaticamente a instrução do motorista com o texto
  // genérico "ENTREGA REALIZADA COM FALTA DE VOLUMES" — não comprova ressalva
  // de fato. Pra oc=19, motivo válido = APENAS ressalva manuscrita na foto
  // identificando volumes faltantes. Sem ressalva real → sugere 56.
  //
  // Pra oc=10/35 mantém fallback (instrução motorista pode ter motivo real
  // como "recusou por X" — não é texto padrão SSWMOBILE).
  const instrEhGenerico = ehMotivoSswGenerico(instrucao);
  const ressalvaTextoLimpo = (foto.ressalva_texto ?? "").trim();
  const ressalvaEhGenerica = ehMotivoSswGenerico(ressalvaTextoLimpo);
  const ressalvaValida = foto.tem_ressalva_na_foto && !ressalvaEhGenerica && ressalvaTextoLimpo.length > 0;

  // Caio 2026-05-23 (NF 2299043): limpa marcadores SSWMOBILE/GPS/SEFAZ antes
  // de salvar — não polui motivo_extraido nem corpo do email pro cliente.
  let motivoRaw: string | null;
  if (codigoOc === 19) {
    // oc=19: motivo SÓ via ressalva da foto. Ignora instrução motorista (SSWMOBILE genérico).
    motivoRaw = ressalvaValida ? ressalvaTextoLimpo : null;
  } else {
    // oc=10/35: motivo via instrução motorista OU ressalva foto.
    motivoRaw = !instrEhGenerico
      ? instrucao
      : (ressalvaValida ? ressalvaTextoLimpo : null);
  }
  const motivoConsolidado: string | null = motivoRaw ? removerMarcadoresSswmobile(motivoRaw) || null : null;

  // 3. oc=35 — verifica CT-e devolução (REVERSA) via listarCTRCsDaNF (re-uso de
  // dados já buscados pelo puxar-historico-ssw-card seria ideal, mas a função
  // que retorna lista é separada. Pra economizar, chamamos só pra oc=35 quando
  // tem motivo OK — senão a sugestão já é 56.
  let cteDevolucao: { numero: string | null; tem: boolean } = { numero: null, tem: false };
  if (codigoOc === 35 && motivoConsolidado) {
    cteDevolucao = await checarCteDevolucao(env, nf);
  }

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
      tem_cte_devolucao: codigoOc === 35 ? false : null,
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
    if (cteDevolucao.tem) {
      confianca = 0.95;
      observacao = `oc=35 com motivo escrito + CT-e de devolução identificado (${cteDevolucao.numero}). Evidência muito sólida.`;
    } else {
      confianca = 0.7;
      observacao = `oc=35 com motivo escrito mas SEM CT-e de devolução localizado. Operador deve validar com operação antes de notificar cliente — pode faltar a devolução formalizada.`;
    }
    if (foto.alerta_caixa_lacrada) {
      confianca = Math.min(confianca, 0.6);
      observacao = `⚠️ EVIDÊNCIA INDICA CAIXA LACRADA — ${foto.alerta_caixa_lacrada_motivo ?? "embalagem aparentemente íntegra com indicação de falta de itens internos"}. Pode não haver devolução real — apenas ressarcimento dos itens faltantes. Revise o template e o conteúdo do email antes de aprovar.`;
    }
  }

  const alertaCaixaLacrada = codigoOc === 35 ? foto.alerta_caixa_lacrada : null;
  const alertaCaixaLacradaMotivo = codigoOc === 35 ? foto.alerta_caixa_lacrada_motivo : null;

  return {
    proposta_destacada: 54,
    template_email_sugerido: template,
    corpo_email_sugerido: gerarCorpoEmail(template, {
      nf,
      motivo: motivoConsolidado,
      cte_devolucao: codigoOc === 35 ? cteDevolucao.numero : null,
    }),
    motivo_extraido: motivoConsolidado,
    foto_classificacao: foto.foto_classificacao,
    tem_ressalva: foto.tem_ressalva_na_foto,
    ressalva_texto: foto.ressalva_texto,
    ressalva_tipo: foto.ressalva_tipo,
    gps_distancia_metros: null,
    gps_dentro_threshold: null,
    tem_cte_devolucao: codigoOc === 35 ? cteDevolucao.tem : null,
    cte_devolucao_numero: codigoOc === 35 ? cteDevolucao.numero : null,
    alerta_caixa_lacrada: alertaCaixaLacrada,
    alerta_caixa_lacrada_motivo: alertaCaixaLacradaMotivo,
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

async function checarCteDevolucao(
  env: Record<string, string>,
  nf: string,
): Promise<{ numero: string | null; tem: boolean }> {
  // Chama uma edge wrapper que lista CTRCs da NF? Não temos. Vamos importar
  // direto do _shared/ssw-internal-client.ts e ler do SSW.
  try {
    const { readSswInternalEnv, obterSessao, listarCTRCsDaNF } = await import("../_shared/ssw-internal-client.ts");
    // Usa creds default (qualquer operador disponível) — só leitura.
    // Tenta LARISSA primeiro, fallback DUILIO, fallback default. Se nenhum
    // existir, retorna sem dados.
    let sswEnv;
    try {
      sswEnv = readSswInternalEnv(env, "LARISSA");
    } catch {
      try {
        sswEnv = readSswInternalEnv(env, "DUILIO");
      } catch {
        sswEnv = readSswInternalEnv(env);
      }
    }
    const sessao = await obterSessao(sswEnv);
    const ctrcs = await listarCTRCsDaNF(sessao, nf);
    const reversa = ctrcs.find((c) => c.tipo.toUpperCase() === "REVERSA" && !c.cancelado);
    return { numero: reversa?.ctrc ?? null, tem: !!reversa };
  } catch (err) {
    console.warn(`checarCteDevolucao falhou (nf=${nf}): ${err instanceof Error ? err.message : String(err)}`);
    return { numero: null, tem: false };
  }
}

function gerarCorpoEmail(
  template: string,
  ctx: { nf: string; motivo: string | null; gps_metros?: number | null; cte_devolucao?: string | null },
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
      // Caio 2026-05-27: REMOVIDA frase "sem notificação prévia" — factualmente
      // errada (entrega parcial é sempre precedida de notificação).
      return `Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino por falta de volume(s). Anotação registrada: "${ctx.motivo ?? ""}". Se preferir, podemos compartilhar informações detalhadas da recusa pra avaliar a melhor tratativa: seguir com devolução, nova tentativa de entrega ou aguardar.`;
    case "PROBLEMAS_COM_ENDERECO":
      return `Não conseguimos localizar o endereço de entrega da NF {nf}.${
        ctx.gps_metros != null ? ` Nossa equipe esteve a ${ctx.gps_metros}m da localização cadastrada.` : ""
      } Pode confirmar o endereço correto ou orientar uma referência pra próxima tentativa?`;
    default:
      return `Identificamos uma intercorrência na entrega da NF {nf}. Motivo: "${ctx.motivo ?? ""}". Aguardamos sua orientação.`;
  }
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
