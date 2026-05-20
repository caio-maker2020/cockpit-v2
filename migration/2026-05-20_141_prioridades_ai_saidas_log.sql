-- =============================================================================
-- prioridades_ai_saidas: log persistente de cards que saem do kanban
--
-- Caio 2026-05-20: hoje quando cron-sync-prioridades-ai roda autonomamente
-- (07/09/11/14/16 BRT) e atualiza cards, alguns somem do kanban — operador
-- não consegue ver o que saiu nem por quê. Já existia modal "📋 cards que
-- saíram" no front mas só cobre chamada MANUAL ("Atualizar Geral"), porque
-- a edge calculava diff inline e devolvia no response.
--
-- Esta tabela persiste o diff de TODA fonte (cron + manual + ações operador).
-- Front consulta últimas 24h numa aba/widget e enxerga tudo.
--
-- skill: supabase-postgres-best-practices
--   - IF NOT EXISTS (idempotente)
--   - PRIMARY KEY uuid auto
--   - Índice em saiu_em DESC pra query "últimas N horas"
--   - RLS combinada (RESTRICTIVE + PERMISSIVE) limitando authenticated a
--     últimas 24h. Pattern testado mig 138/139 (cron_prioridades_ai).
--   - GRANT SELECT TO authenticated explícito (memory feedback_rls_grant_antes_de_policy).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.prioridades_ai_saidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  nf text NOT NULL,
  responsavel_relacionamento text,
  oc_antes integer,
  oc_depois integer,
  state_depois text,
  motivo text NOT NULL,
  fonte text NOT NULL CHECK (fonte IN ('cron_autonomo','atualizar_geral_manual','outro')),
  detalhes jsonb,
  saiu_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prioridades_ai_saidas_saiu_em
  ON public.prioridades_ai_saidas(saiu_em DESC);

CREATE INDEX IF NOT EXISTS idx_prioridades_ai_saidas_resp
  ON public.prioridades_ai_saidas(responsavel_relacionamento, saiu_em DESC)
  WHERE responsavel_relacionamento IS NOT NULL;

ALTER TABLE public.prioridades_ai_saidas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prioridades_ai_saidas_restrict_recent ON public.prioridades_ai_saidas;
CREATE POLICY prioridades_ai_saidas_restrict_recent
  ON public.prioridades_ai_saidas
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (saiu_em > now() - interval '24 hours')
  WITH CHECK (false);

DROP POLICY IF EXISTS prioridades_ai_saidas_select_authenticated ON public.prioridades_ai_saidas;
CREATE POLICY prioridades_ai_saidas_select_authenticated
  ON public.prioridades_ai_saidas
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

GRANT SELECT ON public.prioridades_ai_saidas TO authenticated;

COMMENT ON TABLE public.prioridades_ai_saidas IS
  'Log de cards que saíram do kanban PRIORIDADES AI. Populado por cron-sync-'
  'prioridades-ai (autônomo) e atualizar-batch-prioridades-ai (manual). Front '
  'consulta últimas 24h. RLS RESTRICTIVE limita visão a 24h pra evitar bloat. '
  'Caio 2026-05-20.';


-- =============================================================================
-- Função registrar_saidas_kanban(card_ids uuid[], p_fonte text)
--
-- Compara snapshot atual de v_prioridades_ai contra os card_ids passados.
-- Pra cada card_id em (card_ids - v_prioridades_ai), insere linha em saidas.
-- Idempotente por (card_id, fonte, saiu_em) — chamadas concorrentes ok.
--
-- SECURITY DEFINER + search_path='' (skill supabase-postgres-best-practices)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.registrar_saidas_kanban(
  p_card_ids uuid[],
  p_fonte text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
BEGIN
  IF p_card_ids IS NULL OR array_length(p_card_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_fonte NOT IN ('cron_autonomo','atualizar_geral_manual','outro') THEN
    RAISE EXCEPTION 'fonte inválida: %', p_fonte;
  END IF;

  -- INSERT dos card_ids que NÃO estão mais em v_prioridades_ai
  WITH ainda_na_view AS (
    SELECT card_id FROM public.v_prioridades_ai
    WHERE card_id = ANY(p_card_ids)
  ),
  sairam AS (
    SELECT c.id, c.nf, c.responsavel_relacionamento,
           c.cod_ultima_ocorrencia, c.state
    FROM public.cards c
    WHERE c.id = ANY(p_card_ids)
      AND c.id NOT IN (SELECT card_id FROM ainda_na_view)
  ),
  ins AS (
    INSERT INTO public.prioridades_ai_saidas
      (card_id, nf, responsavel_relacionamento, oc_antes, oc_depois,
       state_depois, motivo, fonte, detalhes)
    SELECT
      s.id, s.nf, s.responsavel_relacionamento,
      NULL,  -- oc_antes desconhecida no DB (snapshot pré não persiste)
      s.cod_ultima_ocorrencia,
      s.state,
      CASE
        WHEN s.state IN ('RESOLVIDO','CANCELADO') THEN 'Card foi pra ' || s.state
        WHEN s.cod_ultima_ocorrencia NOT IN (13, 21) THEN
          'OC avançou para ' || COALESCE(s.cod_ultima_ocorrencia::text, '?')
        ELSE 'SSW lançou ocorrência posterior — card saiu por filtro temporal'
      END,
      p_fonte,
      jsonb_build_object(
        'cod_ultima_ocorrencia', s.cod_ultima_ocorrencia,
        'state', s.state
      )
    FROM sairam s
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_saidas_kanban(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_saidas_kanban(uuid[], text) TO service_role;

COMMENT ON FUNCTION public.registrar_saidas_kanban IS
  'Detecta cards do array que NÃO estão mais em v_prioridades_ai e registra '
  'em prioridades_ai_saidas. Chamada por cron-sync-prioridades-ai e '
  'atualizar-batch-prioridades-ai DEPOIS do refresh dos históricos. '
  'Caio 2026-05-20.';


-- =============================================================================
-- View pro front consumir
-- =============================================================================

CREATE OR REPLACE VIEW public.v_prioridades_ai_saidas_recentes
WITH (security_invoker = on) AS
SELECT
  id, card_id, nf, responsavel_relacionamento,
  oc_antes, oc_depois, state_depois, motivo, fonte, detalhes,
  saiu_em
FROM public.prioridades_ai_saidas
WHERE saiu_em > now() - interval '24 hours'
ORDER BY saiu_em DESC;

GRANT SELECT ON public.v_prioridades_ai_saidas_recentes TO authenticated, service_role;

COMMENT ON VIEW public.v_prioridades_ai_saidas_recentes IS
  'Cards que saíram do kanban PRIORIDADES AI nas últimas 24h. Front consulta '
  'pra widget "Saídas recentes". Caio 2026-05-20.';
