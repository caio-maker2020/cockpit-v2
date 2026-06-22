-- 2026-06-22_227 — reverter_acao_falhou: extravio falho volta pra EXTRAVIOS
--
-- BUG (NF 114763, Duilio): card de extravio (oc=6) na aba EXTRAVIOS teve a ação
-- "Notificar cliente por e-mail (sem lançar ocorrência)" aprovada; a ação falhou
-- e reverter_acao_falhou jogou o card pra state=AGUARDANDO_VALIDACAO_HUMANA →
-- ele saiu da aba EXTRAVIOS (que filtra state=EXTRAVIO_MONITORADO + oc 6/9/16)
-- e foi parar na aba "AGUARDANDO VOCÊ". O operador espera o card de volta em
-- EXTRAVIOS, onde os cards de extravio vivem (kanban D1-D5).
--
-- FIX: quando o todo que falhou é de origem extravio_cockpit E o card ainda é um
-- extravio (cod_ultima_ocorrencia IN 6/9/16), reverter pra EXTRAVIO_MONITORADO
-- (lock=false pra permitir nova tentativa) em vez de AGUARDANDO_VALIDACAO_HUMANA.
-- Mantém o acao_falhou_motivo pra rastreabilidade (some no próximo sucesso, via
-- executor). Demais casos (relacionamento etc.) seguem o fluxo normal.
--
-- Par desta correção: executor (skip_oc success) passa a devolver o card pra
-- EXTRAVIO_MONITORADO no SUCESSO do e-mail (antes ficaria preso em
-- EXECUTANDO_ACAO). Backend only; nenhuma mudança no front (Lovable).

CREATE OR REPLACE FUNCTION public.reverter_acao_falhou(p_todo_id uuid, p_motivo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_todo record;
  v_approved_at timestamptz;
  v_ressuscitados int;
  v_card_oc int;
  v_is_extravio boolean;
  v_state_novo text;
BEGIN
  SELECT id, card_id, status, approved_at, proposta_payload INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id;
  END IF;

  v_approved_at := COALESCE(v_todo.approved_at, now());

  -- Ressuscita TODOS os todos do card criados <= approved_at do aprovado
  -- que NÃO estejam em 'pendente' nem 'executado'.
  -- - cancelado → pendente (concorrentes cancelados pela aprovação)
  -- - falhou → pendente (a tentativa que falhou; permite retentar)
  -- - executando → pendente (oc lançada mas algo falhou depois; ex: email)
  -- - aprovado → pendente (estado intermediário antes do enqueue)
  -- - executado NÃO mexe (oc confirmada no SSW; rollback impossível)
  WITH ressuscitados AS (
    UPDATE public.todos
    SET status = 'pendente',
        rejection_reason = NULL
    WHERE card_id = v_todo.card_id
      AND created_at <= v_approved_at
      AND status IN ('cancelado', 'falhou', 'executando', 'aprovado')
    RETURNING id
  )
  SELECT count(*) INTO v_ressuscitados FROM ressuscitados;

  -- Caio 2026-06-22 (mig 227): ação de extravio que falha volta pra a aba
  -- EXTRAVIOS, não pra "AGUARDANDO VOCÊ". Só redireciona se o todo veio do
  -- extravios (origem=extravio_cockpit) E o card AINDA é um extravio (oc 6/9/16).
  -- Se a oc já mudou (card seguiu pro fluxo de relacionamento), cai no ELSE e
  -- segue a validação humana normal.
  SELECT cod_ultima_ocorrencia INTO v_card_oc FROM public.cards WHERE id = v_todo.card_id;
  v_is_extravio := (v_todo.proposta_payload->'meta'->>'origem' = 'extravio_cockpit')
                   AND (v_card_oc = ANY (ARRAY[6, 9, 16]));

  IF v_is_extravio THEN
    v_state_novo := 'EXTRAVIO_MONITORADO';
    UPDATE public.cards
    SET state = 'EXTRAVIO_MONITORADO',
        lock_aguardando_validacao = false,
        acao_falhou_motivo = LEFT(p_motivo, 500)
    WHERE id = v_todo.card_id;
  ELSE
    v_state_novo := 'AGUARDANDO_VALIDACAO_HUMANA';
    UPDATE public.cards
    SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
        lock_aguardando_validacao = true,
        acao_falhou_motivo = LEFT(p_motivo, 500)
    WHERE id = v_todo.card_id;
  END IF;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id,
    'AcaoRevertidaPosFalha',
    'system',
    'executor',
    jsonb_build_object(
      'todo_id', p_todo_id,
      'motivo', LEFT(p_motivo, 500),
      'todos_ressuscitados', v_ressuscitados,
      'state_novo', v_state_novo
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', v_todo.card_id,
    'todos_ressuscitados', v_ressuscitados,
    'state_novo', v_state_novo
  );
END;
$function$;
