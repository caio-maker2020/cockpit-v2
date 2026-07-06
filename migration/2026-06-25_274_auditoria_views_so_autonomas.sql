-- =============================================================================
-- Aba Auditoria = SÓ ações 100% autônomas — na FONTE que o front já lê
--
-- Caio 2026-06-25 (2ª passada): a aba Auditoria continuava mostrando RECOMENDOU /
-- NÃO RODOU / LANÇOU-por-operador. Motivo: o front lê DIRETO as views por-agente
-- `v_ressarc54_auditoria` e `v_agente_extravio_auditoria` (ver prompts
-- lovable-ressarc54-auditoria-e-banner.md / lovable-extravios-auditoria-agente.md),
-- e elas retornavam TODOS os event_types. Trocar a query do front pra uma view
-- nova (mig 273) não pegou no Lovable.
--
-- Fix definitivo e sem dependência de front: FILTRAR as próprias views que o
-- front já consome pra só execução autônoma. Mesmas colunas de antes (não quebra
-- o select do front) — só muda o WHERE.
--   - v_ressarc54_auditoria: só `RessarcRelancar54Lancou` E NÃO por operador
--     (payload.por_operador IS NOT TRUE). por_operador=TRUE = humano aprovou → fora.
--   - v_agente_extravio_auditoria: só `AgenteExtravioLancou49`.
--
-- As MÉTRICAS (v_ressarc54_metricas / v_agente_extravio_metricas) NÃO mudam —
-- continuam contando recomendadas/nao_rodou/por-operador pro track-record. O
-- histórico completo segue em card_events. Se um dia quiser revisar as
-- recomendações em shadow, criar uma view/aba própria — a Auditoria é só autônomo.
--
-- Supersede a mig 273 (v_auditoria_acoes_autonomas) — agora redundante: removida.
-- security_invoker=on + GRANT mantidos.
-- =============================================================================

DROP VIEW IF EXISTS public.v_auditoria_acoes_autonomas;

-- ----------------------------------------------------------------------------
-- Ressarcimento 54 — só lançamento AUTÔNOMO do agente
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_ressarc54_auditoria;
CREATE VIEW public.v_ressarc54_auditoria
WITH (security_invoker = on) AS
SELECT
  ce.id AS event_id,
  ce.card_id,
  c.nf,
  c.assigned_operator_id,
  c.responsavel_relacionamento AS operador,
  ce.event_type,
  (ce.payload->>'tier') AS tier,
  (ce.payload->>'por_operador')::boolean AS por_operador,
  'Agente RELANÇOU a oc 54 automaticamente (round-trip de ressarcimento, tier '
    || COALESCE(ce.payload->>'tier','?') || ')' AS descricao,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'RessarcRelancar54Lancou'
  AND (ce.payload->>'por_operador')::boolean IS NOT TRUE
ORDER BY ce.created_at DESC;

GRANT SELECT ON public.v_ressarc54_auditoria TO authenticated, service_role;

COMMENT ON VIEW public.v_ressarc54_auditoria IS
  'Aba Auditoria (ressarc54): SÓ lançamento 100% autônomo do agente. Exclui '
  'recomendou/nao_rodou/lançou-por-operador. Track-record completo em '
  'v_ressarc54_metricas; histórico em card_events.';

-- ----------------------------------------------------------------------------
-- Extravio 49 — só lançamento autônomo da oc 49
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_agente_extravio_auditoria;
CREATE VIEW public.v_agente_extravio_auditoria
WITH (security_invoker = on) AS
SELECT
  ce.id AS event_id,
  ce.card_id,
  c.nf,
  c.assigned_operator_id,
  c.responsavel_relacionamento AS operador,
  ce.event_type,
  'Agente lançou a oc 49 (PRAZO DE PERDAS EXPIRADO) automaticamente' AS descricao,
  (ce.payload->>'oc_achada')::int AS oc_achada,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'AgenteExtravioLancou49'
ORDER BY ce.created_at DESC;

GRANT SELECT ON public.v_agente_extravio_auditoria TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_extravio_auditoria IS
  'Aba Auditoria (extravio49): SÓ lançamento autônomo da oc 49. Exclui '
  'recomendou/nao_rodou. Track-record completo em v_agente_extravio_metricas; '
  'histórico em card_events.';

NOTIFY pgrst, 'reload schema';
