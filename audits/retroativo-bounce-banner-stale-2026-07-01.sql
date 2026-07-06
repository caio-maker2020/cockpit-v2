-- ============================================================================
-- RETROATIVO — limpar banner de bounce STALE (outbound posterior ao bounce)
-- Caio 2026-07-01 (refino do item 4b)
--
-- CONTEXTO: o banner "EMAIL BLOQUEADO" fica em pé enquanto `ultimo_bounce_em`
-- não-nulo E cliente não respondeu. A regra nova no gmail-poll-inbox (item 4b)
-- só reconcilia quando um bounce é (RE)PROCESSADO por aquele poll — mas bounces
-- já processados foram marcados como lidos e NÃO voltam a ser listados. Logo,
-- cards cujo banner já estava registrado (ex.: HDL, NF 575330) e que depois
-- receberam um novo envio NÃO seriam limpos pelo runtime. Este sweep faz a
-- limpeza retroativa: zera `ultimo_bounce_*` de todo card onde já existe um
-- outbound MAIS NOVO que o bounce → banner obsoleto.
--
-- skill: supabase-postgres-best-practices
--   * JOIN em cards_emails_outbound (idx idx_emails_outbound_card_id) + filtro
--     `ultimo_bounce_em IS NOT NULL` (índice parcial idx_cards_ultimo_bounce_recente).
--   * Idempotente: depois de zerar, `ultimo_bounce_em IS NULL` → não reaparece.
--   * Event sourcing (convenção nº 1/3): evento BounceBannerLimpoRetroativo por
--     card em card_events (append-only).
--
-- COMO RODAR: BLOCO 1 (preview) → confere → BLOCO 2 (transação) → COMMIT/ROLLBACK.
-- Rodar DEPOIS do retroativo de hex (ordem não crítica, são ortogonais).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1 — PREVIEW (read-only): quais banners seriam limpos?
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  c.id,
  c.nf,
  o.nome                       AS operador,
  c.ultimo_bounce_em,
  max(e.sent_at)               AS ultimo_outbound,
  count(e.id)                  AS outbounds_posteriores
FROM public.cards c
JOIN public.cards_emails_outbound e
  ON e.card_id = c.id AND e.sent_at > c.ultimo_bounce_em
LEFT JOIN public.operadores o ON o.id = c.assigned_operator_id
WHERE c.ultimo_bounce_em IS NOT NULL
GROUP BY c.id, c.nf, o.nome, c.ultimo_bounce_em
ORDER BY c.ultimo_bounce_em DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2 — CORREÇÃO (transacional). Rode, confira o COUNT, aí COMMIT/ROLLBACK.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

WITH stale AS (
  SELECT
    c.id,
    c.ultimo_bounce_em,
    max(e.sent_at) AS ultimo_outbound
  FROM public.cards c
  JOIN public.cards_emails_outbound e
    ON e.card_id = c.id AND e.sent_at > c.ultimo_bounce_em
  WHERE c.ultimo_bounce_em IS NOT NULL
  GROUP BY c.id, c.ultimo_bounce_em
),
upd AS (
  UPDATE public.cards c
  SET ultimo_bounce_em = NULL,
      ultimo_bounce_payload = NULL
  FROM stale s
  WHERE c.id = s.id
  RETURNING c.id, s.ultimo_bounce_em AS bounce_antigo, s.ultimo_outbound
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  u.id,
  'BounceBannerLimpoRetroativo',
  'system',
  'retroativo-banner-stale-2026-07-01',
  jsonb_build_object(
    'ultimo_bounce_em_antigo', u.bounce_antigo,
    'ultimo_outbound', u.ultimo_outbound,
    'razao', 'outbound posterior ao bounce — banner obsoleto (item 4b)'
  )
FROM upd u
RETURNING card_id;   -- COUNT deve bater com o preview do BLOCO 1

-- Confira acima. Depois:
--   COMMIT;   -- aplica
--   ROLLBACK; -- desfaz
