-- =============================================================================
-- REVERSÃO 2026-07-23 — Caio restringiu o escopo do retroativo DEPOIS da
-- execução: "apenas cards que estejam em AGUARDANDO CLIENTE e que não foram
-- puxados para CLIENTE RESPONDEU". Dos 237 reabertos, 232 vieram de
-- TRANSFERIDO/RESOLVIDO → voltam pro estado de origem. Os 5 de
-- AGUARDANDO_CLIENTE (incl. NF 73220) FICAM. Classe 1 (16 oc59 →
-- AGUARDANDO_CLIENTE) fica — é exatamente o estado que o Caio descreveu.
--
-- Segurança verificada antes: 0 ações de operador nos 232; 20 cards com
-- todos novos do cron-ia (cancelados aqui); 6 com ia_sugestao (zerada).
-- Cada reversão ganha card_event de auditoria (ciclo completo rastreável).
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _rev AS
SELECT e.card_id, e.payload->>'state_anterior' AS state_anterior, e.created_at AS reaberto_em
FROM card_events e
WHERE e.event_type = 'RetroativoRespostaClienteDestravada'
  AND e.actor_id = 'retroativo-2026-07-23'
  AND e.payload->>'state_anterior' IN ('TRANSFERIDO', 'RESOLVIDO');

SELECT 'alvo da reversão' AS resumo, count(*) FROM _rev;

-- Guard: nenhum com ação de operador depois da reabertura (se aparecer, abortar)
SELECT 'GUARD ações de operador pós-reabertura (deve ser 0)' AS resumo, count(DISTINCT r.card_id)
FROM _rev r JOIN card_events e2 ON e2.card_id = r.card_id
  AND e2.created_at > r.reaberto_em
  AND e2.event_type IN ('AprovacaoOperador', 'AcaoExecutada');

-- Cancela propostas que o cron-ia criou na janela reaberta
UPDATE todos t
SET status = 'cancelado'
FROM _rev r
WHERE t.card_id = r.card_id AND t.status = 'pendente' AND t.created_at > r.reaberto_em;

-- Volta o card pro estado de origem
UPDATE cards c
SET state = r.state_anterior,
    lock_aguardando_validacao = false,
    cliente_respondeu_em = NULL,
    ia_sugestao_oc_resposta = NULL
FROM _rev r
WHERE c.id = r.card_id;

INSERT INTO card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT r.card_id, 'RetroativoRevertidoPorEscopo', 'system', 'retroativo-2026-07-23',
       jsonb_build_object(
         'motivo', 'Caio restringiu o escopo do retroativo (23/07): apenas cards de AGUARDANDO_CLIENTE. Card volta pro estado de origem; respostas seguem visíveis na aba Mensagens.',
         'state_restaurado', r.state_anterior,
         'reaberto_em', r.reaberto_em)
FROM _rev r;

SELECT 'FINAL revertidos' AS resumo, count(*) FROM _rev
UNION ALL
SELECT 'FINAL mantidos (AGUARDANDO_CLIENTE de origem)', count(*)
FROM card_events WHERE event_type='RetroativoRespostaClienteDestravada'
  AND actor_id='retroativo-2026-07-23' AND payload->>'state_anterior'='AGUARDANDO_CLIENTE';

COMMIT;
