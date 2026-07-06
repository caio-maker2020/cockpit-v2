-- ============================================================================
-- RETROATIVO — sanear `cards.ultimo_bounce_payload.motivo_smtp` com blob hex
-- Caio 2026-07-01 (bug B, NF 575330 HDL LOGISTICA / Larissa)
--
-- CONTEXTO: o parser antigo (`/(550...)/` sobre o 1º text/plain) gravava o blob
-- de diagnóstico do MS Exchange como `motivo_smtp` (ex.: "5503238344042323531393A
-- ...:.NET 10.0.8..."). O parser novo (parse-bounce-ndr.ts) corrige daqui pra
-- frente, mas os bounces JÁ processados não re-parseiam (a mensagem no Gmail já
-- foi marcada como lida → o gmail-poll não re-lista). Este script limpa o dado
-- histórico: zera `motivo_smtp` quando ele é um blob hex, mantendo o banner vivo
-- (o front esconde só a linha do motivo; destinatário/data seguem). NÃO re-parseia
-- (não temos o corpo do bounce no banco) — só remove o garbage.
--
-- skill: supabase-postgres-best-practices
--   * Filtra `ultimo_bounce_em IS NOT NULL` PRIMEIRO → usa o índice parcial
--     idx_cards_ultimo_bounce_recente (mig 187); o regex hex roda no subconjunto
--     pequeno de cards-com-bounce, não em scan da tabela toda.
--   * Idempotente: depois do UPDATE `motivo_smtp` vira JSON null → o regex não
--     casa mais → re-rodar é no-op.
--   * Event sourcing (convenção nº 1/3): cada card saneado ganha um evento
--     `BounceMotivoSanitizado` em card_events (append-only, respeita imutabilidade).
--
-- COMO RODAR:
--   1. Rode o BLOCO 1 (preview) e confira a lista/contagem.
--   2. Rode o BLOCO 2 dentro da transação; confira o COUNT do RETURNING.
--   3. Se bater com o preview → COMMIT. Se não → ROLLBACK.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1 — PREVIEW (read-only): quais cards seriam saneados?
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  c.id,
  c.nf,
  c.pagador,
  o.nome                                        AS operador,
  c.ultimo_bounce_em,
  c.ultimo_bounce_payload->>'destinatario'      AS destinatario,
  left(c.ultimo_bounce_payload->>'motivo_smtp', 60) AS motivo_hex_atual
FROM public.cards c
LEFT JOIN public.operadores o ON o.id = c.assigned_operator_id
WHERE c.ultimo_bounce_em IS NOT NULL
  AND c.ultimo_bounce_payload->>'motivo_smtp' ~ '[0-9a-fA-F]{16,}'
ORDER BY c.ultimo_bounce_em DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2 — CORREÇÃO (transacional). Rode, confira o COUNT, aí COMMIT/ROLLBACK.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

WITH afetados AS (
  SELECT
    c.id,
    c.ultimo_bounce_payload->>'motivo_smtp' AS motivo_antigo
  FROM public.cards c
  WHERE c.ultimo_bounce_em IS NOT NULL
    AND c.ultimo_bounce_payload->>'motivo_smtp' ~ '[0-9a-fA-F]{16,}'
),
upd AS (
  UPDATE public.cards c
  SET ultimo_bounce_payload =
        jsonb_set(c.ultimo_bounce_payload, '{motivo_smtp}', 'null'::jsonb, false)
  FROM afetados a
  WHERE c.id = a.id
  RETURNING c.id, a.motivo_antigo
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  u.id,
  'BounceMotivoSanitizado',
  'system',
  'retroativo-bug-B-2026-07-01',
  jsonb_build_object(
    'motivo_smtp_antigo', u.motivo_antigo,
    'motivo_smtp_novo',   null,
    'razao', 'blob hex de diagnostico Exchange capturado pelo parser antigo; parser novo (parse-bounce-ndr) corrige daqui pra frente'
  )
FROM upd u
RETURNING card_id;   -- COUNT deste RETURNING deve bater com o preview do BLOCO 1

-- Confira acima. Depois:
--   COMMIT;   -- aplica
--   ROLLBACK; -- desfaz (se o COUNT não bater com o preview)
