-- ============================================================================
-- Cockpit v2 — colunas tracking do agente-sugere-ocs-padrao (oc=10/11/19/35)
-- Caio 2026-05-23
--
-- Espelha mig 147 (analise_oc13_*) pra um agente IA NÃO-autônomo (só sugere
-- próxima ação pro operador aprovar — nunca age sozinho).
--
-- Universo: TODOS os clientes/operadores (sem allowlist de exceção).
-- Cron 5min varre cards AVH+lock + cod_ultima_ocorrencia ∈ (10,11,19,35) +
-- criados <6h + sem análise ainda.
--
-- skill: supabase-postgres-best-practices
--   * IF NOT EXISTS pra idempotência
--   * CHECK constraint cobrindo NULL (estado inicial)
--   * Index parcial só pros cards alvo do cron
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS analise_padrao_status text
    CHECK (analise_padrao_status IS NULL OR analise_padrao_status IN ('pendente','analisando','concluida','falhou')),
  ADD COLUMN IF NOT EXISTS analise_padrao_resultado jsonb,
  ADD COLUMN IF NOT EXISTS analise_padrao_tentativas int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analise_padrao_atualizado_em timestamptz;

COMMENT ON COLUMN public.cards.analise_padrao_status IS
  'Status do agente-sugere-ocs-padrao (oc=10/11/19/35). NULL=ainda não analisado. '
  'pendente/analisando/concluida/falhou. Caio 2026-05-23.';
COMMENT ON COLUMN public.cards.analise_padrao_resultado IS
  'Resultado JSON: {proposta_destacada (54|56), motivo_extraido, template_email_sugerido, '
  'corpo_email_sugerido, foto_classificacao, tem_ressalva, ressalva_texto, '
  'tem_cte_devolucao (oc=35), confianca}';

CREATE INDEX IF NOT EXISTS idx_cards_analise_padrao_pendente
  ON public.cards (analise_padrao_atualizado_em NULLS FIRST)
  WHERE cod_ultima_ocorrencia IN (10, 11, 19, 35)
    AND (analise_padrao_status IS NULL OR analise_padrao_status IN ('pendente','falhou','analisando'));
