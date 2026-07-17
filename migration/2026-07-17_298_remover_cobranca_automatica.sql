-- =============================================================================
-- FASE 2 do fix "fila acoes_agendadas saturada" — REMOÇÃO DEFINITIVA da
-- cobrança automática (decisão Caio/Matheus 2026-07-17: "pode apagar a
-- cobrança automática, não usaremos mais; não vai ter flag").
--
-- ⚠️ NUMERAÇÃO: conferir contra prod (migs 292–296 aplicadas do repo antigo).
-- ⚠️ ORDEM: aplicar DEPOIS da mig 297 (que cancela as cobranças pendentes).
--
-- Contexto: a mig 168 "desativou" a cobrança fechando só o cron; 5 portas
-- continuaram criando ações (executor inline/manual/relancamento_54,
-- enviar-resposta x2, marcar_retorno_inconclusivo) e a fila recresceu 7
-- semanas até saturar a janela LIMIT 200 e starvar os cancelamentos de
-- reentrega (ver mig 297 e audits/FIX_FILA_ACOES_AGENDADAS_SATURADA_2026-07-16.md).
--
-- Este arquivo REMOVE a feature na raiz:
--   1. marcar_retorno_inconclusivo reescrito SEM agendamento de cobrança
--      (era a única porta em SQL; as portas em código morrem no deploy das
--      edge functions executor + enviar-resposta, mesmo passo).
--   2. DROP do RPC agendar_cobranca_email (assinatura viva da mig 035).
--      Versão antiga de edge function que ainda chame o RPC recebe {error}
--      logado (código novo checa {error}) e NADA é criado — fail-safe.
--   3. Nenhuma flag: feature apagada, não desativada. Religar exigiria
--      migration nova + ADR (decisão consciente, não um toggle).
--
-- O handler de cobranca_email no processar-acoes-agendadas FICA (defensivo):
-- qualquer ação residual criada por versão antiga ainda é drenada com
-- INV-fila (reagenda com teto → cancelado + alerta) em vez de virar pendência
-- eterna ou "Tipo desconhecido".
-- =============================================================================

-- 1. marcar_retorno_inconclusivo (definição viva: mig 041) — idêntico ao
-- original EXCETO: não agenda mais cobrança (era INSERT direto de
-- cobranca_email chamado pelo botão "retorno inconclusivo" do front) e o
-- evento/retorno passam a dizer a verdade (cobranca_agendada: false).
CREATE OR REPLACE FUNCTION public.marcar_retorno_inconclusivo(
  p_card_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_acoes_canc int;
  v_todos_canc int;
BEGIN
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state NOT IN ('AGUARDANDO_AGENTE', 'AGUARDANDO_VALIDACAO_HUMANA') THEN
    RAISE EXCEPTION 'Só funciona em AGUARDANDO_AGENTE ou AGUARDANDO_VALIDACAO_HUMANA (atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH canc AS (
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = 'retorno marcado como inconclusivo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_acoes_canc FROM canc;

  WITH todos_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = 'retorno inconclusivo — operadora reiniciou ciclo'
    WHERE card_id = p_card_id AND status = 'pendente'
    RETURNING 1
  )
  SELECT count(*) INTO v_todos_canc FROM todos_canc;

  -- Move pra AGUARDANDO_CLIENTE + destrava lock + limpa aviso
  UPDATE public.cards
  SET state = 'AGUARDANDO_CLIENTE',
      lock_aguardando_validacao = false,
      aviso_alteracao_oc = NULL
  WHERE id = p_card_id;

  -- Cobrança automática REMOVIDA (2026-07-17): não agenda mais nada aqui.
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'RetornoMarcadoComoInconclusivo',
    'operator',
    v_operador_id::text,
    jsonb_build_object(
      'motivo', coalesce(p_motivo, '(sem motivo)'),
      'acoes_canceladas', v_acoes_canc,
      'todos_cancelados', v_todos_canc,
      'cobranca_agendada', false,
      'cobranca_removida_em', '2026-07-17 (mig 298 — feature apagada)',
      'state_anterior', v_card.state,
      'state_novo', 'AGUARDANDO_CLIENTE'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'acoes_canceladas', v_acoes_canc,
    'todos_cancelados', v_todos_canc,
    'cobranca_agendada', false
  );
END;
$$;

-- 2. DROP do RPC de agendamento (assinatura viva da mig 035; a de 4 args só
-- existiria se uma versão intermediária desta branch tivesse sido aplicada).
DROP FUNCTION IF EXISTS public.agendar_cobranca_email(uuid, text, int);
DROP FUNCTION IF EXISTS public.agendar_cobranca_email(uuid, text, int, text);

-- 3. Higiene: garantir que a flag intermediária não existe (nunca aplicada em
-- prod; no-op na prática, aqui só por idempotência de ambientes de teste).
DELETE FROM public.feature_flags WHERE key = 'cobranca_automatica_enabled';
