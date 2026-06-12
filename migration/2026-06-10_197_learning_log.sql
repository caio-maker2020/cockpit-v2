-- ============================================================================
-- Cockpit v2 — learning_log: caderno dos agentes IA externos (Managed Agents)
-- Data: 2026-06-10
--
-- Contexto: 2 Managed Agents da Anthropic vão rodar fora do Cockpit:
--   1. Triagem Noturna (cron 6h BRT) — investiga incidentes da noite,
--      sugere fixes pra aprovação do Caio.
--   2. Aprendizado Contínuo — observer amostrado dos feedbacks da operadora,
--      synthesizer diário, weekly digest domingo 20h BRT.
--
-- Esta tabela é o "caderno do agente". Eventos são PRODUTOS do agente
-- (incidentes detectados, padrões identificados, ajustes sugeridos), não
-- eventos do sistema Cockpit (esses ficam em card_events).
--
-- Referencia tabelas existentes (não duplica):
--   - agente_ocs_padrao_feedback / agente_oc13_feedback → fonte dos sinais
--   - agent_runs → métricas de execução dos agentes IA do Cockpit
--   - todos → resultado das sugestões (aprovado / rejeitado / executado)
--   - cards / card_events → contexto dos incidentes
--
-- Loop fechado via parent_id:
--   padrao_identificado → ajuste_sugerido → ajuste_aprovado → ajuste_aplicado
--     → impacto_medido (semanas depois mede se acerto IA subiu)
--
-- IMPORTANTE: tabela é INSERT-only do lado dos agentes (service_role).
-- Operadores leem; Caio (gestor) revisa status via UPDATE controlado por
-- coluna nominal — não há UPDATE livre de detalhes/resumo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.learning_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---------- IDENTIDADE DO EVENTO ----------
  agente text NOT NULL
    CHECK (agente IN ('triagem-noturna', 'aprendizado-continuo')),

  tipo text NOT NULL
    CHECK (tipo IN (
      'incidente_detectado',     -- Triagem: algo anômalo na noite
      'incidente_resolvido',     -- Triagem: incidente fechou (auto ou manual)
      'padrao_identificado',     -- Aprendizado: cluster de feedbacks bate >threshold
      'ajuste_sugerido',         -- Aprendizado: proposta de mudança em prompt/regra
      'ajuste_aprovado',         -- Caio aprovou via revisão
      'ajuste_rejeitado',        -- Caio rejeitou
      'ajuste_aplicado',         -- PR mergeado / prompt atualizado em produção
      'ajuste_revertido',        -- Reverteu por regressão
      'metrica_snapshot',        -- Snapshot semanal das 6 métricas
      'impacto_medido'           -- Métrica pós-ajuste comparada com baseline
    )),

  severidade text
    CHECK (severidade IN ('info', 'warning', 'critical')),

  titulo text NOT NULL,
  resumo text NOT NULL,
  detalhes jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ---------- REFERÊNCIAS ----------
  -- cards envolvidos no evento (array pq padrão_identificado tipicamente cobre N cards)
  card_ids uuid[] DEFAULT NULL,

  -- agente do Cockpit-alvo do ajuste (ex: 'agente-sugere-ocs-padrao')
  agente_alvo text,
  prompt_alvo text,           -- ex: 'prompts/agente-sugere-ocs-padrao-system.md'
  diff_proposto text,         -- patch unified diff sugerido pelo agente

  -- snapshot das métricas no momento (pra impacto_medido + metrica_snapshot)
  metrica_snapshot jsonb,

  -- ---------- ESTADO DE REVISÃO ----------
  status text NOT NULL DEFAULT 'aberto'
    CHECK (status IN ('aberto', 'aprovado', 'rejeitado', 'aplicado', 'revertido', 'observacao')),

  revisado_por uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  revisado_em timestamptz,
  motivo_decisao text,

  -- ---------- LINKAGEM DO LOOP ----------
  -- parent_id encadeia: padrão → sugestão → aprovação → aplicação → impacto
  parent_id uuid REFERENCES public.learning_log(id) ON DELETE SET NULL,

  -- ---------- AUDITORIA DO AGENTE ----------
  -- agent_run_id NÃO referencia FK porque agent_runs é dos agentes do Cockpit;
  -- managed agents rodam fora. Guardamos o run_id externo da Anthropic como texto.
  managed_agent_session_id text,
  managed_agent_message_id text,
  tokens_in int,
  tokens_out int,
  modelo text,
  custo_usd numeric(10, 6),

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.learning_log IS
  'Caderno dos Managed Agents externos (Triagem Noturna + Aprendizado Contínuo). Cada linha é um produto do agente: incidente, padrão, ajuste sugerido, aprovação, impacto medido. Loop fechado via parent_id. INSERT-only pelos agentes (service_role); UPDATE só do status+motivo_decisao via RPC controlada. Lido pelo Caio (gestor) via digest semanal e painel.';

-- ============================================================================
-- ÍNDICES
-- ============================================================================

-- Listagem por tipo + status (digest semanal)
CREATE INDEX IF NOT EXISTS idx_learning_log_tipo_status
  ON public.learning_log(tipo, status, created_at DESC);

-- Filtragem por agente (Triagem vs Aprendizado)
CREATE INDEX IF NOT EXISTS idx_learning_log_agente_data
  ON public.learning_log(agente, created_at DESC);

-- Itens abertos (precisam de revisão do Caio) — partial pra ser leve
CREATE INDEX IF NOT EXISTS idx_learning_log_abertos
  ON public.learning_log(created_at DESC)
  WHERE status = 'aberto';

-- Loop encadeado: dado um sugestao, achar todos descendentes
CREATE INDEX IF NOT EXISTS idx_learning_log_parent
  ON public.learning_log(parent_id)
  WHERE parent_id IS NOT NULL;

-- Cards envolvidos (GIN pra array)
CREATE INDEX IF NOT EXISTS idx_learning_log_card_ids
  ON public.learning_log USING gin(card_ids)
  WHERE card_ids IS NOT NULL;

-- ============================================================================
-- RLS — só gestor lê (Caio). Lembrar: GRANT antes da POLICY
-- (feedback_rls_grant_antes_de_policy).
-- ============================================================================

ALTER TABLE public.learning_log ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.learning_log TO authenticated;
GRANT INSERT ON public.learning_log TO service_role;
GRANT UPDATE (status, revisado_por, revisado_em, motivo_decisao) ON public.learning_log TO authenticated;

CREATE POLICY learning_log_select_gestor
  ON public.learning_log
  FOR SELECT
  TO authenticated
  USING (public.current_operador_papel() = 'gestor');

CREATE POLICY learning_log_update_gestor
  ON public.learning_log
  FOR UPDATE
  TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

-- service_role bypassa RLS por padrão, agentes externos usam essa role.

-- ============================================================================
-- RPC de revisão (operador aprova/rejeita ajuste sugerido)
-- Não permite editar titulo/resumo/detalhes (imutáveis pós-INSERT do agente).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revisar_learning_log(
  p_id uuid,
  p_decisao text,             -- 'aprovado' | 'rejeitado' | 'observacao'
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_papel text;
  v_log record;
BEGIN
  SELECT id, papel INTO v_operador_id, v_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_papel <> 'gestor' THEN
    RAISE EXCEPTION 'Só gestor pode revisar learning_log'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_decisao NOT IN ('aprovado', 'rejeitado', 'observacao') THEN
    RAISE EXCEPTION 'Decisão inválida: %', p_decisao
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, status, tipo INTO v_log
  FROM public.learning_log WHERE id = p_id;

  IF v_log.id IS NULL THEN
    RAISE EXCEPTION 'learning_log % não encontrado', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_log.status <> 'aberto' THEN
    RAISE EXCEPTION 'learning_log % já em status=% (não pode revisar)', p_id, v_log.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.learning_log
  SET status = p_decisao,
      revisado_por = v_operador_id,
      revisado_em = now(),
      motivo_decisao = p_motivo
  WHERE id = p_id;

  RETURN jsonb_build_object(
    'ok', true,
    'id', p_id,
    'status', p_decisao,
    'revisado_em', now()
  );
END;
$$;

COMMENT ON FUNCTION public.revisar_learning_log IS
  'Caio (gestor) aprova/rejeita/comenta ajuste sugerido pelo agente. Só transição aberto→{aprovado|rejeitado|observacao}. Status terminais (aplicado/revertido) gravados pelos agentes via service_role após PR mergeado.';
