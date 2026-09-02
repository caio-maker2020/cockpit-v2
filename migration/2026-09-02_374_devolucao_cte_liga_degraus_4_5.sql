-- =============================================================================
-- 2026-09-02_374_devolucao_cte_liga_degraus_4_5.sql
--
-- Liga os degraus 4 e 5 da devolução com CT-e da MARIA EDUARDA (ADR 0018 §12):
--   degrau 4 — `devolucao_cte_maria_enabled`: o detector (nível A) passa a CRIAR
--              a proposta de oc 44 com o CT-e anexado, pra MARIA aprovar;
--   degrau 5 — `devolucao_cte_email_interno`: após a 44 lançada, e-mail NOVO e
--              separado ao setor de Devolução (Leonel) com o CT-e original.
--
-- A sombra (degrau 3) fica LIGADA de propósito: no código `enabled` vence
-- `shadow` (devolucao-cte-proposta.ts: "o degrau 4 substitui o 3, não soma"),
-- então ela é inerte enquanto o 4 estiver ligado, e se o 4 for desligado o
-- sistema cai no degrau 3 (sombra), não no 0. É o rollback mais seguro.
-- O degrau 7 (NFD) continua DESLIGADO: o código dele não existe (INV-130 SKIP).
--
-- TIPO B (liga flag de automação). AUTORIZAÇÃO: Caio, sessão Claude Code de
-- 2026-09-02 ~16:20 BRT, resposta literal à pergunta "qual degrau deve ficar
-- ligado": "Ligar degraus 4 e 5". Aplicada via `scripts/dbq.py --autorizado-por`.
--
-- Pré-requisitos verificados antes de escrever: mig 373 aplicada (tabelas,
-- função de escopo, 4 flags); executor v156 e gmail-poll-inbox v72 (código dos
-- degraus 4/5) em produção desde 2026-09-02 18:13Z; vinculador v130,
-- scan-email-pre-card v38 e cron-ia-resposta-pendentes v38 (cerca da 44 sem
-- CT-e no menu) desde 19:09Z. INV-123..135 PASS.
--
-- Idempotente (UPDATE por chave). SEM BEGIN/COMMIT interno (regra 13/08).
--
-- REVERSÃO (volta ao degrau 3 = sombra):
--   UPDATE public.feature_flags SET enabled = false
--    WHERE key IN ('devolucao_cte_maria_enabled','devolucao_cte_email_interno');
-- =============================================================================

-- G1: pré-condições — a infra do degrau 0 existe e as 4 flags estão lá
DO $$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.devolucoes_cte') IS NULL THEN
    RAISE EXCEPTION 'G1: public.devolucoes_cte ausente — mig 373 não aplicada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'devolucao_cte_em_escopo') THEN
    RAISE EXCEPTION 'G1: função devolucao_cte_em_escopo ausente — mig 373 não aplicada';
  END IF;
  SELECT count(*) INTO v_n FROM public.feature_flags WHERE key LIKE 'devolucao_cte%';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'G1: esperado 4 flags devolucao_cte, achei % — mig 373 incompleta', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.devolucao_cte_config WHERE id = 1 AND email_setor_devolucao IS NOT NULL) THEN
    RAISE EXCEPTION 'G1: devolucao_cte_config sem e-mail do setor — degrau 5 mandaria e-mail pra ninguém';
  END IF;
END $$;

-- Liga 4 e 5
UPDATE public.feature_flags
   SET enabled = true
 WHERE key IN ('devolucao_cte_maria_enabled', 'devolucao_cte_email_interno')
   AND enabled = false;

-- G2: pós-condição — exatamente o estado do degrau 5 (3 ligadas, NFD desligada)
DO $$
DECLARE v_on int; v_nfd boolean;
BEGIN
  SELECT count(*) INTO v_on FROM public.feature_flags
   WHERE key IN ('devolucao_cte_maria_enabled','devolucao_cte_email_interno') AND enabled;
  IF v_on <> 2 THEN RAISE EXCEPTION 'G2: degraus 4/5 não ligaram (ligadas=%)', v_on; END IF;
  SELECT enabled INTO v_nfd FROM public.feature_flags WHERE key = 'devolucao_cte_nfd';
  IF v_nfd THEN RAISE EXCEPTION 'G2: devolucao_cte_nfd LIGADA — o degrau 7 não tem código'; END IF;
  RAISE NOTICE 'mig 374 OK — degraus 4 e 5 LIGADOS (sombra mantida, NFD desligada)';
END $$;
