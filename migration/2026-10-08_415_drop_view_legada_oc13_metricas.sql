-- =============================================================================
-- 2026-10-08_415_drop_view_legada_oc13_metricas.sql  (INV-174)  — TIPO B
-- (DROP de objeto: o classificador do dbq exige --autorizado-por; aplicada em
-- 08/10 com "Caio, 08/10/2026 ~15:40 BRT (chat): 'ok, pode fazer o merge...
-- garanta que tudo estará regularizado'")
--
-- Caio 08/10 (pedido do Duilio: "a oc 13 não está sendo medida"). Diagnóstico
-- só de leitura, master 55c1d86: os pares da oc 13 EXISTEM (agente_oc13_feedback
-- 82 seguidas + 39 corrigidas em set/26, espelhados em agent_feedback e no
-- placar v_placar_agente). O que mostrava "sem dados" era a view legada
-- `v_agente_oc13_metricas` (mig 149): ela filtra `cards.cod_ultima_ocorrencia
-- = 13`, e o card sai da 13 no instante em que o operador age → 0 linhas em
-- 7d/30d/set (144 cards analisados em 30 dias, nenhum ainda na 13). O front
-- ainda lia as colunas que a mig 158 renomeou (`autonomas_corrigidas` →
-- `autonomas_erradas`), então mesmo com linhas daria NaN.
--
-- A view some. O indicador "Acerto Agente IA oc=13" passa a ler o placar
-- oficial (`v_placar_agente`, mig 338, agent_name = 'agente-oc13-autonomo'),
-- que é a fonte única desde 13/08. Ninguém mais lê a view: pg_depend sem
-- dependentes (verificado 08/10) e no repo só o componente do front (trocado
-- no mesmo commit). Reversível: a definição está na mig 158.
--
-- skill: supabase-postgres-best-practices — DDL puro, sem lock em tabela
-- operacional (DROP VIEW só trava a própria view). Sem BEGIN/COMMIT.
-- =============================================================================

DROP VIEW IF EXISTS public.v_agente_oc13_metricas;

-- Guarda: a fonte que o front passa a usar precisa existir e estar legível
-- pelo app (grant da mig 338).
DO $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT has_table_privilege('authenticated', 'public.v_placar_agente', 'SELECT') INTO v_ok;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'mig 415: v_placar_agente sem SELECT pro authenticated — o indicador oc13 ficaria cego (ver mig 338)';
  END IF;
  IF to_regclass('public.v_agente_oc13_metricas') IS NOT NULL THEN
    RAISE EXCEPTION 'mig 415: v_agente_oc13_metricas ainda existe';
  END IF;
  RAISE NOTICE 'mig 415 ok: view legada removida; v_placar_agente legível pelo app';
END
$$;
