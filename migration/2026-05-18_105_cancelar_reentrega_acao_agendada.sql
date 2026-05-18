-- ============================================================================
-- Cockpit v2 — extende acoes_agendadas pra suportar cancelamento automático
-- de reentrega no SSW (opção 450) 24h após lançamento da oc=21
-- Data: 2026-05-18
--
-- Caso de uso: quando insucesso de entrega por culpa da Sal e cliente libera
-- reentrega mas se nega a pagar, operador marca checkbox no modal oc=21 →
-- executor agenda ação aqui → cron diário processa em 24-48h → SSW interno
-- localiza CT-e de reentrega complementar e cancela via opção 450.
--
-- Componentes:
--   1. CHECK constraint estendido pra incluir tipo='cancelar_reentrega_ssw'
--   2. View v_cancelamentos_reentrega pra monitoramento no Cockpit
--
-- Reusa infra existente: tabela acoes_agendadas (migration 2026-05-01_035),
-- edge function processar-acoes-agendadas (cron 12h UTC daily).
-- ============================================================================

-- ----- 1. CHECK constraint estendido --------------------------------------

ALTER TABLE public.acoes_agendadas
  DROP CONSTRAINT IF EXISTS acoes_agendadas_tipo_check;

ALTER TABLE public.acoes_agendadas
  ADD CONSTRAINT acoes_agendadas_tipo_check
  CHECK (tipo IN ('cobranca_email', 'cancelar_reentrega_ssw'));

-- ----- 2. View de monitoramento -------------------------------------------

CREATE OR REPLACE VIEW public.v_cancelamentos_reentrega AS
SELECT
  aa.id,
  aa.card_id,
  c.nf,
  c.ctrc AS ctrc_original,
  aa.executar_em,
  aa.processed_at,
  aa.status,
  aa.cancelado_motivo,
  aa.payload->>'operador_nome'  AS operador,
  aa.payload->>'lancamento_em'  AS oc21_lancada_em,
  aa.payload->>'ctrc_cancelado' AS ctrc_reentrega_cancelado,
  aa.created_at AS agendado_em
FROM public.acoes_agendadas aa
JOIN public.cards c ON c.id = aa.card_id
WHERE aa.tipo = 'cancelar_reentrega_ssw'
ORDER BY aa.created_at DESC;

GRANT SELECT ON public.v_cancelamentos_reentrega TO authenticated, service_role;

COMMENT ON VIEW public.v_cancelamentos_reentrega IS
  'Caio 2026-05-18: visibilidade de cancelamentos automáticos de reentrega '
  '(oc=21 + checkbox 24h). Estados: pendente=aguardando cron, processado=ok no SSW, '
  'cancelado=falha definitiva (CTRC não emitido ou SSW rejeitou após 3 retries).';
