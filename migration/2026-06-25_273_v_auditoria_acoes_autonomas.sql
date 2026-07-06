-- =============================================================================
-- v_auditoria_acoes_autonomas — fonte canônica da aba AUDITORIA
-- ("SNAPSHOTS CONGELADOS DE AÇÕES AUTÔNOMAS")
--
-- Caio 2026-06-25: a aba Auditoria mostrava TUDO que os agentes faziam —
-- "RECOMENDOU" (só sugestão, espera humano), "NÃO RODOU" (não agiu) e até
-- "LANÇOU (operador)" (operador aprovou → Cockpit lançou). O subtítulo da tela
-- é "AÇÕES AUTÔNOMAS": deve listar SÓ o que o agente executou 100% sozinho.
--
-- Definição canônica de "100% autônomo" (vive aqui, no SQL, pra tela não driftar):
--   - Ressarc 54: event_type='RessarcRelancar54Lancou' E NÃO foi por operador
--     (payload.por_operador IS NOT TRUE). O caso por_operador=TRUE é lançamento
--     aprovado por humano (creditado pela mig 271) → NÃO é autônomo, fica de fora.
--   - Extravio 49: event_type='AgenteExtravioLancou49' (o agente lança via
--     envelope após a pré-checagem do SSW; toda linha desse event é execução
--     autônoma).
--
-- Recomendou / NaoRodou / ReportadoErrado continuam em v_ressarc54_auditoria e
-- v_agente_extravio_auditoria (timeline completa por agente) — esta view NÃO os
-- inclui de propósito. Novo agente autônomo no futuro = adicionar um UNION aqui.
--
-- security_invoker=on → RLS de cards aplica (operador vê só os seus; gestor vê
-- todos). GRANT explícito (INV: policy/view nova exige GRANT junto).
-- =============================================================================

DROP VIEW IF EXISTS public.v_auditoria_acoes_autonomas;
CREATE VIEW public.v_auditoria_acoes_autonomas
WITH (security_invoker = on) AS
SELECT
  ce.id                              AS event_id,
  ce.card_id,
  c.nf,
  c.ctrc,
  c.empresa_cliente,
  c.assigned_operator_id,
  c.responsavel_relacionamento       AS operador,
  'ressarcimento_54'::text           AS agente,
  ce.event_type,
  54                                 AS oc,
  (ce.payload->>'tier')              AS tier,
  'LANÇOU 54'::text                  AS acao_label,
  'Agente RELANÇOU a oc 54 automaticamente (round-trip de ressarcimento, tier '
    || COALESCE(ce.payload->>'tier','?') || ')' AS descricao,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'RessarcRelancar54Lancou'
  AND (ce.payload->>'por_operador')::boolean IS NOT TRUE

UNION ALL

SELECT
  ce.id                              AS event_id,
  ce.card_id,
  c.nf,
  c.ctrc,
  c.empresa_cliente,
  c.assigned_operator_id,
  c.responsavel_relacionamento       AS operador,
  'extravio_49'::text                AS agente,
  ce.event_type,
  49                                 AS oc,
  NULL::text                         AS tier,
  'LANÇOU OC49'::text                AS acao_label,
  'Agente lançou a oc 49 (PRAZO DE PERDAS EXPIRADO) automaticamente' AS descricao,
  ce.payload,
  ce.created_at
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'AgenteExtravioLancou49'

ORDER BY created_at DESC;

GRANT SELECT ON public.v_auditoria_acoes_autonomas TO authenticated, service_role;

COMMENT ON VIEW public.v_auditoria_acoes_autonomas IS
  'Fonte canônica da aba Auditoria: SÓ ações 100% autônomas (agente executou '
  'sozinho). Exclui RECOMENDOU, NÃO RODOU e LANÇOU-por-operador. Novo agente '
  'autônomo = novo UNION ALL aqui.';
