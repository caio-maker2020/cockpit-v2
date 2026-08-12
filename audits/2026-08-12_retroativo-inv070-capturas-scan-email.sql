-- ============================================================================
-- RETROATIVO INV-070 (Caio 2026-08-12) — respostas de cliente do trilho
-- scan-email-pre-card que nunca ganharam `RespostaClienteCapturada`.
--
-- Medido em prod 12/08: 10 mensagens em 6 cards ativos (NFs 895873, 115779,
-- 5171, 97477, 518693) sem acionamento e sem outbound depois — órfãs
-- invisíveis pro detector INV-042 e pro reconciliador INV-067. Pior caso:
-- NF 895873, 3 e-mails do cliente parados desde 28/07 em AGUARDANDO_CLIENTE.
--
-- O QUE FAZ: insere o evento de captura retroativo pra ÚLTIMA mensagem órfã
-- de cada card. O reconciliador (cron-ia-resposta-pendentes) drena no ciclo
-- seguinte: carimba cliente_respondeu_em, recria propostas, chama IA, e move
-- pra AGUARDANDO_VALIDACAO_HUMANA quem estiver em AGUARDANDO_CLIENTE.
--
-- ⚠️ RODAR SOMENTE DEPOIS do deploy das edge functions desta branch
-- (fix/inv069-070-resposta-engolida-reconciliador). Antes do deploy, o
-- reconciliador em prod ainda tem o return antecipado (INV-069) e NÃO drena —
-- o health-check só ia alarmar 6 cards novos sem ninguém pra agir.
--
-- Idempotente: o NOT EXISTS de captura por message_inbox_id impede duplicar.
-- ============================================================================

BEGIN;

INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT DISTINCT ON (mi.card_id)
  mi.card_id,
  'RespostaClienteCapturada',
  'system',
  'retroativo-inv070',
  jsonb_build_object(
    'message_inbox_id', mi.id,
    'gmail_thread_id', mi.raw_payload->>'gmail_thread_id',
    'origem', 'retroativo_inv070',
    'recebido_em_original', mi.recebido_em,
    'motivo', 'INV-070: resposta adotada pelo scan-email-pre-card sem evento de captura — retroativo pra o reconciliador INV-067 acionar'
  )
FROM public.messages_inbox mi
JOIN public.cards c ON c.id = mi.card_id
WHERE mi.raw_payload->>'origem' = 'scan-email-pre-card'
  AND mi.recebido_em > now() - interval '90 days'
  AND c.state IN ('AGUARDANDO_CLIENTE', 'ACAO_EXECUTADA', 'AGUARDANDO_VALIDACAO_HUMANA')
  -- nenhum acionamento/ação de operador depois da mensagem
  AND NOT EXISTS (
    SELECT 1 FROM public.card_events x
    WHERE x.card_id = c.id
      AND x.event_type IN ('RetornoClienteEmAguardo', 'AprovacaoOperador', 'AcaoExecutada')
      AND x.created_at >= mi.recebido_em - interval '1 minute')
  -- nenhum e-mail nosso depois da mensagem
  AND NOT EXISTS (
    SELECT 1 FROM public.cards_emails_outbound o
    WHERE o.card_id = c.id AND o.sent_at > mi.recebido_em)
  -- ainda sem captura pra esta mensagem (idempotência)
  AND NOT EXISTS (
    SELECT 1 FROM public.card_events cap
    WHERE cap.card_id = c.id
      AND cap.event_type = 'RespostaClienteCapturada'
      AND cap.payload @> jsonb_build_object('message_inbox_id', mi.id))
ORDER BY mi.card_id, mi.recebido_em DESC;

-- Conferência: deve listar os cards que o reconciliador vai drenar em seguida.
SELECT c.nf, c.state, ce.created_at AS captura_retroativa
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.actor_id = 'retroativo-inv070'
ORDER BY ce.created_at DESC;

COMMIT;
