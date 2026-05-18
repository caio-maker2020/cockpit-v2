-- ============================================================================
-- Cockpit v2 — Cancelamento reentrega: status 'precisa_acao' + subcategorias
-- Data: 2026-05-18
--
-- Evolução do tipo 'cancelar_reentrega_ssw' em acoes_agendadas:
--   - Falhas DEFINITIVAS (CTRC faturado, sem permissão, fora de prazo, já
--     cancelado) NÃO devem virar status='cancelado' silencioso — operador
--     precisa ser avisado pra agir manualmente (ex: pedir Maisa pra excluir
--     da fatura). Novo status='precisa_acao' marca isso.
--   - Subcategoria da falha + sugestão de ação ficam no payload pra
--     renderização contextual na aba de monitoramento + futuras automações.
--
-- Estados pós-fix:
--   pendente              → aguardando cron rodar (ou retry após falha temp)
--   processado            → cancelamento gravado no SSW com sucesso
--   precisa_acao          → falha definitiva; operador precisa intervir
--   tratado_manualmente   → operador marcou como resolvido na aba (após agir
--                            fora do sistema ou aceitar a falha)
--   cancelado             → ação desistida programaticamente (raro; ex:
--                            card em RESOLVIDO antes da hora)
-- ============================================================================

-- ----- 1. Estender CHECK constraint do status -----------------------------

ALTER TABLE public.acoes_agendadas
  DROP CONSTRAINT IF EXISTS acoes_agendadas_status_check;

ALTER TABLE public.acoes_agendadas
  ADD CONSTRAINT acoes_agendadas_status_check
  CHECK (status IN ('pendente', 'processado', 'cancelado', 'precisa_acao', 'tratado_manualmente'));

-- ----- 2. View atualizada incluindo subcategoria + sugestão ---------------

DROP VIEW IF EXISTS public.v_cancelamentos_reentrega;

CREATE VIEW public.v_cancelamentos_reentrega AS
SELECT
  aa.id,
  aa.card_id,
  c.nf,
  c.ctrc                              AS ctrc_original,
  aa.executar_em,
  aa.processed_at,
  aa.status,
  aa.cancelado_motivo,
  aa.payload->>'operador_nome'        AS operador,
  COALESCE(aa.payload->>'responsavel_relacionamento', aa.payload->>'operador_nome') AS responsavel_relacionamento,
  aa.payload->>'lancamento_em'        AS oc21_lancada_em,
  aa.payload->>'ctrc_cancelado'       AS ctrc_reentrega_cancelado,
  aa.payload->>'subcategoria_falha'   AS subcategoria_falha,
  aa.payload->>'sugestao_acao'        AS sugestao_acao,
  aa.payload->>'ultima_falha'         AS ultima_falha,
  (aa.payload->>'tentativas')::int    AS tentativas,
  aa.payload->>'tratado_em'           AS tratado_em,
  aa.payload->>'tratado_por'          AS tratado_por,
  aa.payload->>'tratado_motivo'       AS tratado_motivo,
  aa.created_at                       AS agendado_em
FROM public.acoes_agendadas aa
JOIN public.cards c ON c.id = aa.card_id
WHERE aa.tipo = 'cancelar_reentrega_ssw'
ORDER BY aa.created_at DESC;

GRANT SELECT ON public.v_cancelamentos_reentrega TO authenticated, service_role;

COMMENT ON VIEW public.v_cancelamentos_reentrega IS
  'Caio 2026-05-18 v2: visibilidade de cancelamentos automáticos de reentrega + ações pendentes. '
  'Estados: pendente=aguardando cron, processado=ok no SSW, '
  'precisa_acao=falha definitiva exige operador, tratado_manualmente=operador resolveu fora, '
  'cancelado=ação descartada programaticamente.';

-- ----- 3. RPC pra operador marcar como tratado ----------------------------

CREATE OR REPLACE FUNCTION public.marcar_cancelamento_tratado(
  p_acao_id bigint,
  p_motivo text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card_id uuid;
  v_user uuid;
BEGIN
  v_user := auth.uid();

  SELECT card_id INTO v_card_id
  FROM public.acoes_agendadas
  WHERE id = p_acao_id AND tipo = 'cancelar_reentrega_ssw';

  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'Ação % não encontrada ou não é do tipo cancelar_reentrega_ssw', p_acao_id;
  END IF;

  UPDATE public.acoes_agendadas
  SET
    status = 'tratado_manualmente',
    processed_at = now(),
    payload = payload
      || jsonb_build_object(
        'tratado_em', now()::text,
        'tratado_por', COALESCE(v_user::text, 'sistema'),
        'tratado_motivo', COALESCE(p_motivo, '')
      )
  WHERE id = p_acao_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_card_id,
    'CancelamentoReentregaTratadoManualmente',
    'operator',
    COALESCE(v_user::text, 'sistema'),
    jsonb_build_object('acao_id', p_acao_id, 'motivo', COALESCE(p_motivo, ''))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.marcar_cancelamento_tratado(bigint, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.marcar_cancelamento_tratado(bigint, text) IS
  'Caio 2026-05-18: operador marca cancelamento como "tratado manualmente" (resolveu fora do '
  'sistema OU aceitou que não vai ser cancelado). Move status pra tratado_manualmente, registra '
  'card_event de auditoria.';
