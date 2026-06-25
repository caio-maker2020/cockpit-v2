-- =============================================================================
-- 2026-06-24_263 — cards seg=001 de OUTRO operador não vazam pra visão da CAMILA
-- =============================================================================
-- Diretriz Caio 2026-06-24: "os da camila é apenas o que te passei na planilha".
--
-- CAMILA tem segmentos={001}. A RLS (card_visivel_pelo_operador_atual, mig 025)
-- mostra TODO card com segmento_codigo='001' pra ela. Restam cards seg=001 que
-- JÁ pertencem (assigned) a outro operador ativo (ex.: 7 cards ATACADO UNIAO,
-- CNPJ 12377080000188, do ISA E KAROL) — a Camila os veria indevidamente.
--
-- Fix: NÃO muda o dono (continuam de quem são). Só reetiqueta segmento_codigo
-- para o segmento primário do dono real, tirando-os da rede seg-001 da Camila.
-- (cards.pagador é NOME → carteira-RLS não filtra; a visão da Camila é só via
--  segmento_codigo + assigned. Por isso reetiquetar o segmento é o que resolve.)
--
-- Idempotente; sem reatribuição de propriedade. skill: supabase-postgres-best-practices.
-- =============================================================================
BEGIN;

DO $$
DECLARE v_camila uuid; v_cnt int;
BEGIN
  SELECT id INTO v_camila FROM public.operadores WHERE nome='CAMILA';

  WITH alvo AS (
    SELECT c.id, c.segmento_codigo seg_old, o.nome dono, o.segmentos[1] dono_seg
    FROM public.cards c
    JOIN public.operadores o ON o.id=c.assigned_operator_id AND o.ativo AND o.id<>v_camila
    WHERE c.segmento_codigo='001'
      AND c.state NOT IN ('RESOLVIDO','CANCELADO')
      AND o.segmentos[1] IS NOT NULL
      AND o.segmentos[1] <> '001'
  ), upd AS (
    UPDATE public.cards c
    SET segmento_codigo = a.dono_seg
    FROM alvo a WHERE c.id=a.id
    RETURNING c.id, a.seg_old, a.dono, a.dono_seg
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'SegmentoReetiquetado','system','fix_mig_263',
    jsonb_build_object('segmento_anterior',seg_old,'segmento_novo',dono_seg,'dono',dono,
      'motivo','Card seg 001 de '||dono||' não deve aparecer na visão seg-001 da Camila (planilha=verdade)')
  FROM upd;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'mig 263: % cards seg-001 de outro operador reetiquetados (saíram da visão da Camila)', v_cnt;
END $$;

COMMIT;
