-- =============================================================================
-- Limpeza auditável das rajadas de fabricação nas NFs 23657, 339024 e 137344
-- (mesma CLASSE do bug da NF 2084 — dossiê audits/BUG_NF2084_CARDS_DUPLICADOS_
-- 2026-07-21.md, INV-040 — em rajadas ANTERIORES: 30/06-01/07 e 07-08/07).
-- Aprovação do Caio: 2026-07-22 ("Pode fazer a limpeza de outras nfs também").
--
-- Executar: bash scripts/dbq.sh -v ON_ERROR_STOP=1 -f scripts/limpeza-duplicados-rajadas-2026-07-22.sql
--
-- CANCELA (nunca deleta) 146 cards fabricados: 64 da 23657 + 41 da 339024 +
-- 41 da 137344, cada um com card_event `DuplicadoLimpezaRajadaSync`.
--
-- O que PRESERVA (auditado card a card — atividade real de operador/ação,
-- card ativo, ou original pré-rajada):
--   23657:  dc3fb9a1… original 23/06 (962 eventos, tratativa longa)
--           ce30e4ef… 07/07 — AprovacaoOperador + RespostaEnviada + AcaoExecutada
--           5803dfea… 08/07 — 2× AprovacaoOperador/AcaoExecutada + resposta cliente
--   339024: 5a53546a… original 24/06 (204 eventos)
--           9e39dfce… 01/07 — AprovacaoOperador + AcaoExecutada + CardReaberto
--   137344: b7c79657… original 23/06 (pré-rajada)
--           e9b415b5… ATIVO (AGUARDANDO_VALIDACAO_HUMANA) — intocável
--
-- Guards do WHERE (cinto e suspensório):
--   (1) só terminais RESOLVIDO/TRANSFERIDO (card ativo jamais);
--   (2) só dentro das janelas de rajada por NF;
--   (3) exclusão EXPLÍCITA dos 7 preservados por UUID;
--   (4) exclusão por CRITÉRIO: qualquer card com evento de operador ou de
--       ação real fica fora, mesmo se alguém errar a lista de UUIDs;
--   (5) aborta se as contagens por NF não forem exatamente 64/41/41.
-- =============================================================================

begin;

create temp table _dup_rajadas on commit drop as
select c.id, c.nf, c.state as state_anterior, c.ctrc, c.created_at
from cards c
where c.nf in ('23657', '339024', '137344')
  and c.state in ('RESOLVIDO', 'TRANSFERIDO')
  and ((c.nf = '23657'  and c.created_at >= '2026-07-07 00:00:00+00' and c.created_at < '2026-07-09 00:00:00+00')
    or (c.nf = '339024' and c.created_at >= '2026-06-30 00:00:00+00' and c.created_at < '2026-07-02 00:00:00+00')
    or (c.nf = '137344' and c.created_at >= '2026-07-07 00:00:00+00' and c.created_at < '2026-07-09 00:00:00+00'))
  and c.id not in (
    'dc3fb9a1-e910-4d0b-bf1f-6b78baed6760',  -- 23657 original 23/06
    'ce30e4ef-8649-4ec6-ad4f-f991a8ba5eb7',  -- 23657 tratativa real 07/07
    '5803dfea-f7d5-4076-9e00-49c28f5dc130',  -- 23657 tratativa real 08/07
    '5a53546a-4279-44f1-99cb-fc0b9b0f6fee',  -- 339024 original 24/06
    '9e39dfce-3321-49c9-8da2-fbbba386c82d',  -- 339024 tratativa real 01/07
    'b7c79657-c8d0-408b-8b19-c23b96452b93',  -- 137344 original 23/06
    'e9b415b5-bce2-495f-9418-6c1a5ca13a87'   -- 137344 ATIVO
  )
  and not exists (
    select 1 from card_events ce
    where ce.card_id = c.id
      and (ce.actor_type = 'operator'
        or ce.event_type in ('AprovacaoOperador','AcaoExecutada','AcaoExecutadaConfirmadaPeloSsw',
                             'RespostaEnviada','RespostaClienteCapturada','MensagemAnexadaPorThread',
                             'CardReaberto','EmailEnviado'))
  );

do $$
declare n23657 int; n339024 int; n137344 int;
begin
  select count(*) filter (where nf='23657'),
         count(*) filter (where nf='339024'),
         count(*) filter (where nf='137344')
    into n23657, n339024, n137344
  from _dup_rajadas;
  if n23657 <> 64 or n339024 <> 41 or n137344 <> 41 then
    raise exception 'Contagens divergem do auditado (23657=% esperado 64, 339024=% esperado 41, 137344=% esperado 41) — abortando',
      n23657, n339024, n137344;
  end if;
end $$;

update cards c
set state = 'CANCELADO',
    lock_aguardando_validacao = false
from _dup_rajadas d
where c.id = d.id;

insert into card_events (card_id, event_type, actor_type, actor_id, payload)
select d.id,
       'DuplicadoLimpezaRajadaSync',
       'system',
       'limpeza-rajadas-sync',
       jsonb_build_object(
         'nf', d.nf,
         'state_anterior', d.state_anterior,
         'ctrc', d.ctrc,
         'criado_na_rajada_em', d.created_at,
         'caso_ancora', 'NF 2084',
         'motivo', 'Card fabricado pelo loop criação→terminal→recriação do sync '
                   || '(mesma classe da NF 2084; rajadas 30/06-01/07 e 07-08/07/2026). '
                   || 'Cancelado na limpeza auditável aprovada pelo Caio em 22/07. '
                   || 'Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md; INV-040.'
       )
from _dup_rajadas d;

-- Conferência dentro da transação (esperado: 146 / 146 / 0 ativos tocados).
select
  (select count(*) from cards where nf in ('23657','339024','137344') and state='CANCELADO')      as cancelados_total,
  (select count(*) from card_events where event_type='DuplicadoLimpezaRajadaSync')                as eventos_limpeza,
  (select count(*) from _dup_rajadas d join cards c on c.id=d.id
     where c.state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO'))                                as ativos_tocados_deve_ser_0;

commit;

-- Pós-limpeza (validação):
--   select nf, state, count(*) from cards where nf in ('23657','339024','137344')
--   group by nf, state order by nf, count desc;
--   -- esperado: 23657 CANCELADO=64 +RESOLVIDO=2 +TRANSFERIDO=1;
--   --           339024 CANCELADO=41 +TRANSFERIDO=2;
--   --           137344 CANCELADO=41 +RESOLVIDO=1 +AGUARDANDO_VALIDACAO_HUMANA=1
