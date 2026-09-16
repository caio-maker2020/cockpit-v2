-- =============================================================================
-- 2026-09-16_400 — Mapa de Demanda: tipo do registro (Caio 16/09, ajuste do QA)
-- =============================================================================
-- "quero campos mesmo: acao executada ou acionamento" — o registro nasce com
-- um seletor travado (acionamento = alguém acionou a Isadora; acao_executada =
-- ela executou algo), e escrita livre SÓ nos campos de texto. TIPO A, aditiva.
-- =============================================================================

ALTER TABLE public.pdi_demanda_log
  ADD COLUMN IF NOT EXISTS tipo_registro text NOT NULL DEFAULT 'acionamento';
