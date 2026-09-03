-- =============================================================================
-- 2026-09-03_380 — seguir-parcial-auto: modo sombra + cron do agente
-- =============================================================================
-- ADR 0025, F5/F7. Complementa a mig 379 (tabela + kill-switch).
--
-- Duas coisas:
--   1. feature_flags.seguir_parcial_auto_sombra nascendo LIGADA. A semântica é
--      invertida de propósito: sombra ON = o agente decide, grava
--      SeguirParcialAutoSimulado e NÃO lança nada. O código trata ausência da
--      linha e erro de leitura como sombra ON (fail-safe) — só sai da sombra
--      com a linha existindo e enabled=false explícito.
--   2. Cron de 15 min chamando o agente.
--
-- POR QUE LIGAR O CRON JÁ, com tudo desligado: o agente é inerte enquanto
-- `seguir_parcial_auto_enabled` (mig 379) estiver OFF — a primeira coisa que
-- ele faz é ler a flag e devolver `skipped: flag_off`, antes de qualquer SELECT
-- de card e antes de abrir sessão no SSW. Assim o cron já fica testado no
-- trilho normal e o go-live do shadow vira um UPDATE de uma linha, sem mexer em
-- agendamento no dia D.
--
-- ⚠ ATENÇÃO À MEMÓRIA "cron dormente não é neutro": ali o risco era religar um
-- cron que varre backlog e MANDA E-MAIL. Aqui não há e-mail em nenhum caminho, e
-- o backlog só é lido depois de duas flags e de uma whitelist que nasce vazia de
-- clientes ativos. Ainda assim, a ordem de ativação é: sombra primeiro, whitelist
-- 1 CNPJ por vez depois.
--
-- TIPO B (exige --autorizado-por). Eu havia rotulado TIPO A por engano. O
-- classificador do `scripts/dbq.py` acusa DOIS motivos:
--   1. `cron.unschedule` — aqui é só idempotência (guardado por EXISTS, para
--      reagendar sem duplicar job). Risco real zero.
--   2. **"flag nascendo LIGADA"** — este É legítimo e merece olho humano: a
--      `seguir_parcial_auto_sombra` nasce `true`. Só é seguro porque a
--      semântica é INVERTIDA (ON = decide e registra, NÃO lança). Quem
--      autorizar precisa ter entendido essa inversão; é o oposto do usual.
-- Reversível: cron.unschedule + DELETE da flag.
--
-- skill supabase-postgres-best-practices: não instalada nesta sessão (ver ADR
-- 0025). Aplicado dos precedentes: idempotente (ON CONFLICT / unschedule antes
-- de schedule); schema-qualified; sem RLS nova; segredo lido do vault, nunca
-- literal na migration.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08): o
-- `scripts/dbq.py` já envolve o arquivo na transação dele. Um COMMIT aqui
-- encerraria a transação externa e o ROLLBACK do --dry-run viraria no-op —
-- tudo persistiria (caso real: mig 337, 13/08).
-- =============================================================================

-- 1. Modo sombra — nasce LIGADO (= não lança) -------------------------------
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'seguir_parcial_auto_sombra',
  true,
  'ADR 0025 F7: modo sombra do agente-seguir-parcial-auto. ON (default) = o '
  'agente decide e grava card_event SeguirParcialAutoSimulado, mas NÃO lança a '
  'oc 55 no SSW. Desligar SÓ depois de conferir as decisões simuladas. '
  'Semântica fail-safe: linha ausente ou erro de leitura = sombra ON.'
)
ON CONFLICT (key) DO NOTHING;

-- 2. Cron de 15 min -----------------------------------------------------------
-- Inerte enquanto seguir_parcial_auto_enabled estiver OFF (mig 379).
SELECT cron.unschedule('agente-seguir-parcial-auto')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agente-seguir-parcial-auto');

SELECT cron.schedule(
  'agente-seguir-parcial-auto',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-seguir-parcial-auto',
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

-- 3. Smoke test inline --------------------------------------------------------
DO $$
DECLARE
  v_sombra boolean;
  v_mestra boolean;
  v_jobs integer;
BEGIN
  SELECT enabled INTO v_sombra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_sombra';
  IF v_sombra IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Sombra deveria nascer LIGADA (valor=%) — sem ela o agente lançaria de verdade no 1º ciclo', v_sombra;
  END IF;

  -- Guarda-corpo cruzado com a mig 379: o cron não pode entrar num ambiente
  -- onde a flag mestra já esteja ligada sem ninguém ter revisado.
  SELECT enabled INTO v_mestra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_enabled';
  IF v_mestra IS NOT TRUE THEN
    RAISE NOTICE 'OK: flag mestra OFF — o cron nasce inerte.';
  ELSE
    RAISE NOTICE 'ATENCAO: flag mestra JA ESTA ON. O agente vai rodar em SOMBRA no proximo ciclo.';
  END IF;

  SELECT count(*) INTO v_jobs FROM cron.job WHERE jobname = 'agente-seguir-parcial-auto';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 job agendado, encontrado %', v_jobs;
  END IF;
END $$;
