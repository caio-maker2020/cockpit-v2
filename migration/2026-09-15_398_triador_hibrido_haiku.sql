-- =============================================================================
-- 2026-09-15_398 — flag do triador híbrido Haiku+Sonnet (Caio 15/09: "vamos
-- fazer hibrido + tranca do aceite... garanta q iremos reduzir 70usd por mes")
-- =============================================================================
-- Haiku classifica tudo; rótulo 'reentrega' → Sonnet re-classifica e a
-- palavra final é dele (inclusive o aceite do cliente). Tranca do aceite no
-- vinculador é código (sem flag — regra de produto). Flag NASCE ON por ordem
-- expressa; OFF = Sonnet em tudo (rollback sem deploy). TIPO A/flag.
-- =============================================================================

INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('triador_hibrido_haiku_enabled', true,
        'Triador híbrido (Caio 15/09): Haiku 4.5 classifica tudo; tipo reentrega → Sonnet arbitra e a palavra final é dele. OFF = Sonnet puro (comportamento pré-15/09). Economia projetada ~US$ 70/mês.')
ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, description = EXCLUDED.description;
