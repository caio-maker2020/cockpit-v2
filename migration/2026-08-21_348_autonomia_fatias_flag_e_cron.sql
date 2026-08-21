-- =============================================================================
-- 2026-08-21_348_autonomia_fatias_flag_e_cron.sql
--
-- Rodada 2 da autonomia (Caio 21/08): o fio que liga o cofre aos agentes.
--   1. Flag master `autonomia_fatias_enabled` — NASCE OFF. Mesmo com fatia
--      promovida (⚡), NADA roda sozinho até o Caio ligar. Kill-switch sem deploy.
--   2. Cron diário do kill-switch de QUALIDADE: demover_fatias_abaixo_da_meta()
--      (mig 340 — histerese: promove ≥95, despromove <90 em 14d/20+ pares).
--      A função existia sem agendamento ("rodar no cron diário" ficou na
--      intenção) — agora roda 05:45 BRT, antes do expediente.
--
-- Código (mesmo PR): _shared/autonomia-fatias.ts chamado por
-- agente-sugere-ocs-padrao e agente-oc13-autonomo; executor pula o feedback
-- implícito em aprovações automáticas (placar não se autoavalia).
--
-- SEM begin/commit interno (lição da mig 337). Idempotente.
-- =============================================================================

insert into public.feature_flags (key, enabled)
values ('autonomia_fatias_enabled', false)
on conflict (key) do nothing;

comment on function public.demover_fatias_abaixo_da_meta(numeric) is
  'Kill-switch de qualidade da autonomia por fatia (mig 340): despromove fatia ativa que caiu abaixo do piso (default 90%) na janela de 14d com ≥20 pares. Agendada diariamente às 05:45 BRT (mig 348).';

-- Cron (idempotente: remove agendamento anterior de mesmo nome antes)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'demover-fatias-autonomia-diario') then
    perform cron.unschedule('demover-fatias-autonomia-diario');
  end if;
  perform cron.schedule(
    'demover-fatias-autonomia-diario',
    '45 8 * * *',  -- 08:45 UTC = 05:45 BRT
    $cron$ select public.demover_fatias_abaixo_da_meta(90); $cron$
  );
end;
$$;
