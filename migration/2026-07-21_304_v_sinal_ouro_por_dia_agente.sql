-- 2026-07-21_304 — v_sinal_ouro_por_dia_agente
--
-- Fix de raiz do indicador "Performance dos agentes" vazio: o painel buscava
-- v_sinal_ouro_metricas_diarias (grão dia×agente×oc×operador = 1.237 linhas
-- em 60d) e o PostgREST corta em 1.000 → dias recentes sumiam. O painel só
-- precisa de dia×agente (~180 linhas/60d). Mesma classe do bug da estreia
-- do agente-chefe (commit 3942cfc) — agora eliminada no front por design.

BEGIN;

CREATE VIEW public.v_sinal_ouro_por_dia_agente
WITH (security_invoker = on) AS
SELECT
  (u.decidido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  u.agent_name,
  count(*)                                         AS pares,
  count(*) FILTER (WHERE u.veredito = 'seguida')   AS seguidas,
  count(*) FILTER (WHERE u.veredito = 'corrigida') AS corrigidas,
  count(*) FILTER (WHERE u.veredito IN ('abstencao','nao_rodou')) AS abstencoes
FROM public.v_agent_feedback_unificado u
GROUP BY 1, 2;

COMMENT ON VIEW public.v_sinal_ouro_por_dia_agente IS
  'Sinal de Ouro agregado por dia×agente — fonte enxuta do painel Aprendizado (hero, performance diária, placar, gráficos). Baixa cardinalidade por design (teto PostgREST de 1000 linhas nunca alcançável).';

COMMIT;
