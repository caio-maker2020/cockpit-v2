-- =============================================================================
-- 2026-08-21_347_gestao_drill_fila_autonomia.sql
--
-- Pedidos do Caio (21/08, 2ª rodada de auditoria das abas de gestão):
--   1. Drill por OCORRÊNCIA GERADORA (oc do card no momento da sugestão):
--      oc_card entra nas views de placar/divergência — "oc 10 gerou sugestão 44
--      e o operador executou 21".
--   2. FIX NF 678886 (Würth): a foto da fila ancorava no evento antigo — agora
--      o marcador inclui RetornoIntranetWurth e, na coluna "cliente respondeu",
--      a âncora é GREATEST(evento, cliente_respondeu_em) — 3/77 cards estavam
--      com horas superestimadas (70h vs <1 dia).
--   3. Demanda por ocorrência: v_operador_tratativas ganha oc_entrada (a oc
--      que gerou o ciclo de trabalho).
--   4. Autonomia por fatia: RPC promover_fatia_autonoma (gestor + executor)
--      valida ≥95% e ≥50 pares em 30d e registra em fatias_autonomas (mig 340).
--   5. meu_dashboard_agentes passa a devolver oc_card (aba do operador espelha).
--
-- CREATE OR REPLACE VIEW: colunas novas SEMPRE no fim (contrato preservado).
-- SEM begin/commit interno (lição da mig 337). Idempotente.
-- =============================================================================

-- 1a. ─── v_gestao_agentes_placar + oc_card ───────────────────────────────────
create or replace view public.v_gestao_agentes_placar
with (security_invoker = on) as
select
  (f.created_at at time zone 'America/Sao_Paulo')::date as dia,
  f.agent_name,
  f.oc_sugerida,
  f.modo,
  f.operador_id,
  o.nome as operador_nome,
  count(*) filter (where f.veredito = 'seguida')   as seguidas,
  count(*) filter (where f.veredito = 'corrigida') as corrigidas,
  count(*) filter (where f.veredito = 'abstencao') as abstencoes,
  count(*) filter (where f.veredito in ('seguida','corrigida')) as pares,
  f.oc_card
from public.agent_feedback f
left join public.operadores o on o.id = f.operador_id
group by 1, 2, 3, 4, 5, 6, 11;

-- 1b. ─── v_gestao_agentes_divergencias + oc_card ─────────────────────────────
create or replace view public.v_gestao_agentes_divergencias
with (security_invoker = on) as
select
  (f.created_at at time zone 'America/Sao_Paulo')::date as dia,
  f.agent_name,
  f.oc_sugerida,
  f.oc_executada,
  f.operador_id,
  o.nome as operador_nome,
  count(*) as n,
  max(f.created_at) as ultimo_em,
  (array_agg(f.card_id order by f.created_at desc))[1:3] as cards_exemplo,
  f.oc_card
from public.agent_feedback f
left join public.operadores o on o.id = f.operador_id
where f.veredito = 'corrigida'
  and f.oc_sugerida is not null
  and f.oc_executada is not null
group by 1, 2, 3, 4, 5, 6, 10;

-- 3. ─── v_operador_tratativas: + RetornoIntranetWurth no marcador + oc_entrada
create or replace view public.v_operador_tratativas
with (security_invoker = on) as
select
  a.card_id,
  c.nf,
  c.pagador as cnpj_pagador,
  c.empresa_cliente,
  a.actor_id::uuid as operador_id,
  (a.created_at at time zone 'America/Sao_Paulo')::date as dia,
  ent.event_type as entrada_tipo,
  case when ent.event_type in ('RespostaClienteCapturada','RetornoClienteEmAguardo','CardReabertoPorRespostaCliente','RetornoIntranetWurth')
       then 'cliente_respondeu' else 'aguardando_voce' end as coluna,
  ent.created_at as entrada_em,
  a.created_at as tratado_em,
  round((extract(epoch from (a.created_at - ent.created_at)) / 3600.0)::numeric, 2) as horas_brutas,
  round(public.horas_uteis_entre(ent.created_at, a.created_at), 2) as horas_uteis,
  a.event_type = 'AprovacaoOperador' as foi_aprovacao,
  -- oc GERADORA do ciclo: último evento COM oc antes da tratativa (o evento de
  -- entrada nem sempre carrega — BastaoCardAtualizado guarda em payload.current)
  nullif(regexp_replace(coalesce(
    oce.payload->'current'->>'cod_ultima_ocorrencia',
    oce.payload->>'cod_ultima_ocorrencia',
    oce.payload->>'oc_atual_bastao',
    oce.payload->>'oc_atual',
    oce.payload->>'oc'
  ), '\D', '', 'g'), '')::int as oc_entrada
from public.card_events a
join public.cards c on c.id = a.card_id
left join lateral (
  select e.payload
  from public.card_events e
  where e.card_id = a.card_id
    and e.created_at < a.created_at
    and e.event_type in (
      'BastaoCardImportado','BastaoCardAtualizado','AguardandoClienteOcMudou',
      'CardReaberto','RetornoIntranetWurth'
    )
  order by e.created_at desc
  limit 1
) oce on true
left join lateral (
  select e.event_type, e.created_at
  from public.card_events e
  where e.card_id = a.card_id
    and e.created_at < a.created_at
    and e.event_type in (
      'TodoPropostoAutomaticamente','CardReaberto','BastaoCardImportado',
      'RespostaClienteCapturada','RetornoClienteEmAguardo',
      'CardReabertoPorRespostaCliente','AguardandoClienteOcMudou',
      'RetornoIntranetWurth'
    )
  order by e.created_at desc
  limit 1
) ent on true
where a.event_type in ('AprovacaoOperador','RejeicaoOperador')
  and a.actor_type = 'operator'
  and a.actor_id ~ '^[0-9a-f-]{36}$'
  and a.created_at > now() - interval '90 days'
  and ent.created_at is not null;

-- 2. ─── v_operador_fila_agora: âncora honesta (FIX NF 678886) ────────────────
create or replace view public.v_operador_fila_agora
with (security_invoker = on) as
with base as (
  select
    c.id as card_id,
    c.nf,
    c.pagador as cnpj_pagador,
    c.empresa_cliente,
    c.assigned_operator_id as operador_id,
    c.responsavel_relacionamento,
    case when c.cliente_respondeu_em is not null
          and c.cod_ultima_ocorrencia in (
            select (d.codigo)::int from public.ocorrencias_dicionario d
            where d.responsabilidade = 'Cliente'
          )
         then 'cliente_respondeu' else 'aguardando_voce' end as coluna,
    ent.created_at as entrada_evento,
    c.cliente_respondeu_em,
    c.cod_ultima_ocorrencia
  from public.cards c
  left join lateral (
    select e.created_at
    from public.card_events e
    where e.card_id = c.id
      and e.event_type in (
        'TodoPropostoAutomaticamente','CardReaberto','BastaoCardImportado',
        'RespostaClienteCapturada','RetornoClienteEmAguardo',
        'CardReabertoPorRespostaCliente','AguardandoClienteOcMudou',
        'RetornoIntranetWurth'
      )
    order by e.created_at desc
    limit 1
  ) ent on true
  where c.state = 'AGUARDANDO_VALIDACAO_HUMANA'
    and ent.created_at is not null
)
select
  b.card_id, b.nf, b.cnpj_pagador, b.empresa_cliente, b.operador_id,
  b.responsavel_relacionamento, b.coluna,
  -- FIX NF 678886: na coluna "cliente respondeu" o relógio (re)começa na
  -- resposta mais recente — nunca antes dela.
  case when b.coluna = 'cliente_respondeu'
       then greatest(b.entrada_evento, coalesce(b.cliente_respondeu_em, b.entrada_evento))
       else b.entrada_evento end as na_fila_desde,
  round((extract(epoch from (now() - (case when b.coluna = 'cliente_respondeu'
       then greatest(b.entrada_evento, coalesce(b.cliente_respondeu_em, b.entrada_evento))
       else b.entrada_evento end))) / 3600.0)::numeric, 1) as horas_brutas,
  round(public.horas_uteis_entre((case when b.coluna = 'cliente_respondeu'
       then greatest(b.entrada_evento, coalesce(b.cliente_respondeu_em, b.entrada_evento))
       else b.entrada_evento end), now()), 2) as horas_uteis,
  public.horas_uteis_entre((case when b.coluna = 'cliente_respondeu'
       then greatest(b.entrada_evento, coalesce(b.cliente_respondeu_em, b.entrada_evento))
       else b.entrada_evento end), now()) > 9.5 as parado_mais_1d_util,
  b.cod_ultima_ocorrencia as oc_card
from base b;

-- 4. ─── RPC promover_fatia_autonoma ──────────────────────────────────────────
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
    raise exception 'Só gestão pode promover fatia a autônoma';
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

  -- Mesma régua da v_fatias_candidatas_autonomia (mig 340): ≥95% e ≥50 pares.
  if coalesce(v_pct, 0) < 95 or coalesce(v_pares, 0) < 50 then
    raise exception 'Fatia fora da régua de autonomia (precisa ≥95%% e ≥50 pares em 30d; tem %% = %, pares = %)', v_pct, v_pares;
  end if;

  insert into public.fatias_autonomas
    (agent_name, oc_card, oc_sugerida, ativa, pct_na_promocao, pares_na_promocao,
     promovida_em, promovida_por, motivo)
  values
    (p_agent_name, p_oc_card, p_oc_sugerida, true, v_pct, v_pares,
     now(), public.current_operador_id(), 'Promovida na Gestão Agentes (drill de fatias)')
  on conflict do nothing
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'pct', v_pct, 'pares', v_pares,
    'ja_existia', v_id is null);
end;
$$;

grant execute on function public.promover_fatia_autonoma(text, integer, integer) to authenticated;

-- 5. ─── meu_dashboard_agentes devolve oc_card (aba do operador espelha) ──────
drop function if exists public.meu_dashboard_agentes(integer);
create or replace function public.meu_dashboard_agentes(p_dias integer default 30)
returns table (
  agent_name text,
  oc_sugerida integer,
  meus_pares bigint,
  minhas_seguidas bigint,
  meu_pct numeric,
  time_pct numeric,
  oc_card integer
)
language sql
stable
security definer
set search_path to ''
as $$
  with eu as (
    select public.current_operador_id() as id
  ),
  janela as (
    select f.* from public.agent_feedback f
    where f.created_at > now() - make_interval(days => greatest(1, least(p_dias, 365)))
      and f.veredito in ('seguida','corrigida')
  ),
  meu as (
    select f.agent_name, f.oc_sugerida, f.oc_card,
           count(*) as pares,
           count(*) filter (where f.veredito = 'seguida') as seguidas
    from janela f, eu
    where f.operador_id = eu.id
    group by 1, 2, 3
  ),
  time_geral as (
    select f.agent_name, f.oc_sugerida, f.oc_card,
           round(100.0 * count(*) filter (where f.veredito = 'seguida') / nullif(count(*), 0), 1) as pct
    from janela f
    group by 1, 2, 3
  )
  select m.agent_name, m.oc_sugerida, m.pares, m.seguidas,
         round(100.0 * m.seguidas / nullif(m.pares, 0), 1),
         t.pct,
         m.oc_card
  from meu m
  join time_geral t on t.agent_name = m.agent_name
    and t.oc_sugerida is not distinct from m.oc_sugerida
    and t.oc_card is not distinct from m.oc_card
  where (select id from eu) is not null
  order by m.pares desc
$$;

grant execute on function public.meu_dashboard_agentes(integer) to authenticated;
