-- ============================================================================
-- Cockpit v2 — reverter_acao_falhou agora ressuscita TODAS as opções
-- primárias do card, independente do status atual delas.
-- Data: 2026-05-05
--
-- Caso real: NF 196537 (cliente Vale, oc=10). Larissa aprovou oc=54 com
-- email manual. Email falhou (bug do tool antes do fix). oc=54 foi lançada
-- mas email não saiu. Cleanup manual reverteu o card pra AGUARDANDO_VALIDACAO_HUMANA
-- mas a oc=54 ficou status='executando' e NÃO foi ressuscitada — Larissa não
-- viu mais a opção 54 na lista.
--
-- Regra Caio 2026-05-05: "se reverte, TODAS as opções primárias devem voltar".
-- Não importa o status anterior do todo (cancelado/falhou/executando/aprovado),
-- todos voltam pra 'pendente'. Exceção: 'executado' (oc já confirmada no SSW)
-- não pode ser desfeito — fica como está.
--
-- Heurística: todos do card criados ATÉ approved_at do todo aprovado fazem
-- parte da mesma "rodada" de propostas (sync-bastao cria em batch). Esses
-- voltam pra pendente. Todos criados depois (nova rodada) ficam intactos.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reverter_acao_falhou(
  p_todo_id uuid,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_todo record;
  v_approved_at timestamptz;
  v_ressuscitados int;
BEGIN
  SELECT id, card_id, status, approved_at INTO v_todo
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

  -- Card volta pro state de validação humana com flag de falha
  UPDATE public.cards
  SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
      lock_aguardando_validacao = true,
      acao_falhou_motivo = LEFT(p_motivo, 500)
  WHERE id = v_todo.card_id;

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
      'state_novo', 'AGUARDANDO_VALIDACAO_HUMANA'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', v_todo.card_id,
    'todos_ressuscitados', v_ressuscitados
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reverter_acao_falhou(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverter_acao_falhou(uuid, text) TO service_role;

COMMENT ON FUNCTION public.reverter_acao_falhou IS
  'Reverte acao falhou e ressuscita TODAS as opcoes primarias do card (cancelado/falhou/executando/aprovado -> pendente). Nunca mexe em executado. Regra Sal Express 2026-05-05.';
