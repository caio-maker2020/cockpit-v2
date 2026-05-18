-- ============================================================================
-- Cockpit v2 — Ativa security_invoker na view v_cancelamentos_reentrega
-- Data: 2026-05-18
--
-- Bug encontrado em 2026-05-18 ao validar isolamento por operador da aba
-- "Cancelamentos Reentrega": Larissa via cancelamentos do Duilio, mesmo com
-- RLS correto em acoes_agendadas/cards. Causa raiz: view foi criada SEM
-- WITH (security_invoker=on) → Postgres 15+ default é security_definer,
-- então a view roda como `postgres` e BYPASSA toda RLS das tabelas
-- subjacentes (acoes_agendadas, cards).
--
-- Fix: ativar security_invoker. View passa a respeitar a RLS do caller.
-- Padrão do projeto: as outras 2 views públicas (vw_divergencias_*,
-- vw_invariante_status) já tinham security_invoker=true.
-- ============================================================================

ALTER VIEW public.v_cancelamentos_reentrega SET (security_invoker = on);

COMMENT ON VIEW public.v_cancelamentos_reentrega IS
  'Cancelamentos de reentrega agendados/processados. security_invoker=on '
  'garante que cada operador só vê seus próprios cancelamentos via RLS '
  'herdada de acoes_agendadas/cards. Gestor vê tudo.';
