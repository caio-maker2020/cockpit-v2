-- =============================================================================
-- Agente autônomo de extravios (PART 2) — M4: flag global de autonomia
--
-- Caio 2026-06-24: liga o agente D+4 pra LANÇAR a oc 49 SOZINHO. OFF (default) =
-- o agente só RECOMENDA (modo validação: Caio aprova o lote e o execute lança).
-- ON = o scan, ao confirmar no SSW que o card está limpo (última oc ∈ {6,9,16}),
-- lança a 49 direto (a pré-checagem SSW continua obrigatória em TODO lançamento).
-- Caio liga DEPOIS de validar o lote (M2). Reportes de erro → Caio desliga.
-- =============================================================================

INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('extravios_agente_autonomo_enabled',
   'Liga o agente de extravio D+4 pra LANÇAR a oc 49 sozinho (autônomo). OFF = só '
   'recomenda (validação por lote do Caio via execute). Pré-checagem SSW é sempre '
   'obrigatória. Caio liga após validar o lote; reportes de erro → desligar.',
   false)
ON CONFLICT (key) DO NOTHING;
