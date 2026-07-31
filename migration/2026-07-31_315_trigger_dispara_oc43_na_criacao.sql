-- ============================================================================
-- Cockpit v2 — trigger dispara o agente oc43 na criação do card
-- Duílio 2026-07-31
--
-- Problema: perecível entrega tão rápido que o card corre de
-- AVH+oc43 → TRANSFERIDO+oc14 ANTES do cron de 10min pegar → o agente perde a
-- janela e a 55 não é lançada. Evidência: NF 743124/93027/... nasceram estáles.
--
-- Fix: trigger em `cards` que, no INSTANTE que um card entra em oc 43 + AVH,
-- pinga o agente-oc43-autonomo (pg_net async) passando o card_id → o agente
-- processa SÓ aquele card imediatamente (segundos), fechando a janela. NÃO edita
-- o sync-bastao (arquivo crítico) — é declarativo e desacoplado de quem escreve.
--
-- Os GATES continuam no agente: se flag off / fora do horário comercial, ele
-- pula (skipped) e o cron */10 pega depois. Sem loop: o agente ao processar muda
-- state→EXECUTANDO_ACAO (WHEN falha) ou só o status (fora do `OF ... state`).
--
-- Boas práticas Postgres:
--   * SECURITY DEFINER + search_path='' + tudo qualificado (net./vault./pg_catalog)
--   * AFTER trigger, RETURN NULL (retorno ignorado)
--   * `OF cod_ultima_ocorrencia, state` → não dispara em updates que não mexem
--     nessas colunas (reduz fire espúrio); WHEN filtra oc43+AVH+status null
--   * reusa o secret cron_prioridades_ai_key (mesmo do cron da mig 314)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notificar_agente_oc43()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $function$
BEGIN
  -- CRÍTICO: trigger na tabela `cards` (caminho do sync-bastao). Um AFTER trigger
  -- que lança exceção ABORTA a transação → quebraria a criação/update do card.
  -- Blindagem obrigatória: qualquer falha (vault, pg_net) é engolida — o ping é
  -- best-effort e o cron */10 é a rede de segurança.
  BEGIN
    PERFORM net.http_post(
      url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-oc43-autonomo',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
        'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('card_id', NEW.id),
      timeout_milliseconds := 120000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notificar_agente_oc43 falhou para card %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS cards_dispara_oc43 ON public.cards;

CREATE TRIGGER cards_dispara_oc43
  AFTER INSERT OR UPDATE OF cod_ultima_ocorrencia, state ON public.cards
  FOR EACH ROW
  WHEN (
    NEW.cod_ultima_ocorrencia = 43
    AND NEW.state = 'AGUARDANDO_VALIDACAO_HUMANA'
    AND NEW.agente_oc43_status IS NULL
  )
  EXECUTE FUNCTION public.notificar_agente_oc43();
