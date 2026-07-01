-- =============================================================================
-- Agente "relançar 54 por ressarcimento" (M1) — colunas de estado + feature flags
--
-- Caio 2026-06-25 (NF 374609, 775461): padrão recorrente. Cliente notificado
-- (oc 54) → Ressarcimento analisa (oc 46) → Ressarcimento devolve pro
-- relacionamento (oc 49) mandando RELANÇAR 54. A ação é só relançar a oc 54 (sem
-- e-mail novo — gêmeo lançar-só-54). Detector puro: _shared/ressarcimento-relancar-54.ts.
--
-- Espelha o agente-extravio-d4 (migs 256/258/259): colunas de sombra no card +
-- flag master (scan liga) + flag de autonomia (lançar sozinho, default OFF).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Colunas de estado do agente no card (sombra / track-record).
--    status: 'recomendado' | 'lancou' | 'nao_rodou' | 'nao_aplica'
--    tier:   'A' (determinístico) | 'B' (interpretação do agente)
-- ----------------------------------------------------------------------------
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS ressarc54_status     text,
  ADD COLUMN IF NOT EXISTS ressarc54_tier       text,
  ADD COLUMN IF NOT EXISTS ressarc54_motivo     text,
  ADD COLUMN IF NOT EXISTS ressarc54_checado_em timestamptz;

COMMENT ON COLUMN public.cards.ressarc54_status IS
  'Estado do agente relançar-54-por-ressarcimento: recomendado/lancou/nao_rodou/nao_aplica. Caio 2026-06-25.';
COMMENT ON COLUMN public.cards.ressarc54_tier IS
  'Tier da detecção: A (a 49 manda relançar 54 explicitamente) | B (interpretação do agente via e-mail).';

-- Índice parcial: o scan filtra cards ainda não checados; o front lista os tratados.
-- Só indexa as linhas com status setado (a vasta maioria fica NULL).
CREATE INDEX IF NOT EXISTS idx_cards_ressarc54_status
  ON public.cards (ressarc54_status)
  WHERE ressarc54_status IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Feature flags.
--    master   : liga o scan (modo sombra — só recomenda, sem lançar). Default ON.
--    autonomo : o scan LANÇA a 54 sozinho (via envelope). Default OFF — Caio liga
--               depois de validar a taxa de acertos do lote.
-- ----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('ressarcimento_relancar54_enabled',
   'Liga o agente que detecta o round-trip de ressarcimento (54→46→49 "lançar 54") '
   'e RECOMENDA relançar só a oc 54. Modo sombra (não lança) até a flag de autonomia. '
   'Caio 2026-06-25.',
   true),
  ('ressarcimento_relancar54_autonomo_enabled',
   'Liga o agente pra RELANÇAR a oc 54 sozinho (autônomo, via envelope SSW) quando '
   'detecta o round-trip de ressarcimento. OFF = só recomenda. Caio liga após validar '
   'a taxa de acertos manualmente; reportes de erro → desligar. Caio 2026-06-25.',
   false)
ON CONFLICT (key) DO NOTHING;
