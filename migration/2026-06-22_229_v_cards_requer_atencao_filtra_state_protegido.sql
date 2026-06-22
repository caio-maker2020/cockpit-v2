-- =============================================================================
-- Fix aba ⚠️ CONFLITOS — só mostra cards AINDA em escopo protegido.
--
-- Caio 2026-06-22: a v_cards_requer_atencao (mig 228) filtrava só pelo flag
-- (mudanca_suspeita tipo=saiu_de_escopo + vista_em null). Mas um card podia
-- sair do escopo protegido (operador FORÇOU → TRANSFERIDO/RESOLVIDO, ou aprovou
-- proposta dentro do Cockpit → ACAO_EXECUTADA → TRANSFERIDO) e o flag ficar
-- pendurado (vista_em null) → o card continuava aparecendo na aba mesmo já
-- TRANSFERIDO. Sintoma: NF 519803 (TRANSFERIDO) seguia na lista de Conflitos.
--
-- Conserto robusto: a aba só lista cards que AINDA estão em estado protegido
-- (AGUARDANDO_VALIDACAO_HUMANA / AGUARDANDO_CLIENTE). Assim, no instante em que
-- o card sai (transferiu, finalizou, ou voltou pra fluxo normal), ele some da
-- aba — independente de o flag ter sido baixado. A aba tende sempre a 0.
-- =============================================================================

DROP VIEW IF EXISTS public.v_cards_requer_atencao;
CREATE VIEW public.v_cards_requer_atencao
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  c.state,
  c.empresa_cliente,
  c.assigned_operator_id,
  (c.mudanca_suspeita->>'de_oc')::int        AS de_oc,
  (c.mudanca_suspeita->>'para_oc')::int      AS para_oc,
  (c.mudanca_suspeita->>'para_oc')::int      AS oc_fora_escopo,
  c.mudanca_suspeita->>'de_state'            AS de_state,
  c.mudanca_suspeita->>'origem_pass'         AS origem_pass,
  (c.mudanca_suspeita->>'detectada_em')      AS detectada_em
FROM public.cards c
WHERE c.mudanca_suspeita IS NOT NULL
  AND (c.mudanca_suspeita->>'vista_em') IS NULL
  AND (c.mudanca_suspeita->>'tipo') = 'saiu_de_escopo'
  -- NOVO (mig 229): card só aparece enquanto AINDA está em escopo protegido.
  -- Saiu (TRANSFERIDO/RESOLVIDO/etc) → some da aba na hora.
  AND c.state IN ('AGUARDANDO_VALIDACAO_HUMANA', 'AGUARDANDO_CLIENTE')
ORDER BY (c.mudanca_suspeita->>'detectada_em') DESC NULLS LAST;
GRANT SELECT ON public.v_cards_requer_atencao TO authenticated, service_role;
