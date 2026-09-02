-- =============================================================================
-- 2026-09-02_373_cron_devolucao_cte_ciclo.sql
--
-- Agenda o tick diário dos ciclos de devolução com CT-e (MARIA EDUARDA).
-- Faz três coisas: cobra o cliente que não mandou o CT-e (1 lembrete, cadência
-- do Caio 01/09), escalona pra MARIA quando o teto passa sem retorno, e VIGIA
-- ciclo aberto e parado.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ TIPO B — SÓ O CAIO APLICA.                                                │
-- │                                                                           │
-- │ Motivo: agenda um job que PODE mandar e-mail EXTERNO ao cliente. Mesmo    │
-- │ sendo inerte hoje (ver abaixo), a política do projeto trata "manda e-mail │
-- │ pra fora" como TIPO B, e essa regra existe por um caso real: o cron       │
-- │ `cobranca-cliente-aguardando-daily` está `active = false` em produção, e  │
-- │ religá-lo faria a 1ª execução varrer TODO o backlog acumulado e disparar  │
-- │ e-mail em volume sobre casos antigos — irreversível.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- POR QUE ESTE NASCE AGENDADO (e não desligado):
-- cron dormente NÃO é neutro — acordá-lo depois é a ação de blast radius alto
-- que a decisão nº 12 evitou de propósito. Este nasce **ativo e vazio**: a
-- inércia vem de (a) `devolucoes_cte` sem nenhuma linha até o degrau 4 ligar o
-- detector, e (b) o caminho de COBRANÇA ser fechado pela flag
-- `devolucao_cte_cobranca`, que está OFF. Vigia e escalonamento são internos
-- (card_event), não vazam nada pra fora, e são justamente o que impede o caso
-- de ficar invisível durante a espera da NFD.
--
-- HORÁRIO: 12:00 UTC = 09:00 BRT, dentro do expediente. Um lembrete ao cliente
-- não pode sair de madrugada. Seg-sex apenas — a cadência é em dias ÚTEIS e não
-- faz sentido acordar no fim de semana só pra não fazer nada.
--
-- Refs: ADR 0018 · decisões nº 12 (cobrança própria) e nº 15 (controle próprio
--       do ciclo) · plano §6 e §10 · mig 372 (config e tabela do ciclo).
-- =============================================================================

BEGIN;

-- --- Guards de pré-condição ---------------------------------------------------
DO $g$
BEGIN
  IF to_regclass('public.devolucoes_cte') IS NULL THEN
    RAISE EXCEPTION 'G1: public.devolucoes_cte ausente — aplique a mig 372 antes';
  END IF;
  IF to_regclass('public.devolucao_cte_config') IS NULL THEN
    RAISE EXCEPTION 'G1: public.devolucao_cte_config ausente — aplique a mig 372 antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devolucao_cte_config WHERE id = 1) THEN
    RAISE EXCEPTION 'G2: devolucao_cte_config sem a linha id=1';
  END IF;

  -- G3: a flag da cobrança tem de existir E estar OFF. Se estiver ON no momento
  -- de agendar, a 1ª execução já cobraria — e ninguém pediu isso agora.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE key = 'devolucao_cte_cobranca') THEN
    RAISE EXCEPTION 'G3: flag devolucao_cte_cobranca ausente — aplique a mig 372 antes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.feature_flags WHERE key = 'devolucao_cte_cobranca' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'G3: devolucao_cte_cobranca está LIGADA. Agendar o cron agora faria a 1ª execução cobrar clientes. Desligue a flag, agende, e ligue depois no degrau certo.';
  END IF;

  -- G4: o segredo que autentica a chamada tem de existir, senão o cron roda e
  -- toma 401 todo dia em silêncio.
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_sync_bastao_key'
  ) THEN
    RAISE EXCEPTION 'G4: segredo cron_sync_bastao_key ausente no vault';
  END IF;

  -- G5: a tabela de feriados tem de existir — a cadência é em dias ÚTEIS, e sem
  -- feriado a conta erra (cobrança em feriado é ruído pro cliente).
  IF to_regclass('public.feriados') IS NULL THEN
    RAISE EXCEPTION 'G5: public.feriados ausente — a conta de dias úteis depende dela';
  END IF;
END $g$;

-- --- Agendamento --------------------------------------------------------------
-- unschedule antes pra ser idempotente (reaplicar não duplica o job).
SELECT cron.unschedule('devolucao-cte-ciclo-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'devolucao-cte-ciclo-daily');

SELECT cron.schedule(
  'devolucao-cte-ciclo-daily',
  -- 09:00 BRT, seg-sex. Lembrete ao cliente não sai de madrugada nem no sábado.
  '0 12 * * 1-5',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/devolucao-cte-ciclo',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $cron$
);

-- --- Guard de pós-condição ----------------------------------------------------
DO $g$
DECLARE v_n int; v_ativo boolean;
BEGIN
  SELECT count(*), bool_or(active) INTO v_n, v_ativo
    FROM cron.job WHERE jobname = 'devolucao-cte-ciclo-daily';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'G6: esperado 1 job devolucao-cte-ciclo-daily, achei %', v_n;
  END IF;
  IF v_ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'G6: job criado INATIVO — cron dormente não é neutro, ver cabeçalho';
  END IF;

  -- G7: prova de que a 1ª execução não faz nada. Se houver ciclo aberto ANTES do
  -- detector existir, algo está muito errado e é melhor abortar do que descobrir
  -- por e-mail enviado a cliente.
  SELECT count(*) INTO v_n FROM public.devolucoes_cte WHERE encerrado_em IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'G7: % ciclo(s) de devolução ABERTO(S) no momento de agendar. A 1ª execução agiria sobre eles. Confira antes.', v_n;
  END IF;
  RAISE NOTICE 'G7 ok: 0 ciclos abertos — 1ª execução sera no-op';
END $g$;

COMMIT;

-- =============================================================================
-- REVERSÃO
-- =============================================================================
-- BEGIN;
--   SELECT cron.unschedule('devolucao-cte-ciclo-daily');
-- COMMIT;
--
-- Desligar SEM desagendar (rollback rápido do comportamento, mantendo o job):
--   UPDATE public.feature_flags SET enabled = false WHERE key = 'devolucao_cte_cobranca';
-- Isso fecha a cobrança (o único caminho com e-mail externo) e deixa vigia e
-- escalonamento rodando — que é o estado seguro, não o inverso.
--
-- ATENÇÃO: card_events NUNCA é apagado no rollback (lição do INV-047 — é o que
-- permite o retroativo depois).
-- =============================================================================
