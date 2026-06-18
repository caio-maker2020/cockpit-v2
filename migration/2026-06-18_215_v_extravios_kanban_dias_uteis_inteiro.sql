-- =============================================================================
-- v_extravios_kanban — dias úteis INTEIROS (sem fração)
--
-- Caio 2026-06-18: o card mostrava "1,7 du" / "2,7 du" porque a view expunha
-- dias_uteis = round(dias_uteis_entre(ts_lançamento, now()), 2). A função
-- dias_uteis_entre conta dias úteis FRACIONÁRIOS (proporção de horas de cada
-- dia), então 1,7 = 1 dia útil + 0,7 de outro. A regra do kanban, porém, é
-- por DIAS úteis (não horas): ou é 1, ou é 2. E pro SLA de Perdas (5 dias úteis)
-- contar por hora subestima ("PRAZO DE PERDAS EXPIRADO" só após 5 dias úteis).
--
-- Fix: contar dias úteis pela DATA, não pelo timestamp. Ao usar a DATA dos dois
-- lados, dias_uteis_entre soma exatamente 1.0 por dia útil → resultado INTEIRO.
-- Mínimo 1 (lançado hoje/ontem = D1), bucket máximo D5 (5+). O número no card =
-- o número da coluna.
--   • lançado hoje              → 0 dias úteis → exibe 1 (D1)
--   • lançado ontem (dia útil)  → 1            → D1
--   • lançado 2 dias úteis atrás→ 2            → D2 ... 5+ → D5
--
-- CUIDADO timezone (Caio 2026-06-18): o Bastão manda só a DATA da ocorrência
-- ("2026-06-12") e ela é gravada como 2026-06-12 00:00 UTC. Converter o lado do
-- lançamento via AT TIME ZONE 'America/Sao_Paulo' jogaria pra 11/06 21:00 →
-- a data "volta" 1 dia e a contagem fica +1 errada (NF 3082459 dava 5 em vez
-- de 4). Por isso o lado do LANÇAMENTO usa ::date direto (= a data que o Bastão
-- mandou); só o "hoje" (now()) é trazido pra data BRT, que é a data correta no
-- Brasil. session timezone do banco = UTC.
--
-- security_invoker=on mantido (RLS de cards → operador vê só os seus).
-- =============================================================================

DROP VIEW IF EXISTS public.v_extravios_kanban;

CREATE VIEW public.v_extravios_kanban
WITH (security_invoker = on) AS
SELECT
  base.card_id,
  base.nf,
  base.ctrc,
  base.base_destino,
  base.empresa_cliente,
  base.pagador_nome,
  base.cnpj_pagador,
  base.remetente,
  base.destinatario,
  base.oc_extravio,
  base.instrucao,
  base.qtde_volumes,
  base.data_lancamento,
  base.assigned_operator_id,
  base.responsavel_relacionamento,
  -- dias úteis INTEIROS (mínimo 1) — número exibido no card
  GREATEST(1, base.du_raw::int) AS dias_uteis,
  -- bucket D1..D5 (mínimo 1, máximo 5) — coincide com dias_uteis até D5
  'D' || LEAST(5, GREATEST(1, base.du_raw::int)) AS coluna_kanban
FROM (
  SELECT
    c.id AS card_id,
    c.nf,
    c.ctrc,
    COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
    c.empresa_cliente,
    c.pagador AS pagador_nome,
    c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
    c.agent_state->>'remetente'    AS remetente,
    c.agent_state->>'destinatario' AS destinatario,
    c.cod_ultima_ocorrencia AS oc_extravio,
    c.agent_state->>'instrucao_ultima_ocorrencia' AS instrucao,
    c.qtde_volumes,
    c.bastao_data_ultima_ocorrencia AS data_lancamento,
    c.assigned_operator_id,
    c.responsavel_relacionamento,
    -- conta dias úteis pela DATA dos dois lados → valor inteiro.
    -- lançamento: ::date direto (a data que o Bastão mandou; NÃO converter via
    -- BRT senão datas puras 00:00 UTC voltam 1 dia). hoje: data BRT do now().
    public.dias_uteis_entre(
      (c.bastao_data_ultima_ocorrencia::date)::timestamptz,
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamptz
    ) AS du_raw
  FROM public.cards c
  WHERE c.state = 'EXTRAVIO_MONITORADO'
    AND c.cod_ultima_ocorrencia IN (6, 9, 16)
) base
ORDER BY base.du_raw DESC NULLS LAST;

GRANT SELECT ON public.v_extravios_kanban TO authenticated, service_role;

COMMENT ON VIEW public.v_extravios_kanban IS
  'Kanban EXTRAVIOS (aba do Duilio). Cards state=EXTRAVIO_MONITORADO + oc∈{6,9,16}. '
  'dias_uteis = INTEIRO (conta dias úteis pela data BRT, mínimo 1). '
  'coluna_kanban = D1..D5 (=dias_uteis até D5). security_invoker=on → RLS de cards. '
  'Caio 2026-06-18 (fix fração 1,7/2,7).';
