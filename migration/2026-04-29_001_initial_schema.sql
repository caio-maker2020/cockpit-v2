-- ============================================================================
-- Cockpit v2 — Schema inicial event-sourced
-- Data: 2026-04-29
-- Premissas: Supabase (Postgres 15+), pgcrypto disponível, auth.users existe.
-- Fonte de verdade: card_events. cards é projeção (mantida pela aplicação).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- operadores — papel real (operador / gestor) e carteira de empresas
-- ============================================================================
CREATE TABLE public.operadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nome text NOT NULL,
  email text NOT NULL,
  papel text NOT NULL DEFAULT 'operador' CHECK (papel IN ('operador', 'gestor')),
  carteira text[] NOT NULL DEFAULT '{}',
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_operadores_user_id ON public.operadores(user_id);

-- Helper: papel do usuário autenticado.
CREATE OR REPLACE FUNCTION public.current_operador_papel()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT papel FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_operador_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
$$;

-- ============================================================================
-- cards — projeção do agregado (estado atual reconstruível via card_events)
-- ============================================================================
CREATE TABLE public.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificadores de negócio
  nf text,
  ctrc text,
  canal_origem text NOT NULL CHECK (canal_origem IN ('whatsapp', 'email', 'sistema')),
  remetente_inicial text,
  empresa_cliente text,
  nome_cliente text,
  pagador text,
  base_destino text,
  responsavel_relacionamento text,

  -- Estado da máquina
  state text NOT NULL DEFAULT 'RECEBIDO' CHECK (state IN (
    'RECEBIDO',
    'EM_TRIAGEM',
    'AGUARDANDO_VINCULACAO',
    'AGUARDANDO_CONTEXTO',
    'AGUARDANDO_AGENTE',
    'EM_EXECUCAO_AUTOMATICA',
    'AGUARDANDO_VALIDACAO_HUMANA',
    'EXECUTANDO_ACAO',
    'AGUARDANDO_CLIENTE',
    'AGUARDANDO_TERCEIRO',
    'BLOQUEADO_POR_ERRO',
    'ESCALADO_HUMANO',
    'RESOLVIDO',
    'CANCELADO'
  )),
  agent_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  tipo text,
  risco text CHECK (risco IS NULL OR risco IN ('alto', 'baixo')),

  assigned_agent text,
  assigned_operator_id uuid REFERENCES public.operadores(id) ON DELETE SET NULL,

  last_event_id uuid,
  last_event_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cards_state_last_event ON public.cards(state, last_event_at DESC);
CREATE INDEX idx_cards_nf ON public.cards(nf) WHERE nf IS NOT NULL;
CREATE INDEX idx_cards_ctrc ON public.cards(ctrc) WHERE ctrc IS NOT NULL;
CREATE INDEX idx_cards_assigned_operator_state ON public.cards(assigned_operator_id, state);
CREATE INDEX idx_cards_responsavel_state ON public.cards(responsavel_relacionamento, state);

-- 1 card ativo por NF — estados terminais liberam.
CREATE UNIQUE INDEX uniq_cards_nf_active
  ON public.cards(nf)
  WHERE nf IS NOT NULL AND state NOT IN ('RESOLVIDO', 'CANCELADO');

-- ============================================================================
-- card_events — fonte da verdade. Append-only, imutável.
-- ============================================================================
CREATE TABLE public.card_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL CHECK (actor_type IN ('agent', 'operator', 'system')),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_events_card_created ON public.card_events(card_id, created_at);
CREATE INDEX idx_card_events_type_created ON public.card_events(event_type, created_at);

-- Imutabilidade: nada de UPDATE/DELETE, mesmo via service_role.
CREATE OR REPLACE FUNCTION public.reject_card_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'card_events é append-only — UPDATE/DELETE proibido';
END;
$$;

CREATE TRIGGER card_events_no_update
  BEFORE UPDATE ON public.card_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_card_events_mutation();

CREATE TRIGGER card_events_no_delete
  BEFORE DELETE ON public.card_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_card_events_mutation();

-- Projeção mínima: ao inserir evento, atualiza `cards.last_event_*` e `updated_at`.
-- Transição de `state` continua sob responsabilidade da aplicação (lib/state-machine
-- vai validar a transição antes de gravar evento + projeção).
CREATE OR REPLACE FUNCTION public.project_card_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.card_id IS NOT NULL THEN
    UPDATE public.cards
    SET last_event_id = NEW.id,
        last_event_at = NEW.created_at,
        updated_at = now()
    WHERE id = NEW.card_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER card_events_project_after_insert
  AFTER INSERT ON public.card_events
  FOR EACH ROW EXECUTE FUNCTION public.project_card_event();

-- FK reversa de cards.last_event_id (declarada DEFERRABLE pra não quebrar
-- inserção do primeiro evento — card existe antes do evento).
ALTER TABLE public.cards
  ADD CONSTRAINT cards_last_event_id_fkey
  FOREIGN KEY (last_event_id) REFERENCES public.card_events(id) DEFERRABLE INITIALLY DEFERRED;

-- ============================================================================
-- messages_inbox — entrada bruta antes de virar card_event
-- ============================================================================
CREATE TABLE public.messages_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  canal text NOT NULL CHECK (canal IN ('whatsapp', 'email', 'sistema')),
  remetente text NOT NULL,
  conteudo text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processed', 'failed'))
);

CREATE INDEX idx_inbox_status_recebido ON public.messages_inbox(processing_status, recebido_em);
CREATE INDEX idx_inbox_card_recebido ON public.messages_inbox(card_id, recebido_em);

-- ============================================================================
-- agent_runs — telemetria de cada step de agente
-- ============================================================================
CREATE TABLE public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  agent_name text NOT NULL,
  step_name text,
  input jsonb,
  output jsonb,
  model text,
  tokens_in integer,
  tokens_out integer,
  duration_ms integer,
  status text NOT NULL CHECK (status IN ('success', 'error', 'timeout')),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX idx_agent_runs_card_started ON public.agent_runs(card_id, started_at DESC);
CREATE INDEX idx_agent_runs_agent_started ON public.agent_runs(agent_name, started_at DESC);
CREATE INDEX idx_agent_runs_errors
  ON public.agent_runs(status, started_at DESC)
  WHERE status <> 'success';

-- ============================================================================
-- audit_log — efeitos externos (SSW / Evolution / Resend) com idempotência
-- ============================================================================
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('agent', 'operator', 'system')),
  actor_id text NOT NULL,
  external_system text NOT NULL CHECK (external_system IN ('ssw', 'evolution', 'resend', 'postmark', 'bastao', 'internal')),
  idempotency_key text NOT NULL UNIQUE,
  request_payload jsonb,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_card_created ON public.audit_log(card_id, created_at DESC);
CREATE INDEX idx_audit_system_status ON public.audit_log(external_system, status, created_at DESC);

-- ============================================================================
-- pendencias — follow-ups agendados
-- ============================================================================
CREATE TABLE public.pendencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  titulo text NOT NULL,
  data_agendada timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'concluida', 'cancelada')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pendencias_status_data ON public.pendencias(status, data_agendada);
CREATE INDEX idx_pendencias_card ON public.pendencias(card_id);

-- ============================================================================
-- todos — ações propostas pelo agente, aguardando validação humana
-- ============================================================================
CREATE TABLE public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  action_id uuid,                          -- aponta pro card_event 'AcaoPropostaPeloAgente'
  descricao text NOT NULL,
  proposta_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'aprovado', 'rejeitado', 'executado', 'expirado')),
  approved_by uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_todos_card_status ON public.todos(card_id, status);
CREATE INDEX idx_todos_pendentes_created
  ON public.todos(status, created_at)
  WHERE status = 'pendente';

-- ============================================================================
-- feature_flags — gates de auto-aprovação e flags experimentais
-- ============================================================================
CREATE TABLE public.feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.operadores(id) ON DELETE SET NULL
);

-- Flags conhecidas (todas desligadas por padrão).
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('agent_reentrega_enabled',   'Liga o agente Reentrega para criar propostas de ação', false),
  ('agent_devolucao_enabled',   'Liga o agente Devolução',                                false),
  ('agent_rastreamento_enabled','Liga o agente Rastreamento',                             false),
  ('auto_approve_rastreamento', 'Permite execução de Rastreamento sem validação humana', false),
  ('auto_approve_reentrega',    'Permite execução de Reentrega sem validação humana',    false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Triggers genéricos: updated_at em cards
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER cards_set_updated_at
  BEFORE UPDATE ON public.cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS — papel real (operador / gestor). service_role bypassa RLS por padrão.
-- ============================================================================

ALTER TABLE public.operadores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cards           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages_inbox  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pendencias      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags   ENABLE ROW LEVEL SECURITY;

-- operadores: todos veem todos; só o próprio usuário escreve no próprio registro.
CREATE POLICY operadores_select_all ON public.operadores
  FOR SELECT TO authenticated USING (true);
CREATE POLICY operadores_insert_self ON public.operadores
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY operadores_update_self ON public.operadores
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- cards: operador vê só os atribuídos a ele OU sem dono; gestor vê tudo.
CREATE POLICY cards_select_role ON public.cards
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR assigned_operator_id IS NULL
    OR assigned_operator_id = public.current_operador_id()
  );

-- Atualizações de cards via UI são raras (executor é service_role). Permitimos
-- update apenas pra dono ou gestor — campos editáveis ficam por convenção.
CREATE POLICY cards_update_role ON public.cards
  FOR UPDATE TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR assigned_operator_id = public.current_operador_id()
  );

-- card_events: SELECT pra quem vê o card; INSERT só por service_role
-- (authenticated não cria evento direto — passa por API com SECURITY DEFINER no futuro).
CREATE POLICY card_events_select_via_card ON public.card_events
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id IS NULL
         OR assigned_operator_id = public.current_operador_id()
    )
  );

-- messages_inbox: gestor vê tudo; operador vê só vinculado a card seu.
CREATE POLICY inbox_select_role ON public.messages_inbox
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id = public.current_operador_id()
    )
  );

-- agent_runs: só gestor.
CREATE POLICY agent_runs_select_gestor ON public.agent_runs
  FOR SELECT TO authenticated
  USING (public.current_operador_papel() = 'gestor');

-- audit_log: só gestor.
CREATE POLICY audit_select_gestor ON public.audit_log
  FOR SELECT TO authenticated
  USING (public.current_operador_papel() = 'gestor');

-- pendencias: vê quem vê o card.
CREATE POLICY pendencias_select_via_card ON public.pendencias
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id IS NULL
         OR assigned_operator_id = public.current_operador_id()
    )
  );
CREATE POLICY pendencias_update_via_card ON public.pendencias
  FOR UPDATE TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id = public.current_operador_id()
    )
  );

-- todos: aprovação/rejeição é a primária.
CREATE POLICY todos_select_via_card ON public.todos
  FOR SELECT TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id IS NULL
         OR assigned_operator_id = public.current_operador_id()
    )
  );
CREATE POLICY todos_update_via_card ON public.todos
  FOR UPDATE TO authenticated
  USING (
    public.current_operador_papel() = 'gestor'
    OR card_id IN (
      SELECT id FROM public.cards
      WHERE assigned_operator_id = public.current_operador_id()
    )
  );

-- feature_flags: todos leem; só gestor altera.
CREATE POLICY ff_select_all ON public.feature_flags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ff_update_gestor ON public.feature_flags
  FOR UPDATE TO authenticated
  USING (public.current_operador_papel() = 'gestor');
CREATE POLICY ff_insert_gestor ON public.feature_flags
  FOR INSERT TO authenticated
  WITH CHECK (public.current_operador_papel() = 'gestor');
