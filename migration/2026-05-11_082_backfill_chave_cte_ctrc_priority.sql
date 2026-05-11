-- ============================================================================
-- Cockpit v2 — Backfill retroativo de chave_cte com CTRC priority (v3)
-- Data: 2026-05-11
--
-- Bug raiz NF 351849 + 351960 + outros: cards criados ANTES do deploy de hoje
-- (mig 078/079) tinham chave_cte resolvida pelo algoritmo v2 (sem CTRC),
-- frequentemente apontando pro CT-e de reentrega/complementar. SSW responde
-- "DOCUMENTO BAIXADO OU ENTREGUE" porque esses CT-es finalizam com oc=34.
--
-- O resolver helper (chave-cte-resolver.ts) é IDEMPOTENTE — pula se já tem
-- chave em agent_state. Pass F do sync só retenta sem_chave_cte=true. Logo,
-- cards legados ficam com chave errada eternamente até alguém forçar.
--
-- Este backfill:
--   1. Pra cada card com ctrc IS NOT NULL e agent_state->>'chave_cte' IS NOT NULL,
--      chama lookup_chave_cte(nf, cnpj_pagador, ctrc) v3.
--   2. Se a chave retornada for diferente da atual:
--      - Atualiza cards.agent_state.chave_cte
--      - Atualiza todos.proposta_payload.args.chave_cte de propostas pendentes
--      - Grava card_event ChaveCteCorrigidaRetroativamenteRunV2
--   3. Idempotente — rodar de novo não faz nada se já está correto.
--
-- Executor (linha ~265) já prioriza agent_state sobre proposta_payload.args
-- desde fix de hoje, mas atualizamos args também pra consistência total.
-- ============================================================================

DO $$
DECLARE
  v_card record;
  v_chave_nova text;
  v_total_cards int := 0;
  v_corrigidos int := 0;
  v_propostas_atualizadas int := 0;
BEGIN
  FOR v_card IN
    SELECT
      c.id,
      c.nf,
      c.ctrc,
      c.agent_state,
      c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
      c.agent_state->>'chave_cte' AS chave_atual
    FROM public.cards c
    WHERE c.ctrc IS NOT NULL
      AND c.nf IS NOT NULL
      AND c.agent_state->>'cnpj_pagador' IS NOT NULL
      AND c.agent_state->>'chave_cte' IS NOT NULL
      AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
  LOOP
    v_total_cards := v_total_cards + 1;

    SELECT chave_cte INTO v_chave_nova
    FROM public.lookup_chave_cte(v_card.nf, v_card.cnpj_pagador, v_card.ctrc)
    LIMIT 1;

    IF v_chave_nova IS NOT NULL
       AND v_chave_nova <> v_card.chave_atual
    THEN
      v_corrigidos := v_corrigidos + 1;

      UPDATE public.cards
      SET agent_state = jsonb_set(
            COALESCE(agent_state, '{}'::jsonb),
            '{chave_cte}',
            to_jsonb(v_chave_nova)
          ),
          sem_chave_cte = false
      WHERE id = v_card.id;

      WITH atualizadas AS (
        UPDATE public.todos t
        SET proposta_payload = jsonb_set(
              t.proposta_payload,
              '{args,chave_cte}',
              to_jsonb(v_chave_nova)
            )
        WHERE t.card_id = v_card.id
          AND t.status = 'pendente'
          AND t.proposta_payload->'args'->>'chave_cte' IS NOT NULL
          AND t.proposta_payload->'args'->>'chave_cte' <> v_chave_nova
        RETURNING id
      )
      SELECT COALESCE(count(*), 0) INTO v_propostas_atualizadas
      FROM atualizadas;

      INSERT INTO public.card_events (
        card_id, event_type, actor_type, actor_id, payload
      ) VALUES (
        v_card.id,
        'ChaveCteCorrigidaRetroativamenteRunV2',
        'system',
        'mig_082_backfill_ctrc_priority',
        jsonb_build_object(
          'nf', v_card.nf,
          'ctrc', v_card.ctrc,
          'chave_antiga', v_card.chave_atual,
          'chave_nova', v_chave_nova,
          'propostas_pendentes_atualizadas', v_propostas_atualizadas,
          'motivo', 'Algoritmo v3 com CTRC priority — corrige cards que tinham chave do CT-e reentrega/complementar'
        )
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'Backfill chave_cte v3: % cards inspecionados, % corrigidos',
    v_total_cards, v_corrigidos;
END;
$$;
