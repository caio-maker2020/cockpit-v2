-- =============================================================================
-- 2026-09-02_376_faxina_prioridades_ai_e_cron_cobranca.sql
--
-- Faxina da feature MORTA "Prioridades AI" + cron-produtor da cobrança de
-- cliente (ADR 0021). Blast radius medido em 02/09 (pg_depend + grep no repo,
-- front, migrations e pg_proc):
--   - RPC registrar_saidas_kanban (lê v_prioridades_ai) só era chamada pelas
--     funções apagadas; sem trigger. Cai junto.
--   - v_prioridades_ai depende de v_oc13_paradas_prioridades e
--     v_oc21_paradas_prioridades; _ultimo_sync e _saidas_recentes não têm
--     dependentes. NENHUMA função do banco lê essas views; no código só as
--     funções mortas (agente-priorizador-ai, agente-insights-globais-ai,
--     sync-kanban-status-prioridades) — apagadas neste mesmo commit. Front: zero.
--   - `dias_uteis_entre` NÃO é tocada: v_oc13_paradas, v_oc21_finalizadas e
--     v_extravios_kanban (vivas) a usam.
--   - Tabelas `analises_prioridades_ai` e `prioridades_ai_saidas` FICAM
--     (dado histórico; apagar dado é outra decisão). Só as VIEWS caem.
--   - Cron `cobranca-cliente-aguardando-daily` (jobid 15) está INATIVO desde a
--     mig 168; as funções que ele chamava foram apagadas (ADR 0020). Remover o
--     job impede religar por engano.
--
-- TIPO B (remoção de objeto existente + cron.unschedule). AUTORIZAÇÃO: Caio,
-- 2026-09-02, sessão Claude Code: "ok pode regularizar. ja faca os pontos 1 2 e 3"
-- (ponto 3 = faxina de Prioridades AI). Idempotente. SEM BEGIN/COMMIT interno.
-- REVERSÃO: definições das views nas migs 129/158/209/215 e no git; cron na 104.
-- =============================================================================

-- RPC exclusiva de Prioridades AI (migs 141/144): chamada só por cron-sync-prioridades-ai
-- e atualizar-batch-prioridades-ai (apagadas); sem trigger; lê v_prioridades_ai.
DROP FUNCTION IF EXISTS public.registrar_saidas_kanban(uuid[], text);

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind IN ('f','p') AND pg_get_functiondef(p.oid) ~ '(v_prioridades_ai|v_oc21_paradas_prioridades|v_oc13_paradas_prioridades)';
  IF v <> 0 THEN RAISE EXCEPTION 'G1: % função(ões) do banco ainda leem views de prioridades — abortando', v; END IF;
  SELECT count(*) INTO v FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid JOIN pg_class dep ON dep.oid=r.ev_class
   JOIN pg_class ref ON ref.oid=d.refobjid
   WHERE ref.relname IN ('v_prioridades_ai','v_prioridades_ai_ultimo_sync','v_prioridades_ai_saidas_recentes','v_oc21_paradas_prioridades','v_oc13_paradas_prioridades')
     AND dep.relname NOT IN ('v_prioridades_ai','v_prioridades_ai_ultimo_sync','v_prioridades_ai_saidas_recentes','v_oc21_paradas_prioridades','v_oc13_paradas_prioridades');
  IF v <> 0 THEN RAISE EXCEPTION 'G2: % dependente(s) externo(s) das views — abortando', v; END IF;
END $$;

DROP VIEW IF EXISTS public.v_prioridades_ai_saidas_recentes;
DROP VIEW IF EXISTS public.v_prioridades_ai_ultimo_sync;
DROP VIEW IF EXISTS public.v_prioridades_ai;
DROP VIEW IF EXISTS public.v_oc21_paradas_prioridades;
DROP VIEW IF EXISTS public.v_oc13_paradas_prioridades;

DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'cobranca-cliente-aguardando-daily';
  IF jid IS NOT NULL THEN
    PERFORM cron.unschedule(jid);
    RAISE NOTICE 'cron cobranca-cliente-aguardando-daily (jobid=%) REMOVIDO', jid;
  END IF;
END $$;

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_views WHERE schemaname='public' AND viewname IN ('v_prioridades_ai','v_prioridades_ai_ultimo_sync','v_prioridades_ai_saidas_recentes','v_oc21_paradas_prioridades','v_oc13_paradas_prioridades');
  IF v <> 0 THEN RAISE EXCEPTION 'pós: % view(s) ainda existem', v; END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='cobranca-cliente-aguardando-daily') THEN RAISE EXCEPTION 'pós: cron ainda existe'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='dias_uteis_entre') THEN RAISE EXCEPTION 'pós: dias_uteis_entre sumiu'; END IF;
  IF (SELECT count(*) FROM pg_views WHERE viewname IN ('v_oc13_paradas','v_oc21_finalizadas','v_extravios_kanban')) <> 3 THEN RAISE EXCEPTION 'pós: view viva sumiu'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='registrar_saidas_kanban') THEN RAISE EXCEPTION 'pós: registrar_saidas_kanban ainda existe'; END IF;
  RAISE NOTICE 'mig 376 OK — 5 views + RPC de Prioridades AI removidas, cron de cobrança removido, vivas intactas';
END $$;
