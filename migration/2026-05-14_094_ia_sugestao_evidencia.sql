-- ============================================================================
-- Cockpit v2 — Cache 24h da análise de evidência via IA Vision
-- Data: 2026-05-14
--
-- Caio 2026-05-14: feature "🔍 Interpretar Evidência" no histórico SSW chama
-- Claude Sonnet 4.6 Vision (edge `interpretador-evidencia-foto`) — 15s por
-- análise + custo ~$0.01. Hoje toda vez que Larissa abre o mesmo card e
-- clica "Interpretar" novamente, paga de novo.
--
-- Solução: cachear o resultado por (card_id, codigo_oc) por 24h, mesmo
-- padrão do `historico_ssw` (migrations 085/086). Larissa pode forçar
-- refresh apertando o botão de novo (cache é só pra evitar re-cliques
-- automáticos / re-abertura do card no mesmo dia).
--
-- Schema:
--   - ia_sugestao_evidencia jsonb: objeto indexado por codigo_oc. Cada entrada
--     tem { analise, atualizado_em }. Permite cachear multiplas ocs do mesmo
--     card sem colidir. Ex:
--       {
--         "10": { "atualizado_em": "...", "analise": { ... } },
--         "49": { "atualizado_em": "...", "analise": { ... } }
--       }
--   - ia_sugestao_evidencia_atualizado_em timestamptz: timestamp do registro
--     MAIS RECENTE dentro do objeto. Permite cleanup eficiente via WHERE.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS ia_sugestao_evidencia jsonb,
  ADD COLUMN IF NOT EXISTS ia_sugestao_evidencia_atualizado_em timestamptz;

COMMENT ON COLUMN public.cards.ia_sugestao_evidencia IS
  'Caio 2026-05-14: cache do interpretador-evidencia-foto (Claude Vision). '
  'Objeto indexado por codigo_oc (string), cada entrada tem { analise, '
  'atualizado_em }. Expira em 24h via cron cleanup. Larissa pode forçar '
  'refresh re-clicando o botão.';

COMMENT ON COLUMN public.cards.ia_sugestao_evidencia_atualizado_em IS
  'Timestamp do registro mais recente dentro de ia_sugestao_evidencia. Usado '
  'pelo cron de cleanup 24h pra zerar a coluna inteira quando todos os '
  'registros expiraram.';

-- Índice parcial pra cleanup rápido: só linhas com cache não-nulo entram.
CREATE INDEX IF NOT EXISTS idx_cards_ia_sugestao_evidencia_atualizado_em
  ON public.cards(ia_sugestao_evidencia_atualizado_em)
  WHERE ia_sugestao_evidencia IS NOT NULL;

-- ============================================================================
-- Cron de cleanup — zera cache após 24h
-- ============================================================================

SELECT cron.unschedule('cleanup-ia-sugestao-evidencia-every-hour')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-ia-sugestao-evidencia-every-hour');

SELECT cron.schedule(
  'cleanup-ia-sugestao-evidencia-every-hour',
  '15 * * * *',  -- minuto 15 de cada hora (desencaixa do cleanup historico_ssw em 0)
  $$
  UPDATE public.cards
  SET ia_sugestao_evidencia = NULL,
      ia_sugestao_evidencia_atualizado_em = NULL
  WHERE ia_sugestao_evidencia_atualizado_em IS NOT NULL
    AND ia_sugestao_evidencia_atualizado_em < now() - interval '24 hours';
  $$
);
