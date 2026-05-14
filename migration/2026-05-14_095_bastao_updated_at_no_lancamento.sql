-- ============================================================================
-- Cockpit v2 — Coluna bastao_updated_at_no_lancamento (versão robusta da
-- guarda contra reabertura por sync que re-importa o mesmo snapshot)
-- Data: 2026-05-14
--
-- Caio 2026-05-14 (refinamento NF 1075381 vs cenário Operação re-tratativa):
--
-- Guarda anterior (migration 074 + sync-bastao): comparava só
-- `Bastão.oc === card.bastao_oc_no_lancamento`. Funciona pro caso "sync
-- re-importa o MESMO snapshot que originou o card" (cenário 1: Bastão
-- ainda mostra 49 da atualização das 14h14). MAS quebra no cenário 2:
-- Operação devolve com 49 NOVA (atualização das 16h14, mesma oc) — guarda
-- antiga bloqueava reabertura, perdendo rastreabilidade da NF.
--
-- Discriminador correto: `pendencia.updated_at` do Bastão (timestamp da
-- atualização do registro). Cada update do RPA Bastão gera novo updated_at.
-- Mesmo snapshot = mesmo updated_at. Nova tratativa = novo updated_at.
--
-- Guarda nova (combinada como defesa em profundidade):
--   bloquear = (pendencia.updated_at === card.bastao_updated_at_no_lancamento)
--           AND (pendencia.oc === card.bastao_oc_no_lancamento)
--
-- Só bloqueia se AMBOS batem. Qualquer divergência → snapshot novo → reabre.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS bastao_updated_at_no_lancamento timestamptz;

COMMENT ON COLUMN public.cards.bastao_updated_at_no_lancamento IS
  'Caio 2026-05-14: timestamp do pendencia.updated_at do Bastão NO momento '
  'do lançamento de oc pelo executor. Usado pela guarda anti-reabertura no '
  'Pass A do sync-bastao em conjunto com bastao_oc_no_lancamento. Só bloqueia '
  'reabertura se Bastão re-importar o MESMO snapshot exato (updated_at + oc '
  'idênticos). Atualização nova do Bastão (mesmo com mesma oc) gera novo '
  'updated_at e libera reabertura — preserva rastreabilidade quando Operação '
  'devolve a mesma oc após tratativa nova.';

-- Não precisa de índice — campo só é lido junto com a linha do card no Pass A
-- via SELECT por id. Lookup já é PK.
