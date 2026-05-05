-- ============================================================================
-- Cockpit v2 — Ação que falha no SSW volta pra AGUARDANDO_VALIDACAO_HUMANA
-- com flag visual amarela. Não vai mais pra BLOQUEADO_POR_ERRO/EXECUTANDO_ACAO.
-- Data: 2026-05-05
--
-- Caso real: NF 683099 oc=49 / NF 1005523 oc=10. Larissa aprovou "lançar 56"
-- (FALTA INFO). SSW retornou 400 "CODIGO SSW NAO CADASTRADO" (problema de
-- de-para ssw 33/41/56). Card foi pra BLOQUEADO_POR_ERRO e os 4 outros todos
-- (cancelados pela aprovação) ficaram cancelados — Larissa não conseguia
-- escolher outra opção sem refazer manualmente.
--
-- Regra nova:
--   - Quando executor falha: card volta pra AGUARDANDO_VALIDACAO_HUMANA com
--     lock=true e acao_falhou_motivo populado (= mensagem de erro).
--   - Os todos que foram cancelados pela aprovação que falhou voltam pra
--     pendente (Larissa pode escolher outra opção).
--   - Frontend mostra badge amarelo "⚠️ Ação não executada — verifique" no
--     card pra Larissa identificar rapidamente.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS acao_falhou_motivo text;

CREATE INDEX IF NOT EXISTS idx_cards_acao_falhou
  ON public.cards(acao_falhou_motivo)
  WHERE acao_falhou_motivo IS NOT NULL;

COMMENT ON COLUMN public.cards.acao_falhou_motivo IS
  'Mensagem de erro quando última ação aprovada falhou no SSW. Limpa quando aprovação seguinte é bem-sucedida ou quando Larissa marca card como resolvido. Frontend usa pra mostrar badge amarelo.';

-- ============================================================================
-- RPC reverter_acao_falhou(p_todo_id, p_motivo)
-- Chamada pelo executor quando lançamento SSW falha. Volta o card pro state
-- AGUARDANDO_VALIDACAO_HUMANA, ressuscita os todos cancelados pela aprovação,
-- e marca acao_falhou_motivo.
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

  -- Ressuscita todos pra pendente:
  --  (a) os cancelados pela aprovação (mesmo card, rejection_reason padrão,
  --      criados antes/junto do approved_at)
  --  (b) o próprio todo que falhou (p_todo_id) — Larissa precisa poder
  --      retentar a mesma opção depois que o motivo da falha for resolvido
  --      (de-para corrigido, SSW de volta, etc). O histórico do erro fica
  --      preservado no card_event AcaoFalhou.
  WITH ressuscitados AS (
    UPDATE public.todos
    SET status = 'pendente',
        rejection_reason = NULL
    WHERE card_id = v_todo.card_id
      AND (
        (status = 'cancelado'
          AND rejection_reason = 'Auto-cancelado: outra opção foi aprovada no mesmo card'
          AND id <> p_todo_id
          AND created_at <= v_approved_at)
        OR id = p_todo_id
      )
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
  'Chamada pelo executor quando lançamento SSW falha. Volta card pra AGUARDANDO_VALIDACAO_HUMANA com flag amarela e ressuscita todos cancelados pela mesma aprovação.';
