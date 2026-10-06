-- =============================================================================
-- indicadores_agentes.sql — os DOIS indicadores do Duilio (Caio, 06/10/2026)
--
--   I1  % de sugestões seguidas  (unidade = SUGESTÃO, não card)
--   I2  % de entradas sem sugestão nenhuma (unidade = ENTRADA do card)
--
-- Regras completas em docs/INDICADORES_AGENTES.md. Este arquivo é a fonte
-- executável: só leitura, só CTEs (roda com o role leitura_duilio).
--
-- Como rodar (qualquer máquina com o trilho):
--   python3 scripts/dbq.py -f scripts/sql/indicadores_agentes.sql
-- Janela: edite :INICIO abaixo (default = 1º dia de 3 meses atrás). O role de
-- leitura tem statement_timeout 60s; a janela de 3 meses leva ~2–4 min, por
-- isso o SET no topo (vale só nesta sessão, é permitido ao role).
-- =============================================================================
set statement_timeout = '300s';
set work_mem = '256MB';

-- ---------------------------------------------------------------------------
-- I2 — ENTRADAS no escopo dos agentes sem sugestão
--   entrada  = evento de EVENTOS_NOVA_ENTRADA (ciclos-tratativa.ts +
--              analise-nova-entrada.ts, INV-168) com a oc daquele momento
--   escopo   = ocs com agente de sugestão hoje: 10,11,19,35,49 (padrão) + 13
--   sugestão = AgenteOcsPadraoDecisao com proposta_destacada OU
--              AgenteOc13Decisao, entre a entrada e a próxima entrada (máx 48h)
--   classes do "sem sugestão": abstenção (agente rodou e não propôs — ex.
--              caso_oc49=nao_reconhecido), falhou, suprimida sem evidência,
--              não rodou
-- ---------------------------------------------------------------------------
with
ev as materialized (
  select card_id, created_at, event_type,
    case event_type
      when 'BastaoCardImportado' then (payload->>'cod_ultima_ocorrencia')::int
      when 'CardReaberto' then (payload->>'oc')::int
      when 'BastaoReabriuNFFonteRelacionamento' then (payload->>'oc_atual_bastao')::int
      when 'AguardandoClienteOcMudou' then (payload->>'oc_atual')::int
      when 'OcComRegraChegouEmParaFazer' then (payload->>'oc_nova')::int
      when 'AgenteExtravioLancou49' then 49 end oc_entrada,
    case when event_type='AgenteOcsPadraoDecisao' then (payload->'decisao'->>'proposta_destacada')::int
         when event_type='AgenteOc13Decisao' then nullif(substring(payload->>'decisao' from 'sugerir_(\d+)'),'')::int end sug_oc
  from card_events
  where created_at >= date_trunc('month', now() - interval '3 months')
    and event_type in ('BastaoCardImportado','CardReaberto','BastaoReabriuNFFonteRelacionamento','CardReabertoPorRespostaCliente',
                       'AguardandoClienteOcMudou','OcComRegraChegouEmParaFazer','AgenteExtravioLancou49',
                       'AgenteOcsPadraoDecisao','AgenteOc13Decisao','AgenteOcsPadraoFalhou','SugestaoSuprimidaSemEvidencia','AprovacaoOperador')),
ent as (
  select card_id, created_at, oc_entrada oc,
         lead(created_at) over (partition by card_id order by created_at) prox
  from ev where oc_entrada is not null),
ent_cls as (
  select x.oc, to_char(x.created_at at time zone 'America/Sao_Paulo','YYYY-MM') mes,
    case
      when exists (select 1 from ev s where s.card_id=x.card_id and s.event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao') and s.sug_oc is not null and s.created_at >= x.created_at - interval '2 minutes' and s.created_at < least(coalesce(x.prox,'infinity'::timestamptz), x.created_at + interval '48 hours')) then 'com_sugestao'
      when exists (select 1 from ev s where s.card_id=x.card_id and s.event_type='SugestaoSuprimidaSemEvidencia' and s.created_at >= x.created_at - interval '2 minutes' and s.created_at < least(coalesce(x.prox,'infinity'::timestamptz), x.created_at + interval '48 hours')) then 'suprimida_sem_evidencia'
      when exists (select 1 from ev s where s.card_id=x.card_id and s.event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao') and s.created_at >= x.created_at - interval '2 minutes' and s.created_at < least(coalesce(x.prox,'infinity'::timestamptz), x.created_at + interval '48 hours')) then 'agente_abstencao'
      when exists (select 1 from ev s where s.card_id=x.card_id and s.event_type='AgenteOcsPadraoFalhou' and s.created_at >= x.created_at - interval '2 minutes' and s.created_at < least(coalesce(x.prox,'infinity'::timestamptz), x.created_at + interval '48 hours')) then 'agente_falhou'
      else 'agente_nao_rodou' end cls,
    exists (select 1 from ev d where d.card_id=x.card_id and d.event_type='AprovacaoOperador' and d.created_at >= x.created_at and d.created_at < coalesce(x.prox,'infinity'::timestamptz)) operador_agiu
  from ent x where x.oc in (10,11,19,35,49,13))
select 'I2' indicador, mes, oc,
       count(*) entradas,
       count(*) filter (where cls='com_sugestao') com_sugestao,
       round(100.0*count(*) filter (where cls<>'com_sugestao')/count(*),1) pct_sem_sugestao,
       count(*) filter (where cls='agente_abstencao') abstencao,
       count(*) filter (where cls='agente_falhou') falhou,
       count(*) filter (where cls='suprimida_sem_evidencia') suprimida,
       count(*) filter (where cls='agente_nao_rodou') nao_rodou,
       count(*) filter (where cls<>'com_sugestao' and operador_agiu) sem_sugestao_e_operador_agiu
from ent_cls
group by grouping sets ((mes), (mes, oc))
order by mes, oc nulls first;

-- ---------------------------------------------------------------------------
-- I1 — SUGESTÕES seguidas (por sugestão, acompanha o ciclo)
--   sugestão = cada AgenteOcsPadraoDecisao / AgenteOc13Decisao (uma por rodada
--              do agente; re-análise por entrada nova gera sugestão NOVA)
--   par      = a 1ª AprovacaoOperador depois da sugestão e ANTES da sugestão
--              seguinte do mesmo card. Sem ação até a próxima sugestão =
--              "superada" (fora do %, mas contada)
--   seguida  = oc aprovada == oc proposta; corrigida = diferente
--   abstenção do agente (sem proposta_destacada) fica fora do %
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
    and event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','AprovacaoOperador')),
sug as (
  select card_id, created_at sug_em, sug_oc, event_type agente,
         to_char(created_at at time zone 'America/Sao_Paulo','YYYY-MM') mes,
         lead(created_at) over (partition by card_id order by created_at) prox_sug
  from ev where event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao')),
par as (
  select s.*, d.acao_oc
  from sug s left join lateral (
    select acao_oc from ev d where d.card_id=s.card_id and d.event_type='AprovacaoOperador'
      and d.created_at > s.sug_em and d.created_at < coalesce(s.prox_sug,'infinity'::timestamptz)
    order by d.created_at limit 1) d on true)
select 'I1' indicador, mes, agente,
  count(*) sugestoes_emitidas,
  count(*) filter (where sug_oc is null) abstencao_agente,
  count(*) filter (where sug_oc is not null and acao_oc is not null) pares,
  count(*) filter (where sug_oc is not null and acao_oc = sug_oc) seguidas,
  count(*) filter (where sug_oc is not null and acao_oc is not null and acao_oc <> sug_oc) corrigidas,
  round(100.0*count(*) filter (where sug_oc is not null and acao_oc = sug_oc)/nullif(count(*) filter (where sug_oc is not null and acao_oc is not null),0),1) pct_seguida,
  count(*) filter (where sug_oc is not null and acao_oc is null) superadas_sem_acao
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
    and event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao','AprovacaoOperador')),
sug as (
  select card_id, created_at sug_em, sug_oc,
         lead(created_at) over (partition by card_id order by created_at) prox_sug
  from ev where event_type in ('AgenteOcsPadraoDecisao','AgenteOc13Decisao')),
par as (
  select s.*, d.acao_oc
  from sug s left join lateral (
    select acao_oc from ev d where d.card_id=s.card_id and d.event_type='AprovacaoOperador'
      and d.created_at > s.sug_em and d.created_at < coalesce(s.prox_sug,'infinity'::timestamptz)
    order by d.created_at limit 1) d on true)
select 'I1-trocas' indicador, sug_oc as agente_sugeriu, acao_oc as operador_fez, count(*) vezes
from par where sug_oc is not null and acao_oc is not null and acao_oc <> sug_oc
group by 2,3 order by 4 desc limit 15;
