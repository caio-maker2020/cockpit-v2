-- ============================================================================
-- Cockpit v2 — Persistir corpo renderizado de email outbound
-- Data: 2026-05-12
--
-- Caio 2026-05-12 (NF 920161): IA interpretador-resposta-cliente hoje só lê
-- a resposta do cliente, sem o email da Larissa pré-resposta. Não consegue
-- detectar pendências (ex: "Larissa pediu romaneio mas cliente respondeu sem
-- anexar"). Pra resolver, precisamos do corpo do email outbound persistido.
--
-- Antes: só metadata em cards_emails_outbound + preview 300 chars em
-- card_events.RespostaEnviada.payload.texto_preview (insuficiente).
--
-- Agora: coluna corpo_renderizado text com texto integral. Backfill best-effort
-- pega o preview do card_events (melhor que nada — IA ainda decide com
-- truncamento). Backfill completo via Gmail API roda separadamente.
-- ============================================================================

ALTER TABLE public.cards_emails_outbound
  ADD COLUMN IF NOT EXISTS corpo_renderizado text;

COMMENT ON COLUMN public.cards_emails_outbound.corpo_renderizado IS
  'Caio 2026-05-12: texto renderizado do email enviado. Usado pelo '
  'interpretador-resposta-cliente pra comparar perguntas Larissa vs '
  'respostas cliente e detectar pendências.';

-- Backfill best-effort: usa preview do card_events.RespostaEnviada quando
-- disponível. Pra envios via responder-email-cliente (composer), o preview
-- também existe em RespostaManualEnviadaPeloCockpit.
UPDATE public.cards_emails_outbound o
SET corpo_renderizado = COALESCE(
  (
    SELECT ce.payload->>'texto_preview'
    FROM public.card_events ce
    WHERE ce.card_id = o.card_id
      AND ce.event_type IN ('RespostaEnviada', 'RespostaManualEnviadaPeloCockpit')
      AND ce.payload->>'gmail_message_id' = o.gmail_message_id
    ORDER BY ce.created_at DESC
    LIMIT 1
  ),
  NULL
)
WHERE corpo_renderizado IS NULL;
