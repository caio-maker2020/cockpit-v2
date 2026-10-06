-- 2026-10-06_411_role_leitura_duilio.sql
-- Role Postgres SOMENTE LEITURA pro DUILIO (Caio, 06/10/2026).
--
-- Contexto: o Duilio passa a liderar a melhoria dos números dos agentes
-- (sugestão do agente × ação do operador). Ele pediu o SUPABASE_ACCESS_TOKEN do
-- Caio no .env.local — RECUSADO: token da Management API é a conta pessoal do
-- Caio, roda qualquer SQL como `postgres`, reinicia o banco e troca secrets. Não
-- existe "modo leitura" nele. A trava real é um usuário Postgres próprio, com
-- SELECT e nada mais, que o `scripts/dbq.py` já aceita via SUPABASE_DB_URL.
--
-- Camadas (em ordem de dureza):
--   1. Privilégio: só USAGE nos schemas public/legacy e SELECT nas tabelas.
--      INSERT/UPDATE/DELETE/DDL são recusados pelo Postgres, não por combinado.
--   2. BYPASSRLS: as 102 tabelas de public têm RLS com policies pra
--      anon/authenticated/service_role; sem bypass o role veria 0 linhas.
--      Bypass de RLS num role que só tem SELECT não abre escrita.
--   3. default_transaction_read_only = on: 56 funções de public são executáveis
--      por PUBLIC e 127 são SECURITY DEFINER — um `select rpc_x()` poderia
--      escrever "por dentro". Com a transação read-only, o UPDATE dentro da
--      função falha. (É GUC de sessão: dá pra desligar com SET — é cinto, não
--      parede. A parede é a camada 1.)
--   4. Teto de recurso: statement_timeout 60s, idle_in_transaction 30s,
--      CONNECTION LIMIT 5 — query de análise pesada não derruba produção.
--
-- A SENHA NÃO ESTÁ NESTE ARQUIVO (repo é público). Ela é definida fora do git:
--   python3 scripts/dbq.py -c "alter role leitura_duilio password '<senha>';" \
--     --autorizado-por "Caio, 06/10/2026: senha do role de leitura do Duilio"
-- Rotação = repetir esse comando. Revogação = `drop owned by leitura_duilio;
-- drop role leitura_duilio;` (TIPO B, com --autorizado-por).
--
-- URL que vai no .env.local do Duilio (pooler, session mode, IPv4):
--   SUPABASE_DB_URL=postgresql://leitura_duilio.xjbycvscljqoqpjkmevb:<senha>@aws-1-us-east-1.pooler.supabase.com:5432/postgres
--
-- Guard anti-regressão: /verify-cockpit Fase 7.11 (role existe, não escreve,
-- não cria role, read-only ligado).
--
-- Reversão: drop owned by leitura_duilio; drop role leitura_duilio;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'leitura_duilio') then
    create role leitura_duilio
      login nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls
      connection limit 5;
  end if;
end
$$;

alter role leitura_duilio set default_transaction_read_only = on;
alter role leitura_duilio set statement_timeout = '60s';
alter role leitura_duilio set idle_in_transaction_session_timeout = '30s';
-- lista SEM aspas externas: entre aspas simples vira UM schema literal e
-- `select * from cards` falha com "relation does not exist" (aconteceu na 1ª aplicação)
alter role leitura_duilio set search_path = "$user", public, extensions;

grant usage on schema public to leitura_duilio;
grant usage on schema legacy to leitura_duilio;
grant select on all tables in schema public to leitura_duilio;
grant select on all tables in schema legacy to leitura_duilio;

-- tabelas/views futuras criadas pelo `postgres` (todas as migrations do trilho)
alter default privileges for role postgres in schema public
  grant select on tables to leitura_duilio;

-- Camada 3b — fecha o único caminho de escrita que sobrava: 11 RPCs SECURITY
-- DEFINER que fazem INSERT/UPDATE/DELETE e eram executáveis por PUBLIC (default
-- do Postgres). Medido em 06/10: todas as 11 já têm grant EXPLÍCITO pra
-- anon/authenticated/service_role/postgres (proacl), então tirar o PUBLIC não
-- muda nada pro front, pras edges (service_role) nem pro pg_cron (postgres).
-- Sem isso, `set default_transaction_read_only=off; select rpc(...)` escreveria.
revoke execute on function public.cancelar_acoes_agendadas_do_card from public;
revoke execute on function public.forcar_cancelamento_reentrega from public;
revoke execute on function public.marcar_cancelamento_tratado from public;
revoke execute on function public.promover_fatia_autonoma from public;
revoke execute on function public.registrar_acerto_oc13_ia from public;
revoke execute on function public.registrar_acerto_ocs_padrao_ia from public;
revoke execute on function public.registrar_feedback_interpretador_resposta_ia from public;
revoke execute on function public.registrar_feedback_oc13_ia from public;
revoke execute on function public.registrar_feedback_ocs_padrao_ia from public;
revoke execute on function public.reportar_erro_lancamento from public;
revoke execute on function public.revisar_learning_log from public;

comment on role leitura_duilio is
  'Somente leitura (public/legacy) — Duilio, análise sugestão×ação dos agentes. Criado 2026-10-06 (mig 411). Senha fora do git.';
