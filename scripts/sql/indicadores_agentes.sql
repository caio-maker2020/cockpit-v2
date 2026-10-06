-- =============================================================================
-- indicadores_agentes.sql — os DOIS indicadores do Duilio (Caio, 06/10/2026)
--
--   I1  % de sugestões seguidas  (unidade = SUGESTÃO, não card)
--   I2  % de ações lançadas sem sugestão nenhuma (unidade = AÇÃO aprovada)
--
-- Regras completas em docs/INDICADORES_AGENTES.md. Este arquivo é a fonte
-- executável: só leitura, só CTEs (roda com o role leitura_duilio).
--
-- Como rodar (qualquer máquina com o trilho):
--   python3 scripts/dbq.py -f scripts/sql/indicadores_agentes.sql
-- Janela: edite :INICIO abaixo (default = 1º dia de 3 meses atrás). O role de
-- leitura tem statement_timeout 60s; a janela de 3 meses leva ~2–4 min, por
-- isso o SET no topo (vale só nesta sessão, é permitido ao role).
-- Saída I1: coluna pct_seguida por mês (linha com agente vazio = total).
-- =============================================================================
set statement_timeout = '300s';
set work_mem = '256MB';

-- ---------------------------------------------------------------------------
-- I2 — das ações lançadas no Cockpit, quantas não tinham sugestão nenhuma
--   unidade = cada AprovacaoOperador; sem sugestão = sugestao_vigente vazio
--   (nem agente_oc nem interpretador_oc). Existe desde 04/09 (mig 377).
-- ---------------------------------------------------------------------------
select 'I2' indicador, to_char(created_at at time zone 'America/Sao_Paulo','YYYY-MM') mes,
  count(*) acoes_lancadas,
  count(*) filter (where coalesce(payload->'sugestao_vigente'->>'agente_oc', payload->'sugestao_vigente'->>'interpretador_oc') is null) sem_sugestao,
  round(100.0*count(*) filter (where coalesce(payload->'sugestao_vigente'->>'agente_oc', payload->'sugestao_vigente'->>'interpretador_oc') is null)/count(*),1) pct_sem_sugestao
from card_events where event_type='AprovacaoOperador' and created_at >= '2026-09-04'
group by 2 order by 2;

select 'I2-o-que-lanca-sem-sugestao' indicador, to_char(created_at at time zone 'America/Sao_Paulo','YYYY-MM') mes,
  coalesce(payload->'proposta_payload'->>'acao_key', payload->'proposta_payload'->>'tool') acao, count(*) n
from card_events where event_type='AprovacaoOperador' and created_at >= '2026-09-04'
  and coalesce(payload->'sugestao_vigente'->>'agente_oc', payload->'sugestao_vigente'->>'interpretador_oc') is null
group by 2,3 order by 2, 4 desc;

-- ---------------------------------------------------------------------------
-- I1 — SUGESTÕES seguidas (por sugestão, acompanha o ciclo)
--   sugestão = cada AgenteOcsPadraoDecisao / AgenteOc13Decisao (uma por rodada
--              do agente; re-análise por entrada nova gera sugestão NOVA)
--   par      = a 1ª AprovacaoOperador depois da sugestão e ANTES da sugestão
--              seguinte do mesmo card. Sem ação até a próxima sugestão =
--              "superada" (fora do %, mas contada)
--   seguida  = oc aprovada == oc proposta; corrigida = diferente
--   análise SEM proposta_destacada não é sugestão (vai pro I2), fica fora
--   Fonte da ação: proposta_payload da aprovação (args.codigo_ssw /
--              codigo_ocorrencia / acao_key) — 13 de 8.731 aprovações de set
--              sem código extraível (0,15%)
-- ---------------------------------------------------------------------------
with
ev as materialized (
  select card_id, created_at, event_type,
    case when event_type='AgenteOcsPadraoDecisao' then (payload->'decisao'->>'proposta_destacada')::int
         when event_type='AgenteOc13Decisao' then nullif(substring(payload->>'decisao' from 'sugerir_(\d+)'),'')::int end sug_oc,
    case when event_type='AprovacaoOperador' then
      coalesce((payload->'proposta_payload'->'args'->>'codigo_ssw')::int,
               (payload->'proposta_payload'->'args'->>'codigo_ocorrencia')::int,
               nullif(split_part(coalesce(payload->'proposta_payload'->>'acao_key',''),':',2),'')::int) end acao_oc
  from card_events
  where created_at >= date_trunc('month', now() - interval '3 months')
    and event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','InterpretadorRespostaClienteConcluido','AprovacaoOperador')),
sug as (
  select card_id, created_at sug_em, sug_oc, event_type agente,
         to_char(created_at at time zone 'America/Sao_Paulo','YYYY-MM') mes,
         lead(created_at) over (partition by card_id, event_type order by created_at) prox_sug
  from ev where event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','InterpretadorRespostaClienteConcluido')),
par as (
  select s.*, d.acao_oc
  from sug s left join lateral (
    select acao_oc from ev d where d.card_id=s.card_id and d.event_type='AprovacaoOperador'
      and d.created_at > s.sug_em and d.created_at < coalesce(s.prox_sug,'infinity'::timestamptz)
    order by d.created_at limit 1) d on true)
select 'I1' indicador, mes, agente,
  count(*) filter (where sug_oc is not null) sugestoes,
  count(*) filter (where sug_oc is not null and acao_oc is not null) com_acao_operador,
  count(*) filter (where sug_oc is not null and acao_oc = sug_oc) acao_igual_sugestao,
  count(*) filter (where sug_oc is not null and acao_oc is not null and acao_oc <> sug_oc) acao_diferente,
  round(100.0*count(*) filter (where sug_oc is not null and acao_oc = sug_oc)/nullif(count(*) filter (where sug_oc is not null and acao_oc is not null),0),1) pct_seguida,
  count(*) filter (where sug_oc is not null and acao_oc is null) sem_acao_ate_proxima_sugestao,
  count(*) filter (where sug_oc is null) analises_sem_sugestao_vao_pro_I2
from par
group by grouping sets ((mes), (mes, agente))
order by mes, agente nulls first;

-- Top trocas (o que o operador fez quando corrigiu) — últimos 3 meses
with
ev as materialized (
  select card_id, created_at, event_type,
    case when event_type='AgenteOcsPadraoDecisao' then (payload->'decisao'->>'proposta_destacada')::int
         when event_type='AgenteOc13Decisao' then nullif(substring(payload->>'decisao' from 'sugerir_(\d+)'),'')::int end sug_oc,
    case when event_type='AprovacaoOperador' then
      coalesce((payload->'proposta_payload'->'args'->>'codigo_ssw')::int,
               (payload->'proposta_payload'->'args'->>'codigo_ocorrencia')::int,
               nullif(split_part(coalesce(payload->'proposta_payload'->>'acao_key',''),':',2),'')::int) end acao_oc
  from card_events
  where created_at >= date_trunc('month', now() - interval '3 months')
    and event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','InterpretadorRespostaClienteConcluido','AprovacaoOperador')),
sug as (
  select card_id, created_at sug_em, sug_oc,
         lead(created_at) over (partition by card_id, event_type order by created_at) prox_sug
  from ev where event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','InterpretadorRespostaClienteConcluido')),
par as (
  select s.*, d.acao_oc
  from sug s left join lateral (
    select acao_oc from ev d where d.card_id=s.card_id and d.event_type='AprovacaoOperador'
      and d.created_at > s.sug_em and d.created_at < coalesce(s.prox_sug,'infinity'::timestamptz)
    order by d.created_at limit 1) d on true)
select 'I1-trocas' indicador, sug_oc as agente_sugeriu, acao_oc as operador_fez, count(*) vezes
from par where sug_oc is not null and acao_oc is not null and acao_oc <> sug_oc
group by 2,3 order by 4 desc limit 15;
