-- ============================================================================
-- Cockpit v2 — v_tempo_oc21_oc14_detalhe: incluir operador + cliente + base
-- pro indicador filtrar por operador logado
-- Caio 2026-05-23
--
-- Problema: aba Larissa mostrava NFs do Duilio porque view detalhe não tinha
-- campo de operador. Indicador é PESSOAL (mede performance das bases por
-- operador relacionamento).
--
-- Fix: expor responsavel_relacionamento + empresa_cliente + base_destino_card +
-- cidade_destino + uf_destino. Front filtra por session operador.
--
-- Tabela tempo_oc21_para_oc14 não muda — apenas a view de leitura.
-- ============================================================================

DROP VIEW IF EXISTS public.v_tempo_oc21_oc14_detalhe CASCADE;

CREATE VIEW public.v_tempo_oc21_oc14_detalhe
WITH (security_invoker = on) AS
SELECT
  t.id, t.card_id,
  t.data_oc21, t.data_oc14,
  t.delta_minutos,
  round(t.delta_minutos::numeric / 60.0, 1) AS delta_horas,
  round(public.dias_uteis_entre(t.data_oc21, t.data_oc14), 2) AS delta_dias_uteis,
  t.dentro_sla,
  t.base_oc14, t.usuario_oc14,
  t.base_oc21, t.usuario_oc21,
  t.created_at,
  c.nf, c.ctrc,
  c.responsavel_relacionamento,
  c.empresa_cliente,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino_card,
  c.agent_state->>'cidade_destino' AS cidade_destino,
  c.agent_state->>'uf_destino' AS uf_destino
FROM public.tempo_oc21_para_oc14 t
JOIN public.cards c ON c.id = t.card_id
ORDER BY t.data_oc14 DESC;

GRANT SELECT ON public.v_tempo_oc21_oc14_detalhe TO authenticated, service_role;

COMMENT ON VIEW public.v_tempo_oc21_oc14_detalhe IS
  'v2 Caio 2026-05-23: expõe responsavel_relacionamento + empresa_cliente + '
  'base_destino_card + cidade/uf pra front filtrar por operador. Pares 21→14 '
  'completos (ciclos fechados). Pendentes NÃO entram aqui — usar v_oc21_aguardando_oc14.';
