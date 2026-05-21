-- ============================================================================
-- Cockpit v2 — REPORTAR ERRO: nova categoria "Evidência Incompleta/Indevida"
-- Caio 2026-05-21
--
-- Hoje o "REPORTAR ERRO" só registra quando a OC lançada está errada (ex: base
-- lançou oc=35 mas era oc=49). Existe outro tipo de erro IGUALMENTE relevante:
-- a OC pode estar CORRETA mas a foto/evidência associada está incompleta ou
-- indevida (foto desfocada, sem assinatura, NF errada visível, etc).
--
-- Adiciona categoria `motivo_categoria`:
--   * 'OC_DIFERENTE' (default, retrocompat) — base lançou oc X, deveria ser Y
--   * 'EVIDENCIA_INCOMPLETA' — oc correta, mas a evidência está errada/indevida
--
-- No fluxo de evidência incompleta, oc_correta = oc_errada (mesmo código)
-- e `p_motivo` (texto livre operador) vira OBRIGATÓRIO — explica o que
-- exatamente faltou/estava errado. IA classifica esses textos em
-- sub-categorias pra abastecer indicador.
--
-- skill: supabase-postgres-best-practices
--   - ALTER TABLE com IF NOT EXISTS pra idempotência
--   - DEFAULT preserva retrocompat com rows antigas
--   - CHECK constraint robusto
--   - RPC mantém SECURITY DEFINER + search_path=''
-- ============================================================================

-- 1. Coluna motivo_categoria
ALTER TABLE public.erros_lancamento_ssw
  ADD COLUMN IF NOT EXISTS motivo_categoria text
  NOT NULL
  DEFAULT 'OC_DIFERENTE'
  CHECK (motivo_categoria IN ('OC_DIFERENTE','EVIDENCIA_INCOMPLETA'));

CREATE INDEX IF NOT EXISTS idx_erros_lancamento_categoria
  ON public.erros_lancamento_ssw(motivo_categoria, created_at DESC);

COMMENT ON COLUMN public.erros_lancamento_ssw.motivo_categoria IS
  'OC_DIFERENTE: base lançou oc errada (códigos diferentes). '
  'EVIDENCIA_INCOMPLETA: base lançou oc correta mas evidência inadequada '
  '(operador descreve no campo motivo). Caio 2026-05-21.';


-- 2. RPC v2 — aceita motivo_categoria + valida regras de cada categoria
DROP FUNCTION IF EXISTS public.reportar_erro_lancamento(uuid, int, int, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.reportar_erro_lancamento(
  p_card_id uuid,
  p_codigo_oc_errada int,
  p_codigo_oc_correta int,
  p_descricao_oc_errada text DEFAULT NULL,
  p_data_oc_errada text DEFAULT NULL,
  p_base_responsavel text DEFAULT NULL,
  p_usuario_responsavel text DEFAULT NULL,
  p_motivo text DEFAULT NULL,
  p_motivo_categoria text DEFAULT 'OC_DIFERENTE'
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_nome text;
  v_id bigint;
  v_assigned_op uuid;
  v_pagador text;
  v_segmento text;
  v_oc_correta int;
  v_motivo_limpo text;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN
    v_nome := 'desconhecido';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo
    INTO v_assigned_op, v_pagador, v_segmento
  FROM public.cards WHERE id = p_card_id;

  IF v_assigned_op IS NULL AND v_pagador IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned_op, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra reportar erro neste card' USING ERRCODE = '42501';
  END IF;

  IF p_base_responsavel IS NULL OR p_usuario_responsavel IS NULL THEN
    RAISE EXCEPTION 'base_responsavel e usuario_responsavel são obrigatórios (vêm do historico_ssw)';
  END IF;

  IF p_motivo_categoria NOT IN ('OC_DIFERENTE','EVIDENCIA_INCOMPLETA') THEN
    RAISE EXCEPTION 'motivo_categoria inválido: % (válidos: OC_DIFERENTE | EVIDENCIA_INCOMPLETA)', p_motivo_categoria;
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo, '')), '');

  -- Regras por categoria
  IF p_motivo_categoria = 'EVIDENCIA_INCOMPLETA' THEN
    -- OC correta deve ser a MESMA (a oc está certa, só a evidência está errada)
    v_oc_correta := p_codigo_oc_errada;

    -- Texto livre é OBRIGATÓRIO (sem ele, IA não consegue classificar)
    IF v_motivo_limpo IS NULL OR length(v_motivo_limpo) < 10 THEN
      RAISE EXCEPTION 'Pra erro de evidência, descreva o que exatamente estava errado (mínimo 10 caracteres)'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- OC_DIFERENTE: códigos devem ser distintos
    v_oc_correta := p_codigo_oc_correta;
    IF v_oc_correta = p_codigo_oc_errada THEN
      RAISE EXCEPTION 'Pra erro de OC, oc correta deve ser DIFERENTE da errada (se a oc está certa mas a evidência não, use motivo_categoria=EVIDENCIA_INCOMPLETA)'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.erros_lancamento_ssw (
    card_id, codigo_oc_errada, codigo_oc_correta,
    descricao_oc_errada, data_oc_errada,
    base_responsavel, usuario_responsavel,
    motivo, motivo_categoria,
    reportado_por, reportado_por_nome
  ) VALUES (
    p_card_id, p_codigo_oc_errada, v_oc_correta,
    p_descricao_oc_errada, p_data_oc_errada,
    p_base_responsavel, p_usuario_responsavel,
    v_motivo_limpo, p_motivo_categoria,
    v_user, v_nome
  )
  ON CONFLICT (card_id, codigo_oc_errada, data_oc_errada, usuario_responsavel)
  DO UPDATE SET
    codigo_oc_correta = EXCLUDED.codigo_oc_correta,
    motivo = EXCLUDED.motivo,
    motivo_categoria = EXCLUDED.motivo_categoria,
    reportado_por = EXCLUDED.reportado_por,
    reportado_por_nome = EXCLUDED.reportado_por_nome
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id,
    'ErroLancamentoReportado',
    'operator',
    v_user::text,
    jsonb_build_object(
      'erro_id', v_id,
      'codigo_oc_errada', p_codigo_oc_errada,
      'codigo_oc_correta', v_oc_correta,
      'motivo_categoria', p_motivo_categoria,
      'base_responsavel', p_base_responsavel,
      'usuario_responsavel', p_usuario_responsavel,
      'motivo', v_motivo_limpo
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reportar_erro_lancamento(uuid, int, int, text, text, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.reportar_erro_lancamento IS
  'v2 2026-05-21: aceita motivo_categoria (OC_DIFERENTE | EVIDENCIA_INCOMPLETA). '
  'EVIDENCIA_INCOMPLETA exige motivo texto livre (>=10 chars), oc correta = errada. '
  'OC_DIFERENTE exige oc correta != errada. Idempotente (UPSERT por chave única).';


-- 3. Atualiza views pra expor motivo_categoria
DROP VIEW IF EXISTS public.v_indicador_erros_lancamento_base CASCADE;
CREATE VIEW public.v_indicador_erros_lancamento_base AS
SELECT
  e.base_responsavel,
  e.usuario_responsavel,
  e.codigo_oc_errada,
  e.codigo_oc_correta,
  e.motivo_categoria,
  COUNT(*) AS total_erros,
  MIN(e.created_at) AS primeiro_erro,
  MAX(e.created_at) AS ultimo_erro,
  jsonb_agg(
    jsonb_build_object(
      'id', e.id,
      'card_id', e.card_id,
      'nf', c.nf,
      'ctrc', c.ctrc,
      'data_oc_errada', e.data_oc_errada,
      'descricao_oc_errada', e.descricao_oc_errada,
      'motivo', e.motivo,
      'motivo_categoria', e.motivo_categoria,
      'reportado_por_nome', e.reportado_por_nome,
      'created_at', e.created_at
    )
    ORDER BY e.created_at DESC
  ) AS erros_detalhe
FROM public.erros_lancamento_ssw e
JOIN public.cards c ON c.id = e.card_id
GROUP BY e.base_responsavel, e.usuario_responsavel, e.codigo_oc_errada, e.codigo_oc_correta, e.motivo_categoria
ORDER BY total_erros DESC;

GRANT SELECT ON public.v_indicador_erros_lancamento_base TO authenticated, service_role;

DROP VIEW IF EXISTS public.v_erros_lancamento_detalhe CASCADE;
CREATE VIEW public.v_erros_lancamento_detalhe AS
SELECT
  e.id, e.card_id, c.nf, c.ctrc,
  e.codigo_oc_errada, e.codigo_oc_correta,
  e.descricao_oc_errada, e.data_oc_errada,
  e.base_responsavel, e.usuario_responsavel,
  e.motivo, e.motivo_categoria,
  e.reportado_por, e.reportado_por_nome,
  e.created_at
FROM public.erros_lancamento_ssw e
JOIN public.cards c ON c.id = e.card_id
ORDER BY e.created_at DESC;

GRANT SELECT ON public.v_erros_lancamento_detalhe TO authenticated, service_role;


-- 4. security_invoker=on (memory feedback_views_publicas_security_invoker)
-- Postgres 15+ tem DEFINER como default e bypassa RLS. Toda view pública
-- precisa setar invoker explícito.
ALTER VIEW public.v_indicador_erros_lancamento_base SET (security_invoker = on);
ALTER VIEW public.v_erros_lancamento_detalhe SET (security_invoker = on);
