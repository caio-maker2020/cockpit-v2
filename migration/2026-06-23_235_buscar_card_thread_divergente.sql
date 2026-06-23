-- =============================================================================
-- Opção 1 (Caio 2026-06-23): detecção de tratativa divergente SÓ "daqui pra
-- frente" — gatilho por e-mail NOVO no gmail-poll, não por varredura retroativa.
--
-- O re-scan retroativo (mig 232/234) dragava threads VELHAS → poluiu CLIENTE
-- RESPONDEU (161 cards). Revertido. Agora: quando o poll recebe um e-mail novo
-- que não casa com card, esta RPC acha um card ATIVO do operador com aquela NF
-- (sem e-mail rastreado) — e só então o poll enfileira um scan FOCADO na thread
-- nova. Nenhuma thread antiga entra (o poll só olha e-mail novo).
--
-- p_nfs já vem normalizada (só dígitos, sem zeros à esquerda) do caller.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.buscar_card_para_thread_divergente(
  p_operador uuid,
  p_nfs text[]
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id
  FROM public.cards c
  WHERE c.assigned_operator_id = p_operador
    AND c.state IN ('AGUARDANDO_CLIENTE', 'AGUARDANDO_VALIDACAO_HUMANA')  -- card ativo aguardando
    AND regexp_replace(c.nf, '\D', '', 'g') = ANY (p_nfs)                 -- NF do e-mail bate
    AND NOT EXISTS (                                                      -- Cockpit não rastreia e-mail nesse card
      SELECT 1 FROM public.messages_inbox m WHERE m.card_id = c.id
    )
    AND (                                                                 -- não decidido ainda
      c.email_preexistente_sugerido IS NULL
      OR (c.email_preexistente_sugerido->>'decidido_em') IS NULL
    )
  ORDER BY c.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.buscar_card_para_thread_divergente(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buscar_card_para_thread_divergente(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.buscar_card_para_thread_divergente(uuid, text[]) IS
  'Opção 1 (Caio 2026-06-23): dado um e-mail novo não casado (operador + NFs do '
  'assunto), acha um card ATIVO do operador com aquela NF e SEM e-mail rastreado. '
  'O poll usa pra enfileirar um scan focado na thread nova (gatilho daqui pra frente).';

-- Garante que o re-scan retroativo NÃO volta a rodar (mig 232 agendava cron).
SELECT cron.unschedule('rescan-cards-aguardando-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rescan-cards-aguardando-hourly');
