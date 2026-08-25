-- =============================================================================
-- 2026-08-25_354_rpc_auto_aprovar_veto_e_cron.sql
--
-- ETAPA D do plano "Ação Autônoma com Janela de Veto" (Caio 25/08) — o MOTOR:
--   1. RPC auto_aprovar_e_executar_veto — replica o pré-voo HUMANO da
--      aprovar_e_executar (mig 226) que a auto_aprovar_e_executar (mig 021)
--      NÃO tem (risco 15): guard sem_chave_cte, guard multi-thread de e-mail
--      (risco 16), merge de extras, cancelamento das irmãs com a FRASE
--      LITERAL que o fluxo de falha reconhece (risco 32), limpeza do aviso.
--      E aprova EM NOME DO OPERADOR DONO do card (risco 21 — o e-mail sai da
--      caixa Gmail dele; a marca de autonomia é auto_approval_rule + evento
--      AutoAprovacaoPermitida + aprovacao_modo='autonoma', NUNCA approved_by).
--   2. Trigger todos→agendamento: todo saiu de 'pendente' (aprovação manual,
--      rejeição, cancelamento) → agendamento de veto pendente desse todo é
--      cancelado (riscos 4 e 18 — cancelamento SELETIVO, só o do todo).
--   3. View v_veto_agendamentos_atrasados — watchdog (risco 3).
--   4. Cron do processar-acoes-agendadas: 15min → 5min.
--
-- NADA muda de comportamento sem a flag master (OFF) + degrau da escada.
-- SEM begin/commit interno. Idempotente.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RPC auto_aprovar_e_executar_veto
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_aprovar_e_executar_veto(
  p_todo_id        uuid,
  p_agendamento_id bigint,
  p_regra          text,
  p_extras         jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_todo record;
  v_card record;
  v_msg_id bigint;
  v_outros_cancelados int;
  v_proposta_payload jsonb;
  v_tool text;
  v_qtd_tratativas int;
BEGIN
  IF p_regra IS NULL OR length(trim(p_regra)) = 0 THEN
    RAISE EXCEPTION 'Regra de auto-aprovação obrigatória — sem regra não há rastreabilidade';
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status
  INTO v_todo FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status <> 'pendente' THEN
    RAISE EXCEPTION 'Todo % já em status=% — mundo mudou, devolver pro humano', p_todo_id, v_todo.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, assigned_operator_id, state, nf, ctrc, sem_chave_cte, tratativa_email_escolhida
  INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  -- Risco 21: a execução autônoma é EM NOME do operador dono (Gmail dele,
  -- rótulo de rastreamento intacto). Card órfão nunca executa sozinho.
  IF v_card.assigned_operator_id IS NULL THEN
    RAISE EXCEPTION 'Card NF % sem operador dono — ação autônoma exige dono (veto)', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_tool := v_todo.proposta_payload->>'tool';

  -- Guard do pré-voo humano (mig 052): sem chave fiscal não lança.
  IF v_card.sem_chave_cte = true AND v_tool IN ('lancar_ocorrencia', 'lancar_oc_e_enviar_email') THEN
    RAISE EXCEPTION 'Card NF % sem chave fiscal cadastrada (sem_chave_cte=true) — devolver pro humano', v_card.nf
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Guard multi-thread (mig 212 / risco 16): 2+ tratativas de e-mail ativas
  -- sem escolha → NUNCA autônomo (a resposta poderia sair na thread errada).
  IF v_tool ILIKE '%email%' AND v_card.tratativa_email_escolhida IS NULL THEN
    SELECT count(*) INTO v_qtd_tratativas FROM (
      SELECT 1
      FROM (
        SELECT NULLIF(mi.raw_payload->>'gmail_thread_id','') AS thr,
               'in'::text AS dir, mi.remetente AS addr, mi.recebido_em AS ts
          FROM public.messages_inbox mi
         WHERE mi.card_id = v_todo.card_id AND mi.canal = 'email'
        UNION ALL
        SELECT NULLIF(eo.gmail_thread_id,''), 'out'::text, eo.to_email, eo.sent_at
          FROM public.cards_emails_outbound eo
         WHERE eo.card_id = v_todo.card_id
      ) m
      WHERE m.thr IS NOT NULL
      GROUP BY m.thr
      HAVING (ARRAY_AGG(m.dir  ORDER BY m.ts DESC))[1] = 'in'
         AND (ARRAY_AGG(m.addr ORDER BY m.ts DESC))[1] NOT ILIKE '%@salexpress.com.br'
    ) ativas;

    IF v_qtd_tratativas > 1 THEN
      RAISE EXCEPTION 'Card NF % com mais de uma tratativa de e-mail ativa — thread ambígua, devolver pro humano (monitorado)', v_card.nf
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- MERGE de extras (mig 226): preserva skip_oc/enviar_email/texto da criação.
  v_proposta_payload := v_todo.proposta_payload;
  IF p_extras IS NOT NULL AND jsonb_typeof(p_extras) = 'object' THEN
    v_proposta_payload := jsonb_set(
      v_proposta_payload,
      '{args,extras}',
      COALESCE(v_todo.proposta_payload->'args'->'extras', '{}'::jsonb) || p_extras,
      true
    );
  END IF;

  -- Marcação obrigatória da autonomia (Auditoria/risco "impossível existir
  -- ação autônoma sem marca"): evento + auto_approval_rule + aprovacao_modo.
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'AutoAprovacaoPermitida', 'system', 'veto-janela',
    jsonb_build_object(
      'todo_id', p_todo_id,
      'action_id', v_todo.action_id,
      'regra', p_regra,
      'agendamento_id', p_agendamento_id,
      'em_nome_do_operador', v_card.assigned_operator_id,
      'proposta_payload', v_proposta_payload,
      'extras', p_extras
    )
  );

  -- approved_by = operador dono (Gmail/rastreamento); a marca de autonomia é
  -- auto_approval_rule (INV-089: o placar não se autoavalia lê daqui).
  UPDATE public.todos
  SET status = 'aprovado',
      approved_by = v_card.assigned_operator_id,
      approved_at = now(),
      auto_approval_rule = p_regra,
      proposta_payload = v_proposta_payload
  WHERE id = p_todo_id;

  -- Pré-voo humano (risco 15): irmãs canceladas com a FRASE LITERAL que
  -- reverter_acao_falhou usa pra ressuscitar (risco 32 — mig 048).
  WITH outros_canc AS (
    UPDATE public.todos
    SET status = 'cancelado',
        rejection_reason = 'Auto-cancelado: outra opção foi aprovada no mesmo card'
    WHERE card_id = v_todo.card_id
      AND id <> p_todo_id
      AND status = 'pendente'
    RETURNING id
  )
  SELECT count(*) INTO v_outros_cancelados FROM outros_canc;

  IF v_outros_cancelados > 0 THEN
    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      v_todo.card_id, 'TodosConcorrentesCancelados', 'system', 'auto_aprovar_e_executar_veto',
      jsonb_build_object(
        'aprovado', p_todo_id,
        'cancelados', v_outros_cancelados,
        'motivo', 'Janela de veto venceu sem veto; demais opções ficaram obsoletas'
      )
    );
  END IF;

  UPDATE public.cards
  SET aprovacao_modo = 'autonoma',
      lock_aguardando_validacao = false,
      aviso_alteracao_oc = NULL,
      state = 'EXECUTANDO_ACAO'
  WHERE id = v_todo.card_id;

  v_msg_id := pgmq.send('agent_executor', jsonb_build_object(
    'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'action_id', v_todo.action_id, 'proposta_payload', v_proposta_payload,
    'aprovado_por', v_card.assigned_operator_id,
    'auto_approval_rule', p_regra,
    'card_nf', v_card.nf, 'card_ctrc', v_card.ctrc
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'regra', p_regra,
    'em_nome_do_operador', v_card.assigned_operator_id,
    'pgmq_msg_id', v_msg_id,
    'outros_cancelados', v_outros_cancelados
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_aprovar_e_executar_veto(uuid, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_aprovar_e_executar_veto(uuid, bigint, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.auto_aprovar_e_executar_veto IS
  'Execução da janela de veto (plano 25/08): pré-voo HUMANO completo (chave, '
  'multi-thread, merge extras, cancela irmãs com a frase literal, limpa aviso) '
  '+ aprovação EM NOME do operador dono (Gmail dele). Marca de autonomia: '
  'AutoAprovacaoPermitida + auto_approval_rule + aprovacao_modo=autonoma. '
  'Chamada SÓ pelo processar-acoes-agendadas (service_role) após claim/TTL/hash.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Trigger: todo saiu de 'pendente' → cancela o agendamento de veto DELE
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_todo_status_cancela_veto()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'pendente' AND NEW.status <> 'pendente'
     -- a PRÓPRIA execução do veto aprova o todo; nesse momento o agendamento
     -- está 'executando' (claim atômico) — o filtro status='pendente' abaixo
     -- já o ignora, e auto_approval_rule marca a origem.
  THEN
    UPDATE public.acoes_agendadas
    SET status = 'cancelado',
        cancelado_motivo = CASE
          WHEN NEW.status = 'aprovado' THEN 'humano aprovou o todo antes do vencimento da janela'
          WHEN NEW.status = 'rejeitado' THEN 'todo rejeitado antes do vencimento da janela'
          ELSE 'todo saiu de pendente (' || NEW.status || ') antes do vencimento da janela'
        END
    WHERE tipo = 'executar_acao_autonoma'
      AND status = 'pendente'
      AND card_id = NEW.card_id
      AND payload->>'todo_id' = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_todo_status_cancela_veto ON public.todos;
CREATE TRIGGER trg_todo_status_cancela_veto
  AFTER UPDATE OF status ON public.todos
  FOR EACH ROW EXECUTE FUNCTION public.fn_todo_status_cancela_veto();

COMMENT ON FUNCTION public.fn_todo_status_cancela_veto() IS
  'Riscos 4/18 do plano de veto: aprovação manual, rejeição ou cancelamento do '
  'todo mata o agendamento de veto DELE (seletivo — outros tipos de agendamento '
  'intocados). O espelho cards.acao_autonoma atualiza via trg_espelho (mig 353).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Watchdog (risco 3): agendado vencido sem processar
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_veto_agendamentos_atrasados
WITH (security_invoker = true) AS
SELECT
  aa.id, aa.card_id, c.nf,
  aa.executar_em, aa.status, aa.claimed_at,
  now() - aa.executar_em AS atraso
FROM public.acoes_agendadas aa
JOIN public.cards c ON c.id = aa.card_id
WHERE aa.tipo = 'executar_acao_autonoma'
  AND (
    (aa.status = 'pendente'   AND aa.executar_em < now() - interval '15 minutes') OR
    (aa.status = 'executando' AND aa.claimed_at  < now() - interval '15 minutes')
  )
ORDER BY aa.executar_em;

GRANT SELECT ON public.v_veto_agendamentos_atrasados TO authenticated, service_role;

COMMENT ON VIEW public.v_veto_agendamentos_atrasados IS
  'Watchdog do veto (risco 3): pendente vencido há >15min = cron parado/atrasado; '
  'executando há >15min sem processed = claim travado. Linha aqui = investigar.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Cron 15min → 5min (a janela de veto precisa de granularidade)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE jid int;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'processar-acoes-agendadas-daily';
  IF jid IS NOT NULL THEN
    PERFORM cron.alter_job(jid, schedule => '*/5 * * * *');
    RAISE NOTICE 'cron processar-acoes-agendadas: */5 * * * *';
  ELSE
    RAISE NOTICE 'cron processar-acoes-agendadas-daily não encontrado (nada a fazer)';
  END IF;
END $$;
