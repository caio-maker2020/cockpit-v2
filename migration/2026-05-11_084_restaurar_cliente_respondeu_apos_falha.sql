-- ============================================================================
-- Cockpit v2 — Restaurar cards que perderam cliente_respondeu_em / ia_sugestao
-- após falha de aprovação + Pass A forçar AGUARDANDO_CLIENTE.
-- Data: 2026-05-11
--
-- Bug raiz NF 351849 (Caio 2026-05-11): aprovar_e_executar (mig 062) limpava
-- cliente_respondeu_em + ia_sugestao_oc_resposta na aprovação. Quando o
-- executor falhava no SSW, reverter_acao_falhou voltava state=AVH+lock=true
-- mas não restaurava esses campos. Pass A então forçava AGUARDANDO_CLIENTE
-- na oc=54 — card sumia da aba CLIENTE RESPONDEU sem ter sido resolvido.
--
-- Mig 083 corrige o futuro (aprovar não limpa mais). Esta mig restaura cards
-- atualmente nesse estado:
--   - state IN ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VALIDACAO_HUMANA')
--   - cliente_respondeu_em IS NULL E ia_sugestao_oc_resposta IS NULL
--   - card_events recente: AcaoRevertidaPosFalha (após último AprovacaoOperador
--     que tinha ia_sugestao_oc_resposta contexto)
--
-- Estratégia: reconstruir cliente_respondeu_em e ia_sugestao_oc_resposta dos
-- card_events ('InterpretadorRespostaClienteConcluido' + recebido_em do
-- messages_inbox).
-- ============================================================================

DO $$
DECLARE
  v_card record;
  v_ia_payload jsonb;
  v_resposta_recebida_em timestamptz;
  v_total_inspecionados int := 0;
  v_total_restaurados int := 0;
BEGIN
  FOR v_card IN
    SELECT c.id, c.nf, c.state, c.lock_aguardando_validacao,
           c.cod_ultima_ocorrencia
    FROM public.cards c
    WHERE c.state IN ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VALIDACAO_HUMANA')
      AND c.cliente_respondeu_em IS NULL
      AND c.ia_sugestao_oc_resposta IS NULL
      AND EXISTS (
        SELECT 1 FROM public.card_events ce
        WHERE ce.card_id = c.id
          AND ce.event_type = 'AcaoRevertidaPosFalha'
          AND ce.created_at > now() - interval '7 days'
      )
  LOOP
    v_total_inspecionados := v_total_inspecionados + 1;

    -- Busca a sugestão IA mais recente do card. Event canonical:
    -- InterpretadorRespostaClienteConcluido (interpretador-resposta-cliente
    -- escreve payload = sugestaoFull com oc_sugerida/confianca/motivo).
    SELECT payload INTO v_ia_payload
    FROM public.card_events
    WHERE card_id = v_card.id
      AND event_type = 'InterpretadorRespostaClienteConcluido'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_ia_payload IS NULL THEN
      CONTINUE;
    END IF;

    -- Última resposta cliente em messages_inbox
    SELECT recebido_em INTO v_resposta_recebida_em
    FROM public.messages_inbox
    WHERE card_id = v_card.id
    ORDER BY recebido_em DESC
    LIMIT 1;

    IF v_resposta_recebida_em IS NULL THEN
      CONTINUE;
    END IF;

    -- Restaura: AVH + lock=true + cliente_respondeu_em + ia_sugestao
    UPDATE public.cards
    SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
        lock_aguardando_validacao = true,
        cliente_respondeu_em = v_resposta_recebida_em,
        ia_sugestao_oc_resposta = v_ia_payload
    WHERE id = v_card.id;

    INSERT INTO public.card_events (
      card_id, event_type, actor_type, actor_id, payload
    ) VALUES (
      v_card.id,
      'ClienteRespondeuRestauradoAposFalha',
      'system',
      'mig_084_restaurar',
      jsonb_build_object(
        'nf', v_card.nf,
        'state_anterior', v_card.state,
        'lock_anterior', v_card.lock_aguardando_validacao,
        'cliente_respondeu_em', v_resposta_recebida_em,
        'sugestao_recuperada_de', 'card_events.InterpretadorRespostaClienteConcluido',
        'motivo', 'Mig 083 corrigiu raiz; este restauro recupera cards já afetados pelo bug antigo (aprovar limpava prematuramente).'
      )
    );

    v_total_restaurados := v_total_restaurados + 1;
  END LOOP;

  RAISE NOTICE 'Restauro cliente_respondeu_em: % cards inspecionados, % restaurados',
    v_total_inspecionados, v_total_restaurados;
END;
$$;
