-- =============================================================================
-- 2026-06-24_262 — CAMILA fica SÓ com os clientes da planilha dela (por CNPJ)
-- =============================================================================
-- Diretriz Caio 2026-06-24 (verdade = planilha):
--   "se o cliente consta na planilha do [outro operador], é do [outro] —
--    independente do que aconteceu no passado. os da camila é apenas o que te
--    passei na planilha."
--
-- O onboarding (mig 260) reatribuiu cards à CAMILA por SEGMENTO (001), o que
-- sobre-capturou cards cujo CNPJ pertence à planilha de OUTRO operador ativo
-- (15 cards do ISA E KAROL) + cards de clientes que não estão na planilha de
-- ninguém (7 cards, ex-Carlos). Esta migration corrige POR CNPJ:
--
--   1. Card da Camila cujo cnpj_pagador ∈ carteira de outro operador ativo
--      → reatribui pro dono real (assigned + responsavel + segmento_codigo =
--        segmento primário do dono, p/ sair da visão seg-001 da Camila).
--   2. Card da Camila cujo cnpj_pagador NÃO está em NENHUMA planilha
--      → órfão (assigned_operator_id=NULL, segmento_codigo=NULL) — sai da Camila.
--   3. Resto (cnpj ∈ planilha da Camila) → permanece com ela.
--
-- Match de CNPJ: agent_state->>'cnpj_pagador' normalizado (só dígitos, zfill 14)
-- contra operadores.carteira (já em 14 dígitos). cards.pagador é NOME, não serve.
--
-- Event sourcing: card_event 'OperadorReatribuido' p/ cada card tocado.
-- Idempotente. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE v_camila uuid; v_cam_carteira text[]; v_reatrib int; v_orfao int;
BEGIN
  SELECT id, carteira INTO v_camila, v_cam_carteira FROM public.operadores WHERE nome='CAMILA';

  -- normaliza o cnpj do card uma vez via CTE materializada
  CREATE TEMP TABLE _cam_cards ON COMMIT DROP AS
  SELECT c.id,
         lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') cnpj,
         c.responsavel_relacionamento resp_old, c.assigned_operator_id aid_old
  FROM public.cards c
  WHERE c.assigned_operator_id = v_camila
    AND c.state NOT IN ('RESOLVIDO','CANCELADO');

  -- dono real por CNPJ (outro operador ativo cuja carteira contém o cnpj)
  -- LATERAL pega 1 determinístico (menor nome) se houver +1
  CREATE TEMP TABLE _dono ON COMMIT DROP AS
  SELECT cc.id, cc.cnpj, cc.resp_old, cc.aid_old,
         d.id AS dono_id, d.nome AS dono_nome, COALESCE(d.segmentos[1], NULL) AS dono_seg
  FROM _cam_cards cc
  LEFT JOIN LATERAL (
    SELECT o.id, o.nome, o.segmentos
    FROM public.operadores o
    WHERE o.ativo AND o.nome <> 'CAMILA' AND cc.cnpj = ANY(o.carteira)
    ORDER BY o.nome LIMIT 1
  ) d ON true
  WHERE NOT (cc.cnpj = ANY(v_cam_carteira));

  -- 1. reatribui pros donos reais
  WITH upd AS (
    UPDATE public.cards c
    SET assigned_operator_id = d.dono_id,
        responsavel_relacionamento = d.dono_nome,
        segmento_codigo = COALESCE(d.dono_seg, c.segmento_codigo)
    FROM _dono d
    WHERE c.id = d.id AND d.dono_id IS NOT NULL
    RETURNING c.id, d.resp_old, d.aid_old, d.dono_nome, d.cnpj
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_262',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo',dono_nome,'cnpj_pagador',cnpj,
      'motivo','Planilha=verdade: CNPJ pertence à planilha de '||dono_nome||' (saiu da Camila)')
  FROM upd;
  GET DIAGNOSTICS v_reatrib = ROW_COUNT;

  -- 2. órfãos (não estão em nenhuma planilha) — saem da Camila
  WITH upd AS (
    UPDATE public.cards c
    SET assigned_operator_id = NULL,
        segmento_codigo = NULL
    FROM _dono d
    WHERE c.id = d.id AND d.dono_id IS NULL
    RETURNING c.id, d.resp_old, d.aid_old, d.cnpj
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','fix_mig_262',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo',NULL,'cnpj_pagador',cnpj,
      'motivo','Planilha=verdade: CNPJ não está em nenhuma planilha — removido da Camila (órfão)')
  FROM upd;
  GET DIAGNOSTICS v_orfao = ROW_COUNT;

  RAISE NOTICE 'mig 262: % cards reatribuídos pro dono real, % cards orfanados (saíram da Camila)', v_reatrib, v_orfao;
END $$;

COMMIT;
