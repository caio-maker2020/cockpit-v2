-- Migration 096: snapshot da bastao_pendencia_id no momento do lançamento.
--
-- CONTEXTO (Caio 2026-05-14):
-- A guarda combinada `(bastao_oc_no_lancamento, bastao_updated_at_no_lancamento)`
-- criada na migration 095 é insuficiente. O Bastão cria novas pendencia_id
-- a cada observação RPA, mesmo sem mudança semântica no SSW. Resultado: o
-- updated_at avança sem haver re-tratativa real e o guard falha.
--
-- Regra correta (Caio 2026-05-14): "A MESMA atualização do Bastão não pode
-- recriar cards. Só a próxima atualização pode reabrir."
--
-- Discriminador correto = `bastao_pendencia_id`. Cada atualização do Bastão
-- tem id único. Comparar (id_no_lancamento == id_atual) é critério
-- semanticamente correto pra dizer "mesma atualização".
--
-- USO:
-- - Executor preenche no momento do lançamento.
-- - Pass A de sync-bastao usa pra decidir se reabre ou faz no-op.
-- - Cleanup pós-confirmação SSW (Pass G/H) NÃO limpa — preserva como
--   referência histórica.
--
-- BACKFILL:
-- Cards que JÁ têm bastao_oc_no_lancamento != null mas bastao_pendencia_id_no_lancamento
-- ainda null recebem o valor atual de bastao_pendencia_id. Premissa: se SSW
-- já confirmou o lançamento e Bastão não criou pendência nova ainda, o id
-- atual é o id do lançamento. Para os 4 cards travados em loop hoje (NF
-- 20958, 177817, 1074810, 1005270), o cleanup explícito vem em script
-- separado — esse backfill genérico cobre cards futuros que possam ter
-- ficado em estado transitório.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS bastao_pendencia_id_no_lancamento uuid;

COMMENT ON COLUMN cards.bastao_pendencia_id_no_lancamento IS
  'Snapshot da bastao_pendencia_id no momento que o executor lançou oc no SSW. Usado pelo Pass A de sync-bastao pra decidir se a atualização atual do Bastão é a MESMA do lançamento (=NO-OP) ou uma nova (=avalia reabertura). Regra Caio 2026-05-14: mesma atualização do Bastão não pode recriar card.';

-- Backfill conservador: só cards lançados recentemente cujo pendência id atual
-- bate semanticamente com o lançamento. Como heurística pragmática usamos os
-- cards com bastao_oc_no_lancamento != null que ainda não foram pegos por
-- novo ciclo do Bastão. Cards em loop hoje ficam pra cleanup explícito.
UPDATE cards
SET bastao_pendencia_id_no_lancamento = bastao_pendencia_id
WHERE bastao_oc_no_lancamento IS NOT NULL
  AND bastao_pendencia_id IS NOT NULL
  AND bastao_pendencia_id_no_lancamento IS NULL;
