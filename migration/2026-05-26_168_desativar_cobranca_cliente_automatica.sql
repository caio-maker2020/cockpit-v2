-- ============================================================================
-- 2026-05-26_168 — Desativa feature de cobrança automática de cliente
--
-- Caio 2026-05-26: feature "cobrar cliente automaticamente após 4 dias sem
-- resposta" será reavaliada. Por enquanto, parar geração de novas ações
-- e cancelar as 34 acoes_agendadas tipo `cobranca_email` presas
-- (clientes sem email cadastrado em contatos_cliente — retentavam a cada
-- 15min gerando IO desperdiçado: ~136 eventos CobrancaAdiadaSemContato/hora).
--
-- Escopo do desligamento:
--   1. cron `cobranca-cliente-aguardando-daily` (jobid=15): DESATIVADO via
--      cron.alter_job (`active=false`). Não recria via processar-cobrancas-
--      cliente-aguardando. Reativação manual quando processo for refinado.
--   2. Todas acoes_agendadas tipo='cobranca_email' status='pendente':
--      marcadas como `cancelado` com motivo administrativo. Para o ciclo
--      eterno no processar-acoes-agendadas (que continua rodando pros
--      outros tipos, ex: cancelar_reentrega_ssw).
--   3. Cron `processar-acoes-agendadas` permanece ATIVO (jobid=7) — só
--      cancelar_reentrega_ssw fica rolando.
--
-- Para REATIVAR (quando processo for refinado):
--   UPDATE cron.job SET active=true WHERE jobid=15;
--   (NÃO recriar as ações canceladas — gerar novas via processar-cobrancas-
--    cliente-aguardando run manual ou pelo próximo ciclo do cron.)
--
-- skill: supabase-postgres-best-practices
--   - cron.alter_job preserva jobid (sem race condition durante o switch)
--   - UPDATE com motivo explícito documentado em cancelado_motivo (audit-friendly)
-- ============================================================================

-- 1. Desativa o cron que cria novas ações
DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'cobranca-cliente-aguardando-daily';
  IF jid IS NULL THEN
    RAISE NOTICE 'cron cobranca-cliente-aguardando-daily não encontrado (nada a fazer)';
  ELSE
    PERFORM cron.alter_job(jid, active := false);
    RAISE NOTICE 'cron cobranca-cliente-aguardando-daily DESATIVADO (jobid=%). Reativar via UPDATE cron.job SET active=true WHERE jobid=%.', jid, jid;
  END IF;
END $$;

-- 2. Cancela as 34 ações presas (todos os operadores)
WITH cancelados AS (
  UPDATE public.acoes_agendadas
  SET status = 'cancelado',
      cancelado_motivo = 'Caio 2026-05-26: feature de cobrança automática desativada (cancelamento administrativo de todos). Cliente sem email em contatos_cliente gerava ciclo eterno via cron. Reavaliar processo.',
      processed_at = now()
  WHERE tipo = 'cobranca_email' AND status = 'pendente'
  RETURNING id, card_id
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  card_id,
  'CobrancaAutomaticaCancelada',
  'system',
  'admin-cancel-2026-05-26',
  jsonb_build_object(
    'acao_id', id,
    'motivo', 'Feature de cobrança automática desativada (todos operadores). Decisão Caio 2026-05-26.'
  )
FROM cancelados;
