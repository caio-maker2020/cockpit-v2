-- ============================================================================
-- Cockpit v2 — RPC reportar_erro_lancamento_via_agente
-- Caio 2026-05-22
--
-- A RPC `reportar_erro_lancamento` (mig 145) exige `auth.uid()` (operador
-- autenticado). O agente IA `agente-oc13-autonomo` roda via service_role e
-- não tem auth.uid → precisa de RPC irmã sem essa exigência.
--
-- Segregação: operador continua na RPC v2 autenticada (auditável por user).
-- Agente tem RPC service_role-only (nunca callable por user). Reduz risco
-- de bypass acidental do auth.uid.
--
-- skill: supabase-postgres-best-practices
--   - SECURITY DEFINER + search_path=public
--   - REVOKE explícito ALL FROM PUBLIC, authenticated
--   - GRANT EXECUTE pra service_role somente
--   - Reusa CHECK constraint motivo_categoria + UPSERT por chave única
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reportar_erro_lancamento_via_agente(
  p_card_id uuid,
  p_codigo_oc_errada int,
  p_codigo_oc_correta int,
  p_descricao_oc_errada text DEFAULT NULL,
  p_data_oc_errada text DEFAULT NULL,
  p_base_responsavel text DEFAULT NULL,
  p_usuario_responsavel text DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_motivo_categoria text DEFAULT 'EVIDENCIA_INCOMPLETA',
  p_agente_nome text DEFAULT 'agente-oc13-autonomo'
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
  v_oc_correta int;
  v_motivo_limpo text;
BEGIN
  IF p_base_responsavel IS NULL OR p_usuario_responsavel IS NULL THEN
    RAISE EXCEPTION 'base_responsavel e usuario_responsavel são obrigatórios (vêm do historico_ssw)';
  END IF;

  IF p_motivo_categoria NOT IN ('OC_DIFERENTE','EVIDENCIA_INCOMPLETA') THEN
    RAISE EXCEPTION 'motivo_categoria inválido: % (válidos: OC_DIFERENTE | EVIDENCIA_INCOMPLETA)', p_motivo_categoria;
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo, '')), '');

  IF p_motivo_categoria = 'EVIDENCIA_INCOMPLETA' THEN
    v_oc_correta := p_codigo_oc_errada;
    IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
      RAISE EXCEPTION 'Pra erro de evidência, descreva o motivo (mínimo 10 caracteres)'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_oc_correta := p_codigo_oc_correta;
    IF v_oc_correta = p_codigo_oc_errada THEN
      RAISE EXCEPTION 'Pra erro de OC, oc correta deve ser DIFERENTE da errada'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.erros_lancamento_ssw (
    card_id, codigo_oc_errada, codigo_oc_correta,
    descricao_oc_errada, data_oc_errada,
    base_responsavel, usuario_responsavel,
    motivo, motivo_categoria,
    reportado_por, reportado_por_nome
  ) VALUES (
    p_card_id, p_codigo_oc_errada, v_oc_correta,
    p_descricao_oc_errada, p_data_oc_errada,
    p_base_responsavel, p_usuario_responsavel,
    v_motivo_limpo, p_motivo_categoria,
    NULL, p_agente_nome
  )
  ON CONFLICT (card_id, codigo_oc_errada, data_oc_errada, usuario_responsavel)
  DO UPDATE SET
    codigo_oc_correta = EXCLUDED.codigo_oc_correta,
    motivo = EXCLUDED.motivo,
    motivo_categoria = EXCLUDED.motivo_categoria,
    reportado_por = EXCLUDED.reportado_por,
    reportado_por_nome = EXCLUDED.reportado_por_nome
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'ErroLancamentoReportado',
    'agent',
    p_agente_nome,
    jsonb_build_object(
      'erro_id', v_id,
      'codigo_oc_errada', p_codigo_oc_errada,
      'codigo_oc_correta', v_oc_correta,
      'motivo_categoria', p_motivo_categoria,
      'base_responsavel', p_base_responsavel,
      'usuario_responsavel', p_usuario_responsavel,
      'motivo', v_motivo_limpo,
      'via', 'agente'
    )
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reportar_erro_lancamento_via_agente(
  uuid, int, int, text, text, text, text, text, text, text
) FROM PUBLIC, authenticated, anon;

GRANT EXECUTE ON FUNCTION public.reportar_erro_lancamento_via_agente(
  uuid, int, int, text, text, text, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.reportar_erro_lancamento_via_agente IS
  'Versão da reportar_erro_lancamento pra service_role (agente IA). Sem auth.uid(). '
  'reportado_por=NULL, reportado_por_nome=p_agente_nome. Caio 2026-05-22.';
