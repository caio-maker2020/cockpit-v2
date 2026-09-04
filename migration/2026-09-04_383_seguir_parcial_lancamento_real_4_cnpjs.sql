-- =============================================================================
-- 2026-09-04_383 — oc 55 automática SAI DA SOMBRA: lançamento REAL nos 4 CNPJs
-- =============================================================================
-- ADR 0025, seção "SAIDA DA SOMBRA AUTORIZADA — 2026-09-04, Carlos".
-- Fecha a sequência: 379 (tabela) -> deploy -> 380 (sombra+cron) -> 381 (shadow
-- no DUILIO) -> 382 (troca pro CNPJ com volume) -> ESTA.
--
-- ⚠️⚠️ ESTA MIGRATION TORNA O AGENTE IRREVERSÍVEL NO EFEITO. ⚠️⚠️
-- Ocorrência lançada no SSW NÃO TEM DESFAZER. Até aqui o agente decidia e
-- gravava `SeguirParcialAutoSimulado`; a partir do próximo ciclo de 15 min ele
-- LANÇA a oc 55 de verdade, sem aprovação humana.
--
-- ## ORDEM E AUTORIZAÇÃO
--
-- Carlos, 04/09, literal no chat: "quero que ele já rode e lance automaticamente,
-- sem quebrar e regredir nada. somente para os cnpj mencionados."
-- Autonomia: docs/POLITICA_MIGRATIONS.md, TIPO B ("Ligar/desligar flags e degraus
-- de automação"), revisão 02/09 = "Autonomia total" do Carlos, com a autorização
-- DECLARADA aqui, no --autorizado-por e no commit.
--
-- ## O QUE A RÉGUA PEDIA E O QUE HAVIA (registrado de propósito)
--
-- O ADR 0025 fixou 3 condições cumulativas pra sair da sombra. Estado real:
--   * decisões simuladas conferidas sem falso positivo: exigido >=5, havia 1;
--   * >=1 extravio TOTAL corretamente barrado:           exigido 1,  havia 0;
--   * autorização escrita:                                exigido 1,  havia 1.
-- A única decisão simulada (NF 200776, 2 de 9 vol) estava CORRETA. A recusa do
-- mesmo ciclo (NF 196195) foi por SSW divergente, não por sinal de total, então
-- não conta pra 2ª condição.
--
-- Também SUPERA a compensação do D4 ("ativação 1 CNPJ por vez"): liga os 4 juntos.
-- Justificativa MEDIDA hoje, não suposta: o universo elegível dos 4 CNPJs somava
-- 3 cards (NF 117057 DUILIO; NF 196195 e 200776 FELIPE). "4 CNPJs" não produz o
-- efeito rajada que o D4 temia — produz 3 cards.
--
-- Nada disso é maquiado: o INV-145 existe pra impedir que a saída da sombra
-- aconteça em silêncio, e a seção do ADR carrega esta mesma tabela do que faltou.
--
-- ## O QUE CONTINUA PROTEGENDO (conferido hoje, não presumido)
--
--  1. WHITELIST FECHADA — a tabela tem exatamente 4 linhas, os 4 CNPJs
--     mencionados (conferido: total=4, dos_4=4). O filtro por CNPJ está no
--     PRÓPRIO SELECT do agente: cliente fora da lista nunca é lido. É o
--     "somente para os cnpj mencionados" por CONSTRUÇÃO. O smoke test abaixo
--     ABORTA se aparecer 5ª linha ou CNPJ estranho.
--  2. PRÉ-CHECAGEM SSW obrigatória (camada 6) antes de cada lançamento, no mesmo
--     ciclo. Já exercitada em card REAL: barrou a NF 196195 (SSW mostrava
--     oc 1 ENTREGUE de 10/08/26).
--  3. SINAL DE EXTRAVIO TOTAL (camada 4): palavra TOTAL **ou** qtd >= volumes da
--     NF; fail-closed se a qtd é legível e os volumes são desconhecidos.
--  4. IDEMPOTÊNCIA (camada 7) por (card_id, codigo_oc, ctrc) + envelope
--     lancarSswPortal com o GUARD DO TRIPÉ CTRC+NF+Localização antes do submit.
--  5. HORÁRIO COMERCIAL (camada 5): 8h-17h30 seg-sex.
--  6. Teto de 50 cards por ciclo, orçamento de 110s.
--  7. SEM E-MAIL: o todo do agente vai com enviar_email=false.
--  8. Texto certo no SSW: extras.texto_descricao entra em montarDescricaoSsw como
--     texto livre e SUBSTITUI a base, então a 55 chega com
--     "AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL". Os 3 cards têm CTRC
--     preenchido (senão o executor abortaria no guard do tripé).
--
-- Guards de não-regressão rodados ANTES desta migration, todos PASS:
-- INV-141 (a inversão parcial não vaza da whitelist), INV-142 (nada nasce
-- ligado / loader fail-safe), INV-143 (55 como ciência é opt-in), INV-145
-- (saída da sombra exige autorização escrita), INV-146 (trilho enxerga o banco).
-- Suíte da regra: 46 passed / 0 failed.
--
-- ## TIPO B — exige --autorizado-por.
--
-- REVERSÃO — KILL-SWITCH sem deploy, efeito no próximo ciclo de 15 min.
-- Volta pra sombra (decide e grava, NÃO lança):
--   UPDATE public.feature_flags SET enabled = true
--    WHERE key = 'seguir_parcial_auto_sombra';
-- Desliga o agente inteiro:
--   UPDATE public.feature_flags SET enabled = false
--    WHERE key = 'seguir_parcial_auto_enabled';
-- Voltar ao estado da mig 382 (1 CNPJ, sombra ON):
--   UPDATE public.feature_flags SET enabled = true  WHERE key = 'seguir_parcial_auto_sombra';
--   UPDATE public.cliente_config_seguir_parcial_auto SET ativo = false
--    WHERE cnpj_pagador <> '26013236000156';
--
-- SEM BEGIN/COMMIT interno (regra 13/08) — o scripts/dbq.py embrulha; um COMMIT
-- aqui faria o ROLLBACK do --dry-run virar no-op.
--
-- skill supabase-postgres-best-practices: sem DDL, sem RLS nova, sem função nova.
-- Só UPDATE em 1 linha de feature_flags e em 4 linhas de tabela de configuração
-- (PK = cnpj_pagador). Idempotente: reaplicar deixa o mesmo estado final.
-- =============================================================================

-- 1. Ativa os 4 CNPJs mencionados -------------------------------------------
--    Restrito por lista LITERAL: se um CNPJ estranho estiver na tabela, ele NÃO
--    é ativado por esta migration.
UPDATE public.cliente_config_seguir_parcial_auto
   SET ativo = true,
       observacao = 'LANCAMENTO REAL desde 2026-09-04 (mig 383). Ordem do Carlos: '
                    '"que ele ja rode e lance automaticamente, somente para os cnpj '
                    'mencionados". Sombra OFF. Ver ADR 0025 secao SAIDA DA SOMBRA.'
 WHERE cnpj_pagador IN (
   '13309775000195',  -- TOTALL DISTRIBUIDORA        (carteira DUILIO)
   '04098359000366',  -- GMI DISTRIBUIDORA           (carteira FELIPE)
   '04098359000102',  -- GMI DISTRIBUIDORA           (carteira FELIPE)
   '26013236000156'   -- DISTRIB MINEIRA DE FILTROS  (carteira FELIPE)
 );

-- 2. DESLIGA A SOMBRA — daqui pra frente o agente LANÇA no SSW ---------------
UPDATE public.feature_flags
   SET enabled = false,
       description = 'ADR 0025: modo sombra do agente-seguir-parcial-auto. '
                     'DESLIGADO em 2026-09-04 (mig 383) por ordem do Carlos — o agente '
                     'LANCA a oc 55 no SSW de verdade. Semantica invertida: ON = decide e '
                     'grava, NAO lanca. Religar = kill-switch (volta a nao lancar).'
 WHERE key = 'seguir_parcial_auto_sombra';

-- 3. Smoke test inline --------------------------------------------------------
DO $$
DECLARE
  v_mestra    boolean;
  v_sombra    boolean;
  v_ativos    integer;
  v_total     integer;
  v_estranhos integer;
  v_jobs      integer;
BEGIN
  -- A trava que MAIS importa agora: nenhum CNPJ fora dos 4 mencionados pode
  -- estar ativo. É o "somente para os cnpj mencionados" da ordem do Carlos,
  -- checado no banco e não prometido no comentário.
  SELECT count(*) INTO v_estranhos
    FROM public.cliente_config_seguir_parcial_auto
   WHERE ativo
     AND cnpj_pagador NOT IN ('13309775000195','04098359000366',
                              '04098359000102','26013236000156');
  IF v_estranhos <> 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % CNPJ(s) ATIVO(s) fora dos 4 mencionados — com a sombra OFF isso lancaria oc 55 em cliente NAO autorizado', v_estranhos;
  END IF;

  SELECT count(*) INTO v_total FROM public.cliente_config_seguir_parcial_auto;
  IF v_total <> 4 THEN
    RAISE EXCEPTION
      'ABORTADO: a tabela de autorizacao tem % linhas, esperado 4 — alguem ampliou o escopo sem passar por aqui', v_total;
  END IF;

  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_seguir_parcial_auto WHERE ativo;
  IF v_ativos <> 4 THEN
    RAISE EXCEPTION 'Esperado os 4 CNPJs ativos, encontrado %', v_ativos;
  END IF;

  SELECT enabled INTO v_sombra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_sombra';
  IF v_sombra IS NOT FALSE THEN
    RAISE EXCEPTION 'A sombra deveria estar OFF (valor=%) — sem isso o agente continua sem lancar', v_sombra;
  END IF;

  SELECT enabled INTO v_mestra
    FROM public.feature_flags WHERE key = 'seguir_parcial_auto_enabled';
  IF v_mestra IS NOT TRUE THEN
    RAISE EXCEPTION 'Flag mestra deveria estar ON (valor=%) — o agente esta inerte', v_mestra;
  END IF;

  SELECT count(*) INTO v_jobs
    FROM cron.job WHERE jobname = 'agente-seguir-parcial-auto' AND active;
  IF v_jobs <> 1 THEN
    RAISE EXCEPTION 'Cron do agente ausente/inativo (jobs=%) — sem ele nada roda', v_jobs;
  END IF;

  RAISE NOTICE 'OK: LANCAMENTO REAL LIGADO. mestra=ON sombra=OFF ativos=%/4 estranhos=% cron=%',
    v_ativos, v_estranhos, v_jobs;
  RAISE NOTICE 'Kill-switch: UPDATE feature_flags SET enabled=true WHERE key=''seguir_parcial_auto_sombra'';';
END $$;
