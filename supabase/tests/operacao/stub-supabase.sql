-- =============================================================================
-- Stub MÍNIMO do ambiente Supabase do Cockpit, para rodar as migs 430/431 e o
-- teste de separação num Postgres DESCARTÁVEL local (nunca no banco real).
-- Reproduz: roles anon/authenticated/service_role, auth.uid() pelo GUC
-- request.jwt.claim.sub (como o PostgREST), os default privileges do Supabase
-- (tabela nova = ALL para anon/authenticated; função nova = EXECUTE), e um
-- recorte das tabelas e policies do Relacionamento copiado das migrations
-- (001, 025, 076, 092, 100, 242, 324).
-- Rodar: ver supabase/tests/operacao/rodar-local.sh
-- =============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS cron;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, jobname text);

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.operadores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nome text NOT NULL, email text NOT NULL,
  papel text NOT NULL DEFAULT 'operador' CHECK (papel IN ('operador', 'gestor')),
  carteira text[] NOT NULL DEFAULT '{}', ativo boolean NOT NULL DEFAULT true,
  pode_executar boolean NOT NULL DEFAULT true, gmail_oauth_credentials jsonb,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.current_operador_papel() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT papel FROM public.operadores WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE OR REPLACE FUNCTION public.current_operador_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.operadores WHERE user_id = auth.uid() LIMIT 1 $$;
CREATE OR REPLACE FUNCTION public.current_operador_carteira() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT carteira FROM public.operadores WHERE user_id = auth.uid() LIMIT 1), '{}') $$;
ALTER TABLE public.operadores ENABLE ROW LEVEL SECURITY;
CREATE POLICY operadores_select_all ON public.operadores FOR SELECT TO authenticated USING (true);
CREATE POLICY operadores_insert_self ON public.operadores FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY operadores_update_self ON public.operadores FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text,
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY ff_select_all ON public.feature_flags FOR SELECT TO authenticated USING (true);

CREATE TABLE public.ocorrencias_dicionario (codigo integer PRIMARY KEY, descricao text NOT NULL, responsabilidade text NOT NULL);
INSERT INTO public.ocorrencias_dicionario VALUES
  (1,'Mercadoria entregue','Operação'),(2,'Entrega com comprovante','Operação'),(13,'Chegada na unidade','Operação'),
  (14,'Entrega iniciada','Operação'),(15,'Entrega impossib: limit. base','Operação'),(21,'Reentrega','Operação'),
  (30,'Devolução autorizada','Devolução'),(32,'Cancelada','Operação'),(34,'Documento','Operação'),
  (36,'Chegada na base para entrega','Operação'),(37,'Problema no veículo','Operação'),(41,'Informação complementar','Operação'),
  (49,'Tratativa de relacionamento','Relacionamento'),(54,'Aguardando cliente','Cliente'),(56,'Falta info operacional','Operação'),
  (6,'Extravio','Perdas'),(33,'Ressarcimento','Ressarcimento'),(44,'Devolução','Devolução'),(11,'Endereço','Relacionamento');
ALTER TABLE public.ocorrencias_dicionario ENABLE ROW LEVEL SECURITY;
CREATE POLICY ocorrencias_dicionario_select_all ON public.ocorrencias_dicionario FOR SELECT TO authenticated USING (true);

CREATE TABLE public.cards (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nf text, ctrc text, state text NOT NULL,
  pagador text, segmento_codigo text, assigned_operator_id uuid, updated_at timestamptz DEFAULT now());
CREATE INDEX idx_cards_ctrc ON public.cards(ctrc) WHERE ctrc IS NOT NULL;
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY cards_select_visibilidade ON public.cards FOR SELECT TO authenticated USING (
  (SELECT public.current_operador_papel()) = 'gestor' OR assigned_operator_id = (SELECT public.current_operador_id())
  OR (pagador = ANY (SELECT unnest(public.current_operador_carteira()))));

CREATE TABLE public.card_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), card_id uuid NOT NULL, event_type text,
  payload jsonb, actor_type text, actor_id text, created_at timestamptz DEFAULT now());
ALTER TABLE public.card_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY card_events_select_via_card ON public.card_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cards c WHERE c.id = card_events.card_id));

CREATE TABLE public.todos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), card_id uuid, status text);
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY todos_select_via_card ON public.todos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.cards c WHERE c.id = todos.card_id));

CREATE TABLE public.messages_inbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), card_id uuid, corpo text);
ALTER TABLE public.messages_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_inbox_select_via_card ON public.messages_inbox FOR SELECT TO authenticated
  USING ((card_id IS NULL AND public.current_operador_papel() = 'gestor')
      OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = messages_inbox.card_id));

CREATE TABLE public.clientes (cnpj_cpf text PRIMARY KEY, nome text);
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY clientes_select_por_carteira ON public.clientes FOR SELECT TO authenticated
  USING (public.current_operador_papel() = 'gestor' OR cnpj_cpf = ANY (public.current_operador_carteira()));

CREATE TABLE public.contatos_escalonamento (id serial PRIMARY KEY, email text);
ALTER TABLE public.contatos_escalonamento ENABLE ROW LEVEL SECURITY;
CREATE POLICY contatos_escal_select ON public.contatos_escalonamento FOR SELECT TO authenticated USING (true);
CREATE POLICY contatos_escal_modify ON public.contatos_escalonamento FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.templates_email (id serial PRIMARY KEY, corpo text);
ALTER TABLE public.templates_email ENABLE ROW LEVEL SECURITY;
CREATE POLICY templates_email_select_authenticated ON public.templates_email FOR SELECT TO authenticated USING (true);

-- O furo: policy sem TO (= PUBLIC) com USING(true) — anon e authenticated leem e escrevem.
CREATE TABLE public.cliente_config (cnpj text PRIMARY KEY, romaneio_interno boolean);
ALTER TABLE public.cliente_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY cliente_config_service_role ON public.cliente_config USING (true) WITH CHECK (true);

-- Uma visão SEM security_invoker (lê como o dono, sem RLS) — como v_placar_agente.
CREATE VIEW public.v_placar_agente AS SELECT c.id, c.state FROM public.cards c;
GRANT SELECT ON public.v_placar_agente TO anon, authenticated;

-- Uma RPC SECURITY DEFINER sem checagem de operador, não usada pelo front.
CREATE OR REPLACE FUNCTION public.cards_cliente_respondeu_sem_proposta()
RETURNS TABLE (id uuid, nf text) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT id, nf FROM public.cards $$;
