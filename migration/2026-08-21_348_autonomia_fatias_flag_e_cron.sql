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

-- =============================================================================
-- REGRA DO CAIO (21/08, expressa): "Nada roda autônomo sem minha validação
-- expressa. O botão do Cockpit APENAS SINALIZA."
--
-- O ⚡ da Gestão Agentes passa a registrar a fatia com ativa=FALSE
-- (sinalizada). fatia_esta_autonoma (mig 340) só devolve TRUE pra ativa=true —
-- ou seja, fatia sinalizada NÃO roda. A ativação real exige DUAS chaves, ambas
-- manuais e só com validação expressa do Caio no chat:
--   chave 1: UPDATE fatias_autonomas SET ativa=true WHERE id=...;
--   chave 2: feature_flags.autonomia_fatias_enabled = true.
-- =============================================================================
create or replace function public.promover_fatia_autonoma(
  p_agent_name text,
  p_oc_card integer,
  p_oc_sugerida integer
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_pct numeric;
  v_pares bigint;
  v_id uuid;
begin
  if public.current_operador_papel() is distinct from 'gestor' then
    raise exception 'Só gestão pode sinalizar fatia pra autonomia';
  end if;
  perform public.assert_pode_executar();

  select round(100.0 * count(*) filter (where f.veredito = 'seguida')
               / nullif(count(*) filter (where f.veredito in ('seguida','corrigida')), 0), 1),
         count(*) filter (where f.veredito in ('seguida','corrigida'))
    into v_pct, v_pares
  from public.agent_feedback f
  where f.agent_name = p_agent_name
    and f.oc_card is not distinct from p_oc_card
    and f.oc_sugerida = p_oc_sugerida
    and f.created_at > now() - interval '30 days';

  if coalesce(v_pct, 0) < 95 or coalesce(v_pares, 0) < 50 then
    raise exception 'Fatia fora da régua (precisa ≥95%% e ≥50 pares em 30d; tem %% = %, pares = %)', v_pct, v_pares;
  end if;

  -- dedupe manual (o unique parcial da mig 340 só cobre ativa=true)
  if exists (
    select 1 from public.fatias_autonomas fa
    where fa.agent_name = p_agent_name
      and fa.oc_card is not distinct from p_oc_card
      and fa.oc_sugerida = p_oc_sugerida
      and fa.demovida_em is null
  ) then
    return jsonb_build_object('ok', true, 'ja_existia', true, 'pct', v_pct, 'pares', v_pares);
  end if;

  insert into public.fatias_autonomas
    (agent_name, oc_card, oc_sugerida, ativa, pct_na_promocao, pares_na_promocao,
     promovida_em, promovida_por, motivo)
  values
    (p_agent_name, p_oc_card, p_oc_sugerida, false, v_pct, v_pares,
     now(), public.current_operador_id(),
     'SINALIZADA na Gestão Agentes — aguarda validação EXPRESSA do Caio pra ativar (regra 21/08)')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'pct', v_pct, 'pares', v_pares,
    'ja_existia', false, 'sinalizada', true);
end;
$$;

grant execute on function public.promover_fatia_autonoma(text, integer, integer) to authenticated;
