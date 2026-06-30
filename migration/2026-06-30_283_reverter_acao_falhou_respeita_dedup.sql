-- =============================================================================
-- FIX watchdog em loop de falha (Caio 2026-06-30) — colisão INV-031 × INV-030.
--
-- SINTOMA: cron reconciliar-execucao-presa-every-5min falha de 5 em 5 min desde
-- 2026-06-30 09:15 (15+ falhas/dia e subindo) com:
--   duplicate key value violates unique constraint "uniq_todos_card_tool_cod_ativo"
--   Key (card_id, tool, codigo_ssw)=(deb7fe19-..., lancar_oc_e_enviar_email, 54)
-- enquanto o watchdog NÃO reconcilia mais NENHUM card preso (txn aborta inteira).
--
-- CAUSA RAIZ: reverter_acao_falhou (INV-031, mig 279) "ressuscita" pra 'pendente'
-- TODOS os todos cancelado/falhou/executando/aprovado do card. Quando ressuscita
-- um GÊMEO cancelado (card, tool, cod) e JÁ EXISTE um todo ativo (pendente/aprovado)
-- com a MESMA identidade, viola o índice parcial único uniq_todos_card_tool_cod_ativo
-- (INV-030, mig 278: UNIQUE em (card_id, tool, codigo_ssw) WHERE status IN
-- ('pendente','aprovado')). O UPDATE estoura, a transação do reconciliador aborta,
-- o cron loga 'failed' — e como o card preso nunca é resolvido, repete pra sempre.
--
-- FIX NA RAIZ: a ressurreição passa a RESPEITAR a dedup do INV-030:
--   (a) NÃO ressuscita um todo se já existe OUTRO todo ativo (pendente/aprovado)
--       com a mesma identidade (card, tool, codigo_ssw) — esse já é a ação que vai
--       à validação; o gêmeo cancelado é redundante e fica cancelado.
--   (b) entre VÁRIOS candidatos com a mesma identidade (ex.: 2 cancelados, nenhum
--       ativo), ressuscita só o mais novo (rn=1) — evita colisão dos próprios
--       ressuscitados entre si.
--   tool IS NULL não entra no índice parcial → continua ressuscitando todos.
--
-- Resto da função é idêntico à versão da mig 279 (redirecionamento extravio,
-- card_events AcaoRevertidaPosFalha, state AGUARDANDO_VALIDACAO_HUMANA / lock).
-- =============================================================================

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

  -- Ressuscita os todos do card criados <= approved_at do aprovado que NÃO estejam
  -- em 'pendente' nem 'executado' (cancelado/falhou/executando/aprovado → pendente),
  -- MAS respeitando a dedup do INV-030 (índice uniq_todos_card_tool_cod_ativo):
  --   - pula gêmeo que já tem outro ativo (pendente/aprovado) com a mesma identidade;
  --   - entre vários candidatos da mesma identidade, ressuscita só o mais novo.
  -- (Antes era um UPDATE cru, sem essa guarda → violava o índice e abortava a txn.)
  WITH cand AS (
    SELECT t.id,
           (t.proposta_payload ->> 'tool') AS tool,
           row_number() OVER (
             PARTITION BY (t.proposta_payload ->> 'tool'),
                          COALESCE(t.proposta_payload -> 'args' ->> 'codigo_ssw', '')
             ORDER BY t.created_at DESC, t.id
           ) AS rn
    FROM public.todos t
    WHERE t.card_id = v_todo.card_id
      AND t.created_at <= v_approved_at
      AND t.status IN ('cancelado', 'falhou', 'executando', 'aprovado')
      AND NOT EXISTS (
        SELECT 1 FROM public.todos a
        WHERE a.card_id = t.card_id
          AND a.id <> t.id
          AND a.status IN ('pendente', 'aprovado')
          AND (a.proposta_payload ->> 'tool') IS NOT NULL
          AND (a.proposta_payload ->> 'tool') = (t.proposta_payload ->> 'tool')
          AND COALESCE(a.proposta_payload -> 'args' ->> 'codigo_ssw', '')
              = COALESCE(t.proposta_payload -> 'args' ->> 'codigo_ssw', '')
      )
  ),
  ressuscitados AS (
    UPDATE public.todos x
    SET status = 'pendente',
        rejection_reason = NULL
    FROM cand
    WHERE x.id = cand.id
      AND (cand.tool IS NULL OR cand.rn = 1)
    RETURNING x.id
  )
  SELECT count(*) INTO v_ressuscitados FROM ressuscitados;

  -- (mig 227) ação de extravio que falha volta pra a aba EXTRAVIOS, não pra
  -- "AGUARDANDO VOCÊ". Só redireciona se o todo veio do extravios E o card AINDA
  -- é extravio (oc 6/9/16). Se a oc já mudou, cai no ELSE (validação humana normal).
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
