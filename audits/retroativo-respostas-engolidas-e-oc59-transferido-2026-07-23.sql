-- =============================================================================
-- RETROATIVO 2026-07-23 — NF 73220 (LARISSA) + classes irmãs. Aprovado pelo
-- Caio 23/07 ("reabrir todas as 241"). Rodar: bash scripts/dbq.sh -f <este>
--
-- v2 (pós-ensaio com ROLLBACK): o critério da classe 2 virou POR EVENTO.
-- O executor ZERA cliente_respondeu_em ao executar ação → carimbo nulo NÃO
-- distingue "resposta engolida" de "resposta tratada e card fechado" (302
-- falso-positivos no ensaio). Resposta ENGOLIDA = captura SEM
-- RetornoClienteEmAguardo depois (marcador de processamento do vinculador),
-- SEM ação de operador depois e SEM outbound depois.
-- Guard uniq_cards_nf_active: NF com OUTRO card ativo não reabre o antigo
-- (violaria o índice parcial — ensaio quebrou na NF 23657); fica no preview.
--
-- Ordem: Classe 2 (cliente falou → AVH, cron-ia interpreta em <=1min) antes
-- da Classe 1 (sem resposta → AGUARDANDO_CLIENTE, seguem esperando retorno).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- CLASSE 2 — respostas genuinamente engolidas (14 dias, critério por evento)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _retro_respostas AS
WITH capturas AS (
  SELECT c.id AS card_id, c.nf, c.state AS state_anterior,
         max(e.created_at) AS ultima_resposta_em
  FROM card_events e
  JOIN cards c ON c.id = e.card_id
  WHERE e.event_type = 'RespostaClienteCapturada'
    AND e.created_at > now() - interval '14 days'
    AND c.state IN ('TRANSFERIDO', 'RESOLVIDO', 'AGUARDANDO_CLIENTE')
    AND c.cliente_respondeu_em IS NULL
  GROUP BY c.id, c.nf, c.state
)
SELECT cap.*,
       EXISTS (
         SELECT 1 FROM cards c2
         WHERE c2.nf = cap.nf AND c2.id <> cap.card_id
           AND c2.state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
       ) AS conflito_card_ativo,
       -- v3: dedupe intra-lote — NFs de loop (ex: 23657) têm VÁRIOS cards
       -- terminais com resposta engolida; reabrir 2 da mesma NF viola
       -- uniq_cards_nf_active. Reabre só o da resposta mais recente (rn=1).
       row_number() OVER (PARTITION BY cap.nf ORDER BY cap.ultima_resposta_em DESC) AS rn
FROM capturas cap
WHERE NOT EXISTS (
        SELECT 1 FROM card_events e2
        WHERE e2.card_id = cap.card_id AND e2.event_type = 'RetornoClienteEmAguardo'
          AND e2.created_at >= cap.ultima_resposta_em - interval '1 minute')
  AND NOT EXISTS (
        SELECT 1 FROM card_events e3
        WHERE e3.card_id = cap.card_id
          AND e3.event_type IN ('AprovacaoOperador', 'AcaoExecutada')
          AND e3.created_at >= cap.ultima_resposta_em)
  AND NOT EXISTS (
        SELECT 1 FROM cards_emails_outbound o
        WHERE o.card_id = cap.card_id AND o.sent_at >= cap.ultima_resposta_em);

SELECT 'CLASSE 2 — CONFLITO (NF já tem card ativo; NÃO reaberto, tratar na mão)' AS aviso,
       nf, state_anterior FROM _retro_respostas WHERE conflito_card_ativo;

SELECT 'CLASSE 2 — duplicata intra-lote (mesma NF; NÃO reaberto)' AS aviso, nf, state_anterior
FROM _retro_respostas WHERE rn > 1;

SELECT 'CLASSE 2 total a reabrir' AS resumo, count(*) FROM _retro_respostas WHERE NOT conflito_card_ativo AND rn = 1;

UPDATE cards c
SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
    lock_aguardando_validacao = true,
    cliente_respondeu_em = r.ultima_resposta_em,
    ia_sugestao_oc_resposta = NULL,
    acao_executada_em = NULL
FROM _retro_respostas r
WHERE c.id = r.card_id AND NOT r.conflito_card_ativo AND r.rn = 1;

INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT r.card_id, 'RetroativoRespostaClienteDestravada', 'system',
       'retroativo-2026-07-23',
       jsonb_build_object(
         'motivo', 'Resposta real de cliente estava MUDA (bug NF 73220; fix INV-042). Reaberta retroativamente pra AVH; cron-ia interpreta.',
         'state_anterior', r.state_anterior,
         'ultima_resposta_em', r.ultima_resposta_em,
         'criterio', 'v2 por evento (sem RetornoClienteEmAguardo/acao/outbound apos captura)',
         'caso_ancora', 'NF 73220 LARISSA — romaneio mudo 7 dias')
FROM _retro_respostas r
WHERE NOT r.conflito_card_ativo AND r.rn = 1;

-- ---------------------------------------------------------------------------
-- CLASSE 1 — vítimas do confirmador pré-59 ainda em TRANSFERIDO, sem resposta
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _retro_oc59 AS
SELECT DISTINCT ON (c.nf) c.id AS card_id, c.nf, c.cod_ultima_ocorrencia AS oc,
       EXISTS (
         SELECT 1 FROM cards c2
         WHERE c2.nf = c.nf AND c2.id <> c.id
           AND c2.state NOT IN ('TRANSFERIDO', 'RESOLVIDO', 'CANCELADO')
       ) AS conflito_card_ativo
FROM card_events e
JOIN cards c ON c.id = e.card_id
WHERE e.event_type = 'AcaoExecutadaConfirmadaPeloSsw'
  AND e.payload->>'state_novo' = 'TRANSFERIDO'
  AND (e.payload->>'oc_ssw') IN ('54', '59')
  AND e.created_at BETWEEN '2026-07-13' AND '2026-07-22 14:00+00'
  AND c.state = 'TRANSFERIDO'
  AND c.cod_ultima_ocorrencia IN (54, 59)
  AND c.id NOT IN (SELECT card_id FROM _retro_respostas)
  -- v3: NF que a classe 2 acabou de reativar não pode ganhar 2º card ativo
  AND c.nf NOT IN (SELECT nf FROM _retro_respostas WHERE NOT conflito_card_ativo AND rn = 1)
ORDER BY c.nf, e.created_at DESC;

SELECT 'CLASSE 1 — CONFLITO (não movido)' AS aviso, nf FROM _retro_oc59 WHERE conflito_card_ativo;
SELECT 'CLASSE 1 total → AGUARDANDO_CLIENTE' AS resumo, count(*) FROM _retro_oc59 WHERE NOT conflito_card_ativo;

UPDATE cards c
SET state = 'AGUARDANDO_CLIENTE',
    lock_aguardando_validacao = false
FROM _retro_oc59 r
WHERE c.id = r.card_id AND NOT r.conflito_card_ativo;

INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT r.card_id, 'RetroativoOc59TransferidoCorrigido', 'system',
       'retroativo-2026-07-23',
       jsonb_build_object(
         'motivo', 'Confirmador pré-59 (regressão 13-21/07, corrigida na regularização 22/07) classificou oc 54/59 como "outras" → TRANSFERIDO. Destino correto: AGUARDANDO_CLIENTE.',
         'oc', r.oc)
FROM _retro_oc59 r
WHERE NOT r.conflito_card_ativo;

SELECT 'FINAL classe 2 reabertas' AS resumo, count(*) FROM _retro_respostas WHERE NOT conflito_card_ativo AND rn = 1
UNION ALL
SELECT 'FINAL classe 2 puladas (conflito/duplicata)', count(*) FROM _retro_respostas WHERE conflito_card_ativo OR rn > 1
UNION ALL
SELECT 'FINAL classe 1 → AGUARDANDO_CLIENTE', count(*) FROM _retro_oc59 WHERE NOT conflito_card_ativo;

COMMIT;
