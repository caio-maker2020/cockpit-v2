-- ============================================================================
-- Cockpit v2 — Auto-aprovação de ação proposta pelo agente
-- Data: 2026-04-29
--
-- Caso de uso piloto (TESTE — só rola pra NF allowlist no vinculador):
-- Reentrega onde:
--   1. Última ocorrência SSW = 13 ("Aguardando autorização")
--   2. IA detectou autorização explícita do cliente no email
--   → agente lança ocorrência 21 SEM precisar do operador clicar Aprovar.
--
-- Auditoria visual no Lovable continua: timeline mostra evento
-- AutoAprovacaoPermitida + todo aparece com status='aprovado' e
-- approved_by=NULL + auto_approval_rule preenchido. UI pode renderizar
-- badge "Auto" diferente de "Aprovado por X".
--
-- Diferença pra aprovar_e_executar:
--   - Não exige auth.uid() (chamado pelo vinculador via service_role)
--   - approved_by fica NULL (não é humano)
--   - card_event = 'AutoAprovacaoPermitida' (ao invés de AprovacaoOperador)
--   - todos.auto_approval_rule preenchido (rastreabilidade)
-- ============================================================================

-- ============================================================================
-- Coluna nova em todos pra rastrear regra de auto-aprovação
-- ============================================================================
ALTER TABLE public.todos
  ADD COLUMN IF NOT EXISTS auto_approval_rule text;

COMMENT ON COLUMN public.todos.auto_approval_rule IS
  'Quando NÃO NULL, indica que o todo foi auto-aprovado pelo sistema (sem '
  'operador humano) e qual regra disparou. Ex: "ultima_oc_13_e_cliente_autorizou_reentrega". '
  'Quando NULL, aprovação foi humana (approved_by != NULL) ou todo ainda pendente.';

-- ============================================================================
-- RPC: auto_aprovar_e_executar(p_todo_id, p_regra)
-- Chamado pelo vinculador (service_role) quando regra de auto-aprovação bate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_aprovar_e_executar(
  p_todo_id uuid,
  p_regra text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_todo record;
  v_card record;
  v_msg_id bigint;
BEGIN
  IF p_regra IS NULL OR length(trim(p_regra)) = 0 THEN
    RAISE EXCEPTION 'Regra de auto-aprovação obrigatória — sem regra não há rastreabilidade';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo
  FROM public.todos
  WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já está em status=%, não pode auto-aprovar',
      p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, nf, ctrc INTO v_card
  FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  -- 1. Evento de auditoria — visível na timeline do Lovable
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id,
    'AutoAprovacaoPermitida',
    'system',
    'vinculador',
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'regra', p_regra,
      'proposta_payload', v_todo.proposta_payload
    )
  );

  -- 2. UPDATE todo — approved_by NULL distingue auto vs humano
  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = NULL,
      approved_at = now(),
      auto_approval_rule = p_regra
  WHERE id = p_todo_id;

  -- 3. Mesma mensagem que aprovar_e_executar enfileira — executor consome igual
  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'action_id', v_todo.action_id,
    'proposta_payload', v_todo.proposta_payload,
    'aprovado_por', NULL,
    'auto_approval_rule', p_regra,
    'card_nf', v_card.nf,
    'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'regra', p_regra,
    'pgmq_msg_id', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_aprovar_e_executar(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_aprovar_e_executar(uuid, text) TO service_role;

COMMENT ON FUNCTION public.auto_aprovar_e_executar IS
  'Auto-aprovação atômica: grava AutoAprovacaoPermitida event, marca todo como '
  'aprovado com auto_approval_rule (sem approved_by), enfileira no executor. '
  'Chamada pelo vinculador (service_role) quando regra de auto-execução bate. '
  'Mesmo efeito final que aprovar_e_executar mas sem operador humano.';
