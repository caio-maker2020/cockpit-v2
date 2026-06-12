-- ============================================================================
-- Cockpit v2 — Feedback loop "operador corrige IA" pra interpretador de
-- resposta do cliente (emails inbound)
-- Caio 2026-05-23
--
-- CONTEXTO: edge `interpretador-resposta-cliente` lê email do cliente que
-- voltou, infere intenção, e propõe próxima oc (54 follow-up, 56 falta info,
-- 33 ressarcimento etc) em `cards.ia_sugestao_oc_resposta`. Operador vê no
-- card e aprova/recusa. Hoje não há rastreamento de acerto.
--
-- Esta migration introduz:
--   1. Tabela `interpretador_resposta_cliente_feedback` (positivo + negativo)
--   2. RPC explícita `registrar_feedback_interpretador_resposta_ia`
--      - operador clica 👍 (acertou) ou 👎 (errou) no card
--      - 👎 exige motivo (>=10 chars)
--      - 👍 é opcional registrar — operador pode confirmar mesmo antes de aprovar
--   3. RPC implícita `registrar_feedback_interpretador_resposta_implicito`
--      - executor chama após aprovar todo: se codigo_aprovado == ia.oc_sugerida
--        registra acerto implícito; senão erro implícito
--      - idempotente (1 registro por card)
--   4. View `v_interpretador_resposta_metricas` pra abastecer indicador
--      "🎯 Acerto Agente IA — Interpretação de Email" na aba INDICADORES
--
-- Espelha mig 149 (oc13) e 151 (ocs padrao) mas com:
--   - Suporte explícito a feedback POSITIVO (acertos), não só correção
--   - Granularidade por message_id (qual email gerou aquela sugestão)
--
-- skill: supabase-postgres-best-practices
--   * RLS + GRANT explícito (memory feedback_rls_grant_antes_de_policy)
--   * security_invoker=on na view (memory feedback_views_publicas_security_invoker)
--   * idempotência via UNIQUE em (card_id, message_id, tipo_origem)
-- ============================================================================

-- 1. Tabela
CREATE TABLE IF NOT EXISTS public.interpretador_resposta_cliente_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  message_id uuid,                          -- email_messages.id que gerou sugestão
  oc_card_no_momento int,                   -- cod_ultima_ocorrencia do card quando IA sugeriu
  tipo_feedback text NOT NULL CHECK (tipo_feedback IN (
    'acertou_explicito',                    -- 👍 do operador
    'errou_explicito',                      -- 👎 do operador (com motivo)
    'acertou_implicito',                    -- aprovou exatamente o que IA sugeriu
    'errou_implicito'                       -- aprovou oc != sugerida pela IA
  )),
  decisao_ia jsonb NOT NULL,                -- snapshot do ia_sugestao_oc_resposta
  oc_sugerida_pela_ia int,                  -- oc_sugerida extraído pra facilitar agregação
  decisao_correta_codigo_ssw int,           -- oc que operador disse ser a certa (NULL pra acertos)
  motivo_correcao text,                     -- obrigatório só pra errou_explicito
  corrigido_por uuid REFERENCES public.operadores(id),
  corrigido_por_nome text,
  corrigido_em timestamptz NOT NULL DEFAULT now(),
  -- Coluna gerada pra simplificar UNIQUE + ON CONFLICT (PG não aceita
  -- expressão CASE em ON CONFLICT target).
  origem text GENERATED ALWAYS AS (
    CASE WHEN tipo_feedback IN ('acertou_explicito','errou_explicito') THEN 'explicito' ELSE 'implicito' END
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_feedback_interp_resp_card
  ON public.interpretador_resposta_cliente_feedback (card_id, corrigido_em DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_interp_resp_tipo
  ON public.interpretador_resposta_cliente_feedback (tipo_feedback, corrigido_em DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_interp_resp_oc_sugerida
  ON public.interpretador_resposta_cliente_feedback (oc_sugerida_pela_ia, corrigido_em DESC);

-- Idempotência: 1 registro por (card, message_id, origem).
-- Operador pode dar feedback explícito 1x; executor registra implícito 1x.
-- Se operador mudar de ideia (👍 → 👎), RPC faz ON CONFLICT DO UPDATE no
-- bucket explícito.
-- COALESCE em message_id pra cobrir caso de NULL (sugestão antiga sem msg id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_interp_resp_card_msg_origem
  ON public.interpretador_resposta_cliente_feedback (
    card_id,
    COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origem
  );

ALTER TABLE public.interpretador_resposta_cliente_feedback ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.interpretador_resposta_cliente_feedback TO authenticated;
GRANT ALL ON public.interpretador_resposta_cliente_feedback TO service_role;

DROP POLICY IF EXISTS feedback_interp_resp_select ON public.interpretador_resposta_cliente_feedback;
CREATE POLICY feedback_interp_resp_select ON public.interpretador_resposta_cliente_feedback
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = interpretador_resposta_cliente_feedback.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

-- INSERT só via RPC (service_role bypass), não direto pelo cliente
DROP POLICY IF EXISTS feedback_interp_resp_insert ON public.interpretador_resposta_cliente_feedback;
CREATE POLICY feedback_interp_resp_insert ON public.interpretador_resposta_cliente_feedback
  FOR INSERT TO authenticated WITH CHECK (false);

COMMENT ON TABLE public.interpretador_resposta_cliente_feedback IS
  'Feedback loop operador→IA pra interpretador-resposta-cliente. Caio 2026-05-23. '
  'Suporta feedback positivo (acerto) e negativo (erro). Implícito gerado pelo executor.';


-- 2. RPC explícita (operador clica 👍 ou 👎 no card)
CREATE OR REPLACE FUNCTION public.registrar_feedback_interpretador_resposta_ia(
  p_card_id uuid,
  p_acertou boolean,
  p_decisao_correta_codigo_ssw int DEFAULT NULL,
  p_motivo_correcao text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_oc_sugerida int;
  v_message_id uuid;
  v_codigo_oc int;
  v_motivo_limpo text;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_tipo text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, ia_sugestao_oc_resposta, cod_ultima_ocorrencia
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % sem sugestão IA de resposta — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra registrar feedback neste card' USING ERRCODE = '42501';
  END IF;

  v_oc_sugerida := (v_decisao_ia->>'oc_sugerida')::int;
  v_message_id  := NULLIF(v_decisao_ia->>'message_id','')::uuid;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN v_nome := 'desconhecido'; END IF;

  IF p_acertou THEN
    v_tipo := 'acertou_explicito';
    v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');  -- opcional
  ELSE
    v_tipo := 'errou_explicito';
    v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
    IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
      RAISE EXCEPTION 'Motivo da correção é obrigatório (mínimo 10 caracteres) quando IA errou' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Upsert: se operador clica 👍 e depois muda pra 👎 (ou vice-versa),
  -- atualiza o registro existente em vez de duplicar.
  INSERT INTO public.interpretador_resposta_cliente_feedback (
    card_id, message_id, oc_card_no_momento, tipo_feedback, decisao_ia,
    oc_sugerida_pela_ia, decisao_correta_codigo_ssw, motivo_correcao,
    corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_message_id, v_codigo_oc, v_tipo, v_decisao_ia,
    v_oc_sugerida, p_decisao_correta_codigo_ssw, v_motivo_limpo,
    v_user, v_nome
  )
  ON CONFLICT (
    card_id,
    COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origem
  )
  DO UPDATE SET
    tipo_feedback = EXCLUDED.tipo_feedback,
    decisao_correta_codigo_ssw = EXCLUDED.decisao_correta_codigo_ssw,
    motivo_correcao = EXCLUDED.motivo_correcao,
    corrigido_por = EXCLUDED.corrigido_por,
    corrigido_por_nome = EXCLUDED.corrigido_por_nome,
    corrigido_em = now()
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackInterpretadorRespostaCliente', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'tipo_feedback', v_tipo,
      'oc_sugerida_pela_ia', v_oc_sugerida,
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_feedback_interpretador_resposta_ia(uuid, boolean, int, text) TO authenticated;

COMMENT ON FUNCTION public.registrar_feedback_interpretador_resposta_ia IS
  'Operador registra 👍 (acertou) ou 👎 (errou) na sugestão IA de resposta de cliente. '
  'Motivo obrigatório quando errou. Idempotente (upsert por card+message). Caio 2026-05-23.';


-- 3. RPC implícita (chamada pelo executor após aprovação)
CREATE OR REPLACE FUNCTION public.registrar_feedback_interpretador_resposta_implicito(
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
  v_oc_sugerida int;
  v_codigo_oc int;
  v_message_id uuid;
  v_tipo text;
BEGIN
  SELECT ia_sugestao_oc_resposta, cod_ultima_ocorrencia
    INTO v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  v_oc_sugerida := (v_decisao_ia->>'oc_sugerida')::int;
  v_message_id  := NULLIF(v_decisao_ia->>'message_id','')::uuid;
  IF v_oc_sugerida IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_codigo_aprovado = v_oc_sugerida THEN
    v_tipo := 'acertou_implicito';
  ELSE
    v_tipo := 'errou_implicito';
  END IF;

  INSERT INTO public.interpretador_resposta_cliente_feedback (
    card_id, message_id, oc_card_no_momento, tipo_feedback, decisao_ia,
    oc_sugerida_pela_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_message_id, v_codigo_oc, v_tipo, v_decisao_ia,
    v_oc_sugerida,
    CASE WHEN v_tipo = 'errou_implicito' THEN p_codigo_aprovado ELSE NULL END,
    NULL, NULL, 'executor (implícito)'
  )
  ON CONFLICT (
    card_id,
    COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid),
    origem
  )
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_feedback_interpretador_resposta_implicito(uuid, int) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.registrar_feedback_interpretador_resposta_implicito(uuid, int) TO service_role;

COMMENT ON FUNCTION public.registrar_feedback_interpretador_resposta_implicito IS
  'Executor chama após aprovar todo. Compara codigo aprovado vs oc_sugerida da IA. '
  'Idempotente (1 registro implícito por card+message). Caio 2026-05-23.';


-- 4. View métricas por dia × operador × oc sugerida
DROP VIEW IF EXISTS public.v_interpretador_resposta_metricas CASCADE;
CREATE VIEW public.v_interpretador_resposta_metricas
WITH (security_invoker = on) AS
WITH eventos_sugestao AS (
  -- Cada sugestão da IA é um evento. Quando ia_sugestao_oc_resposta foi
  -- escrita pelo interpretador, isso conta como uma sugestão.
  -- Usa ce.payload pra timestamp confiável + operador responsável atual.
  SELECT
    ce.card_id,
    date_trunc('day', ce.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
    (ce.payload->>'oc_sugerida')::int AS oc_sugerida,
    c.responsavel_relacionamento AS operador,
    ce.created_at
  FROM public.card_events ce
  JOIN public.cards c ON c.id = ce.card_id
  WHERE ce.event_type = 'InterpretadorRespostaClienteConcluido'
),
agg_fb AS (
  SELECT
    card_id,
    bool_or(tipo_feedback IN ('acertou_explicito','acertou_implicito')) AS teve_acerto,
    bool_or(tipo_feedback IN ('errou_explicito','errou_implicito'))     AS teve_erro,
    bool_or(tipo_feedback = 'acertou_explicito')                        AS acerto_explicito,
    bool_or(tipo_feedback = 'errou_explicito')                          AS erro_explicito,
    bool_or(tipo_feedback = 'acertou_implicito')                        AS acerto_implicito,
    bool_or(tipo_feedback = 'errou_implicito')                          AS erro_implicito
  FROM public.interpretador_resposta_cliente_feedback
  GROUP BY card_id
)
SELECT
  e.dia,
  e.oc_sugerida,
  e.operador,
  COUNT(*)                                                              AS total_sugestoes,
  COUNT(*) FILTER (WHERE f.teve_acerto)                                 AS acertos_total,
  COUNT(*) FILTER (WHERE f.teve_erro)                                   AS erros_total,
  COUNT(*) FILTER (WHERE f.acerto_explicito)                            AS acertos_explicitos,
  COUNT(*) FILTER (WHERE f.acerto_implicito)                            AS acertos_implicitos,
  COUNT(*) FILTER (WHERE f.erro_explicito)                              AS erros_explicitos,
  COUNT(*) FILTER (WHERE f.erro_implicito)                              AS erros_implicitos,
  COUNT(*) FILTER (WHERE f.teve_acerto IS NULL AND f.teve_erro IS NULL) AS sem_feedback,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE f.teve_acerto)::numeric
         / NULLIF(COUNT(*) FILTER (WHERE f.teve_acerto OR f.teve_erro), 0)
  , 1) AS pct_acerto_ia
FROM eventos_sugestao e
LEFT JOIN agg_fb f ON f.card_id = e.card_id
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

GRANT SELECT ON public.v_interpretador_resposta_metricas TO authenticated, service_role;

COMMENT ON VIEW public.v_interpretador_resposta_metricas IS
  'Métricas diárias do interpretador-resposta-cliente por oc_sugerida × operador. '
  'pct_acerto = acertos / (acertos + erros) — exclui sem_feedback do denominador. '
  'Alimenta card "🎯 Acerto Agente IA — Interpretação de Email" na aba INDICADORES. '
  'Caio 2026-05-23.';
