-- =============================================================================
-- 2026-10-07_431 — Separação Relacionamento × Operação na RLS (ADR 0041, D2)
-- =============================================================================
-- Decisão do dono: "Relacionamento não precisa aparecer para a Operação, nem
-- vice-versa". Até aqui todo `authenticated` do projeto era alguém do
-- Relacionamento, e várias policies foram escritas assim (USING (true) para
-- authenticated). Com membros da Operação logando no MESMO projeto, isso vazaria
-- cards, mensagens, clientes e contatos para eles. Esta migration fecha o que um
-- usuário FORA de public.operadores alcança — e só isso:
--
--   1. eh_membro_relacionamento(): existe linha em operadores para auth.uid().
--   2. Policy RESTRICTIVE `sep_somente_relacionamento` (FOR ALL, TO anon e
--      authenticated) nas tabelas do Relacionamento. Restrictive é AND com as
--      permissivas que já existem: para quem ESTÁ em operadores o predicado é
--      true e nada muda (gestor, operador, pode_executar — tudo igual); para quem
--      não está, nenhuma linha passa. anon nunca é membro (auth.uid() nulo).
--   3. operadores: INSERT só pelo gestor. Hoje `operadores_insert_self` deixa
--      QUALQUER authenticated se inserir — inclusive com papel 'gestor'. Um
--      membro da Operação viraria "do Relacionamento" (ou gestor) com um POST.
--      Quem já está em operadores não faz INSERT de si mesmo (user_id UNIQUE).
--   4. 5 visões SEM security_invoker (leem como o dono, sem RLS) e que o front
--      não usa: REVOKE SELECT de anon/authenticated (service_role continua).
--   5. 17 RPCs SECURITY DEFINER sem checagem de operador, executáveis por
--      authenticated/anon e que NENHUM front chama (grep em apps/cockpit-web,
--      monitor-capacidade.html, vercel-*): REVOKE de PUBLIC/anon/authenticated e
--      GRANT a service_role (as edges usam service_role; o pg_cron roda como
--      postgres, o dono). Por nome, todas as sobrecargas (pg_proc), sem depender
--      da assinatura exata de produção.
-- O lado inverso (quem não é da Operação nem gestor não lê op_*) está na RLS das
-- tabelas op_* (mig 430): predicado op_pode_ver_unidade / eh_supervisor_op /
-- op_eh_gestor — operador do Relacionamento não passa em nenhum.
--
-- Inventário completo (policies USING(true), RPCs SECURITY DEFINER liberadas,
-- visões e EDGES) e a correção de cada um: docs/OPERACAO-SEPARACAO-RLS.md.
-- O que NÃO está aqui (precisa de REPLACE do corpo de função existente, ou mexe
-- em edge do Relacionamento) está lá como pendência, com dono.
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) LOCK: CREATE POLICY pega ACCESS EXCLUSIVE na tabela por um instante, e
--     cards/card_events/todos/messages_inbox são quentes. `lock_timeout = 5s`:
--     se uma query longa segurar a tabela, a migration FALHA em vez de enfileirar
--     todo mundo atrás dela. Aplicar em horário calmo; se falhar, reaplicar (é
--     idempotente: pula policy que já existe).
-- (b) ANTES de aplicar, rodar o PRÉ-CHECK do docs/OPERACAO-SEPARACAO-RLS.md
--     ("quem loga e não está em operadores"). Se aparecer alguém do
--     Relacionamento fora de operadores, ele perde o acesso ao aplicar. O bloco 0
--     abaixo repete a contagem como NOTICE.
-- (c) Desempenho: o predicado é `(SELECT public.eh_membro_relacionamento())` —
--     initPlan, avaliado 1x por query, não por linha; lookup por
--     operadores.user_id (UNIQUE).
-- (d) TIPO B (CREATE POLICY em tabela existente + REVOKE). --autorizado-por.
-- (e) REVERSÃO (TIPO B):
--       DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_policies
--         WHERE schemaname='public' AND policyname='sep_somente_relacionamento' LOOP
--         EXECUTE format('DROP POLICY sep_somente_relacionamento ON public.%I', t); END LOOP; END $$;
--       DROP POLICY IF EXISTS sep_operadores_insert_so_gestor ON public.operadores;
--       GRANT SELECT ON <as 5 visões> TO authenticated;
--       GRANT EXECUTE ON FUNCTION <as 17> TO authenticated;   -- se algo depender
--       DROP FUNCTION IF EXISTS public.eh_membro_relacionamento();
--
-- ⚠ NÃO APLICADA. ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

SET lock_timeout = '5s';

-- 0. Quem loga e não é do Relacionamento (só informa; ver nota b) ------------------
DO $$
DECLARE
  v_fora integer;
BEGIN
  SELECT count(*) INTO v_fora FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.operadores o WHERE o.user_id = u.id)
     AND (to_regclass('public.operacao_membros') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.operacao_membros m WHERE m.user_id = u.id));
  RAISE NOTICE 'mig 431: % usuário(s) de auth.users fora de operadores e de operacao_membros — eles deixam de ler o Relacionamento', v_fora;
END $$;

-- 1. O predicado -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.eh_membro_relacionamento()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.operadores o WHERE o.user_id = auth.uid());
$$;
COMMENT ON FUNCTION public.eh_membro_relacionamento() IS
  'ADR 0041 D2: true se auth.uid() tem linha em operadores (Relacionamento, inclusive gestor). '
  'Predicado das policies RESTRICTIVE sep_somente_relacionamento (mig 431).';
REVOKE ALL ON FUNCTION public.eh_membro_relacionamento() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.eh_membro_relacionamento() TO anon, authenticated, service_role;

-- 2. Policies RESTRICTIVE nas tabelas do Relacionamento --------------------------------
-- Lista = toda tabela do Relacionamento com policy para authenticated/PUBLIC no estado
-- final de migration/ (inventário no doc). FORA de propósito: feature_flags,
-- ocorrencias_dicionario, feriados, anthropic_pricing (referência, sem dado de cliente),
-- sync_status_global (status público, anon), sync_runs (já tem restrictive própria),
-- pdi_* (gate próprio por participante), op_* e operacao_membros (RLS da mig 430).
DO $$
DECLARE
  v_tabelas text[] := ARRAY[
    'acoes_agendadas', 'acoes_autonomas_veto_config', 'acoes_autonomas_veto_operadores',
    'agent_feedback', 'agent_runs', 'agente_oc13_feedback', 'agente_ocs_padrao_feedback',
    'alertas_operador', 'alertas_sla_oc21_oc14', 'analises_ia_indicadores', 'analises_prioridades_ai',
    'anthropic_usage_log', 'aprendizado_chat_mensagens', 'aprendizado_chat_sessoes', 'audit_log',
    'cancelamentos_acao_autonoma', 'card_events', 'cards', 'cards_auditoria', 'cards_emails_outbound',
    'cliente_config', 'clientes', 'cobrancas_disparadas', 'cobrancas_enviadas', 'contatos_bases_ssw',
    'contatos_cliente', 'contatos_escalonamento', 'desfechos_pares', 'divergencia_motivos',
    'edicoes_acao_autonoma', 'email_anexos', 'erros_lancamento_ssw', 'fatias_autonomas',
    'interpretador_resposta_cliente_feedback', 'learning_log', 'managed_agent_tool_calls',
    'marcadores_processo_operador', 'messages_inbox', 'motivo_bank', 'nf_chave_cte',
    'ocorrencias_dexpara', 'operador_credencial_eventos', 'operadores', 'pendencias',
    'perguntas_extras_cancelamento', 'popup_divergencia_config', 'prioridades_ai_saidas',
    'scan_email_config', 'sugestoes_texto_ia', 'templates_email', 'tempo_oc21_para_oc14', 'todos',
    'tracking_credentials', 'triador_sombra_haiku', 'usuarios_ssw_perdas', 'voz_templates',
    'wurth_evidencias_intranet', 'wurth_retornos_processados'];
  t text;
  n_criadas integer := 0;
  n_existentes integer := 0;
  n_ausentes integer := 0;
BEGIN
  FOREACH t IN ARRAY v_tabelas LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      n_ausentes := n_ausentes + 1;
      RAISE NOTICE 'mig 431: tabela public.% não existe aqui — pulada', t;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                AND policyname = 'sep_somente_relacionamento') THEN
      n_existentes := n_existentes + 1;
      CONTINUE;
    END IF;
    EXECUTE format(
      'CREATE POLICY sep_somente_relacionamento ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated '
      'USING ((SELECT public.eh_membro_relacionamento())) WITH CHECK ((SELECT public.eh_membro_relacionamento()))', t);
    n_criadas := n_criadas + 1;
  END LOOP;
  RAISE NOTICE 'mig 431: sep_somente_relacionamento criada em %, já existia em %, % tabela(s) ausente(s)',
    n_criadas, n_existentes, n_ausentes;
END $$;

-- 3. operadores: ninguém se insere sozinho (só o gestor cadastra) ----------------------
DROP POLICY IF EXISTS sep_operadores_insert_so_gestor ON public.operadores;
CREATE POLICY sep_operadores_insert_so_gestor ON public.operadores AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK ((SELECT public.current_operador_papel()) = 'gestor');

-- 4. Visões sem security_invoker que o front não usa -----------------------------------
DO $$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_agent_feedback_unificado', 'v_agent_feedback_unificado_legado',
                           'v_fatias_candidatas_autonomia', 'v_placar_agente', 'v_placar_agente_erros'] LOOP
    IF to_regclass(format('public.%I', v)) IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', v);
      EXECUTE format('GRANT SELECT ON public.%I TO service_role', v);
    END IF;
  END LOOP;
END $$;

-- 5. RPCs SECURITY DEFINER sem checagem de operador e fora do front ---------------------
DO $$
DECLARE
  v_nomes text[] := ARRAY[
    'agendar_cobranca_email', 'cancelar_acoes_agendadas_do_card', 'cards_cliente_respondeu_sem_proposta',
    'consolidar_automacoes_diarias', 'cron_jobs_recent_failures', 'demover_fatias_abaixo_da_meta',
    'dlq_resumo_cliente', 'enqueue_scan_email_pre_card', 'fatia_esta_autonoma', 'lookup_chave_cte',
    'lookup_chaves_cte_alternativas', 'lookup_codigo_api', 'minutos_desde_ultimo_pass_e',
    'minutos_desde_ultimo_sync_bastao', 'pgmq_queue_length', 'registrar_par_agente', 'validar_sql_readonly'];
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname = ANY (v_nomes) AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'mig 431: EXECUTE fechado para anon/authenticated em % função(ões) SECURITY DEFINER', n;
END $$;

-- 6. Smoke: toda tabela da lista que existe tem a restrictive -----------------------------
DO $$
DECLARE
  v_sem integer;
BEGIN
  SELECT count(*) INTO v_sem
    FROM unnest(ARRAY['cards', 'card_events', 'todos', 'messages_inbox', 'clientes', 'contatos_cliente',
                      'cliente_config', 'operadores', 'templates_email', 'contatos_escalonamento']) t
   WHERE to_regclass(format('public.%I', t)) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t
                      AND p.policyname = 'sep_somente_relacionamento' AND p.permissive = 'RESTRICTIVE');
  IF v_sem > 0 THEN
    RAISE EXCEPTION 'mig 431: % tabela(s) central(is) do Relacionamento sem a policy restrictive', v_sem;
  END IF;
  RAISE NOTICE 'OK mig 431: Relacionamento fechado para quem não está em operadores.';
END $$;

RESET lock_timeout;
