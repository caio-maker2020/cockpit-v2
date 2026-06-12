-- ============================================================================
-- Cockpit v2 — adiciona alias `sugestoes_corrigidas` na v_agente_ocs_padrao_metricas
-- Caio 2026-05-23
--
-- BUG: mig 161 (refatoração da view) removeu o campo legado
-- `sugestoes_corrigidas` que o front Lovable lê via:
--
--   const totalCorrigidas = rows.reduce((acc, r) => acc + r.sugestoes_corrigidas, 0);
--   const pctAcerto = totalSugestoes > 0
--     ? Math.round(100 * (1 - totalCorrigidas / totalSugestoes) * 10) / 10
--     : null;
--
-- Sem o campo, `r.sugestoes_corrigidas` retorna `undefined`. `acc + undefined`
-- = NaN, e NaN se propaga em todo o cálculo. Frente exibe "NaN%" e "1/NaN".
--
-- FIX: re-expõe `sugestoes_corrigidas` na view. Semântica preserva o original
-- (mig 151) = "cards com feedback de ERRO registrado" (não inclui acertos).
-- Front continua usando `1 - corrigidas/total = acerto` e o cálculo bate
-- enquanto não houver mistura significativa de erros+pendentes.
--
-- O front Lovable PRECISA ser patcheado pra usar `pct_acerto_ia` direto da
-- view (que tem fórmula correta: acertos / (acertos + erros)) — ver prompt
-- `prompts/lovable-fix-indicador-acerto-ia-ocs-padrao-nan.md`. Esta migration
-- é um pano-quente pra desbloquear visualização enquanto patch do front
-- não vai pro ar.
-- ============================================================================

DROP VIEW IF EXISTS public.v_agente_ocs_padrao_metricas CASCADE;
CREATE VIEW public.v_agente_ocs_padrao_metricas
WITH (security_invoker = on) AS
WITH cards_com_sugestao AS (
  SELECT
    c.id AS card_id,
    date_trunc('day', c.analise_padrao_atualizado_em)::date AS dia,
    c.responsavel_relacionamento AS operador,
    (c.analise_padrao_resultado->>'proposta_destacada')::int AS proposta_destacada,
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
    CASE
      WHEN bool_or(tipo_feedback = 'sugestao_certa_explicita')
        AND NOT bool_or(tipo_feedback = 'sugestao_errada_explicita') THEN 'acerto'
      WHEN bool_or(tipo_feedback = 'sugestao_errada_explicita')
        AND NOT bool_or(tipo_feedback = 'sugestao_certa_explicita') THEN 'erro'
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
  -- Buckets claros (novos)
  COUNT(*) FILTER (WHERE f.veredito = 'acerto') AS acertos_total,
  COUNT(*) FILTER (WHERE f.veredito = 'erro')   AS erros_total,
  COUNT(*) FILTER (WHERE f.acerto_explicito)    AS acertos_explicitos,
  COUNT(*) FILTER (WHERE f.acerto_implicito)    AS acertos_implicitos,
  COUNT(*) FILTER (WHERE f.erro_explicito)      AS erros_explicitos,
  COUNT(*) FILTER (WHERE f.erro_implicito)      AS erros_implicitos,
  COUNT(*) FILTER (WHERE f.veredito IS NULL)    AS sem_feedback,
  -- Pct correto: denominador = decisões tomadas (não inclui pendentes)
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE f.veredito = 'acerto')::numeric
         / NULLIF(COUNT(*) FILTER (WHERE f.veredito IS NOT NULL), 0)
  , 1) AS pct_acerto_ia,
  -- LEGACY (retrocompat front Lovable atual):
  --   sugestoes_corrigidas: cards com feedback de ERRO (semantic original mig 151)
  COUNT(*) FILTER (WHERE f.veredito = 'erro')   AS sugestoes_corrigidas,
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
  'v3 Caio 2026-05-23: re-expõe sugestoes_corrigidas (legacy mig 151) pra '
  'desbloquear leitura do front Lovable que ainda usa esse campo. '
  'Mantém os buckets novos (acertos_total/erros_total/sem_feedback). '
  'pct_acerto_ia segue fórmula correta (acertos / decisões tomadas).';
