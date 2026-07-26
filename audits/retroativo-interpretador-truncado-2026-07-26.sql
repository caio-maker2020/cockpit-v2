-- =============================================================================
-- Retroativo INV-055 — cards que ficaram SEM interpretação por truncamento
-- (incidente 26/07: maxTokens=700 < resposta legítima do schema).
--
-- RODAR SOMENTE DEPOIS DO DEPLOY do interpretador corrigido — antes disso a
-- reinterpretação cortaria de novo.
--
-- Passo 1 (este arquivo): reabre o crédito de tentativas das mensagens que
-- falharam por causa do bug, gravando o marcador `InterpretadorFalhasZeradas`.
-- Sem ele, o breaker (MAX_FALHAS_LLM) veria as 100+ falhas antigas e mandaria
-- o card direto pro determinístico — o card teria "alguma coisa", mas nunca a
-- LEITURA REAL que o cliente merece. Regra do Caio: corrigir o porquê, não
-- empurrar pro operador.
--
-- Passo 2 (fora daqui): `cron-ia-resposta-pendentes` roda a cada 5 min e
-- reinterpreta sozinho os cards elegíveis (AVH/AGUARDANDO_CLIENTE/
-- ACAO_EXECUTADA). Basta esperar um ciclo e conferir com a query final.
--
-- Idempotente: só grava marcador pra (card, mensagem) que ainda não tem um
-- marcador posterior à última falha.
-- =============================================================================

BEGIN;

WITH falhas AS (
  SELECT ce.card_id,
         ce.payload->>'message_id' AS message_id,
         count(*)      AS falhas,
         max(ce.created_at) AS ultima_falha
  FROM card_events ce
  WHERE ce.event_type = 'InterpretadorRespostaClienteFalhou'
    AND ce.created_at >= '2026-07-25T00:00:00-03'
    AND ce.payload->>'message_id' IS NOT NULL
  GROUP BY 1, 2
),
ja_zeradas AS (
  SELECT ce.card_id, ce.payload->>'message_id' AS message_id, max(ce.created_at) AS zerado_em
  FROM card_events ce
  WHERE ce.event_type = 'InterpretadorFalhasZeradas'
  GROUP BY 1, 2
),
alvo AS (
  SELECT f.*
  FROM falhas f
  LEFT JOIN ja_zeradas z ON z.card_id = f.card_id AND z.message_id = f.message_id
  JOIN cards c ON c.id = f.card_id
  WHERE (z.zerado_em IS NULL OR z.zerado_em < f.ultima_falha)
    -- só cards que o cron reinterpreta (mesma lista do cron-ia-resposta-pendentes)
    AND c.state IN ('AGUARDANDO_VALIDACAO_HUMANA', 'AGUARDANDO_CLIENTE', 'ACAO_EXECUTADA')
)
INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT a.card_id,
       'InterpretadorFalhasZeradas',
       'system',
       'retroativo-inv-055',
       jsonb_build_object(
         'message_id', a.message_id,
         'falhas_do_bug', a.falhas,
         'motivo', 'Falhas causadas pelo teto de 700 tokens (INV-055) — crédito de tentativas reaberto após o fix'
       )
FROM alvo a;

COMMIT;

-- ============================ CONFERÊNCIA =====================================
-- (rodar ~10 min depois, após o cron reinterpretar)
--
-- 1) Nenhum card elegível segue sem interpretação:
-- SELECT count(*) AS ainda_sem_sugestao FROM cards
--  WHERE cliente_respondeu_em IS NOT NULL AND ia_sugestao_oc_resposta IS NULL
--    AND state IN ('AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_CLIENTE','ACAO_EXECUTADA');
--
-- 2) Quantos ficaram com leitura degradada/parcial (deve ser 0 ou pouquíssimos):
-- SELECT count(*) FILTER (WHERE ia_sugestao_oc_resposta->>'leitura_degradada' = 'true') AS degradados,
--        count(*) FILTER (WHERE ia_sugestao_oc_resposta->>'leitura_parcial'  = 'true') AS parciais
--   FROM cards WHERE ia_sugestao_oc_resposta IS NOT NULL
--     AND (ia_sugestao_oc_resposta->>'sugerido_em')::timestamptz > now() - interval '1 hour';
--
-- 3) Loop encerrado — nenhuma mensagem remoída:
-- SELECT message_id, count(*) FROM anthropic_usage_log
--  WHERE function_name='interpretador-resposta-cliente' AND created_at > now() - interval '1 hour'
--  GROUP BY 1 HAVING count(*) > 3;
