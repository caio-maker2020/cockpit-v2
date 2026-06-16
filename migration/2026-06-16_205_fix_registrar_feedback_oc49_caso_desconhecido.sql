-- =============================================================================
-- 2026-06-16 — fix RPC registrar_feedback_oc49_caso_desconhecido
-- =============================================================================
-- Contexto: VICTOR (operador novo onboard 2026-06-15) clicou "Ensinar o agente"
-- na NF 681942 oc=49 (BUNZL EQUIPAMEN A.) e recebeu erro:
--
--   insert or update on table "agente_ocs_padrao_feedback" violates foreign
--   key constraint "agente_ocs_padrao_feedback_corrigido_por_fkey"
--
-- Causa raiz: a RPC gravava `corrigido_por = auth.uid()` direto, mas a FK
-- aponta pra `operadores.id`. Em TODOS os operadores `operadores.id` ≠
-- `auth.users.id` (linkados via coluna `operadores.user_id`).
--
-- Por que ninguém percebeu antes: tipo_feedback='caso_nao_reconhecido' tem
-- 0 registros na tabela — bug nunca deixou ninguém criar feedback desse tipo.
-- VICTOR foi o primeiro operador a clicar nesse fluxo específico.
--
-- Outras 3 RPCs do mesmo arquivo (`registrar_feedback_oc13_ia`,
-- `registrar_feedback_ocs_padrao_ia`, `registrar_feedback_interpretador_resposta_ia`)
-- já fazem a tradução correta `auth.uid() → operadores.id via user_id`. Esta
-- RPC é a única outlier — replicação do mesmo padrão.
--
-- Sem backfill: 0 registros afetados retroativamente.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.registrar_feedback_oc49_caso_desconhecido(
  p_card_id uuid,
  p_explicacao text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_auth_uid uuid := auth.uid();
  v_operador_id uuid;
  v_operador_nome text;
  v_codigo_oc int;
  v_decisao_ia jsonb;
  v_id uuid;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'auth.uid() vazio — operador precisa estar autenticado'
      USING ERRCODE = '42501';
  END IF;

  -- Caio 2026-06-16: tradução auth.uid → operadores.id (mesmo padrão das
  -- outras 3 RPCs de feedback). FK corrigido_por aponta pra operadores.id,
  -- não auth.users.id.
  SELECT id, nome INTO v_operador_id, v_operador_nome
  FROM public.operadores
  WHERE user_id = v_auth_uid AND ativo = true
  LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador (auth.uid=%) não cadastrado/ativo em public.operadores', v_auth_uid
      USING ERRCODE = '42501';
  END IF;

  IF p_card_id IS NULL THEN
    RAISE EXCEPTION 'p_card_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_explicacao IS NULL OR length(btrim(p_explicacao)) < 10 THEN
    RAISE EXCEPTION 'p_explicacao precisa ter pelo menos 10 caracteres'
      USING ERRCODE = '22023';
  END IF;

  -- Snapshot da decisão IA + oc do card (contexto)
  SELECT cod_ultima_ocorrencia, analise_padrao_resultado
    INTO v_codigo_oc, v_decisao_ia
  FROM public.cards
  WHERE id = p_card_id;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback,
    decisao_ia, decisao_correta_codigo_ssw, motivo_correcao,
    corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id,
    v_codigo_oc,
    'caso_nao_reconhecido',
    COALESCE(v_decisao_ia, '{}'::jsonb),
    NULL,  -- desconhecido por definição
    btrim(p_explicacao),
    v_operador_id,
    v_operador_nome
  )
  RETURNING id INTO v_id;

  -- Audit no card_events (mantém histórico mesmo se row deletada futuramente)
  INSERT INTO public.card_events (
    card_id, event_type, actor_type, actor_id, payload
  ) VALUES (
    p_card_id,
    'FeedbackAgenteOc49CasoDesconhecido',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'explicacao', btrim(p_explicacao),
      'codigo_oc_card', v_codigo_oc,
      'operador_nome', v_operador_nome
    )
  );

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.registrar_feedback_oc49_caso_desconhecido(uuid, text) IS
  '2026-06-16: traduz auth.uid → operadores.id via user_id antes do INSERT '
  '(fix FK violation reportado por VICTOR NF 681942). Padrão consistente '
  'com registrar_feedback_oc13_ia / ocs_padrao_ia / interpretador_resposta_ia.';
