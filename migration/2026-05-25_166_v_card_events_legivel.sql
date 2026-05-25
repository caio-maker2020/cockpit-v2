-- =============================================================================
-- 2026-05-25_166 — v_card_events_legivel (histórico narrado pro front)
--
-- Caio 2026-05-25: histórico de eventos no Lovable estava cru — operador via
-- "PendenciasRespostaIgnoradas" em vez de "DURAFA ignorou pendências da IA".
-- Confuso pra entender o que aconteceu (NF 648153).
--
-- Esta view normaliza ~30 event_types com:
--   - narrativa: linha legível em PT-BR
--   - ator_nome: resolvido pelo actor_id quando actor_type='operator'
--   - categoria: bastao / ssw / ia / operador / sistema (pra ícone/filtro)
--   - severidade: info / sucesso / atencao / erro (pra cor)
--   - payload original mantido (pra "Ver detalhe técnico" colapsável)
--
-- security_invoker=on respeita RLS de card_events (lembra
-- [[feedback_views_publicas_security_invoker]]).
-- =============================================================================

DROP VIEW IF EXISTS public.v_card_events_legivel CASCADE;

CREATE VIEW public.v_card_events_legivel
WITH (security_invoker = on)
AS
WITH base AS (
  SELECT
    ce.id,
    ce.card_id,
    ce.event_type,
    ce.actor_type,
    ce.actor_id,
    ce.payload,
    ce.created_at,
    CASE
      WHEN ce.actor_type = 'operator' THEN
        COALESCE(
          (SELECT o.nome FROM public.operadores o WHERE o.id::text = ce.actor_id LIMIT 1),
          'operador'
        )
      WHEN ce.actor_type = 'agent' THEN
        CASE ce.actor_id
          WHEN 'executor' THEN 'Executor'
          WHEN 'interpretador-resposta-cliente' THEN 'IA Resposta Cliente'
          WHEN 'agente-oc13-autonomo' THEN 'Agente IA oc=13'
          WHEN 'agente-sugere-ocs-padrao' THEN 'Agente IA ocs padrão'
          WHEN 'vinculador' THEN 'Vinculador'
          WHEN 'monitor-prioridades-ai' THEN 'Monitor IA'
          WHEN 'priorizador-ai' THEN 'Priorizador IA'
          WHEN 'redator' THEN 'Redator IA'
          ELSE COALESCE(ce.actor_id, 'agente')
        END
      ELSE 'Sistema'
    END AS ator_nome
  FROM public.card_events ce
)
SELECT
  b.id,
  b.card_id,
  b.event_type,
  b.actor_type,
  b.actor_id,
  b.payload,
  b.created_at,
  b.ator_nome,
  -- ---------- CATEGORIA ----------
  CASE
    WHEN b.event_type LIKE 'Bastao%' OR b.event_type LIKE 'BastaoCard%' THEN 'bastao'
    WHEN b.event_type IN ('AtualizadoViaPortalSsw','HistoricoSswPuxado','AcaoExecutadaConfirmadaPeloSsw') THEN 'ssw'
    WHEN b.event_type LIKE 'AgenteO%' OR b.event_type IN ('InterpretadorRespostaClienteConcluido','FeedbackAgenteOc13','FeedbackAgenteOcsPadrao') THEN 'ia'
    WHEN b.actor_type = 'operator' THEN 'operador'
    ELSE 'sistema'
  END AS categoria,
  -- ---------- SEVERIDADE ----------
  CASE
    WHEN b.event_type IN ('AcaoFalhou','AcaoRevertidaPosFalha','AgenteOc13Falhou','AgenteOcsPadraoFalhou','ErroLancamentoReportado') THEN 'erro'
    WHEN b.event_type IN ('AcaoExecutada','AcaoExecutadaConfirmadaPeloSsw','StateTransicaoPosSucesso','OperadorReatribuido') THEN 'sucesso'
    WHEN b.event_type IN ('BastaoDivergiuSswReconciliado','PendenciasRespostaIgnoradas','LinkEvidenciaOmitido','TabelaDeprecada') THEN 'atencao'
    ELSE 'info'
  END AS severidade,
  -- ---------- NARRATIVA ----------
  CASE b.event_type
    -- ====== BASTÃO ======
    WHEN 'BastaoCardImportado' THEN
      format('Card importado do Bastão (oc=%s, %s)',
        b.payload->>'cod_ultima_ocorrencia',
        COALESCE(b.payload->>'segmento_cliente','segmento ?'))
    WHEN 'BastaoCardAtualizado' THEN
      format('Bastão sincronizado: oc %s → %s',
        COALESCE(b.payload->'previous'->>'cod_ultima_ocorrencia','?'),
        COALESCE(b.payload->'current'->>'cod_ultima_ocorrencia','?'))
    WHEN 'BastaoDivergiuSswReconciliado' THEN
      format('Bastão divergiu do SSW (Bastão=%s, SSW real=%s) — reconciliado',
        b.payload->>'oc_bastao_recebida', b.payload->>'oc_ssw_real')

    -- ====== SSW ======
    WHEN 'HistoricoSswPuxado' THEN
      format('Histórico SSW puxado (%s ocorrências)',
        COALESCE(b.payload->>'total_ocorrencias','?'))
    WHEN 'AtualizadoViaPortalSsw' THEN
      format('SSW interno consultado: oc %s → %s, state %s',
        COALESCE(b.payload->>'oc_anterior','?'),
        COALESCE(b.payload->>'oc_atual','?'),
        COALESCE(b.payload->>'state_novo','?'))
    WHEN 'AcaoExecutadaConfirmadaPeloSsw' THEN
      format('SSW confirmou oc=%s lançada (state=%s)',
        b.payload->>'oc_ssw', COALESCE(b.payload->>'state_novo','?'))
    WHEN 'LinkEvidenciaOmitido' THEN
      format('Link de evidência omitido (oc=%s — bloqueada no tracking público)',
        b.payload->>'cod_ocorrencia')
    WHEN 'ChaveCteResolvida' THEN
      format('Chave CT-e resolvida (%s caracteres)', b.payload->>'len')

    -- ====== IA / AGENTES ======
    WHEN 'InterpretadorRespostaClienteConcluido' THEN
      format('IA interpretou resposta do cliente: sugere oc=%s (confiança %s%%) — %s',
        COALESCE(b.payload->>'oc_sugerida','?'),
        COALESCE(round((b.payload->>'confianca')::numeric * 100)::text, '?'),
        COALESCE(left(b.payload->>'motivo', 200), ''))
    WHEN 'AgenteOcsPadraoDecisao' THEN
      format('Agente IA (oc %s) decidiu: sugere oc=%s',
        b.payload->>'codigo_oc_card',
        b.payload->'decisao'->>'proposta_destacada')
    WHEN 'AgenteOc13Decisao' THEN
      format('Agente IA oc=13 decidiu: %s',
        b.payload->'decisao'->>'decisao')
    WHEN 'AgenteOcsPadraoFalhou' THEN
      format('Agente IA (oc %s) falhou — %s (tentativa %s/3)',
        b.payload->>'codigo_oc',
        COALESCE(b.payload->>'categoria','?'),
        b.payload->>'tentativa')
    WHEN 'AgenteOc13Falhou' THEN
      format('Agente IA oc=13 falhou — %s (tentativa %s/3)',
        COALESCE(b.payload->>'categoria','?'),
        b.payload->>'tentativa')
    WHEN 'FeedbackAgenteOc13' THEN
      format('%s registrou feedback: %s',
        b.ator_nome, COALESCE(b.payload->>'tipo_feedback','?'))
    WHEN 'FeedbackAgenteOcsPadrao' THEN
      format('%s registrou feedback: %s',
        b.ator_nome, COALESCE(b.payload->>'tipo_feedback','?'))

    -- ====== OPERADOR ======
    WHEN 'AprovacaoOperador' THEN
      format('%s aprovou oc=%s%s',
        b.ator_nome,
        COALESCE(b.payload->'proposta_payload'->'args'->>'codigo_ssw','?'),
        CASE WHEN b.payload->'extras'->>'template_id_override' IS NOT NULL
             THEN ' + email (' || (b.payload->'extras'->>'template_id_override') || ')'
             WHEN (b.payload->'extras'->>'enviar_email')::boolean
             THEN ' + email'
             ELSE ''
        END)
    WHEN 'PendenciasRespostaIgnoradas' THEN
      format('%s ignorou as pendências da IA (card voltou pra AGUARDANDO_CLIENTE)',
        b.ator_nome)
    WHEN 'TodoPropostoManualmente' THEN
      format('%s adicionou manualmente proposta oc=%s',
        b.ator_nome, b.payload->>'codigo_ssw')

    -- ====== EXECUTOR / AÇÕES ======
    WHEN 'AcaoExecutada' THEN
      format('Executor lançou oc=%s no SSW (sucesso — protocolo %s)',
        b.payload->>'codigo_ssw',
        COALESCE(b.payload->>'protocolo','—'))
    WHEN 'AcaoFalhou' THEN
      format('Executor falhou ao lançar oc=%s: %s',
        b.payload->>'codigo_ssw',
        left(COALESCE(b.payload->>'error',''), 120))
    WHEN 'AcaoRevertidaPosFalha' THEN
      format('Sistema reverteu lock após falha SSW: %s',
        left(COALESCE(b.payload->>'motivo',''), 200))
    WHEN 'StateTransicaoPosSucesso' THEN
      format('Card transição → %s (oc=%s lançada)',
        b.payload->>'state_novo', b.payload->>'codigo_ssw')

    -- ====== MENSAGENS ======
    WHEN 'RespostaClienteCapturada' THEN
      format('Email recebido de %s: "%s"',
        COALESCE(b.payload->>'remetente','?'),
        left(COALESCE(b.payload->>'preview',''), 120))
    WHEN 'MensagemAnexadaPorThread' THEN
      format('Mensagem de %s anexada via thread (resposta a email anterior)',
        COALESCE(b.payload->>'remetente','?'))
    WHEN 'RespostaEnviada' THEN
      format('Email enviado pra %s — assunto: "%s"',
        COALESCE(b.payload->>'destinatario','?'),
        left(COALESCE(b.payload->>'subject',''), 100))
    WHEN 'RetornoClienteEmAguardo' THEN
      format('Cliente respondeu — sistema criou %s novas propostas (state=%s)',
        jsonb_array_length(COALESCE(b.payload->'propostas'->'criados','[]'::jsonb)),
        COALESCE(b.payload->>'new_state','?'))

    -- ====== PROPOSTAS / TODOS ======
    WHEN 'TodoPropostoAutomaticamente' THEN
      format('Sistema propôs %s ações automaticamente (regra %s)',
        jsonb_array_length(COALESCE(b.payload->'todos_criados','[]'::jsonb)),
        COALESCE(b.payload->>'regra','?'))
    WHEN 'TodosConcorrentesCancelados' THEN
      format('%s propostas canceladas (operador escolheu uma)',
        COALESCE(b.payload->>'cancelados','?'))

    -- ====== OUTROS ======
    WHEN 'OperadorReatribuido' THEN
      format('Card reatribuído: %s → %s (%s)',
        COALESCE(b.payload->>'responsavel_anterior','?'),
        COALESCE(b.payload->>'responsavel_novo','?'),
        COALESCE(b.payload->>'motivo','sem motivo'))
    WHEN 'ErroLancamentoReportado' THEN
      format('%s reportou erro de lançamento (categoria: %s)',
        b.ator_nome,
        COALESCE(b.payload->>'motivo_categoria','?'))
    WHEN 'TabelaDeprecada' THEN 'Tabela marcada como deprecated (manutenção sistema)'

    ELSE
      -- fallback: humaniza minimamente o event_type
      regexp_replace(b.event_type, '([a-z])([A-Z])', '\1 \2', 'g')
  END AS narrativa
FROM base b;

GRANT SELECT ON public.v_card_events_legivel TO authenticated, service_role;

COMMENT ON VIEW public.v_card_events_legivel IS
  'Histórico de eventos do card em formato narrativo human-readable. '
  'Caio 2026-05-25 (NF 648153): substitui exibição crua do event_type por linhas '
  'compreensíveis em PT-BR pro operador entender o que aconteceu sem precisar '
  'decodificar payload JSON.';
