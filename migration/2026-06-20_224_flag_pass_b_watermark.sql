-- =============================================================================
-- 2026-06-20_224_flag_pass_b_watermark
--
-- Feature flag do caminho WATERMARK do Pass B (mig 223 criou a coluna/índice).
-- Nasce OFF: o sync segue no caminho legado (byNf por card) até validação.
-- Ligar (enabled=true) em horário de baixa após smoke — NÃO 21h-24h BRT (bug de
-- data SSW já documentado). Rollback = setar enabled=false (sem redeploy).
-- =============================================================================

INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'pass_b_watermark_enabled',
  false,
  'Pass B (sync-bastao) escala via watermark pass_b_checked_at + LIMIT 150 + lookup em lote (fetchPendenciasByNfs) em vez de byNf por card. OFF = caminho legado.'
)
ON CONFLICT (key) DO NOTHING;
