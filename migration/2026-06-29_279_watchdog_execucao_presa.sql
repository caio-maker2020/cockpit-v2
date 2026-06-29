-- 2026-06-29_279_watchdog_execucao_presa.sql
-- Reconciliador conservador de "card preso para sempre em EXECUTANDO_ACAO".
-- Caio 2026-06-29. Causa raiz H8 (confirmada): aprovar_e_executar move o card
-- pra EXECUTANDO_ACAO e enfileira uma mensagem do executor SEM garantia de
-- conclusão nem reconciliação — se a mensagem se perde (gatilho H6/H7, raro,
-- não confirmado), o card congela. NF-âncora 296312. Health-check só ALERTA.
--
-- ESTE NÃO é re-dispatch cego. Restrições (Caio 2026-06-29, 2 rodadas):
--  1. Candidato = card EXECUTANDO_ACAO ANTIGO (>threshold) com todo em
--     ('aprovado' OU 'executando'). 'executando' importa: o executor seta o todo
--     'executando' ANTES de mover o card pra ACAO_EXECUTADA; crash nessa janela
--     deixa o card preso e o todo 'executando' (a ação JÁ rodou — re-enfileirar
--     finaliza idempotente).
--  2. 'aprovado'/'executando' é CANDIDATO, não prova. Decide por EVIDÊNCIA
--     (acoes_executadas_ssw por todo) + idempotência por-todo do envelope/e-mail.
--     NÃO usa "evento terminal" pra excluir candidato (senão nunca pegaria
--     'executando', que sempre tem AcaoExecutadaPortal); re-enfileirar é
--     idempotente quer a ação tenha rodado ou não.
--  3. WHITELIST explícita de tools só-SSW seguras. Tool fora da whitelist →
--     reverte p/ humano (default seguro, sem re-dispatch cego).
--  4. Qualquer possibilidade de e-mail no payload (TODOS os campos reais:
--     email_destino/email_destinatarios/email_destinatario/email_subject/
--     email_corpo/email_cc/email_anexos_ids/texto_email_customizado/template_id/
--     overrides/modo=completo) → reverte (v1 não auto-reenvia). Na dúvida, reverte.
--  5. acoes_executadas_ssw.sucesso=null: recente → aguarda; stale → reverte
--     (envelope abortaria; re-aprovar o MESMO todo segue bloqueado pelo zumbi →
--     humano confere SSW). Verificação SSW via HTTP fica pra v2.
--  6. SSW: re-enfileira a MESMA mensagem/todo_id → idempotência por-todo do
--     envelope (true=skip, false=retry, ausente=lança). Combo parcial completa.
--  7. Anti-loop: máx p_max_tentativas (2) re-enfileiramentos; depois reverte.
--  8. card_events: ExecucaoPresaDetectada (só quando AGE — anti-spam) /
--     ExecucaoReenfileirada / ExecucaoRevertidaPorWatchdog / ExecucaoReconciliada.
--  9. Advisory lock transacional DENTRO da RPC (runs concorrentes do cron no-op).
-- 10. Cron idempotente (unschedule antes de schedule).
--
-- Idempotente: DROP+CREATE da função pura (assinatura mudou), CREATE OR REPLACE
-- da RPC, INDEX IF NOT EXISTS, cron unschedule→schedule.

-- ===========================================================================
-- 1. Função PURA de decisão (sem efeito colateral, testável isoladamente).
-- ===========================================================================
DROP FUNCTION IF EXISTS public._reconciliar_decidir(boolean, jsonb, int, int, int, boolean);

CREATE OR REPLACE FUNCTION public._reconciliar_decidir(
  p_whitelisted boolean,   -- tool ∈ whitelist só-SSW segura
  p_tem_email boolean,     -- payload tem QUALQUER possibilidade de e-mail
  p_acoes jsonb,           -- [{ "codigo_oc": N, "sucesso": true/false/null, "idade_min": N }, ...]
  p_tentativas int,
  p_max_tentativas int,
  p_recent_min int
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- SSW em voo RECENTE (sucesso=null novo) → aguarda (pode estar lançando).
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_acoes, '[]'::jsonb)) e
      WHERE (e->>'sucesso') IS NULL
        AND COALESCE((e->>'idade_min')::numeric, 0) < p_recent_min
    ) THEN 'aguardar'
    -- SSW em voo STALE (sucesso=null antigo = zumbi) → reverte (não re-enfileira
    -- cego; envelope abortaria; humano confere SSW).
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_acoes, '[]'::jsonb)) e
      WHERE (e->>'sucesso') IS NULL
    ) THEN 'reverter'
    -- Tool fora da whitelist só-SSW → reverte (sem re-dispatch cego).
    WHEN NOT p_whitelisted THEN 'reverter'
    -- Qualquer possibilidade de e-mail → v1 conservador.
    WHEN p_tem_email THEN 'reverter'
    -- Anti-loop.
    WHEN p_tentativas >= p_max_tentativas THEN 'reverter'
    -- só-SSW whitelisted, sem null, sem e-mail, sob tentativas → re-enfileira
    -- (envelope idempotente por-todo: true=skip, false=retry, ausente=lança).
    ELSE 'reenfileirar'
  END;
$$;

REVOKE ALL ON FUNCTION public._reconciliar_decidir(boolean, boolean, jsonb, int, int, int) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._reconciliar_decidir(boolean, boolean, jsonb, int, int, int) IS
  'Decisão PURA do watchdog de execução presa (mig 279). reenfileirar|reverter|aguardar. Testada em verify-cockpit INV-031.';

-- ===========================================================================
-- 2. Reconciliador batch (advisory-locked, atômico por card).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.reconciliar_execucoes_presas(
  p_threshold_min int DEFAULT 15,   -- idade mínima em EXECUTANDO_ACAO (10x latência normal)
  p_max_tentativas int DEFAULT 2,   -- re-enfileiramentos antes de reverter
  p_recent_min int DEFAULT 10       -- janela "recente" p/ sucesso=null + cooldown
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  cand record;
  rec record;
  v_acoes jsonb;
  v_terminal boolean;
  v_whitelisted boolean;
  v_tem_email boolean;
  v_tentativas int;
  v_decisao text;
  v_motivo text;
  v_msg_id bigint;
  v_detectados int := 0;
  v_reenfileirados int := 0;
  v_revertidos int := 0;
  v_aguardando int := 0;
  v_reconciliados int := 0;
BEGIN
  -- Lock transacional: 2 runs do cron não pisam um no outro (solta no commit).
  IF NOT pg_try_advisory_xact_lock(hashtext('reconciliar_execucoes_presas')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'lock_em_uso');
  END IF;

  FOR cand IN
    SELECT c.id AS card_id, t.id AS todo_id, t.status AS todo_status, t.action_id, t.approved_by,
           t.proposta_payload, t.approved_at, c.nf AS card_nf, c.ctrc AS card_ctrc,
           (t.proposta_payload->>'tool') AS tool,
           GREATEST(1, round(extract(epoch FROM (now() - t.approved_at)) / 60))::int AS idade_min
    FROM public.cards c
    JOIN public.todos t ON t.card_id = c.id
    WHERE c.state = 'EXECUTANDO_ACAO'
      -- Restrição 1: cobre 'aprovado' E 'executando' (crash entre todo='executando'
      -- e card='ACAO_EXECUTADA' deixa o card preso com todo 'executando').
      AND t.status IN ('aprovado', 'executando')
      AND t.approved_at < now() - make_interval(mins => p_threshold_min)
      -- Cooldown (restrição 7/8): não re-enfileirar antes do executor ter chance.
      AND NOT EXISTS (
        SELECT 1 FROM public.card_events ce
        WHERE ce.card_id = c.id AND ce.event_type = 'ExecucaoReenfileirada'
          AND (ce.payload->>'todo_id') = t.id::text
          AND ce.created_at > now() - make_interval(mins => p_recent_min)
      )
  LOOP
    v_detectados := v_detectados + 1;

    -- Evidência SSW por todo (restrição 2/5): sucesso true/false/null + idade.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'codigo_oc', codigo_oc,
             'sucesso', sucesso,
             'idade_min', GREATEST(0, round(extract(epoch FROM (now() - COALESCE(finalizado_em, iniciado_em))) / 60))::int
           )), '[]'::jsonb)
      INTO v_acoes
      FROM public.acoes_executadas_ssw
      WHERE card_id = cand.card_id AND todo_id = cand.todo_id;

    -- Evento terminal (SÓ p/ auditoria/observabilidade — NÃO decide; ver restrição 2).
    SELECT EXISTS (
      SELECT 1 FROM public.card_events ce
      WHERE ce.card_id = cand.card_id
        AND (ce.payload->>'todo_id') = cand.todo_id::text
        AND ce.created_at >= cand.approved_at
        AND (ce.event_type LIKE 'Acao%'
             OR ce.event_type IN ('ComboPortalConcluido','StateTransicaoPosSucesso','TripeRejeitadoPeloGuard','RespostaEnviada'))
    ) INTO v_terminal;

    -- Restrição 3: WHITELIST explícita de tools só-SSW seguras.
    v_whitelisted := cand.tool IN ('lancar_oc33_solo_portal', 'lancar_combo_33_44', 'lancar_ocorrencia');

    -- Restrição 4: possibilidade de e-mail — TODOS os campos reais. Na dúvida, true.
    v_tem_email := (
      cand.tool ILIKE '%email%'
      OR cand.tool = 'lancar_oc_e_enviar_email'
      OR COALESCE(cand.proposta_payload->'args', '{}'::jsonb) ?| ARRAY[
           'email_destino','email_destinatario','email_destinatarios','email_subject',
           'email_corpo','email_cc','email_anexos_ids','template_id','template_id_override','assunto_override']
      OR COALESCE(cand.proposta_payload->'args'->'extras', '{}'::jsonb) ?| ARRAY[
           'email_destino','email_destinatario','email_destinatarios','email_subject',
           'email_corpo','email_cc','email_anexos_ids','texto_email_customizado',
           'template_id','template_id_override','assunto_override']
      OR COALESCE(cand.proposta_payload->'args'->'extras'->>'enviar_email','') = 'true'
      -- skip_oc=true = ação "só notificar e-mail, NÃO lança SSW" (extravios, executor
      -- linha ~426). É inequivocamente caminho de e-mail → reverte p/ humano.
      OR COALESCE(cand.proposta_payload->'args'->'extras'->>'skip_oc','') = 'true'
      OR COALESCE(cand.proposta_payload->'meta'->>'modo','') = 'completo'
      OR COALESCE(cand.proposta_payload->'meta'->>'modo_email','') <> ''
    );

    SELECT count(*) INTO v_tentativas FROM public.card_events
      WHERE card_id = cand.card_id AND event_type = 'ExecucaoReenfileirada'
        AND (payload->>'todo_id') = cand.todo_id::text;

    v_decisao := public._reconciliar_decidir(
      v_whitelisted, v_tem_email, v_acoes, v_tentativas, p_max_tentativas, p_recent_min);

    -- Restrição 8: ExecucaoPresaDetectada SÓ quando há ação (anti-spam).
    IF v_decisao = 'aguardar' THEN
      v_aguardando := v_aguardando + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (cand.card_id, 'ExecucaoPresaDetectada', 'system', 'reconciliador',
            jsonb_build_object('todo_id', cand.todo_id, 'tool', cand.tool,
              'todo_status', cand.todo_status, 'idade_min', cand.idade_min, 'decisao', v_decisao,
              'acoes_ssw', v_acoes, 'tentativas', v_tentativas,
              'terminal_event', v_terminal, 'whitelisted', v_whitelisted, 'tem_email', v_tem_email));

    IF v_decisao = 'reenfileirar' THEN
      -- Re-check atômico (restrição 2: "card já foi movido por outro fluxo").
      PERFORM 1 FROM public.cards c JOIN public.todos t ON t.card_id = c.id
        WHERE c.id = cand.card_id AND t.id = cand.todo_id
          AND c.state = 'EXECUTANDO_ACAO' AND t.status IN ('aprovado', 'executando');
      IF FOUND THEN
        v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
          'todo_id', cand.todo_id, 'card_id', cand.card_id, 'action_id', cand.action_id,
          'proposta_payload', cand.proposta_payload, 'aprovado_por', cand.approved_by,
          'card_nf', cand.card_nf, 'card_ctrc', cand.card_ctrc));
        INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
        VALUES (cand.card_id, 'ExecucaoReenfileirada', 'system', 'reconciliador',
                jsonb_build_object('todo_id', cand.todo_id, 'tentativa', v_tentativas + 1,
                  'pgmq_msg_id', v_msg_id, 'todo_status', cand.todo_status));
        v_reenfileirados := v_reenfileirados + 1;
      END IF;

    ELSIF v_decisao = 'reverter' THEN
      v_motivo := 'Watchdog: execução presa em EXECUTANDO_ACAO há ' || cand.idade_min || 'min (todo ' || cand.todo_status || ') sem desfecho.'
        || CASE
             WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_acoes) e WHERE (e->>'sucesso') IS NULL)
               THEN ' ATENÇÃO: oc em voo/indeterminado (sucesso=null) — confira no SSW ANTES de reaprovar.'
             WHEN NOT v_whitelisted THEN ' Tool "' || COALESCE(cand.tool,'?') || '" fora da whitelist só-SSW — confira/execute manualmente.'
             WHEN v_tem_email THEN ' Ação envolve e-mail — confira se o e-mail e a oc saíram ANTES de reaprovar.'
             WHEN v_tentativas >= p_max_tentativas THEN ' Re-enfileirado ' || v_tentativas || 'x sem sucesso.'
             ELSE ' Confira o estado no SSW antes de reaprovar.'
           END;
      PERFORM public.reverter_acao_falhou(cand.todo_id, v_motivo);
      INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
      VALUES (cand.card_id, 'ExecucaoRevertidaPorWatchdog', 'system', 'reconciliador',
              jsonb_build_object('todo_id', cand.todo_id, 'motivo', v_motivo,
                'acoes_ssw', v_acoes, 'tentativas', v_tentativas,
                'whitelisted', v_whitelisted, 'tem_email', v_tem_email, 'todo_status', cand.todo_status));
      v_revertidos := v_revertidos + 1;
    END IF;
  END LOOP;

  -- Fechamento do ciclo (restrição 8): card re-enfileirado que JÁ saiu de
  -- EXECUTANDO_ACAO → ExecucaoReconciliada (1x por ciclo de re-enfileiramento).
  FOR rec IN
    SELECT c.id AS card_id, c.state
    FROM public.cards c
    WHERE c.state <> 'EXECUTANDO_ACAO'
      AND EXISTS (
        SELECT 1 FROM public.card_events ce
        WHERE ce.card_id = c.id AND ce.event_type = 'ExecucaoReenfileirada'
          AND ce.created_at > now() - interval '2 hours')
      AND NOT EXISTS (
        SELECT 1 FROM public.card_events ce2
        WHERE ce2.card_id = c.id AND ce2.event_type = 'ExecucaoReconciliada'
          AND ce2.created_at > (
            SELECT max(ce3.created_at) FROM public.card_events ce3
            WHERE ce3.card_id = c.id AND ce3.event_type = 'ExecucaoReenfileirada'))
  LOOP
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (rec.card_id, 'ExecucaoReconciliada', 'system', 'reconciliador',
            jsonb_build_object('state_atual', rec.state,
              'observacao', 'Re-enfileiramento do watchdog resolveu — card saiu de EXECUTANDO_ACAO.'));
    v_reconciliados := v_reconciliados + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'detectados', v_detectados,
    'reenfileirados', v_reenfileirados, 'revertidos', v_revertidos,
    'aguardando', v_aguardando, 'reconciliados', v_reconciliados);
END;
$$;

REVOKE ALL ON FUNCTION public.reconciliar_execucoes_presas(int, int, int) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.reconciliar_execucoes_presas(int, int, int) IS
  'Watchdog de card preso em EXECUTANDO_ACAO (mig 279, INV-031). Conservador: re-enfileira só-SSW whitelisted idempotente por-todo; reverte p/ humano (não-whitelist/e-mail/null-stale/anti-loop). Cobre todo aprovado E executando. NF 296312.';

-- ===========================================================================
-- 3. Índice parcial p/ o scan barato (subconjunto minúsculo).
-- ===========================================================================
CREATE INDEX IF NOT EXISTS idx_cards_executando_acao
  ON public.cards (id) WHERE state = 'EXECUTANDO_ACAO';

-- ===========================================================================
-- 4. Cron a cada 5 min — idempotente (unschedule antes de schedule).
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconciliar-execucao-presa-every-5min') THEN
    PERFORM cron.unschedule('reconciliar-execucao-presa-every-5min');
  END IF;
END $$;

SELECT cron.schedule(
  'reconciliar-execucao-presa-every-5min',
  '*/5 * * * *',
  $$ SELECT public.reconciliar_execucoes_presas(); $$
);
