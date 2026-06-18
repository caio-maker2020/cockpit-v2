-- ============================================================================
-- Remove o monitoramento oc21→oc14 (Caio 2026-06-18): não usado mais.
--
-- Desliga os 2 crons do INDICADOR/ALERTA, dropa as 3 views e as 3 tabelas do
-- recurso. As 4 edge functions do recurso (processar-alertas-sla-oc21-oc14,
-- processar-tempos-oc21-oc14, analisar-indicador-tempo-oc21-oc14,
-- gerar-cobranca-oc14-individual) são removidas do repo + deletadas no Supabase
-- fora desta migration. O indicador no front (Lovable) também sai.
--
-- NÃO TOCAR (infra compartilhada com prioridades-ai / agente oc13, ATIVO):
--   - função public.dias_uteis_entre (usada por views de prioridades + oc13)
--   - view v_oc21_paradas_prioridades (lida por sync-kanban-status-prioridades)
--   - view v_oc13_paradas
--   - edge function + cron `refresh-historico-cards-com-oc21-6h`: apesar do nome,
--     mantém historico_ssw fresco pros cards oc=21 E oc=13 (filtra
--     cod_ultima_ocorrencia IN (13,21)) — base da visibilidade do agente oc13 e
--     da aba PRIORIDADES AI. NÃO faz parte do indicador/alerta oc21→oc14. FICA.
-- O sync-kanban-status-prioridades só citava v_oc21_aguardando_oc14 em COMENTÁRIO
-- velho (v2 trocou por v_oc21_paradas_prioridades) — drop seguro.
-- ============================================================================

-- 1. Desagenda os 2 crons do indicador/alerta (no-op se já removidos).
--    O cron refresh-historico-cards-com-oc21-6h NÃO entra aqui (infra oc13).
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'processar-tempos-oc21-oc14-daily',
  'processar-alertas-sla-oc21-oc14-horario'
);

-- 2. Views do recurso (front lia o indicador — será removido no Lovable).
DROP VIEW IF EXISTS public.v_indicador_tempo_oc21_oc14_base;
DROP VIEW IF EXISTS public.v_tempo_oc21_oc14_detalhe;
DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14;

-- 3. Tabelas do recurso. alertas_sla_oc21_oc14 e contatos_bases_ssw estavam
--    vazias; tempo_oc21_para_oc14 tinha ~258 linhas históricas, descartadas
--    conforme decisão (recurso desativado).
DROP TABLE IF EXISTS public.alertas_sla_oc21_oc14;
DROP TABLE IF EXISTS public.tempo_oc21_para_oc14;
DROP TABLE IF EXISTS public.contatos_bases_ssw;
