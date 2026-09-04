-- =============================================================================
-- 2026-09-04_382 — shadow da oc 55 automática: TROCA o CNPJ ativo por VOLUME
-- =============================================================================
-- ADR 0025, F7. Continua a sequência: mig 379 (tabela) -> deploy -> mig 380
-- (sombra + cron) -> mig 381 (ligou shadow no DUILIO) -> ESTA.
--
-- ## O PROBLEMA QUE ESTA MIGRATION RESOLVE
--
-- A mig 381 ligou o shadow no CNPJ 13309775000195 (TOTALL / carteira DUILIO).
-- Verificação em produção hoje (04/09, 09h) mostrou o ensaio RODANDO E VAZIO:
-- os ciclos de 08:00 a 09:00 devolveram `{"sombra":true,"candidatos":0}`, zero
-- `card_events`, zero `agent_runs`. Não é defeito — é falta de matéria-prima.
--
-- Provado (rodando o código real via deno + supabase-js contra produção):
--   (a) a query de candidatos FUNCIONA — devolve 2 cards pro CNPJ do FELIPE e 0
--       pro do DUILIO. "0 candidatos" não é furo do filtro JSON;
--   (b) `decidirSeguirParcialAuto` aprova os 2 cards reais do FELIPE
--       (NF 196195 = 1 de 3 vol; NF 200776 = 2 de 9 vol) com
--       texto_ssw = "AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL";
--   (c) oc 8 realmente para em AGUARDANDO_VALIDACAO_HUMANA (2 cards de outros
--       clientes nesse estado agora; NF 197840 ficou 56 min lá).
--
-- Os 2 cards de oc 6 do DUILIO que a mig 381 contou (NF 116861 e 116870) saíram
-- do estado elegível às 17:20 de 03/09, levados a TRANSFERIDO pelo
-- `sync-extravios-bastao` (Bastão já com oc 14 "Entrega iniciada" e oc 12
-- "Comprovante retido") — 24 min ANTES da flag ligar às 17:44.
--
-- ## O ACHADO: o DUILIO é o CNPJ de MENOR volume dos 4
--
-- Chegadas medidas em 120 dias (card_events):
--
--   | CNPJ           | operador | oc 8 | oc 6 | última oc 8 |
--   |----------------|----------|------|------|-------------|
--   | 26013236000156 | FELIPE   |  35  |  21  | 02/09       |
--   | 13309775000195 | DUILIO   |   9  |   5  | 03/08       |
--   | 04098359000366 | FELIPE   |   4  |   5  | 26/08       |
--   | 04098359000102 | FELIPE   |   1  |   0  | 31/07       |
--
-- O DUILIO não recebe card de oc 8 há um mês. Manter o shadow só nele mantém a
-- sombra vazia por semanas — o ensaio não produz o dado que ele existe pra
-- produzir. Lição registrada no ADR: o 1º CNPJ de um rollout em sombra se
-- escolhe por VOLUME DE CHEGADA MEDIDO, não por carteira nem ordem alfabética.
--
-- ## O QUE MUDA
--
-- TROCA, não soma: 13309775000195 -> ativo=false, 26013236000156 -> ativo=true.
-- Segue com EXATAMENTE 1 CNPJ ativo, honrando ao pé da letra a compensação do
-- D4 do ADR 0025 ("ativação 1 CNPJ por vez"). Não é reinterpretação da regra:
-- é a mesma regra, apontada pro cliente que tem cards.
--
-- ## O QUE NÃO MUDA
--
-- `seguir_parcial_auto_sombra` continua LIGADA (semântica invertida: ON =
-- decide, grava card_event, NÃO lança no SSW). Nada é lançado no SSW por esta
-- migration nem pelo agente enquanto a sombra estiver ON. Sair da sombra é ato
-- separado, com critério explícito (ver ADR 0025) e agora com guard INV-145.
-- A flag mestra também não é tocada (já está ON desde a mig 381).
--
-- ## BLAST RADIUS
--
-- No próximo ciclo de 15 min, no CNPJ 26013236000156, o agente:
--   - varre cards em EXTRAVIO_MONITORADO (oc 6) e AGUARDANDO_VALIDACAO_HUMANA
--     (oc 8) — medido hoje: 2 cards de oc 6, 0 de oc 8;
--   - faz LEITURA no SSW (pré-checagem da última ocorrência) — read, não write;
--   - grava `SeguirParcialAutoSimulado` / `SeguirParcialAutoNaoAplicou` em
--     card_events e uma linha em agent_runs.
-- NÃO muda state de card, NÃO cancela todo, NÃO manda e-mail, NÃO lança oc.
-- O DUILIO volta a ser inerte: cliente inativo nunca é sequer LIDO pelo SELECT.
--
-- ## TIPO B — "Ligar/desligar flags e degraus de automação"
-- (docs/POLITICA_MIGRATIONS.md). Autonomia do Carlos: seção "TIPO B", rev 02/09
-- ("Autonomia total"), com a autorização DECLARADA aqui, no --autorizado-por e
-- no commit.
--
-- AUTORIZACAO (ritual de deploy, passo 5):
--   "Carlos, 2026-09-04: ordem no chat — 'Quero que o plano já rode'. Plano
--    apresentado na mesma sessão, item 1: mover o shadow da F7 pro CNPJ com
--    volume medido (26013236000156), mantendo 1 CNPJ ativo e a sombra ON."
--
-- REVERSÃO (volta ao estado da mig 381, efeito no próximo ciclo de 15 min):
--   UPDATE public.cliente_config_seguir_parcial_auto SET ativo = true
--    WHERE cnpj_pagador = '13309775000195';
--   UPDATE public.cliente_config_seguir_parcial_auto SET ativo = false
--    WHERE cnpj_pagador = '26013236000156';
-- Kill-switch total (desliga o agente inteiro, sem deploy):
--   UPDATE public.feature_flags SET enabled = false
--    WHERE key = 'seguir_parcial_auto_enabled';
--
-- SEM BEGIN/COMMIT interno (regra 13/08) — o scripts/dbq.py embrulha na
-- transação dele; um COMMIT aqui faria o ROLLBACK do --dry-run virar no-op.
--
-- skill supabase-postgres-best-practices: sem DDL, sem RLS nova, sem função
-- nova. Só UPDATE em 2 linhas de tabela de configuração (PK = cnpj_pagador,
-- lookup pelo índice parcial idx_cliente_config_seguir_parcial_ativo).
-- Idempotente: reaplicar deixa o mesmo estado final.
-- =============================================================================

-- 1. Desliga o CNPJ sem volume (DUILIO) --------------------------------------
UPDATE public.cliente_config_seguir_parcial_auto
   SET ativo = false,
       observacao = 'Desligado do shadow em 2026-09-04 (mig 382): 0 cards elegiveis; '
                    'menor volume dos 4 (9 oc8 / 5 oc6 em 120 dias, ultima oc8 em 03/08). '
                    'Volta no go-live real ou quando chegar card novo.'
 WHERE cnpj_pagador = '13309775000195';

-- 2. Liga o CNPJ com volume medido (FELIPE) ----------------------------------
UPDATE public.cliente_config_seguir_parcial_auto
   SET ativo = true,
       observacao = 'Ligado em SHADOW em 2026-09-04 (mig 382). Escolhido por VOLUME MEDIDO: '
                    '35 cards de oc8 e 21 de oc6 em 120 dias, ultima oc8 em 02/09. '
                    'Tem 2 cards de oc6 elegiveis hoje (NF 200776 e 196195). Sombra ON = nao lanca.'
 WHERE cnpj_pagador = '26013236000156';

-- 3. Smoke test inline --------------------------------------------------------
DO $$
DECLARE
  v_mestra     boolean;
  v_sombra     boolean;
  v_ativos     integer;
  v_ativo_cnpj text;
  v_duilio     boolean;
  v_jobs       integer;
BEGIN
  -- A trava que importa mais: a sombra NÃO pode ter sido desligada por acidente
  -- nesta janela. Sombra OFF + mestra ON = o agente LANÇA no SSW no próximo
  -- ciclo, e ocorrência no SSW não tem desfazer.
  SELECT enabled INTO v_sombra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_sombra';
  IF v_sombra IS NOT TRUE THEN
    RAISE EXCEPTION
      'ABORTADO: sombra=% — trocar o CNPJ ativo com a sombra OFF faz o agente LANCAR no SSW no proximo ciclo', v_sombra;
  END IF;

  SELECT enabled INTO v_mestra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_enabled';
  IF v_mestra IS NOT TRUE THEN
    RAISE EXCEPTION 'Flag mestra deveria estar ON desde a mig 381 (valor=%) — o agente esta inerte', v_mestra;
  END IF;

  -- Compensação do D4 ao pé da letra: 1 CNPJ por vez. Troca, não soma.
  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_seguir_parcial_auto WHERE ativo;
  IF v_ativos <> 1 THEN
    RAISE EXCEPTION 'Esperado exatamente 1 CNPJ ativo (D4: 1 por vez), encontrado %', v_ativos;
  END IF;

  SELECT cnpj_pagador INTO v_ativo_cnpj
    FROM public.cliente_config_seguir_parcial_auto WHERE ativo;
  IF v_ativo_cnpj <> '26013236000156' THEN
    RAISE EXCEPTION 'O CNPJ ativo deveria ser 26013236000156, esta %', v_ativo_cnpj;
  END IF;

  SELECT ativo INTO v_duilio
    FROM public.cliente_config_seguir_parcial_auto WHERE cnpj_pagador = '13309775000195';
  IF v_duilio IS NOT FALSE THEN
    RAISE EXCEPTION 'O DUILIO (13309775000195) deveria ter saido do shadow, ativo=%', v_duilio;
  END IF;

  SELECT count(*) INTO v_jobs
    FROM cron.job WHERE jobname = 'agente-seguir-parcial-auto';
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Cron do agente ausente (jobs=%) — sem ele a sombra nao roda', v_jobs;
  END IF;

  RAISE NOTICE 'OK: shadow movido pro CNPJ com volume. ativo=% mestra=ON sombra=ON ativos=% cron=%',
    v_ativo_cnpj, v_ativos, v_jobs;
END $$;
