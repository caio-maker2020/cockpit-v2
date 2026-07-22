-- =============================================================================
-- Limpeza auditável dos duplicados da NF 2084 (rajada 14-15/07/2026).
-- Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md | INV-040.
--
-- EXECUTAR SÓ COM APROVAÇÃO DO CAIO: bash scripts/dbq.sh -f scripts/limpeza-duplicados-nf2084-2026-07-21.sql
--
-- O que faz: CANCELA (nunca deleta — event sourcing) os 72 cards fabricados
-- pelo loop de criação do sync em 14-15/07, cada um com card_event
-- `DuplicadoLimpezaNf2084` gravando o state anterior.
--
-- O que PRESERVA (não toca):
--   aa09bacd… — card original de 26/05 (RESOLVIDO, histórico legítimo);
--   97b99721… — TTO 15/07 12:30: tratativa REAL (AprovacaoOperador →
--               AcaoExecutada → AcaoExecutadaConfirmadaPeloSsw);
--   b20ee4b9… — TTO 15/07 19:30: card de trabalho até 21/07 (todos, histórico
--               SSW, atualizações; encerrado por troca de CTRC legítima);
--   d6627801… — card ATIVO criado 21/07 20:01 pelo sync pós-59 (AVH, FELIPE).
--
-- Guards do WHERE: janela 14-15/07 + só terminais (nunca toca card ativo) +
-- exclusão explícita dos preservados. Esperado: exatamente 72 linhas.
-- =============================================================================

begin;

create temp table _dup_nf2084 on commit drop as
select id, state as state_anterior, ctrc, created_at
from cards
where nf = '2084'
  and created_at >= '2026-07-14 00:00:00+00'
  and created_at <  '2026-07-16 00:00:00+00'
  and state in ('RESOLVIDO', 'TRANSFERIDO')          -- só terminais; ativo jamais
  and id not in (
    '97b99721-368a-4d96-b671-6557d0a5544f',           -- tratativa real (ação executada+confirmada)
    'b20ee4b9-bab3-4b9a-a4f8-a1f66c40523d'            -- card de trabalho 15-21/07
  );

-- Aborta se o conjunto não for exatamente o esperado (72 duplicados).
do $$
declare n int;
begin
  select count(*) into n from _dup_nf2084;
  if n <> 72 then
    raise exception 'Esperava 72 duplicados da NF 2084, achei % — abortando (rodar as queries do dossiê de novo antes de limpar)', n;
  end if;
end $$;

update cards c
set state = 'CANCELADO',
    lock_aguardando_validacao = false
from _dup_nf2084 d
where c.id = d.id;

insert into card_events (card_id, event_type, actor_type, actor_id, payload)
select d.id,
       'DuplicadoLimpezaNf2084',
       'system',
       'limpeza-nf2084',
       jsonb_build_object(
         'nf', '2084',
         'state_anterior', d.state_anterior,
         'ctrc', d.ctrc,
         'criado_na_rajada_em', d.created_at,
         'motivo', 'Card fabricado pelo loop criação→terminal→recriação do sync '
                   || '(rajada 14-15/07/2026, 74 duplicados; roteamento pré-59 fazia '
                   || 'o card oc59 nascer TRANSFERIDO e a alternância de CTRC AMB↔TTO '
                   || 'recriava o par a cada ciclo). Cancelado na limpeza auditável. '
                   || 'Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md; INV-040.'
       )
from _dup_nf2084 d;

-- Conferência dentro da transação (esperado: 72 cancelados_agora, 72 eventos).
select
  (select count(*) from cards where nf = '2084' and state = 'CANCELADO')            as cancelados_agora,
  (select count(*) from card_events where event_type = 'DuplicadoLimpezaNf2084')    as eventos_limpeza,
  (select count(*) from cards where nf = '2084'
     and state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO'))                      as ativos_restantes;

commit;

-- Pós-limpeza (validação do dossiê):
--   select state, count(*) from cards where nf='2084' group by state;
--   -- esperado: CANCELADO=72, RESOLVIDO=1 (original 26/05), TRANSFERIDO=2
--   --           (97b99721/b20ee4b9), AGUARDANDO_VALIDACAO_HUMANA=1 (ativo 21/07)
