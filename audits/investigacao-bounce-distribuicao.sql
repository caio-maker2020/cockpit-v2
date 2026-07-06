-- ============================================================================
-- INVESTIGAÇÃO A (READ-ONLY) — por que e-mails do Cockpit estão sendo bloqueados
-- Caio 2026-07-01 (a partir dos casos NF 575330 HDL / Larissa e NF 5620 MIX MOTO / Duilio)
--
-- OBJETIVO: separar SISTÊMICO vs ISOLADO ANTES de mexer em DNS/DKIM/conteúdo.
-- Decisor:
--   * concentra num OPERADOR   → conta/caixa/domínio remetente dele (SPF/DKIM/reputação)
--   * concentra em DOMÍNIOS Microsoft/Exchange → receptor rígido (H1/H4)
--   * espalhado por vários      → conteúdo/template (H2) OU domínio remetente global
--
-- LEITURA: as hipóteses A (SPF/DKIM/DMARC vs conteúdo vs isolado) seguem NÃO
-- CONFIRMADAS. Estas queries só medem a DISTRIBUIÇÃO; a prova da causa exige o
-- cabeçalho `Authentication-Results` cru de ≥1 bounce (ver Q7).
--
-- skill: supabase-postgres-best-practices
--   * Tudo em transação READ ONLY (nada muta). Filtro `ultimo_bounce_em IS NOT
--     NULL` usa o índice parcial idx_cards_ultimo_bounce_recente (mig 187).
--
-- NOTA: `fonte`/`destinatario` só ficam confiáveis em bounces processados pelo
-- parser NOVO (pós-deploy). Rows antigas podem ter destinatario NULL (parser
-- antigo falhava) — isso é, por si, um sinal de "quantos vinham garbage".
-- ============================================================================

BEGIN;
SET TRANSACTION READ ONLY;

-- Q1 — Volume e janela dos bounces (é spike recente ou baseline?)
SELECT
  count(*)                                   AS total_bounces,
  min(ultimo_bounce_em)                      AS primeiro,
  max(ultimo_bounce_em)                      AS ultimo,
  count(*) FILTER (WHERE ultimo_bounce_em > now() - interval '7 days')  AS ult_7d,
  count(*) FILTER (WHERE ultimo_bounce_em > now() - interval '30 days') AS ult_30d
FROM public.cards
WHERE ultimo_bounce_em IS NOT NULL;

-- Q2 — Por OPERADOR (concentra em quem? → aponta pra caixa/domínio remetente dele)
SELECT
  coalesce(o.nome, '(sem operador)')         AS operador,
  o.email                                    AS operador_email,
  count(*)                                   AS bounces,
  count(DISTINCT split_part(c.ultimo_bounce_payload->>'destinatario', '@', 2))
                                             AS dominios_destino_distintos
FROM public.cards c
LEFT JOIN public.operadores o ON o.id = c.assigned_operator_id
WHERE c.ultimo_bounce_em IS NOT NULL
GROUP BY o.nome, o.email
ORDER BY bounces DESC;

-- Q3 — Por DOMÍNIO DE DESTINO (concentra em Microsoft/Exchange? → receptor rígido)
SELECT
  lower(split_part(ultimo_bounce_payload->>'destinatario', '@', 2)) AS dominio_destino,
  count(*)                                                          AS bounces,
  count(DISTINCT assigned_operator_id)                             AS operadores_distintos
FROM public.cards
WHERE ultimo_bounce_em IS NOT NULL
GROUP BY 1
ORDER BY bounces DESC;

-- Q4 — Série temporal por dia (detecta início/pico do problema)
SELECT
  date_trunc('day', ultimo_bounce_em)::date  AS dia,
  count(*)                                    AS bounces
FROM public.cards
WHERE ultimo_bounce_em IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC
LIMIT 45;

-- Q5 — Motivo classificado por palavra-chave (spam vs outros)
SELECT
  CASE
    WHEN ultimo_bounce_payload->>'motivo_smtp' IS NULL              THEN '(sem motivo)'
    WHEN ultimo_bounce_payload->>'motivo_smtp' ~* 'spam'           THEN 'spam'
    WHEN ultimo_bounce_payload->>'motivo_smtp' ~* 'block|denied|reject|banned' THEN 'blocked/denied'
    WHEN ultimo_bounce_payload->>'motivo_smtp' ~* 'quota|full|mailbox' THEN 'mailbox cheio'
    WHEN ultimo_bounce_payload->>'motivo_smtp' ~ '[0-9a-fA-F]{16,}' THEN 'BLOB HEX (parser antigo)'
    ELSE 'outro'
  END                                         AS categoria_motivo,
  count(*)                                    AS bounces
FROM public.cards
WHERE ultimo_bounce_em IS NOT NULL
GROUP BY 1
ORDER BY bounces DESC;

-- Q6 — Por FONTE do parser novo (delivery-status / texto / nenhuma / null=antigo)
SELECT
  coalesce(ultimo_bounce_payload->>'fonte', '(pré-parser-novo)') AS fonte,
  count(*)                                                       AS bounces
FROM public.cards
WHERE ultimo_bounce_em IS NOT NULL
GROUP BY 1
ORDER BY bounces DESC;

-- Q7 — LISTA pra puxar o RAW do bounce (via Edge Function bounce-forensics ou
-- Gmail users.messages.get?format=raw na caixa do operador).
-- CUIDADO (Caio): o `Authentication-Results` DO BOUNCE **não é prova sozinho** —
-- ele descreve o hop mailer-daemon→nossa caixa, NÃO o nosso envio. A causa A
-- (SPF/DKIM/DMARC) só se crava com: (a) `Diagnostic-Code`/diagnóstico REMOTO do
-- servidor do cliente, OU (b) os headers do e-mail ORIGINAL anexado
-- (DKIM-Signature + Authentication-Results/spf/dmarc gerados pelo receptor).
-- É exatamente o que parseBounceForensics separa em `original` vs `bounce_headers`.
SELECT
  c.nf,
  o.nome                                        AS operador,
  o.email                                       AS caixa_remetente,
  c.ultimo_bounce_em,
  c.ultimo_bounce_payload->>'destinatario'      AS destinatario,
  c.ultimo_bounce_payload->>'motivo_smtp'       AS motivo,
  c.ultimo_bounce_payload->>'gmail_message_id'  AS gmail_message_id
FROM public.cards c
LEFT JOIN public.operadores o ON o.id = c.assigned_operator_id
WHERE c.ultimo_bounce_em IS NOT NULL
ORDER BY c.ultimo_bounce_em DESC
LIMIT 30;

ROLLBACK;  -- read-only: garante zero efeito colateral
