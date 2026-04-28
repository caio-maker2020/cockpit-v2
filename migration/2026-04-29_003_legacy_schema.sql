-- ============================================================================
-- Cockpit v2 — Schema legacy.* (read-only) para evals e referência
-- Data: 2026-04-29
-- Espelho fiel do schema do v1 (Lovable), com mesmos tipos para data.sql
-- importar via simples replace de `public.` por `legacy.`.
--
-- Acesso:
--   - service_role: SELECT
--   - authenticated: NENHUM acesso direto (evals rodam server-side)
--
-- Nunca escrever em legacy.*. ETL pra projeções de eval gera tabelas em outro
-- schema (ex.: evals.cases_triagem) — não toca legacy.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS legacy;

-- Permissões: revoga tudo de roles autenticadas; só service_role lê.
REVOKE ALL ON SCHEMA legacy FROM PUBLIC;
GRANT  USAGE  ON SCHEMA legacy TO service_role;

-- Tipos (idênticos ao v1).
CREATE TYPE legacy.canal_tipo       AS ENUM ('whatsapp', 'email', 'sistema');
CREATE TYPE legacy.mensagem_status  AS ENUM ('pendente', 'em_analise', 'aprovado', 'rejeitado');
CREATE TYPE legacy.nivel_risco      AS ENUM ('alto', 'baixo');

-- ============================================================================
-- Tabelas (cópia fiel do schema v1, sem FKs entre legacy e public.auth)
-- ============================================================================

CREATE TABLE legacy.operadores (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  nome text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operadores_pkey PRIMARY KEY (id),
  CONSTRAINT operadores_user_id_key UNIQUE (user_id)
);

CREATE TABLE legacy.contatos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identificador text NOT NULL,
  nome text,
  empresa_cliente text,
  canal text NOT NULL DEFAULT 'whatsapp'::text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contatos_pkey PRIMARY KEY (id),
  CONSTRAINT contatos_identificador_key UNIQUE (identificador)
);

CREATE TABLE legacy.mensagens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  canal legacy.canal_tipo NOT NULL DEFAULT 'email',
  remetente text NOT NULL,
  mensagem_original text NOT NULL,
  resumo_agente text,
  resposta_sugerida text,
  nivel_risco legacy.nivel_risco NOT NULL DEFAULT 'baixo',
  status legacy.mensagem_status NOT NULL DEFAULT 'pendente',
  operador_id uuid,
  chegou_em timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  tipo text,
  nome_cliente text,
  empresa_cliente text,
  mensagens_agrupadas integer NOT NULL DEFAULT 1,
  status_comunicacao text NOT NULL DEFAULT 'aguardando_resposta',
  status_problema text NOT NULL DEFAULT 'novo',
  descricao_problema text,
  gravidade_problema text,
  resposta_enviada text,
  thread_id uuid DEFAULT gen_random_uuid(),
  mensagens_thread jsonb DEFAULT '[]'::jsonb,
  nova_mensagem boolean NOT NULL DEFAULT false,
  nf text,
  ctrc text,
  pagador text,
  base_destino text,
  dias_atraso integer,
  responsavel_relacionamento text,
  data_ocorrencia timestamptz,
  prazo_retorno timestamptz,
  CONSTRAINT mensagens_pkey PRIMARY KEY (id),
  CONSTRAINT mensagens_operador_id_fkey FOREIGN KEY (operador_id) REFERENCES legacy.operadores(id)
);

CREATE TABLE legacy.acoes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensagem_id uuid NOT NULL,
  operador_id uuid NOT NULL,
  acao text NOT NULL,
  resposta_final text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acoes_pkey PRIMARY KEY (id),
  CONSTRAINT acoes_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES legacy.mensagens(id) ON DELETE CASCADE,
  CONSTRAINT acoes_operador_id_fkey FOREIGN KEY (operador_id) REFERENCES legacy.operadores(id)
);

CREATE TABLE legacy.historico (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensagem_id uuid NOT NULL,
  operador_id uuid NOT NULL,
  acao_realizada text NOT NULL,
  data_acao timestamptz NOT NULL DEFAULT now(),
  canal legacy.canal_tipo NOT NULL,
  remetente text NOT NULL,
  resumo text,
  CONSTRAINT historico_pkey PRIMARY KEY (id),
  CONSTRAINT historico_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES legacy.mensagens(id) ON DELETE CASCADE,
  CONSTRAINT historico_operador_id_fkey FOREIGN KEY (operador_id) REFERENCES legacy.operadores(id)
);

CREATE TABLE legacy.movimentacoes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensagem_id uuid NOT NULL,
  status_anterior text NOT NULL,
  status_novo text NOT NULL,
  movido_por text NOT NULL DEFAULT 'sistema',
  motivo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movimentacoes_pkey PRIMARY KEY (id),
  CONSTRAINT movimentacoes_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES legacy.mensagens(id) ON DELETE CASCADE
);

CREATE TABLE legacy.pendencias (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensagem_id uuid NOT NULL,
  titulo text NOT NULL,
  data_agendada timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pendencias_pkey PRIMARY KEY (id),
  CONSTRAINT pendencias_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES legacy.mensagens(id) ON DELETE CASCADE
);

CREATE TABLE legacy.todos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensagem_id uuid NOT NULL,
  descricao text NOT NULL,
  concluido boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT todos_pkey PRIMARY KEY (id),
  CONSTRAINT todos_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES legacy.mensagens(id) ON DELETE CASCADE
);

-- ============================================================================
-- Permissões finais — read-only pra service_role; nada pra authenticated/anon.
-- ============================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA legacy TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA legacy GRANT SELECT ON TABLES TO service_role;

-- Reforço explícito: revoga qualquer permissão herdada.
REVOKE ALL ON ALL TABLES IN SCHEMA legacy FROM authenticated, anon;
