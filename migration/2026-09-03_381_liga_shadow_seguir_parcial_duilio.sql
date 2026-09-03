-- =============================================================================
-- 2026-09-03_381 — liga o SHADOW da oc 55 automática: flag mestra ON + 1 CNPJ
-- =============================================================================
-- ADR 0025, F7. Fecha a sequência: mig 379 (tabela + kill-switch) -> deploy do
-- agente-seguir-parcial-auto -> mig 380 (sombra + cron) -> ESTA.
--
-- O que muda: o agente sai de `skipped: flag_off` e passa a AVALIAR cards reais
-- do CNPJ 13309775000195 (TOTALL, carteira DUILIO), gravando o que TERIA feito.
--
-- O que NÃO muda: nada é lançado no SSW. A `seguir_parcial_auto_sombra` continua
-- LIGADA (semântica invertida: ON = decide, grava card_event, NÃO lança). Sair da
-- sombra é ato separado, depois de conferir as decisões simuladas.
--
-- 1 CNPJ POR VEZ (ADR 0025, compensação do D4): os outros 3 seguem inativos.
-- Precedente: a mig 313 avisou do efeito rajada ao ligar o FELIPE em D2.
--
-- TIPO B — "Ligar/desligar flags e degraus de automação"
-- (docs/POLITICA_MIGRATIONS.md). Autonomia do Carlos: seção 3, rev 02/09.
--
-- AUTORIZACAO (ritual de deploy, passo 5):
--   "Carlos, 2026-09-03: ordem no chat — 'ligue agora para o ensaio arrancar
--    amanhã'. F7 do ADR 0025, modo sombra, 1 CNPJ (DUILIO)."
--
-- ⚠ Blast radius: são 17h44 BRT de quinta e o agente opera 8h–17h30 seg–sex.
--   Logo, hoje ele ainda responde `fora_horario_comercial`. O ensaio arranca
--   AMANHÃ (sex, 04/09) às 8h, com a equipe em horário de trabalho — que é
--   justamente o motivo de ligar agora em vez de no fim do dia.
--
-- ⚠ O que o agente PASSA a fazer amanhã, no CNPJ ligado:
--   - varre cards em EXTRAVIO_MONITORADO (oc 6) e AGUARDANDO_VALIDACAO_HUMANA
--     (oc 8) desse CNPJ — medido hoje: 2 cards de oc 6, 0 de oc 8;
--   - faz LEITURA no SSW (pré-checagem da última ocorrência) — read, não write;
--   - grava `SeguirParcialAutoSimulado` / `SeguirParcialAutoNaoAplicou` em
--     card_events. NÃO muda state de card, NÃO manda e-mail, NÃO lança oc.
--
-- Reversão (kill-switch sem deploy, efeito no próximo ciclo de 15 min):
--   UPDATE public.feature_flags SET enabled = false
--    WHERE key = 'seguir_parcial_auto_enabled';
--
-- SEM BEGIN/COMMIT interno (regra 13/08) — o dbq.py embrulha.
-- =============================================================================

-- 1. Liga a chave mestra ------------------------------------------------------
UPDATE public.feature_flags
   SET enabled = true
 WHERE key = 'seguir_parcial_auto_enabled';

-- 2. Ativa UM CNPJ ------------------------------------------------------------
UPDATE public.cliente_config_seguir_parcial_auto
   SET ativo = true,
       observacao = 'Ligado em shadow 2026-09-03 (F7). 1o CNPJ do rollout.'
 WHERE cnpj_pagador = '13309775000195';

-- 3. Smoke test inline --------------------------------------------------------
DO $$
DECLARE
  v_mestra  boolean;
  v_sombra  boolean;
  v_ativos  integer;
  v_jobs    integer;
BEGIN
  SELECT enabled INTO v_mestra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_enabled';
  IF v_mestra IS NOT TRUE THEN
    RAISE EXCEPTION 'Flag mestra deveria estar ON (valor=%)', v_mestra;
  END IF;

  -- A trava que importa: ligar a mestra SEM a sombra faria o agente LANÇAR de
  -- verdade no primeiro ciclo. Ocorrência no SSW não tem desfazer.
  SELECT enabled INTO v_sombra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_sombra';
  IF v_sombra IS NOT TRUE THEN
    RAISE EXCEPTION
      'ABORTADO: sombra=% — ligar a mestra sem a sombra faz o agente LANÇAR no SSW no 1o ciclo', v_sombra;
  END IF;

  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_seguir_parcial_auto WHERE ativo;
  IF v_ativos <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 CNPJ ativo (rollout 1 por vez), encontrado %', v_ativos;
  END IF;

  SELECT count(*) INTO v_jobs
    FROM cron.job WHERE jobname = 'agente-seguir-parcial-auto';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Cron do agente ausente (jobs=%) — a mig 380 nao foi aplicada', v_jobs;
  END IF;

  RAISE NOTICE 'OK: shadow ligado. mestra=ON sombra=ON ativos=% cron=%', v_ativos, v_jobs;
END $$;
