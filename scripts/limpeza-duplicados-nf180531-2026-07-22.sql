-- =============================================================================
-- Limpeza auditável da mini-rajada NF 180531 (EXECUTADA 2026-07-22, registro).
-- Mesma classe da NF 2084 (dossiê audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md,
-- INV-040): ping-pong de CTRC APO405714-7 ↔ BHZ424839-2 em 09-10/07, 1 card por
-- ciclo (~30 min), todos encerrados por CardEncerradoPorTrocaDeCtrc, zero
-- atividade real. Detectada na varredura global pós-limpeza das 3 NFs grandes.
--
-- CANCELOU 6 duplicados; PRESERVOU 5cf73fef… (ATIVO em AGUARDANDO_CLIENTE,
-- tratativa completa: AprovacaoOperador + AcaoExecutada + resposta do cliente).
-- Resultado da execução: UPDATE 6 / INSERT 6 / ativo_preservado=1 / COMMIT.
-- =============================================================================

begin;

create temp table _dup_180531 on commit drop as
select c.id, c.nf, c.state as state_anterior, c.ctrc, c.created_at
from cards c
where c.nf = '180531'
  and c.state in ('RESOLVIDO','TRANSFERIDO')
  and c.created_at >= '2026-07-09 00:00:00+00' and c.created_at < '2026-07-11 00:00:00+00'
  and not exists (
    select 1 from card_events ce
    where ce.card_id = c.id
      and (ce.actor_type = 'operator'
        or ce.event_type in ('AprovacaoOperador','AcaoExecutada','AcaoExecutadaConfirmadaPeloSsw',
                             'RespostaEnviada','RespostaClienteCapturada','MensagemAnexadaPorThread',
                             'CardReaberto','EmailEnviado')));

do $$
declare n int;
begin
  select count(*) into n from _dup_180531;
  if n <> 6 then raise exception 'Esperava 6 duplicados da NF 180531, achei % — abortando', n; end if;
end $$;

update cards c set state='CANCELADO', lock_aguardando_validacao=false
from _dup_180531 d where c.id = d.id;

insert into card_events (card_id, event_type, actor_type, actor_id, payload)
select d.id, 'DuplicadoLimpezaRajadaSync', 'system', 'limpeza-rajadas-sync',
  jsonb_build_object('nf', d.nf, 'state_anterior', d.state_anterior, 'ctrc', d.ctrc,
    'criado_na_rajada_em', d.created_at, 'caso_ancora', 'NF 2084',
    'motivo', 'Card fabricado pelo loop criação→terminal→recriação do sync (mesma classe da NF 2084; mini-rajada 09-10/07/2026, ping-pong APO↔BHZ). Cancelado na limpeza auditável aprovada pelo Caio em 22/07. Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md; INV-040.')
from _dup_180531 d;

select (select count(*) from cards where nf='180531' and state='CANCELADO') as cancelados,
       (select count(*) from cards where nf='180531' and state='AGUARDANDO_CLIENTE') as ativo_preservado;

commit;
