-- ============================================================================
-- Cockpit v2 — fix indicador "Acerto Agente IA — Ocs Padrão" + RPC implícita
-- Caio 2026-05-23
--
-- BUGS DIAGNOSTICADOS (Larissa marcou 3 IA acertou via 👍, indicador mostra NaN):
--
-- Bug 1 — view exclui cards aprovados:
--   v_agente_ocs_padrao_metricas filtra `c.cod_ultima_ocorrencia IN (10,11,19,35)`.
--   Depois que operador aprova oc=54+template, card avança pra oc=54 e SOME
--   da view. Resultado: 3 cards LARISSA com feedback ficam invisíveis.
--   total_sugestoes=0 nas linhas que importam, acertos_confirmados=0, pct=NULL,
--   front renderiza NaN%.
--
-- Bug 2 — RPC implícita não registra acerto:
--   registrar_feedback_ocs_padrao_implicito tem `IF p_codigo_aprovado =
--   v_proposta_destacada THEN RETURN NULL` — quando operador aprova
--   exatamente o que IA sugeriu, NÃO grava feedback. Resultado: 100% dos
--   acertos são invisíveis (a menos que operador clique 👍 manualmente,
--   que ninguém faz).
--
-- FIX:
--   1. View usa snapshot `codigo_oc_card` do feedback quando card já avançou.
--      Cards aprovados sem feedback (acerto implícito não gravado) ainda saem
--      da view — mas o Bug 2 também é fixado, então a partir de agora todo
--      executor.aprovar registra acerto/erro implícito.
--   2. RPC implícita passa a registrar TANTO acerto quanto erro:
--      - p_codigo_aprovado = v_proposta_destacada → 'sugestao_certa_implicita'
--      - p_codigo_aprovado ≠ v_proposta_destacada → 'sugestao_errada_implicita'
--      Idempotente por (card_id, tipo LIKE '%_implicita').
--   3. View ganha colunas claras: acertos_total, erros_total, pct_acerto_ia
--      computado como acertos / (acertos+erros). Mantém campos legados
--      (corrigidas_explicitas/implicitas/acertos_confirmados) pra
--      retrocompat do front Lovable em deploy enquanto patch chega.
--
-- skill: supabase-postgres-best-practices
--   * GRANT explícito (memory feedback_rls_grant_antes_de_policy)
--   * security_invoker=on (memory feedback_views_publicas_security_invoker)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RPC implícita: registra acerto E erro (não retorna mais NULL no match)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_feedback_ocs_padrao_implicito(
  p_card_id uuid,
  p_codigo_aprovado int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_proposta_destacada int;
  v_tipo text;
BEGIN
  SELECT analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  -- Filtro de escopo: card no momento da aprovação precisa estar em 10/11/19/35
  -- (executor chama esta RPC ANTES de avançar a oc — então cod_ultima_ocorrencia
  -- ainda é a original quando o agente sugeriu). Cards fora do escopo (já em
  -- 54/56/etc) não geram feedback implícito.
  IF v_codigo_oc NOT IN (10, 11, 19, 35) THEN
    RETURN NULL;
  END IF;

  v_proposta_destacada := (v_decisao_ia->>'proposta_destacada')::int;
  IF v_proposta_destacada IS NULL THEN
    RETURN NULL;
  END IF;

  -- ✅ Caio 2026-05-23: agora registra TANTO acerto quanto erro implícito.
  -- Antes a RPC retornava NULL no match → acertos eram invisíveis no indicador.
  IF p_codigo_aprovado = v_proposta_destacada THEN
    v_tipo := 'sugestao_certa_implicita';
  ELSE
    v_tipo := 'sugestao_errada_implicita';
  END IF;

  -- Idempotência: 1 registro implícito por card (qualquer tipo)
  IF EXISTS (
    SELECT 1 FROM public.agente_ocs_padrao_feedback
    WHERE card_id = p_card_id AND tipo_feedback LIKE 'sugestao_%_implicita'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, v_tipo, v_decisao_ia,
    CASE WHEN v_tipo = 'sugestao_errada_implicita' THEN p_codigo_aprovado ELSE NULL END,
    NULL, NULL, 'executor (implícito)'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_feedback_ocs_padrao_implicito(uuid, int) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_ocs_padrao_implicito(uuid, int) TO service_role;

COMMENT ON FUNCTION public.registrar_feedback_ocs_padrao_implicito IS
  'v2 Caio 2026-05-23: registra acerto (codigo=proposta) E erro (codigo≠proposta) implícitos. '
  'Idempotente por card. Executor chama após aprovação.';


-- ----------------------------------------------------------------------------
-- 2. View: cards com feedback continuam visíveis mesmo após oc avançar
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_agente_ocs_padrao_metricas CASCADE;
CREATE VIEW public.v_agente_ocs_padrao_metricas
WITH (security_invoker = on) AS
WITH cards_com_sugestao AS (
  SELECT
    c.id AS card_id,
    date_trunc('day', c.analise_padrao_atualizado_em)::date AS dia,
    c.responsavel_relacionamento AS operador,
    (c.analise_padrao_resultado->>'proposta_destacada')::int AS proposta_destacada,
    -- Código da oc original: fonte canônica é o evento AgenteOcsPadraoDecisao
    -- (snapshot no momento da análise). Fallback pra cod_ultima_ocorrencia
    -- quando card ainda está em 10/11/19/35 e não tem evento (raro).
    COALESCE(
      (SELECT (ce.payload->>'codigo_oc_card')::int
         FROM public.card_events ce
         WHERE ce.card_id = c.id
           AND ce.event_type = 'AgenteOcsPadraoDecisao'
         ORDER BY ce.created_at DESC LIMIT 1),
      CASE WHEN c.cod_ultima_ocorrencia IN (10,11,19,35) THEN c.cod_ultima_ocorrencia END
    ) AS codigo_oc
  FROM public.cards c
  WHERE c.analise_padrao_status = 'concluida'
    AND c.analise_padrao_atualizado_em IS NOT NULL
),
agg_fb AS (
  SELECT
    card_id,
    -- Veredito ÚNICO por card. Explícito vence implícito (intencional > inferido).
    -- Se houver tanto certa quanto errada explícitas (operador trocou ideia),
    -- a mais recente prevalece — vem por DESC corrigido_em.
    CASE
      WHEN bool_or(tipo_feedback = 'sugestao_certa_explicita')
        AND NOT bool_or(tipo_feedback = 'sugestao_errada_explicita')
        THEN 'acerto'
      WHEN bool_or(tipo_feedback = 'sugestao_errada_explicita')
        AND NOT bool_or(tipo_feedback = 'sugestao_certa_explicita')
        THEN 'erro'
      -- ambos explícitos: usa o mais recente
      WHEN bool_or(tipo_feedback = 'sugestao_certa_explicita')
        AND bool_or(tipo_feedback = 'sugestao_errada_explicita') THEN
          (SELECT CASE WHEN f.tipo_feedback = 'sugestao_certa_explicita' THEN 'acerto' ELSE 'erro' END
             FROM public.agente_ocs_padrao_feedback f
             WHERE f.card_id = a.card_id
               AND f.tipo_feedback IN ('sugestao_certa_explicita','sugestao_errada_explicita')
             ORDER BY f.corrigido_em DESC LIMIT 1)
      WHEN bool_or(tipo_feedback = 'sugestao_certa_implicita')  THEN 'acerto'
      WHEN bool_or(tipo_feedback = 'sugestao_errada_implicita') THEN 'erro'
    END AS veredito,
    bool_or(tipo_feedback = 'sugestao_certa_explicita')  AS acerto_explicito,
    bool_or(tipo_feedback = 'sugestao_certa_implicita')  AS acerto_implicito,
    bool_or(tipo_feedback = 'sugestao_errada_explicita') AS erro_explicito,
    bool_or(tipo_feedback = 'sugestao_errada_implicita') AS erro_implicito
  FROM public.agente_ocs_padrao_feedback a
  GROUP BY card_id
)
SELECT
  cs.dia,
  cs.codigo_oc,
  cs.operador,
  cs.proposta_destacada,
  COUNT(*) AS total_sugestoes,
  -- Buckets claros (novos) — veredito ÚNICO por card
  COUNT(*) FILTER (WHERE f.veredito = 'acerto') AS acertos_total,
  COUNT(*) FILTER (WHERE f.veredito = 'erro')   AS erros_total,
  COUNT(*) FILTER (WHERE f.acerto_explicito)    AS acertos_explicitos,
  COUNT(*) FILTER (WHERE f.acerto_implicito)    AS acertos_implicitos,
  COUNT(*) FILTER (WHERE f.erro_explicito)      AS erros_explicitos,
  COUNT(*) FILTER (WHERE f.erro_implicito)      AS erros_implicitos,
  COUNT(*) FILTER (WHERE f.veredito IS NULL)    AS sem_feedback,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE f.veredito = 'acerto')::numeric
         / NULLIF(COUNT(*) FILTER (WHERE f.veredito IS NOT NULL), 0)
  , 1) AS pct_acerto_ia,
  -- Campos legados (retrocompat com front Lovable atual)
  COUNT(*) FILTER (WHERE f.erro_explicito)      AS corrigidas_explicitas,
  COUNT(*) FILTER (WHERE f.erro_implicito)      AS corrigidas_implicitas,
  COUNT(*) FILTER (WHERE f.veredito = 'acerto') AS acertos_confirmados
FROM cards_com_sugestao cs
LEFT JOIN agg_fb f ON f.card_id = cs.card_id
WHERE cs.codigo_oc IS NOT NULL
GROUP BY cs.dia, cs.codigo_oc, cs.operador, cs.proposta_destacada
ORDER BY cs.dia DESC, cs.codigo_oc, cs.operador;

GRANT SELECT ON public.v_agente_ocs_padrao_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_agente_ocs_padrao_metricas IS
  'v2 Caio 2026-05-23: usa snapshot codigo_oc_card do feedback quando card '
  'já avançou pra oc=54/56/etc. Cards aprovados continuam contando no total. '
  'pct_acerto_ia = acertos / (acertos + erros) — exclui sem_feedback. '
  'Buckets: acertos_total/erros_total + breakdown explícito/implícito. '
  'Mantém campos legados (corrigidas_*/acertos_confirmados) pra retrocompat.';


-- ----------------------------------------------------------------------------
-- 3. BACKFILL: cards já aprovados (cod_ultima_ocorrencia != 10/11/19/35)
--    que tinham analise_padrao_status='concluida' e NÃO têm feedback ainda.
--    Estes representam acertos/erros implícitos que ficaram sem registro
--    enquanto o Bug 2 estava ativo. Tentamos inferir pelo card_event de
--    aprovação.
-- ----------------------------------------------------------------------------
-- Inferência: cards onde proposta_destacada match com codigo aprovado via
-- evento ToDoAprovadoOperador → acerto_implicito. Onde mismatch → erro_implicito.
-- Esta lógica é best-effort: usa o ÚLTIMO evento de aprovação posterior à
-- conclusão da análise. Idempotente via UNIQUE (card_id, tipo LIKE _implicita).
INSERT INTO public.agente_ocs_padrao_feedback (
  card_id, codigo_oc_card, tipo_feedback, decisao_ia,
  decisao_correta_codigo_ssw, motivo_correcao, corrigido_por, corrigido_por_nome
)
SELECT
  c.id,
  -- Snapshot da oc original no momento da análise.
  -- AgenteOcsPadraoDecisao.payload->>'codigo_oc_card' é a fonte canônica.
  COALESCE(
    (SELECT (ce.payload->>'codigo_oc_card')::int
       FROM public.card_events ce
       WHERE ce.card_id = c.id
         AND ce.event_type = 'AgenteOcsPadraoDecisao'
       ORDER BY ce.created_at DESC LIMIT 1),
    10  -- fallback raro (não deveria acontecer)
  ) AS codigo_oc_card,
  CASE
    WHEN (
      SELECT (ce.payload->>'codigo_ssw')::int
        FROM public.card_events ce
        WHERE ce.card_id = c.id
          AND ce.event_type = 'AcaoExecutada'
          AND ce.created_at > c.analise_padrao_atualizado_em
        ORDER BY ce.created_at DESC LIMIT 1
    ) = (c.analise_padrao_resultado->>'proposta_destacada')::int
    THEN 'sugestao_certa_implicita'
    ELSE 'sugestao_errada_implicita'
  END AS tipo_feedback,
  c.analise_padrao_resultado AS decisao_ia,
  CASE
    WHEN (
      SELECT (ce.payload->>'codigo_ssw')::int
        FROM public.card_events ce
        WHERE ce.card_id = c.id
          AND ce.event_type = 'AcaoExecutada'
          AND ce.created_at > c.analise_padrao_atualizado_em
        ORDER BY ce.created_at DESC LIMIT 1
    ) != (c.analise_padrao_resultado->>'proposta_destacada')::int
    THEN (
      SELECT (ce.payload->>'codigo_ssw')::int
        FROM public.card_events ce
        WHERE ce.card_id = c.id
          AND ce.event_type = 'AcaoExecutada'
          AND ce.created_at > c.analise_padrao_atualizado_em
        ORDER BY ce.created_at DESC LIMIT 1
    )
    ELSE NULL
  END AS decisao_correta_codigo_ssw,
  NULL, NULL, 'backfill (implícito retroativo mig 161)'
FROM public.cards c
WHERE c.analise_padrao_status = 'concluida'
  AND c.cod_ultima_ocorrencia NOT IN (10, 11, 19, 35)
  AND (c.analise_padrao_resultado->>'proposta_destacada')::int IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.agente_ocs_padrao_feedback f
    WHERE f.card_id = c.id AND f.tipo_feedback LIKE 'sugestao_%_implicita'
  )
  AND EXISTS (
    -- Só backfill se conseguir achar evento de aprovação posterior à análise
    SELECT 1 FROM public.card_events ce
    WHERE ce.card_id = c.id
      AND ce.event_type = 'AcaoExecutada'
      AND ce.created_at > c.analise_padrao_atualizado_em
  )
ON CONFLICT DO NOTHING;
