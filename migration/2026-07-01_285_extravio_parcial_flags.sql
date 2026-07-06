-- =============================================================================
-- Extravio parcial — dossiê de completude + gate da oc 33 (Fase 1)
--
-- Caio 2026-07-01 (NF 66193 INOVAMED / Larissa). Rollout SHADOW-FIRST:
--   - extravio_parcial_dossie_enabled = ON  → o interpretador-resposta-cliente
--     POPULA o dossiê (romaneio/descrição/valor) em agent_state.extravio_parcial
--     e emite telemetria (DossieExtravioAtualizado / Oc33BloqueadaDossieIncompleto).
--     Nada é bloqueado — só observa/informa (baseline p/ pegar falso-positivo).
--   - extravio_parcial_gate_enforce = OFF → o gate NÃO bloqueia a oc 33. O
--     executor só passa a RECUSAR a oc 33 de completude com dossiê incompleto
--     quando esta flag virar ON (após alguns dias de sombra). Operador pode
--     forçar via extras.forcar_oc33_dossie_incompleto (card_event de auditoria).
--
-- Nenhuma coluna nova: o dossiê vive no jsonb agent_state existente.
-- Idempotente (ON CONFLICT DO NOTHING) — key é UNIQUE na feature_flags.
-- =============================================================================

INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('extravio_parcial_dossie_enabled',
   'Extravio parcial (NF 66193): o interpretador POPULA o dossiê das 3 evidências '
   '(romaneio + descrição + valor) em agent_state.extravio_parcial e emite '
   'telemetria. Shadow (não bloqueia). Liga cedo p/ observar; enforce é a outra flag.',
   true),
  ('extravio_parcial_gate_enforce',
   'Extravio parcial (NF 66193): quando ON, o executor RECUSA a oc 33 de completude '
   'com dossiê incompleto (e o combo 33+44 operacional sem romaneio), salvo '
   'extras.forcar_oc33_dossie_incompleto. OFF = gate só observa (modo AVISADO). '
   'Ligar após baseline de sombra.',
   false)
ON CONFLICT (key) DO NOTHING;
