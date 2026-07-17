-- =============================================================================
-- FLIP: liga a materialização universal da oc 33 de completude
--
-- Caio 2026-07-17 (NF 135724). PRÉ-REQUISITO: executor deployado com o código
-- da branch correcao-melhoria-oc33-descricao-itens-pdfs-ssw (mig 296 aplicada).
-- APLICAR SÓ no passo 2 do rollout (após validar o deploy dark).
-- Observar 2-3 dias os eventos Oc33CompletudeMaterializada antes da mig 298.
-- Rollback: UPDATE ... SET enabled = false WHERE key = '...'.
-- =============================================================================

UPDATE public.feature_flags
SET enabled = true
WHERE key = 'extravio_parcial_materializacao_enabled';
