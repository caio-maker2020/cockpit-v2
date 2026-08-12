-- =============================================================================
-- 2026-08-12_334_backfill_instrucao_oc21_wurth.sql
--
-- Backfill retroativo (Caio 2026-08-12). As Reentregas Würth processadas ANTES
-- do fix 62b8875 (`enxertarInstrucaoReentrega`) deixaram a oc 21 do menu com
-- `args.descricao` genérico ("Reentrega solicitada pelo cliente") — a instrução
-- da Obs da intranet ("reentregar horário comercial, BERENICE") ficava só no
-- `ia_sugestao` do card e NÃO chegaria ao SSW na aprovação (o executor lê
-- args.descricao → montarDescricaoSsw).
--
-- A dedupe (`wurth_retornos_processados`) impede o robô de reprocessar essas
-- linhas, então o enxerto retroativo é feito AQUI, usando a Obs JÁ guardada
-- (sem re-login na Würth). Espelha campo-a-campo o `enxertarInstrucaoReentrega`
-- (guard: wurth-intranet.test.ts). Idempotente: pula proposta que já tem
-- meta.origem='robo-intranet-wurth'. Só oc 21 (a 44 coleta volumes/motivo no
-- modal). Caso-âncora: NFs 378673, 383793, 663660, 667516, 669899, 681467.
-- =============================================================================

begin;

with w_latest as (
  -- uma linha por card (o ciclo mais recente), só Reentregas com Obs preenchida
  select distinct on (card_id) card_id, nf, solucao, data_solucao, observacao
  from wurth_retornos_processados
  where solucao ilike '%reentrega%' and coalesce(observacao, '') <> ''
  order by card_id, data_solucao desc, processado_em desc
),
alvo as (
  select t.id as todo_id, t.card_id, w.nf, w.solucao, w.data_solucao, w.observacao,
         coalesce(t.proposta_payload->>'rationale', '') as rat_old
  from todos t
  join w_latest w on w.card_id = t.card_id
  where t.status in ('pendente', 'aguardando_aprovacao')
    and t.proposta_payload->>'acao_key' = 'lancar_ocorrencia:21'
    and coalesce(t.proposta_payload->'meta'->>'origem', '') <> 'robo-intranet-wurth'
),
upd as (
  update todos t
  set proposta_payload =
        t.proposta_payload
        || jsonb_build_object('recomendada', true, 'texto', a.observacao)
        || jsonb_build_object('args',
             coalesce(t.proposta_payload->'args', '{}'::jsonb)
             || jsonb_build_object('descricao',
                  'Reentrega autorizada pelo cliente via intranet Würth — ' || a.observacao))
        || jsonb_build_object('meta',
             coalesce(t.proposta_payload->'meta', '{}'::jsonb)
             || jsonb_build_object('origem', 'robo-intranet-wurth',
                                   'texto_ssw_sugerido', a.observacao))
        || jsonb_build_object('rationale',
             case when a.rat_old <> '' then a.rat_old || ' · ' else '' end
             || 'Intranet Würth (' || coalesce(a.data_solucao, '') || '): ' || coalesce(a.solucao, '')
             || case when coalesce(a.observacao, '') <> '' then ' — ' || a.observacao else '' end)
  from alvo a
  where t.id = a.todo_id
  returning t.card_id, a.nf, a.solucao, a.observacao, a.todo_id
)
insert into card_events (card_id, event_type, actor_type, actor_id, payload)
select card_id, 'RetornoIntranetWurthBackfillInstrucao', 'system',
       'migration-334_backfill_instrucao_oc21',
       jsonb_build_object(
         'nf', nf, 'solucao', solucao, 'obs', observacao, 'todo_id', todo_id,
         'motivo', 'enxerto retroativo da instrução na oc21 pós-fix 62b8875')
from upd;

commit;
