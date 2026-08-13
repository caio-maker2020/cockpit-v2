-- =============================================================================
-- 2026-08-13_336_wurth_robo_execucoes.sql
--
-- Feature (Caio 2026-08-12): indicador no card Würth de quando o robô da intranet
-- rodou pela ÚLTIMA vez (+ contadores). A PRÓXIMA é computada no front a partir
-- do cron `robo-intranet-wurth-2x-dia` (0 11,19 UTC = 08h/16h BRT).
--
-- O robô grava 1 linha por VARREDURA (origem='cron'; buscas via botão NÃO contam
-- pro indicador — elas dão o toast na hora). Leitura pelo front só via RPC
-- SECURITY DEFINER (mínima exposição, sem abrir a tabela — lição cliente_config).
-- =============================================================================

create table if not exists public.wurth_robo_execucoes (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  origem text not null check (origem in ('cron', 'botao')),
  cards_wurth_ativos int not null default 0,
  retornos_aplicados int not null default 0,
  erros int not null default 0,
  duration_ms int
);

create index if not exists idx_wurth_robo_exec_started
  on public.wurth_robo_execucoes (started_at desc);

-- RLS ON sem policy de SELECT: authenticated NÃO lê direto (só via RPC).
-- O robô grava via service_role (bypassa RLS). Grant explícito p/ garantir.
alter table public.wurth_robo_execucoes enable row level security;
grant select, insert on public.wurth_robo_execucoes to service_role;

create or replace function public.ultima_rodada_wurth()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'started_at', started_at,
    'started_at_fmt', to_char(started_at at time zone 'America/Sao_Paulo', 'DD/MM/YY, HH24:MI'),
    'origem', origem,
    'retornos_aplicados', retornos_aplicados,
    'erros', erros,
    'minutos', floor(extract(epoch from (now() - started_at)) / 60)::int
  )
  from public.wurth_robo_execucoes
  order by started_at desc
  limit 1;
$$;

revoke all on function public.ultima_rodada_wurth() from public;
grant execute on function public.ultima_rodada_wurth() to authenticated, service_role;

comment on function public.ultima_rodada_wurth() is
  'Card Würth: última VARREDURA do robô-intranet (BRT + contadores). A próxima é '
  'computada no front pelo cron 08h/16h. Caio 2026-08-13.';
