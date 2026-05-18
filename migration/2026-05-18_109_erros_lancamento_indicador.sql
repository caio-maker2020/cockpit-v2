-- ============================================================================
-- Cockpit v2 — Indicador "Erros de Lançamento da Base" + aba INDICADORES
-- Data: 2026-05-18
--
-- Operador clica "REPORTAR ERRO" em cada ocorrência exibida no histórico SSW
-- do card. Indica qual era a oc correta + motivo opcional. Reports são
-- agregados na nova aba INDICADORES (visível pra todos: operadores + gestor).
--
-- Componentes:
--   1. Tabela erros_lancamento_ssw (storage mínimo)
--   2. View v_indicador_erros_lancamento_base (agregado por base/usuário/erro)
--   3. View v_erros_lancamento_detalhe (drilldown)
--   4. RPC reportar_erro_lancamento (operador chama no submit do modal)
--   5. Tabela analises_ia_indicadores (cache da análise IA Sonnet 4.6 com TTL)
--   6. Tabela cobrancas_enviadas (auditoria de relatórios/cobranças)
--   7. RLS aberta pra authenticated (decisão Caio: info compartilhada)
--
-- Arquitetura extensível: tabela cache `analises_ia_indicadores` é genérica
-- com `indicador_tipo` — próximos indicadores reusam mesma infra.
-- ============================================================================

-- ----- 1. Tabela erros_lancamento_ssw -------------------------------------

CREATE TABLE IF NOT EXISTS public.erros_lancamento_ssw (
  id bigserial PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  codigo_oc_errada int NOT NULL,
  codigo_oc_correta int NOT NULL,
  descricao_oc_errada text,
  data_oc_errada text,
  base_responsavel text NOT NULL,
  usuario_responsavel text NOT NULL,
  motivo text,
  reportado_por uuid NOT NULL,
  reportado_por_nome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, codigo_oc_errada, data_oc_errada, usuario_responsavel)
);

CREATE INDEX IF NOT EXISTS idx_erros_lancamento_base
  ON public.erros_lancamento_ssw(base_responsavel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erros_lancamento_usuario
  ON public.erros_lancamento_ssw(usuario_responsavel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_erros_lancamento_created
  ON public.erros_lancamento_ssw(created_at DESC);

ALTER TABLE public.erros_lancamento_ssw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS erros_select_authenticated ON public.erros_lancamento_ssw;
CREATE POLICY erros_select_authenticated ON public.erros_lancamento_ssw
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS erros_insert_authenticated ON public.erros_lancamento_ssw;
CREATE POLICY erros_insert_authenticated ON public.erros_lancamento_ssw
  FOR INSERT TO authenticated WITH CHECK (reportado_por = auth.uid());

COMMENT ON TABLE public.erros_lancamento_ssw IS
  'Caio 2026-05-18: registros de erros de lançamento de oc pela base SSW. '
  'Operador reporta via botão "REPORTAR ERRO" no histórico SSW do card. '
  'Agregado na view v_indicador_erros_lancamento_base.';

-- ----- 2. View agregada (1º indicador) ------------------------------------

DROP VIEW IF EXISTS public.v_indicador_erros_lancamento_base CASCADE;

CREATE VIEW public.v_indicador_erros_lancamento_base AS
SELECT
  e.base_responsavel,
  e.usuario_responsavel,
  e.codigo_oc_errada,
  e.codigo_oc_correta,
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
      'reportado_por_nome', e.reportado_por_nome,
      'created_at', e.created_at
    )
    ORDER BY e.created_at DESC
  ) AS erros_detalhe
FROM public.erros_lancamento_ssw e
JOIN public.cards c ON c.id = e.card_id
GROUP BY e.base_responsavel, e.usuario_responsavel, e.codigo_oc_errada, e.codigo_oc_correta
ORDER BY total_erros DESC;

GRANT SELECT ON public.v_indicador_erros_lancamento_base TO authenticated, service_role;

COMMENT ON VIEW public.v_indicador_erros_lancamento_base IS
  'Agregação por base + usuário + erro. Filtro temporal aplicado no front via '
  'WHERE primeiro_erro/ultimo_erro >= X. erros_detalhe é jsonb pra drilldown.';

-- ----- 3. View detalhada (drilldown linha-a-linha) -----------------------

DROP VIEW IF EXISTS public.v_erros_lancamento_detalhe CASCADE;

CREATE VIEW public.v_erros_lancamento_detalhe AS
SELECT
  e.id,
  e.card_id,
  c.nf,
  c.ctrc,
  e.codigo_oc_errada,
  e.codigo_oc_correta,
  e.descricao_oc_errada,
  e.data_oc_errada,
  e.base_responsavel,
  e.usuario_responsavel,
  e.motivo,
  e.reportado_por,
  e.reportado_por_nome,
  e.created_at
FROM public.erros_lancamento_ssw e
JOIN public.cards c ON c.id = e.card_id
ORDER BY e.created_at DESC;

GRANT SELECT ON public.v_erros_lancamento_detalhe TO authenticated, service_role;

-- ----- 4. RPC reportar_erro_lancamento -----------------------------------

CREATE OR REPLACE FUNCTION public.reportar_erro_lancamento(
  p_card_id uuid,
  p_codigo_oc_errada int,
  p_codigo_oc_correta int,
  p_descricao_oc_errada text DEFAULT NULL,
  p_data_oc_errada text DEFAULT NULL,
  p_base_responsavel text DEFAULT NULL,
  p_usuario_responsavel text DEFAULT NULL,
  p_motivo text DEFAULT NULL
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
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT nome INTO v_nome FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_nome IS NULL THEN
    v_nome := 'desconhecido';
  END IF;

  -- Valida acesso ao card (mesma regra das outras tabelas)
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

  INSERT INTO public.erros_lancamento_ssw (
    card_id, codigo_oc_errada, codigo_oc_correta,
    descricao_oc_errada, data_oc_errada,
    base_responsavel, usuario_responsavel,
    motivo, reportado_por, reportado_por_nome
  ) VALUES (
    p_card_id, p_codigo_oc_errada, p_codigo_oc_correta,
    p_descricao_oc_errada, p_data_oc_errada,
    p_base_responsavel, p_usuario_responsavel,
    NULLIF(trim(COALESCE(p_motivo, '')), ''),
    v_user, v_nome
  )
  ON CONFLICT (card_id, codigo_oc_errada, data_oc_errada, usuario_responsavel)
  DO UPDATE SET
    codigo_oc_correta = EXCLUDED.codigo_oc_correta,
    motivo = EXCLUDED.motivo,
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
      'codigo_oc_correta', p_codigo_oc_correta,
      'base_responsavel', p_base_responsavel,
      'usuario_responsavel', p_usuario_responsavel,
      'motivo', p_motivo
    )
  );

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reportar_erro_lancamento(uuid, int, int, text, text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.reportar_erro_lancamento IS
  'Caio 2026-05-18: operador reporta que uma oc foi lançada errada pela base. '
  'Idempotente — segundo report do mesmo (card, oc errada, data, usuário SSW) atualiza ao invés de duplicar.';

-- ----- 5. Tabela analises_ia_indicadores (cache genérico) -----------------

CREATE TABLE IF NOT EXISTS public.analises_ia_indicadores (
  id bigserial PRIMARY KEY,
  indicador_tipo text NOT NULL,            -- ex: 'erros_lancamento_base'
  filtros jsonb NOT NULL DEFAULT '{}'::jsonb, -- chave de cache (periodo + bases + etc)
  resultado jsonb NOT NULL,                -- JSON estruturado da IA
  gerado_por uuid,                         -- auth.uid() que disparou
  gerado_em timestamptz NOT NULL DEFAULT now(),
  modelo text NOT NULL DEFAULT 'claude-sonnet-4-6'
);

CREATE INDEX IF NOT EXISTS idx_analises_ia_tipo_filtros
  ON public.analises_ia_indicadores(indicador_tipo, gerado_em DESC);

ALTER TABLE public.analises_ia_indicadores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analises_ia_select_authenticated ON public.analises_ia_indicadores;
CREATE POLICY analises_ia_select_authenticated ON public.analises_ia_indicadores
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.analises_ia_indicadores IS
  'Cache de análises da IA (Sonnet 4.6) por (indicador_tipo, filtros). TTL 24h. '
  'Cleanup periódico: DELETE WHERE gerado_em < now() - interval ''7 days''.';

-- ----- 6. Tabela cobrancas_enviadas (auditoria) ---------------------------

CREATE TABLE IF NOT EXISTS public.cobrancas_enviadas (
  id bigserial PRIMARY KEY,
  indicador_tipo text NOT NULL,
  canal text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  destinatarios text[] NOT NULL,
  assunto text,
  corpo_html text,
  sugerido_por_ia boolean NOT NULL DEFAULT false,
  enviado_por uuid NOT NULL,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  resposta_canal jsonb                     -- ex: gmail message id
);

CREATE INDEX IF NOT EXISTS idx_cobrancas_indicador_data
  ON public.cobrancas_enviadas(indicador_tipo, enviado_em DESC);

ALTER TABLE public.cobrancas_enviadas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cobrancas_select_authenticated ON public.cobrancas_enviadas;
CREATE POLICY cobrancas_select_authenticated ON public.cobrancas_enviadas
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cobrancas_insert_authenticated ON public.cobrancas_enviadas;
CREATE POLICY cobrancas_insert_authenticated ON public.cobrancas_enviadas
  FOR INSERT TO authenticated WITH CHECK (enviado_por = auth.uid());

COMMENT ON TABLE public.cobrancas_enviadas IS
  'Caio 2026-05-18: log de cobranças/relatórios enviados via edge function '
  'enviar-cobranca-base. sugerido_por_ia=true indica que o texto veio da '
  'análise IA (pode ter sido editado antes de enviar).';
