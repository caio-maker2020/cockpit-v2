-- ============================================================================
-- Cockpit v2 — State do card segue responsabilidade da última ocorrência
-- Data: 2026-04-30
--
-- Bug raiz: o Pass A do sync-bastao atualizava cod_ultima_ocorrencia mas
-- NUNCA recalculava state. Cards criados com oc=20 (Relacionamento) ficavam
-- em AGUARDANDO_AGENTE pra sempre, mesmo quando a oc virava 54 (Cliente)
-- ou 55 (Operação) no Bastão.
--
-- Caso reportado por Caio em 2026-04-30: 10 cards com oc=54 aparecendo na
-- aba "PARA FAZER" da Larissa. Premissa correta: PARA FAZER (state=
-- AGUARDANDO_AGENTE) só pra cards onde a última oc é responsabilidade do
-- Relacionamento. Senão o card precisa estar em AGUARDANDO_CLIENTE
-- (responsabilidade=Cliente) ou TRANSFERIDO (Operação/Devolução/etc).
--
-- 1. Função pública `state_pela_responsabilidade(cod)` — única fonte da
--    verdade pra esse mapeamento. Usada no backfill abaixo, no sync-bastao
--    (após deploy) e em qualquer outro lugar que precisar.
-- 2. Backfill: cards "passivos" (AGUARDANDO_AGENTE/CLIENTE/CONTEXTO etc)
--    sem lock são reclassificados pelo dicionário. Cards em estados ativos
--    (EXECUTANDO_ACAO, AGUARDANDO_VALIDACAO_HUMANA, TRATATIVA_PENDENTE,
--    BLOQUEADO_POR_ERRO, ESCALADO_HUMANO) NÃO são tocados.
-- 3. Cards em RESOLVIDO/CANCELADO/TRANSFERIDO também NÃO são tocados.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.state_pela_responsabilidade(p_cod int)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_cod IS NULL THEN 'AGUARDANDO_AGENTE'
    ELSE (
      SELECT CASE responsabilidade
        WHEN 'Cliente'        THEN 'AGUARDANDO_CLIENTE'
        WHEN 'Relacionamento' THEN 'AGUARDANDO_AGENTE'
        ELSE                       'TRANSFERIDO'
      END
      FROM public.ocorrencias_dicionario
      WHERE codigo = p_cod
    )
  END;
$$;

GRANT EXECUTE ON FUNCTION public.state_pela_responsabilidade(int) TO authenticated, service_role;

COMMENT ON FUNCTION public.state_pela_responsabilidade(int) IS
  'Mapeia codigo de ocorrencia SSW → state default do card baseado em '
  'ocorrencias_dicionario.responsabilidade. Cliente→AGUARDANDO_CLIENTE, '
  'Relacionamento→AGUARDANDO_AGENTE, demais (Operacao/Devolucao/etc)→TRANSFERIDO. '
  'Usado pelo sync-bastao Pass A pra recalcular state quando oc muda.';

-- ============================================================================
-- Backfill imediato dos cards stuck
-- ============================================================================

WITH alvo AS (
  SELECT
    c.id,
    c.state AS state_atual,
    c.cod_ultima_ocorrencia,
    public.state_pela_responsabilidade(c.cod_ultima_ocorrencia) AS state_correto
  FROM public.cards c
  WHERE c.lock_aguardando_validacao = false
    AND c.state IN (
      'AGUARDANDO_AGENTE',
      'AGUARDANDO_CLIENTE',
      'AGUARDANDO_CONTEXTO',
      'AGUARDANDO_VINCULACAO',
      'EM_TRIAGEM',
      'RECEBIDO'
    )
    AND c.cod_ultima_ocorrencia IS NOT NULL
)
UPDATE public.cards c
SET state = a.state_correto
FROM alvo a
WHERE c.id = a.id
  AND a.state_correto IS NOT NULL
  AND a.state_correto <> a.state_atual;

-- ============================================================================
-- Audit trail: registra um card_event por card alterado pelo backfill
-- (rodar separado caso a query acima tenha alterado cards)
-- ============================================================================

INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  c.id,
  'StateRecalculadoBackfill',
  'system',
  'migration_027',
  jsonb_build_object(
    'cod_ultima_ocorrencia', c.cod_ultima_ocorrencia,
    'state_atual', c.state,
    'motivo', 'Backfill: state agora segue responsabilidade da última ocorrência'
  )
FROM public.cards c
WHERE c.updated_at > now() - interval '10 seconds'
  AND c.state IN ('AGUARDANDO_CLIENTE', 'TRANSFERIDO');
