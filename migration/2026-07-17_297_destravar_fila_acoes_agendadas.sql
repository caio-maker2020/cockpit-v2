-- =============================================================================
-- FASE 0 do fix "fila acoes_agendadas saturada" (2026-07-16/17).
--
-- ⚠️ NUMERAÇÃO: prod recebeu migs 292–296 em 14-15/07 a partir do repo antigo
-- (não presentes neste repo). CONFERIR que 297 está livre em prod antes de
-- aplicar. Ver audits/FIX_FILA_ACOES_AGENDADAS_SATURADA_2026-07-16.md.
--
-- Contexto: as cobranca_email pendentes falham para sempre ("cliente sem
-- e-mail cadastrado") e o handler antigo as mantinha 'pendente' com o MESMO
-- executar_em → ocupavam 100% da janela LIMIT 200 do processar-acoes-agendadas
-- (ordenada por executar_em ASC) e starvaram os cancelar_reentrega_ssw
-- (posições 203–225 em 16/07; vazão zero em 12–14/07; "Forçar agora" inútil).
--
-- Este é o destravamento imediato: cancelamento administrativo de TODAS as
-- cobranca_email pendentes (vencidas E futuras — as futuras venceriam depois
-- e re-entupiriam). Mesmo padrão da mig 168 (1º entupimento, fix parcial que
-- deixou 4 portas criando cobranças novas — fechadas na mig 298).
-- Feature de cobrança segue DESATIVADA (mig 168 + flag da mig 298).
--
-- Efeito esperado: na rodada seguinte (≤15 min) os cancelamentos de reentrega
-- vencidos entram na janela e rodam sozinhos, com os guards normais do handler.
-- NUNCA recriar as ações canceladas aqui (regra da mig 168).
-- =============================================================================

WITH cancelados AS (
  UPDATE public.acoes_agendadas
  SET status = 'cancelado',
      cancelado_motivo = 'Caio 2026-07-16: cancelamento administrativo — cobranca_email presas '
        || 'saturaram a janela LIMIT 200 do processar-acoes-agendadas e starvaram os '
        || 'cancelamentos de reentrega. Feature de cobrança segue desativada (mig 168). '
        || 'Ver audits/FIX_FILA_ACOES_AGENDADAS_SATURADA_2026-07-16.md',
      processed_at = now()
  WHERE tipo = 'cobranca_email' AND status = 'pendente'
  RETURNING id, card_id
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT card_id, 'CobrancaAutomaticaCancelada', 'system', 'admin-cancel-2026-07-16',
       jsonb_build_object('acao_id', id,
         'motivo', 'Cobranças presas saturaram a fila de ações agendadas (fix 2026-07-16).')
FROM cancelados;
