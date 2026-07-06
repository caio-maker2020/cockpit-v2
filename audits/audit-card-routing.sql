-- ============================================================================
-- audit-card-routing.sql  —  Auditoria READ-ONLY de roteamento de cards Bastão/Cockpit
-- ----------------------------------------------------------------------------
-- Objetivo (Passo 1/P0 de CARDS_BASTAO_REGRESSION_FOCUS.md + Fase 1 de
-- PRODUCTION_RISK_ACTION_PLAN.md): medir CORRETAMENTE, sem alterar nada, por operador:
--   - dono esperado (resolver) vs atual; sem-dono; dono-errado; dono-inativo;
--   - cards REALMENTE invisíveis p/ operador comum (replicando a RLS real);
--   - divergência REAL de segmento (código vs código, não vs rótulo);
--   - conflito carteira × responsável/segmento do Bastão.
--
-- GARANTIA: tudo em transações READ ONLY (SET TRANSACTION READ ONLY). Nenhum
-- INSERT/UPDATE/DDL é possível. Re-rodável: psql "$SUPABASE_DB_URL" -f este_arquivo.
--
-- ----------------------------------------------------------------------------
-- CORREÇÃO v2 (Fase 1, 2026-06-27) — o que mudou vs v1 e POR QUÊ:
--   [C1] DIVERGÊNCIA DE SEGMENTO: v1 comparava segmento_codigo (coluna, ex "022")
--        com o RÓTULO completo do Bastão (agent_state->>'segmento_cliente',
--        ex "022 - MOTOBIKE") → 20 de 30 "divergentes" eram FALSO-POSITIVO.
--        v2 compara o CÓDIGO de 3 dígitos dos dois lados. Distingue:
--          - falso_positivo_rotulo: códigos iguais, só o rótulo difere;
--          - divergencia_real: códigos diferentes.
--   [C2] INVISIBILIDADE: v1 marcava invisível só por assigned nulo/inativo,
--        ignorando o predicado RLS de segmento que FUNCIONA. v2 replica a RLS
--        REAL (mig 242), exatamente: visível se (gestor) OR assigned=op OR
--        pagador=ANY(carteira) OR segmento_codigo=ANY(segmentos). O predicado de
--        segmento usa match EXATO (= ANY), igual à RLS — logo card com
--        segmento_codigo em forma de RÓTULO ("022 - MOTOBIKE") NÃO conta como
--        visível por segmento (a RLS também não casaria). pagador=ANY(carteira)
--        é morto (pagador é nome, carteira é CNPJ) mas entra por fidelidade.
--
-- Escopo "card que deveria aparecer" = estados ativos de relacionamento:
--   AGUARDANDO_CLIENTE, AGUARDANDO_VALIDACAO_HUMANA, AGUARDANDO_AGENTE, EXTRAVIO_MONITORADO
--
-- Resolver replicado de operador-resolver.ts:127-189 (cascata):
--   cnpj_excluido -> carteira_cnpj -> carteira_dormente(null) -> responsavel_nome -> segmento -> nenhum
-- NOTA: o resolver compara segmento por match EXATO contra o RÓTULO (hint cru),
-- então a regra 'segmento' do resolver está morta na prática ([R1]); reproduzimos
-- fielmente (expected_via='segmento' raramente dispara) e, à parte, mostramos o
-- dono que a INTENÇÃO de negócio daria por PREFIXO de código (dono_por_segmento_pfx).
-- ============================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

-- ============================================================================
-- SAÍDA 1 — DETALHE por card: divergências de dono + invisibilidade + conflitos.
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
with
ops as (select id,nome,upper(trim(nome)) unome,papel,ativo,cockpit_ativo,coalesce(carteira,'{}') carteira,coalesce(segmentos,'{}') segmentos from operadores),
op_cockpit as (select * from ops where ativo and cockpit_ativo and papel<>'gestor'),
op_dorm    as (select * from ops where ativo and not cockpit_ativo and papel<>'gestor'),
excl as (select distinct regexp_replace(cnpj_pagador,'\D','','g') cnpj from cnpjs_excluidos_cockpit where ativo),
ac as (
  select c.id,c.nf,c.ctrc,c.state,c.pagador,c.assigned_operator_id,c.segmento_codigo,c.cod_ultima_ocorrencia,c.updated_at,
    regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g') cnpj,
    upper(trim(coalesce(c.agent_state->>'responsavel_relacionamento',''))) resp,
    nullif(c.agent_state->>'segmento_cliente','') seg_label,
    substring(c.agent_state->>'segmento_cliente' from '(\d{3})') seg_code_bastao,   -- [C1] código do Bastão
    substring(c.segmento_codigo from '(\d{3})') seg_code_card                       -- [C1] código gravado no card
  from cards c
  where c.state in ('AGUARDANDO_CLIENTE','AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_AGENTE','EXTRAVIO_MONITORADO')),
resolved as (select ac.*,
  (select array_agg(o.id) from op_cockpit o where ac.cnpj<>'' and ac.cnpj=any(o.carteira)) cart_ids,
  (select array_agg(o.id) from op_dorm    o where ac.cnpj<>'' and ac.cnpj=any(o.carteira)) dorm_ids,
  (select array_agg(o.id) from op_cockpit o where ac.resp<>'' and o.unome=ac.resp) nome_ids,
  (select array_agg(o.id) from op_cockpit o where ac.seg_label is not null and ac.seg_label=any(o.segmentos)) seg_ids,         -- regra real (rótulo, morta)
  (select array_agg(o.id) from op_cockpit o where ac.seg_code_bastao is not null and ac.seg_code_bastao=any(o.segmentos)) segpfx_ids, -- intenção (código)
  -- [C2] RLS REAL: card é visível p/ algum operador comum?
  exists(select 1 from op_cockpit o where
            o.id = ac.assigned_operator_id
            or ac.pagador = any(o.carteira)                 -- morto (nome vs CNPJ), mantido por fidelidade
            or ac.segmento_codigo = any(o.segmentos)        -- EXATO, como a RLS (rótulo não casa)
        ) as visivel_por_rls,
  (ac.cnpj<>'' and exists(select 1 from excl e where e.cnpj=ac.cnpj)) is_excluido
  from ac),
expected as (select r.*,
  case when is_excluido then 'cnpj_excluido' when array_length(cart_ids,1)=1 then 'carteira_cnpj'
       when array_length(cart_ids,1)>1 then 'carteira_AMBIGUA' when array_length(dorm_ids,1)>=1 then 'carteira_dormente'
       when array_length(nome_ids,1)=1 then 'responsavel_nome' when array_length(nome_ids,1)>1 then 'nome_AMBIGUO'
       when array_length(seg_ids,1)=1 then 'segmento' when array_length(seg_ids,1)>1 then 'segmento_AMBIGUO' else 'nenhum' end expected_via,
  case when is_excluido then null when array_length(cart_ids,1)=1 then cart_ids[1] when array_length(dorm_ids,1)>=1 then null
       when array_length(nome_ids,1)=1 then nome_ids[1] when array_length(seg_ids,1)=1 then seg_ids[1] else null end expected_op_id
  from resolved r),
classified as (select e.*, ao.nome assigned_nome,
  (ao.id is not null and ao.ativo and ao.cockpit_ativo and ao.papel<>'gestor') assigned_visivel,
  eo.nome expected_nome,
  (case when array_length(e.segpfx_ids,1)=1 then (select nome from operadores where id=e.segpfx_ids[1]) end) dono_por_segmento_pfx,
  -- veredito de dono (igual v1; lógica de dono estava correta)
  case when e.assigned_operator_id is not distinct from e.expected_op_id and e.expected_op_id is not null then 'OK'
       when e.assigned_operator_id is null and e.expected_op_id is not null then 'SEM_DONO_MAS_DEVERIA_TER'
       when e.assigned_operator_id is null and e.expected_op_id is null then 'SEM_DONO_SEM_REGRA'
       when e.assigned_operator_id is not null and e.is_excluido then 'ATRIBUIDO_MAS_CNPJ_EXCLUIDO'
       when e.assigned_operator_id is not null and e.expected_op_id is null and e.expected_via='carteira_dormente' then 'DONO_DEVERIA_SER_CARTEIRA_DORMENTE'
       when e.assigned_operator_id is not null and e.expected_op_id is null then 'DONO_SEM_REGRA_QUE_SUSTENTE'
       when e.assigned_operator_id is distinct from e.expected_op_id then 'DONO_ERRADO' else 'OK' end verdito_dono,
  -- [C1] divergência REAL de segmento (código vs código)
  case when e.seg_code_card is not null and e.seg_code_bastao is not null and e.seg_code_card <> e.seg_code_bastao then 'DIVERGENCIA_REAL'
       when e.seg_code_card is not null and e.seg_code_bastao is not null and e.segmento_codigo <> e.seg_label then 'falso_positivo_rotulo'
       when e.segmento_codigo is null then 'segmento_codigo_NULO'
       else null end segmento_status,
  -- conflito latente: carteira atribuiu a X, mas responsável do Bastão é OUTRO operador ativo
  (e.resp<>'' and exists(select 1 from op_cockpit o where o.unome=e.resp and o.id is distinct from e.assigned_operator_id) and e.assigned_operator_id is not null) conflito_carteira_vs_responsavel
  from expected e left join operadores ao on ao.id=e.assigned_operator_id left join operadores eo on eo.id=e.expected_op_id)
select
  coalesce(assigned_nome,'— SEM DONO') as dono_atual,
  not visivel_por_rls as invisivel_exceto_gestor,                                  -- [C2]
  (assigned_operator_id is not null and not assigned_visivel) as dono_inativo,
  verdito_dono,
  coalesce(expected_nome, dono_por_segmento_pfx, '—') as dono_correto,
  expected_via as regra,
  segmento_status,
  conflito_carteira_vs_responsavel as conflito_resp,
  nf, ctrc, cnpj, seg_label as segmento, state, cod_ultima_ocorrencia as oc, left(pagador,22) as pagador, resp as responsavel_bastao, id as card_id
from classified
where verdito_dono <> 'OK'
   or not visivel_por_rls
   or segmento_status = 'DIVERGENCIA_REAL'
   or conflito_carteira_vs_responsavel
order by
  (not visivel_por_rls) desc,
  case verdito_dono when 'DONO_ERRADO' then 1 when 'ATRIBUIDO_MAS_CNPJ_EXCLUIDO' then 2
    when 'SEM_DONO_MAS_DEVERIA_TER' then 3 when 'DONO_DEVERIA_SER_CARTEIRA_DORMENTE' then 4
    when 'DONO_SEM_REGRA_QUE_SUSTENTE' then 5 when 'SEM_DONO_SEM_REGRA' then 6 else 7 end,
  dono_atual, nf;
COMMIT;

-- ============================================================================
-- SAÍDA 2 — RESUMO POR OPERADOR (dono atual x dono esperado).
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
with
ops as (select id,nome,upper(trim(nome)) unome,papel,ativo,cockpit_ativo,coalesce(carteira,'{}') carteira,coalesce(segmentos,'{}') segmentos from operadores),
op_cockpit as (select * from ops where ativo and cockpit_ativo and papel<>'gestor'),
op_dorm    as (select * from ops where ativo and not cockpit_ativo and papel<>'gestor'),
excl as (select distinct regexp_replace(cnpj_pagador,'\D','','g') cnpj from cnpjs_excluidos_cockpit where ativo),
ac as (select c.id,c.state,c.assigned_operator_id,
    regexp_replace(coalesce(c.agent_state->>'cnpj_pagador',''),'\D','','g') cnpj,
    upper(trim(coalesce(c.agent_state->>'responsavel_relacionamento',''))) resp,
    nullif(c.agent_state->>'segmento_cliente','') seg
  from cards c where c.state in ('AGUARDANDO_CLIENTE','AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_AGENTE','EXTRAVIO_MONITORADO')),
resolved as (select ac.*,
  (select array_agg(o.id) from op_cockpit o where ac.cnpj<>'' and ac.cnpj=any(o.carteira)) cart_ids,
  (select array_agg(o.id) from op_dorm    o where ac.cnpj<>'' and ac.cnpj=any(o.carteira)) dorm_ids,
  (select array_agg(o.id) from op_cockpit o where ac.resp<>'' and o.unome=ac.resp) nome_ids,
  (select array_agg(o.id) from op_cockpit o where ac.seg is not null and ac.seg=any(o.segmentos)) seg_ids,
  (ac.cnpj<>'' and exists(select 1 from excl e where e.cnpj=ac.cnpj)) is_excluido from ac),
expected as (select r.*,
  case when is_excluido then null when array_length(cart_ids,1)=1 then cart_ids[1] when array_length(dorm_ids,1)>=1 then null
       when array_length(nome_ids,1)=1 then nome_ids[1] when array_length(seg_ids,1)=1 then seg_ids[1] else null end expected_op_id from resolved r)
select coalesce(ao.nome,'— SEM DONO') dono_atual, count(*) atribuidos_total,
  count(*) filter (where e.assigned_operator_id is not distinct from e.expected_op_id and e.expected_op_id is not null) ok,
  count(*) filter (where e.assigned_operator_id is distinct from e.expected_op_id and e.expected_op_id is not null) dono_errado,
  count(*) filter (where e.assigned_operator_id is not null and e.expected_op_id is null) sem_base_no_resolver,
  count(*) filter (where ao.id is not null and not (ao.ativo and ao.cockpit_ativo)) dono_inativo
from expected e left join operadores ao on ao.id=e.assigned_operator_id
group by 1 order by atribuidos_total desc;
COMMIT;

-- ============================================================================
-- SAÍDA 3 — CNPJ em MAIS DE UMA carteira (qualquer operador).
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
with c as (select nome, cockpit_ativo, unnest(carteira) cnpj from operadores)
select cnpj, count(*) n_carteiras,
       string_agg(nome||case when not cockpit_ativo then '(dorm/inativo)' else '' end, ', ' order by nome) operadores
from c group by cnpj having count(*) > 1 order by n_carteiras desc;
COMMIT;

-- ============================================================================
-- SAÍDA 4 — PLACAR sistêmico de segmento (CORRIGIDO [C1]).
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
select
  count(*) ativos_total,
  count(*) filter (where agent_state ? 'segmento_cliente') com_segmento_bastao,
  count(*) filter (where segmento_codigo is null) segmento_codigo_NULO,
  count(*) filter (where segmento_codigo is not null
                    and substring(segmento_codigo from '(\d{3})') is distinct from substring(agent_state->>'segmento_cliente' from '(\d{3})')) divergencia_REAL,
  count(*) filter (where segmento_codigo is not null
                    and segmento_codigo <> (agent_state->>'segmento_cliente')
                    and substring(segmento_codigo from '(\d{3})') = substring(agent_state->>'segmento_cliente' from '(\d{3})')) falso_positivo_rotulo
from cards
where state in ('AGUARDANDO_CLIENTE','AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_AGENTE','EXTRAVIO_MONITORADO');
COMMIT;

-- ============================================================================
-- SAÍDA 5 — PLACAR de roteamento/visibilidade (números do relatório).
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
with
op_cockpit as (select id,coalesce(carteira,'{}') carteira,coalesce(segmentos,'{}') segmentos from operadores where ativo and cockpit_ativo and papel<>'gestor'),
ac as (select c.id, c.assigned_operator_id, c.segmento_codigo, c.pagador,
    exists(select 1 from op_cockpit o where o.id=c.assigned_operator_id or c.pagador=any(o.carteira) or c.segmento_codigo=any(o.segmentos)) visivel
  from cards c where c.state in ('AGUARDANDO_CLIENTE','AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_AGENTE','EXTRAVIO_MONITORADO'))
select
  count(*) total_ativos,
  count(*) filter (where not visivel) invisivel_p_operador_comum,
  count(*) filter (where assigned_operator_id is null) sem_dono,
  count(*) filter (where assigned_operator_id is not null and not exists(select 1 from op_cockpit o where o.id=ac.assigned_operator_id)) dono_inativo
from ac;
COMMIT;

-- ============================================================================
-- SAÍDA 6 — fix-orfaos-043-carteira-isa.sql já aplicado? (8 CNPJs na carteira da ISA)
-- ============================================================================
BEGIN; SET TRANSACTION READ ONLY;
with alvo(cnpj) as (values
  ('32768944000108'),('55847057002409'),('02415741000169'),('09601946000188'),
  ('06133273000190'),('18081748000121'),('49816918000100'),('31893116000120'))
select count(*) cnpjs_do_fix, count(*) filter (where a.cnpj in (select unnest(carteira) from operadores where nome='ISA E KAROL')) ja_na_carteira_isa,
  case when count(*) = count(*) filter (where a.cnpj in (select unnest(carteira) from operadores where nome='ISA E KAROL')) then 'APLICADO' else 'PARCIAL/NAO' end status
from alvo a;
COMMIT;
