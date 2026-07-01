-- =============================================================================
-- 2026-06-24_264 — JULIA fica SÓ com a planilha dela (espelha mig 262/263)
-- =============================================================================
-- Diretriz Caio 2026-06-24: "os da [operador] é apenas o que te passei na
-- planilha". Mesma correção da Camila (mig 262 + 263), agora pra JULIA
-- (segmentos {003,005}): o onboarding reatribuiu por segmento e sobre-capturou
-- cards cujo CNPJ não está na planilha da Julia.
--
--   1. Card da Julia cujo cnpj_pagador ∈ planilha de outro operador ativo
--      → reatribui pro dono real (+ segmento_codigo = seg primário do dono).
--   2. Card da Julia cujo cnpj não está em NENHUMA planilha → órfão (sai dela).
--   3. cards seg 003/005 de OUTRO operador → reetiqueta segmento p/ não vazar
--      na visão da Julia.
--
-- Idempotente. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE v_julia uuid; v_carteira text[]; v_reatrib int; v_orfao int; v_retag int;
BEGIN
  SELECT id, carteira INTO v_julia, v_carteira FROM public.operadores WHERE nome='JULIA';

  CREATE TEMP TABLE _ju ON COMMIT DROP AS
  SELECT cc.id,
         lpad(regexp_replace(cc.agent_state->>'cnpj_pagador','\D','','g'),14,'0') cnpj,
         cc.responsavel_relacionamento resp_old, cc.assigned_operator_id aid_old,
         d.id dono_id, d.nome dono_nome, d.segmentos[1] dono_seg
  FROM public.cards cc
  LEFT JOIN LATERAL (
    SELECT o.id, o.nome, o.segmentos FROM public.operadores o
    WHERE o.ativo AND o.nome<>'JULIA'
      AND lpad(regexp_replace(cc.agent_state->>'cnpj_pagador','\D','','g'),14,'0') = ANY(o.carteira)
    ORDER BY o.nome LIMIT 1
  ) d ON true
  WHERE cc.assigned_operator_id=v_julia AND cc.state NOT IN ('RESOLVIDO','CANCELADO')
    AND NOT (lpad(regexp_replace(cc.agent_state->>'cnpj_pagador','\D','','g'),14,'0') = ANY(v_carteira));

  -- 1. reatribui pros donos reais
  WITH upd AS (
    UPDATE public.cards c SET assigned_operator_id=j.dono_id, responsavel_relacionamento=j.dono_nome,
                              segmento_codigo=COALESCE(j.dono_seg,c.segmento_codigo)
    FROM _ju j WHERE c.id=j.id AND j.dono_id IS NOT NULL
    RETURNING c.id, j.resp_old, j.aid_old, j.dono_nome, j.cnpj
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_264',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo',dono_nome,'cnpj_pagador',cnpj,
      'motivo','Planilha=verdade: CNPJ pertence à planilha de '||dono_nome||' (saiu da Julia)')
  FROM upd;
  GET DIAGNOSTICS v_reatrib = ROW_COUNT;

  -- 2. órfãos
  WITH upd AS (
    UPDATE public.cards c SET assigned_operator_id=NULL, segmento_codigo=NULL
    FROM _ju j WHERE c.id=j.id AND j.dono_id IS NULL
    RETURNING c.id, j.resp_old, j.aid_old, j.cnpj
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_264',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo',NULL,'cnpj_pagador',cnpj,
      'motivo','Planilha=verdade: CNPJ não está em nenhuma planilha — removido da Julia (órfão)')
  FROM upd;
  GET DIAGNOSTICS v_orfao = ROW_COUNT;

  -- 3. reetiqueta seg 003/005 de outro operador (não vaza na visão da Julia)
  WITH alvo AS (
    SELECT c.id, c.segmento_codigo seg_old, o.nome dono, o.segmentos[1] dono_seg
    FROM public.cards c
    JOIN public.operadores o ON o.id=c.assigned_operator_id AND o.ativo AND o.id<>v_julia
    WHERE c.segmento_codigo IN ('003','005') AND c.state NOT IN ('RESOLVIDO','CANCELADO')
      AND o.segmentos[1] IS NOT NULL AND o.segmentos[1] NOT IN ('003','005')
  ), upd AS (
    UPDATE public.cards c SET segmento_codigo=a.dono_seg FROM alvo a WHERE c.id=a.id
    RETURNING c.id, a.seg_old, a.dono, a.dono_seg
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'SegmentoReetiquetado','system','fix_mig_264',
    jsonb_build_object('segmento_anterior',seg_old,'segmento_novo',dono_seg,'dono',dono,
      'motivo','Card seg 003/005 de '||dono||' não deve aparecer na visão da Julia (planilha=verdade)')
  FROM upd;
  GET DIAGNOSTICS v_retag = ROW_COUNT;

  RAISE NOTICE 'mig 264 JULIA: % reatribuídos, % orfanados, % reetiquetados', v_reatrib, v_orfao, v_retag;
END $$;

COMMIT;
