-- =============================================================================
-- FLIP: liga o enforce autoritativo do gate da oc 33 (extravio parcial)
--
-- Caio 2026-07-17 (NF 135724). Liga o gateOc33Enforce (executor) — recusa oc 33
-- de completude com dossiê incompleto (e combo operacional sem romaneio), com
-- escape hatch extras.forcar_oc33_dossie_incompleto (evento auditável).
--
-- Baseline de sombra medido em 2026-07-17 (10 dias, 07/07→17/07): 17 avisos
-- Oc33BloqueadaDossieIncompleto; apenas 2 lançamentos teriam sido de fato
-- bloqueados (NF 567 sem descrição+valor; NF 94458 sem valor — ambos
-- genuinamente incompletos). Impacto: ~1 bloqueio/semana.
--
-- PRÉ-REQUISITO: mig 297 aplicada e observada (2-3 dias). APLICAR SÓ no passo 3
-- do rollout. Rollback: UPDATE ... SET enabled = false WHERE key = '...'.
-- =============================================================================

UPDATE public.feature_flags
SET enabled = true
WHERE key = 'extravio_parcial_gate_enforce';
