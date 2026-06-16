-- =============================================================================
-- 2026-06-16_209_desativar_crons_prioridades_ai
--
-- Desativa o feature PRIORIDADES AI (kanban/funil de priorização de cobrança).
-- Não funcionou como esperado; o time trata priorização de outra forma agora.
--
-- PROFUNDIDADE "MÉDIA" (reversível): este migration SÓ desliga os 5 pg_cron jobs
-- (para o custo dos agentes Sonnet + o import oc=13/21 do Bastão como cards
-- TRANSFERIDO). NÃO dropa nenhuma tabela/view/coluna/função — TODOS os dados e
-- objetos de banco ficam intactos pra reativação futura. As edge functions são
-- removidas do deploy em separado (supabase functions delete), mas o código
-- continua no repo.
--
-- Idempotente: cron.unschedule só roda se o job existir (WHERE EXISTS), pode
-- reaplicar sem erro.
--
-- REATIVAÇÃO FUTURA: re-rodar as migrations de agendamento equivalentes às
-- 129 (sync-kanban-status-daily, agente-priorizador-2x, agente-monitor-4x),
-- 154 (cron-sync-prioridades-30min) e 172 (sync-prioridades-ai-do-bastao-1h),
-- e redeployar as edge functions correspondentes.
-- =============================================================================

-- 1. Sync de histórico SSW dos cards em kanban (a cada 30 min).
SELECT cron.unschedule('cron-sync-prioridades-ai-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-sync-prioridades-ai-30min');

-- 2. Agente priorizador (Sonnet, 2x/dia) — ranqueava cards parados por operador.
SELECT cron.unschedule('agente-priorizador-ai-2x')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-priorizador-ai-2x');

-- 3. Agente monitor de efetividade (Sonnet, 4x/dia) — classificava efetividade
--    pós-cobrança e aplicava transições kanban.
SELECT cron.unschedule('agente-monitor-efetividade-ai-4x')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-monitor-efetividade-ai-4x');

-- 4. Bootstrap/housekeeping diário do prioridades_kanban_status (1x/dia).
SELECT cron.unschedule('sync-kanban-status-prioridades-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-kanban-status-prioridades-daily');

-- 5. Import de pendências oc=13/21 do Bastão como cards TRANSFERIDO (a cada 1h).
SELECT cron.unschedule('sync-prioridades-ai-do-bastao-1h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-prioridades-ai-do-bastao-1h');
