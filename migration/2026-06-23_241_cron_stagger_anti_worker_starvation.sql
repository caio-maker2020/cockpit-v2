-- =============================================================================
-- CRON STAGGER — anti "job startup timeout" (apagão 2026-06-23).
--
-- PROBLEMA: a instância tem max_worker_processes=6. pg_cron lança CADA job num
-- background worker. Vários jobs disparavam no MESMO segundo (minuto 0): os 3 de
-- `* * * * *` (triador/vinculador/executor) + os 5 de `*/5` + os 2 de `*/15` +
-- cleanup `0 * * * *` → até ~10 jobs brigando por 6 slots → "job startup timeout"
-- em cascata (sob a saturação que a RLS per-row já causava — ver mig 242).
--
-- FIX: espalhar os horários (alter_job só muda schedule; comando/ativo intactos)
-- pra no máximo ~4 jobs por minuto. O trio `* * * * *` é inerente (granularidade
-- mínima do cron = 1min) e cabe nos 6 slots; o que matava era o empilhamento dos
-- periódicos sobre ele. Comandos são net.http_post (async, ms) — staggering é
-- defesa-em-profundidade; a causa-raiz da saturação foi resolvida na mig 240.
-- Guard: item no /verify-cockpit (nº de jobs por minuto-âncora <= 4).
-- =============================================================================

-- 5 jobs de 5-em-5-min → minutos distintos (0..4), saem de cima do minuto 0:
SELECT cron.alter_job(job_id := 5,  schedule := '0-59/5 * * * *');  -- health-check        0,5,10..
SELECT cron.alter_job(job_id := 8,  schedule := '1-59/5 * * * *');  -- gmail-poll          1,6,11..
SELECT cron.alter_job(job_id := 10, schedule := '2-59/5 * * * *');  -- cron-ia-resposta     2,7,12..
SELECT cron.alter_job(job_id := 23, schedule := '3-59/5 * * * *');  -- agente-oc13          3,8,13..
SELECT cron.alter_job(job_id := 24, schedule := '4-59/5 * * * *');  -- agente-sugere-ocs    4,9,14..

-- 2 jobs de 15-em-15-min → fora do minuto 0:
SELECT cron.alter_job(job_id := 12, schedule := '6-59/15 * * * *');  -- audit-invariante    6,21,36,51
SELECT cron.alter_job(job_id := 7,  schedule := '9-59/15 * * * *');  -- processar-acoes     9,24,39,54

-- cleanup pesado (UPDATE síncrono em cards) → fora do minuto 0:
SELECT cron.alter_job(job_id := 11, schedule := '37 * * * *');       -- cleanup-historico-ssw  :37
