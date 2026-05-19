-- ============================================================================
-- Cockpit v2 — v_tempo_oc21_oc14_detalhe ganha pagador_nome / cnpj_pagador
-- Data: 2026-05-18
--
-- Caio: filtro de cliente pagador no front não estava mudando o tempo médio
-- porque a view agregada (v_indicador_tempo_oc21_oc14_base) não tem cnpj.
-- Solução: o front passa a buscar a detalhe quando há filtro de cliente e
-- agrega client-side. Pra isso a detalhe precisa ter cnpj_pagador disponível.
-- ============================================================================

DROP VIEW IF EXISTS public.v_tempo_oc21_oc14_detalhe CASCADE;

CREATE VIEW public.v_tempo_oc21_oc14_detalhe
WITH (security_invoker = on) AS
SELECT
  t.id,
  t.card_id,
  c.nf,
  c.ctrc,
  c.responsavel_relacionamento,
  c.base_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  t.data_oc21,
  t.data_oc14,
  t.dias_uteis,
  t.dentro_sla_dias_uteis,
  t.delta_minutos,
  t.dentro_sla AS dentro_sla_24h,
  t.base_oc14,
  t.usuario_oc14,
  t.base_oc21,
  t.usuario_oc21,
  t.created_at
FROM public.tempo_oc21_para_oc14 t
JOIN public.cards c ON c.id = t.card_id
ORDER BY t.data_oc14 DESC;

GRANT SELECT ON public.v_tempo_oc21_oc14_detalhe
  TO authenticated, service_role;

COMMENT ON VIEW public.v_tempo_oc21_oc14_detalhe IS
  'Caio 2026-05-18: detalhe dos pares com info de cliente (pagador_nome/cnpj) '
  'pra permitir filtro client-side por cliente quando view agregada não basta.';
