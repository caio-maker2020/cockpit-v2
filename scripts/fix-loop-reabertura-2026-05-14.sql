-- Script one-shot: cleanup retroativo dos 4 cards travados no loop
-- de reabertura descoberto em 2026-05-14 (NF 1005270, 177817, 1074810, 20958).
--
-- Causa raiz já corrigida em código:
--   1. SELECT do Pass A em sync-bastao agora inclui bastao_oc_no_lancamento +
--      bastao_updated_at_no_lancamento (antes vinham undefined).
--   2. Migration 096 + executor: novo campo bastao_pendencia_id_no_lancamento.
--   3. Pass A guard agora usa pendencia_id como discriminador (semanticamente
--      correto — refresh RPA sem mudança não muda esse id).
--
-- Este script só corrige os cards que ficaram travados antes do deploy.
-- IDEMPOTENTE: pode rodar várias vezes, só age em cards ainda travados.

BEGIN;

-- Captura snapshot dos cards afetados pra audit + emite eventos.
WITH cards_afetados AS (
  SELECT
    c.id,
    c.nf,
    c.state AS state_anterior,
    c.cod_ultima_ocorrencia,
    c.bastao_oc_no_lancamento,
    c.bastao_pendencia_id,
    -- Último evento SSW confirma que decidiu o state final do card
    (
      SELECT payload->>'state_novo'
      FROM card_events
      WHERE card_id = c.id
        AND event_type IN ('AcaoExecutadaConfirmadaPeloSsw', 'AtualizadoViaPortalSsw')
        AND created_at >= '2026-05-14 00:00:00'
      ORDER BY created_at DESC
      LIMIT 1
    ) AS state_ssw,
    (
      SELECT (payload->>'oc_ssw')::int
      FROM card_events
      WHERE card_id = c.id
        AND event_type = 'AcaoExecutadaConfirmadaPeloSsw'
        AND created_at >= '2026-05-14 00:00:00'
      ORDER BY created_at DESC
      LIMIT 1
    ) AS oc_ssw_lancada
  FROM cards c
  WHERE c.state = 'AGUARDANDO_VALIDACAO_HUMANA'
    AND c.lock_aguardando_validacao = TRUE
    AND c.bastao_oc_no_lancamento IS NOT NULL
    AND c.cod_ultima_ocorrencia = c.bastao_oc_no_lancamento
    AND c.acao_executada_em IS NULL
    AND c.bastao_synced_at > (NOW() - INTERVAL '24 hours')
),
-- Cancela todos pendentes/executando duplicados criados pelo loop
todos_cancelados AS (
  UPDATE todos
  SET status = 'cancelado',
      rejection_reason = 'Loop reabertura 2026-05-14: cancelado em cleanup retroativo (sync-bastao Pass A reabria com pendência idêntica). Larissa pode re-lançar manualmente se SSW interno não confirmou.'
  WHERE card_id IN (SELECT id FROM cards_afetados)
    AND status IN ('pendente', 'executando')
  RETURNING card_id, id, descricao
),
-- Realinha state + snapshot pendência pra que próximo sync seja NO-OP
cards_corrigidos AS (
  UPDATE cards c
  SET
    state = COALESCE(ca.state_ssw, 'TRANSFERIDO'),
    lock_aguardando_validacao = FALSE,
    -- Realinha pendencia_id_no_lancamento ao atual: próximo Pass A vê
    -- "mesma atualização" → NO-OP. Próxima atualização real do Bastão
    -- (nova pendência) seguirá lógica normal de reabertura.
    bastao_pendencia_id_no_lancamento = c.bastao_pendencia_id
  FROM cards_afetados ca
  WHERE c.id = ca.id
  RETURNING c.id, c.nf, c.state, c.cod_ultima_ocorrencia
),
-- Auditoria: 1 evento por card corrigido
eventos AS (
  INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT
    ca.id,
    'LoopReaberturaCorrigidoRetro',
    'system',
    'fix-loop-reabertura-2026-05-14',
    jsonb_build_object(
      'state_anterior', ca.state_anterior,
      'state_novo', COALESCE(ca.state_ssw, 'TRANSFERIDO'),
      'oc_card', ca.cod_ultima_ocorrencia,
      'oc_bastao_no_lancamento', ca.bastao_oc_no_lancamento,
      'oc_ssw_lancada', ca.oc_ssw_lancada,
      'bastao_pendencia_id_realinhada', ca.bastao_pendencia_id,
      'motivo', 'Loop de reabertura 2026-05-14 (Pass A SELECT não carregava bastao_oc_no_lancamento, guard combinada era letra morta). Fix em sync-bastao + migration 096 + executor. Cleanup retroativo realinha pendencia_id pra NO-OP no próximo sync.'
    )
  FROM cards_afetados ca
  RETURNING card_id
)
SELECT
  (SELECT count(*) FROM cards_afetados) AS cards_detectados,
  (SELECT count(*) FROM todos_cancelados) AS todos_cancelados,
  (SELECT count(*) FROM cards_corrigidos) AS cards_corrigidos,
  (SELECT count(*) FROM eventos) AS eventos_inseridos;

COMMIT;
