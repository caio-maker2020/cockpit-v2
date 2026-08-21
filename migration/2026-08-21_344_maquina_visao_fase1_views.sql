-- =============================================================================
-- 2026-08-21_344_maquina_visao_fase1_views.sql
--
-- Máquina de Visão e Aprendizado — FASE 1 (dados auditados).
-- Plano aprovado pelo Caio em 21/08. Objetivo 1: 95% das sugestões seguidas.
--
-- Conteúdo:
--   1. v_sinal_ouro_casos: atribuição de agente corrigida (chat/replay passam a
--      enxergar robo-intranet-wurth e scan-email-pre-card — pendência da mig 339).
--   2. v_gestao_agentes_placar      — acerto/erro por agente × oc × operador × dia
--   3. v_gestao_agentes_divergencias— matriz oc_sugerida × oc_executada
--   4. v_acoes_cockpit              — ações executadas via Cockpit por tipo/dia/operador
--   5. horas_uteis_entre()          — janela útil 08h–17h30 BRT (fuso fixo -3, padrão da casa)
--   6. v_operador_tratativas        — histórico: entrada na fila → ação do operador
--   7. v_operador_fila_agora        — foto: o que está parado agora e há quanto tempo
--   8. v_melhorias_impacto          — pré × pós de melhorias mergeadas (learning_log)
--   9. RPCs meu_dashboard_agentes / meu_dashboard_operacao — visão do próprio
--      operador + média do time, sem expor linhas dos colegas.
--
-- Todas as views com security_invoker=on (RLS de baixo manda: gestor vê tudo,
-- operador vê só o seu; agent_feedback é gestor-only → operador usa as RPCs).
-- SEM begin/commit interno (lição da mig 337). Idempotente (OR REPLACE / IF NOT EXISTS).
-- =============================================================================

-- 1. ─── v_sinal_ouro_casos: atribuição correta de agente ──────────────────────
-- Mesmas colunas/ordem da mig 302 (contrato do chat/replay). Única mudança: o
-- ramo do interpretador usa agente_da_sugestao_resposta(decisao_ia) — linhas do
-- robô Würth e do scan-email deixam de ser contabilizadas no interpretador.
create or replace view public.v_sinal_ouro_casos
with (security_invoker = on) as
with base as (
  select
    'agente-sugere-ocs-padrao'::text as agent_name,
    f.card_id,
    f.corrigido_em as decidido_em,
    case
      when f.tipo_feedback = 'caso_nao_reconhecido'   then 'abstencao'
      when f.tipo_feedback like 'sugestao_certa%'     then 'seguida'
      else 'corrigida'
    end as veredito,
    f.codigo_oc_card as oc_card,
    case when f.decisao_ia->>'proposta_destacada' ~ '^\d+$'
         then (f.decisao_ia->>'proposta_destacada')::int end as oc_sugerida,
    f.decisao_correta_codigo_ssw as oc_executada,
    f.motivo_correcao,
    f.corrigido_por_nome,
    f.decisao_ia
  from public.agente_ocs_padrao_feedback f

  union all

  select
    'agente-oc13-autonomo', f.card_id, f.corrigido_em,
    case
      when f.decisao_ia ? 'erro_msg'              then 'abstencao'
      when f.tipo_feedback like 'sugestao_certa%' then 'seguida'
      else 'corrigida'
    end,
    13,
    case when split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2) ~ '^\d+$'
         then split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2)::int end,
    f.decisao_correta_codigo_ssw, f.motivo_correcao, f.corrigido_por_nome, f.decisao_ia
  from public.agente_oc13_feedback f

  union all

  select
    -- FASE 1 (2026-08-21): dono real da sugestão — antes tudo caía no
    -- interpretador (120/1746 linhas eram do robô Würth / scan-email, mig 338).
    coalesce(public.agente_da_sugestao_resposta(f.decisao_ia), 'interpretador-resposta-cliente'),
    f.card_id, f.corrigido_em,
    case when f.tipo_feedback like 'acertou%' then 'seguida' else 'corrigida' end,
    f.oc_card_no_momento, f.oc_sugerida_pela_ia, f.decisao_correta_codigo_ssw,
    f.motivo_correcao, f.corrigido_por_nome, f.decisao_ia
  from public.interpretador_resposta_cliente_feedback f
)
select
  b.*,
  c.nf,
  c.empresa_cliente,
  c.responsavel_relacionamento as operador_card,
  c.cod_ultima_ocorrencia,
  c.state
from base b
left join public.cards c on c.id = b.card_id;

comment on view public.v_sinal_ouro_casos is
  'Caso-a-caso do Sinal de Ouro com decisao_ia (o porquê da sugestão). Fase 1 2026-08-21: atribuição de agente corrigida via agente_da_sugestao_resposta — chat/replay enxergam os 5 agentes.';

-- 2. ─── v_gestao_agentes_placar ──────────────────────────────────────────────
-- Grão: dia × agente × oc sugerida × modo × operador. O front agrega por
-- período/filtro. agent_feedback tem RLS gestor-only → view é da gestão.
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
  count(*) filter (where f.veredito in ('seguida','corrigida')) as pares
from public.agent_feedback f
left join public.operadores o on o.id = f.operador_id
group by 1, 2, 3, 4, 5, 6;

comment on view public.v_gestao_agentes_placar is
  'Gestão Agentes D1/D4: acerto por agente×oc×operador×dia. pct = seguidas/pares (calcular no front pra somar períodos sem média-de-médias).';

-- 3. ─── v_gestao_agentes_divergencias ────────────────────────────────────────
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
  (array_agg(f.card_id order by f.created_at desc))[1:3] as cards_exemplo
from public.agent_feedback f
left join public.operadores o on o.id = f.operador_id
where f.veredito = 'corrigida'
  and f.oc_sugerida is not null
  and f.oc_executada is not null
group by 1, 2, 3, 4, 5, 6;

comment on view public.v_gestao_agentes_divergencias is
  'Gestão Agentes D2: matriz sugerida×executada (onde está a confusão), com cards de exemplo pra abrir os casos reais.';

-- 4. ─── v_acoes_cockpit ──────────────────────────────────────────────────────
-- Ações feitas VIA Cockpit. Duas famílias:
--   • ação humana (aprovação/rejeição) — operador = actor_id do evento;
--   • efeito executado (lançamento SSW, e-mail, interpretação, cancelamento) —
--     operador = dono atual do card (aproximação documentada; a atribuição
--     exata por evento não existe no histórico).
create or replace view public.v_acoes_cockpit
with (security_invoker = on) as
select
  (e.created_at at time zone 'America/Sao_Paulo')::date as dia,
  case e.event_type
    when 'AprovacaoOperador'                    then 'aprovacao'
    when 'RejeicaoOperador'                     then 'rejeicao'
    when 'AprovacaoEmergencialOperador'         then 'aprovacao_emergencial'
    when 'AutoAprovacaoPermitida'               then 'auto_aprovacao'
    when 'AcaoExecutada'                        then 'lancamento_ssw'
    when 'RespostaEnviada'                      then 'email_enviado'
    when 'InterpretadorRespostaClienteConcluido' then 'interpretacao_email'
    when 'CancelamentoReentregaAgendado'        then 'cancelamento_reentrega'
    when 'CancelamentoReentregaTratadoManualmente' then 'cancelamento_reentrega'
  end as tipo,
  case
    when e.actor_type = 'operator' and e.actor_id ~ '^[0-9a-f-]{36}$'
      then e.actor_id::uuid
    else c.assigned_operator_id
  end as operador_id,
  count(*) as n
from public.card_events e
join public.cards c on c.id = e.card_id
where e.event_type in (
  'AprovacaoOperador','RejeicaoOperador','AprovacaoEmergencialOperador',
  'AutoAprovacaoPermitida','AcaoExecutada','RespostaEnviada',
  'InterpretadorRespostaClienteConcluido','CancelamentoReentregaAgendado',
  'CancelamentoReentregaTratadoManualmente'
)
group by 1, 2, 3;

comment on view public.v_acoes_cockpit is
  'Gestão Agentes D3 / Gestão Operadores: quantas ações o Cockpit executa (por tipo/dia/operador). Efeitos de sistema atribuídos ao dono ATUAL do card (aproximação).';

-- 5. ─── horas_uteis_entre ────────────────────────────────────────────────────
-- Horas úteis entre dois instantes na janela 08:00–17:30 BRT (fuso fixo -3,
-- padrão do codebase — sem DST no Brasil desde 2019). Fim de semana não conta.
-- Card que entra fora do expediente começa a contar às 08h do dia útil seguinte
-- (decisão do Caio: "oc lançada às 19h só é vista no dia seguinte — não penalizar").
create or replace function public.horas_uteis_entre(p_inicio timestamptz, p_fim timestamptz)
returns numeric
language sql
immutable
set search_path to ''
as $$
  -- ARMADILHA (achada no dry-run 21/08): generate_series(date,date) devolve
  -- TIMESTAMPTZ — somar time e aplicar AT TIME ZONE em cima convertia na
  -- direção errada e deslocava a janela em 3-6h (sex 19h→seg 9h dava 7h em vez
  -- de 1h). Por isso o dia vira ::date e a janela é construída como timestamp
  -- NAIVE local + AT TIME ZONE (naive→timestamptz, direção certa).
  select coalesce(sum(
    greatest(0, extract(epoch from (
      least(((d.dia::timestamp + time '17:30') at time zone 'America/Sao_Paulo'), p_fim)
      - greatest(((d.dia::timestamp + time '08:00') at time zone 'America/Sao_Paulo'), p_inicio)
    )) / 3600.0)
  ), 0)
  from (
    select g.ts::date as dia
    from generate_series(
      (p_inicio at time zone 'America/Sao_Paulo')::date::timestamp,
      (p_fim    at time zone 'America/Sao_Paulo')::date::timestamp,
      interval '1 day'
    ) as g(ts)
  ) d
  where extract(isodow from d.dia) < 6
    and p_fim > p_inicio
$$;

comment on function public.horas_uteis_entre(timestamptz, timestamptz) is
  'Horas úteis (08h–17h30 BRT, seg–sex) entre dois instantes. Base das métricas de operador da Fase 1.';

-- 6. ─── v_operador_tratativas (histórico, 90 dias) ───────────────────────────
-- Cada ação humana (aprovação/rejeição) pareada com o marcador de ENTRADA na
-- fila mais recente antes dela. Coluna do kanban inferida pelo tipo do marcador
-- (resposta de cliente ⇒ "cliente_respondeu"; senão "aguardando_voce" — a foto
-- exata por cod_ultima_ocorrencia∈OCS_CLIENTE só existe no presente, INV-037).
-- AutoAprovacaoPermitida NÃO entra (não houve humano).
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
  case when ent.event_type in ('RespostaClienteCapturada','RetornoClienteEmAguardo','CardReabertoPorRespostaCliente')
       then 'cliente_respondeu' else 'aguardando_voce' end as coluna,
  ent.created_at as entrada_em,
  a.created_at as tratado_em,
  round((extract(epoch from (a.created_at - ent.created_at)) / 3600.0)::numeric, 2) as horas_brutas,
  round(public.horas_uteis_entre(ent.created_at, a.created_at), 2) as horas_uteis,
  a.event_type = 'AprovacaoOperador' as foi_aprovacao
from public.card_events a
join public.cards c on c.id = a.card_id
left join lateral (
  select e.event_type, e.created_at
  from public.card_events e
  where e.card_id = a.card_id
    and e.created_at < a.created_at
    and e.event_type in (
      'TodoPropostoAutomaticamente','CardReaberto','BastaoCardImportado',
      'RespostaClienteCapturada','RetornoClienteEmAguardo',
      'CardReabertoPorRespostaCliente','AguardandoClienteOcMudou'
    )
  order by e.created_at desc
  limit 1
) ent on true
where a.event_type in ('AprovacaoOperador','RejeicaoOperador')
  and a.actor_type = 'operator'
  and a.actor_id ~ '^[0-9a-f-]{36}$'
  and a.created_at > now() - interval '90 days'
  and ent.created_at is not null;

comment on view public.v_operador_tratativas is
  'Gestão Operadores: cada tratativa humana com tempo de espera (bruto e útil 08h–17h30) desde a entrada na fila. 90 dias.';

-- 7. ─── v_operador_fila_agora (foto do momento) ──────────────────────────────
-- O que está parado AGORA em "Aguardando você"/"Cliente respondeu" e desde quando.
-- Discriminação da coluna = a mesma do kanban (cliente_respondeu_em + oc∈{54,59}
-- via dicionário — NUNCA hardcodar 54, INV-037). Na foto o carimbo vale.
create or replace view public.v_operador_fila_agora
with (security_invoker = on) as
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
  ent.created_at as na_fila_desde,
  round((extract(epoch from (now() - ent.created_at)) / 3600.0)::numeric, 1) as horas_brutas,
  round(public.horas_uteis_entre(ent.created_at, now()), 2) as horas_uteis,
  public.horas_uteis_entre(ent.created_at, now()) > 9.5 as parado_mais_1d_util
from public.cards c
left join lateral (
  select e.created_at
  from public.card_events e
  where e.card_id = c.id
    and e.event_type in (
      'TodoPropostoAutomaticamente','CardReaberto','BastaoCardImportado',
      'RespostaClienteCapturada','RetornoClienteEmAguardo',
      'CardReabertoPorRespostaCliente','AguardandoClienteOcMudou'
    )
  order by e.created_at desc
  limit 1
) ent on true
where c.state = 'AGUARDANDO_VALIDACAO_HUMANA'
  and ent.created_at is not null;

comment on view public.v_operador_fila_agora is
  'Gestão Operadores: foto da fila humana agora (desde quando, horas úteis, >1 dia útil = 9,5h). Coluna via dicionário responsabilidade=Cliente (INV-037).';

-- 8. ─── v_melhorias_impacto (pré × pós de melhoria mergeada) ─────────────────
-- Fatia = agente + oc sugerida (parse do chave_padrao '<agente>:sugNN').
-- Janela: 30 dias antes do merge × tudo depois do merge.
create or replace view public.v_melhorias_impacto
with (security_invoker = on) as
select
  l.id as melhoria_id,
  l.titulo,
  l.agente_alvo,
  nullif(regexp_replace(split_part(l.detalhes->>'chave_padrao', ':', 2), '\D', '', 'g'), '')::int as oc_sugerida,
  (l.detalhes->>'mergeado_em')::timestamptz as mergeado_em,
  l.status,
  pre.pares  as pares_pre,  pre.seguidas  as seguidas_pre,
  pos.pares  as pares_pos,  pos.seguidas  as seguidas_pos,
  round(100.0 * pre.seguidas / nullif(pre.pares, 0), 1) as pct_pre,
  round(100.0 * pos.seguidas / nullif(pos.pares, 0), 1) as pct_pos
from public.learning_log l
cross join lateral (
  select count(*) filter (where f.veredito in ('seguida','corrigida')) as pares,
         count(*) filter (where f.veredito = 'seguida') as seguidas
  from public.agent_feedback f
  where f.agent_name = l.agente_alvo
    and (f.oc_sugerida is not distinct from nullif(regexp_replace(split_part(l.detalhes->>'chave_padrao', ':', 2), '\D', '', 'g'), '')::int
         or l.detalhes->>'chave_padrao' is null)
    and f.created_at >= (l.detalhes->>'mergeado_em')::timestamptz - interval '30 days'
    and f.created_at <  (l.detalhes->>'mergeado_em')::timestamptz
) pre
cross join lateral (
  select count(*) filter (where f.veredito in ('seguida','corrigida')) as pares,
         count(*) filter (where f.veredito = 'seguida') as seguidas
  from public.agent_feedback f
  where f.agent_name = l.agente_alvo
    and (f.oc_sugerida is not distinct from nullif(regexp_replace(split_part(l.detalhes->>'chave_padrao', ':', 2), '\D', '', 'g'), '')::int
         or l.detalhes->>'chave_padrao' is null)
    and f.created_at >= (l.detalhes->>'mergeado_em')::timestamptz
) pos
where l.tipo in ('ajuste_sugerido','ajuste_aplicado','resposta_admin')
  and l.detalhes->>'mergeado_em' is not null;

comment on view public.v_melhorias_impacto is
  'Gestão Agentes D5 / Aprendizado M3: taxa da fatia 30d antes do merge × depois. Marco = learning_log.detalhes.mergeado_em (gravado pelo deploy-on-merge, Fase 4).';

-- 9. ─── RPCs do "Seu Dashboard" (operador vê só o seu + média do time) ───────
-- agent_feedback é gestor-only por RLS; estas RPCs SECURITY DEFINER devolvem
-- APENAS agregados: as linhas do próprio operador + a média geral (sem expor
-- dados individuais dos colegas). Guard: operador autenticado.
create or replace function public.meu_dashboard_agentes(p_dias integer default 30)
returns table (
  agent_name text,
  oc_sugerida integer,
  meus_pares bigint,
  minhas_seguidas bigint,
  meu_pct numeric,
  time_pct numeric
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
    select f.agent_name, f.oc_sugerida,
           count(*) as pares,
           count(*) filter (where f.veredito = 'seguida') as seguidas
    from janela f, eu
    where f.operador_id = eu.id
    group by 1, 2
  ),
  time_geral as (
    select f.agent_name, f.oc_sugerida,
           round(100.0 * count(*) filter (where f.veredito = 'seguida') / nullif(count(*), 0), 1) as pct
    from janela f
    group by 1, 2
  )
  select m.agent_name, m.oc_sugerida, m.pares, m.seguidas,
         round(100.0 * m.seguidas / nullif(m.pares, 0), 1),
         t.pct
  from meu m
  join time_geral t using (agent_name, oc_sugerida)
  where (select id from eu) is not null
  order by m.pares desc
$$;

grant execute on function public.meu_dashboard_agentes(integer) to authenticated;

create or replace function public.meu_dashboard_operacao(p_dias integer default 30)
returns table (
  tratadas bigint,
  minhas_ate_2h_pct numeric,
  time_ate_2h_pct numeric,
  minhas_horas_uteis_media numeric,
  time_horas_uteis_media numeric,
  paradas_mais_1d_util bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  with eu as (select public.current_operador_id() as id),
  janela as (
    select t.* from public.v_operador_tratativas t
    where t.dia > (current_date - greatest(1, least(p_dias, 365)))
  ),
  minhas as (select * from janela, eu where operador_id = eu.id),
  foto as (
    select count(*) as paradas from public.v_operador_fila_agora f, eu
    where f.operador_id = eu.id and f.parado_mais_1d_util
  )
  select
    (select count(*) from minhas),
    round(100.0 * (select count(*) from minhas where horas_uteis <= 2) / nullif((select count(*) from minhas), 0), 1),
    round(100.0 * (select count(*) from janela where horas_uteis <= 2) / nullif((select count(*) from janela), 0), 1),
    round((select avg(horas_uteis) from minhas)::numeric, 2),
    round((select avg(horas_uteis) from janela)::numeric, 2),
    (select paradas from foto)
  where (select id from eu) is not null
$$;

grant execute on function public.meu_dashboard_operacao(integer) to authenticated;

grant select on public.v_gestao_agentes_placar,
                public.v_gestao_agentes_divergencias,
                public.v_acoes_cockpit,
                public.v_operador_tratativas,
                public.v_operador_fila_agora,
                public.v_melhorias_impacto
  to authenticated, service_role;
