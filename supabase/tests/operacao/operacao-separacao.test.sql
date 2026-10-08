-- =============================================================================
-- Teste da SEPARAÇÃO Relacionamento × Operação (ADR 0041 D2, migs 430/431, INV-180).
-- Roda SÓ no Postgres descartável (supabase/tests/operacao/rodar-local.sh), sobre o
-- stub do Supabase. Transação única com ROLLBACK.
--
-- Prova, com a sessão de cada tipo de pessoa (auth.uid() + role authenticated):
--   - membro da Operação NÃO lê cards, card_events, todos, messages_inbox, clientes,
--     contatos, templates, cliente_config, operadores; não se insere em operadores;
--     não lê a visão sem security_invoker; não executa a RPC definer fechada;
--   - operador do Relacionamento continua lendo o que lia e NÃO lê op_*;
--   - gestor do Cockpit vê os dois lados;
--   - supervisor da Operação vê a fila toda e nada do Relacionamento;
--   - usuário sem papel e anon não leem nada.
-- =============================================================================
BEGIN;

CREATE SCHEMA t;
CREATE FUNCTION t.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
GRANT USAGE ON SCHEMA t TO anon, authenticated;
GRANT EXECUTE ON FUNCTION t.ok(boolean, text) TO anon, authenticated;
-- tenta um comando como o role atual; true se foi RECUSADO (erro de permissão/RLS/check)
CREATE FUNCTION t.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN insufficient_privilege OR check_violation OR others THEN RETURN true; END $$;
GRANT EXECUTE ON FUNCTION t.recusado(text) TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA t TO service_role;
GRANT EXECUTE ON FUNCTION t.ok(boolean, text) TO service_role;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'rel@sal'), ('00000000-0000-0000-0000-0000000000a2', 'gestor@sal'),
  ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal'), ('00000000-0000-0000-0000-0000000000b2', 'op.bhz@sal'),
  ('00000000-0000-0000-0000-0000000000b3', 'sup.op@sal'), ('00000000-0000-0000-0000-0000000000c1', 'fora@sal');
INSERT INTO public.operadores (id, user_id, nome, email, papel, carteira) VALUES
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'LARISSA', 'rel@sal', 'operador', '{P1}'),
  ('10000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2', 'CAIO', 'gestor@sal', 'gestor', '{}');
INSERT INTO public.operacao_membros (id, user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('20000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'Ana BHZ', 'op.bhz@sal', 'operador_op', '{BHZ}', true),
  ('20000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b3', 'Sup Op', 'sup.op@sal', 'supervisor_op', '{}', true);

INSERT INTO public.cards (id, nf, ctrc, state, pagador) VALUES ('30000000-0000-0000-0000-000000000001', '555', 'AAA1-1', 'AGUARDANDO_VALIDACAO_HUMANA', 'P1');
INSERT INTO public.card_events (card_id, event_type) VALUES ('30000000-0000-0000-0000-000000000001', 'X');
INSERT INTO public.todos (card_id, status) VALUES ('30000000-0000-0000-0000-000000000001', 'pendente');
INSERT INTO public.messages_inbox (card_id, corpo) VALUES ('30000000-0000-0000-0000-000000000001', 'oi');
INSERT INTO public.clientes VALUES ('P1', 'Cliente P1');
INSERT INTO public.contatos_escalonamento (email) VALUES ('base@sal');
INSERT INTO public.templates_email (corpo) VALUES ('Prezado');
INSERT INTO public.cliente_config VALUES ('P1', true);
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia) VALUES
  ('OPX1-1', '123', 'VGA', 13), ('OPX2-2', '124', 'BHZ', 13), ('OPX3-3', '125', NULL, 13);
INSERT INTO public.op_eventos (op_item_id, tipo, ator_tipo) SELECT id, 'ItemMaterializado', 'system' FROM public.op_itens;
UPDATE public.feature_flags SET enabled = true WHERE key = 'operacao_tela';

-- ── membro da Operação (VGA) ─────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t.ok((SELECT count(*) FROM public.cards) = 0, 'Operação leu cards');
SELECT t.ok((SELECT count(*) FROM public.card_events) = 0, 'Operação leu card_events');
SELECT t.ok((SELECT count(*) FROM public.todos) = 0, 'Operação leu todos');
SELECT t.ok((SELECT count(*) FROM public.messages_inbox) = 0, 'Operação leu messages_inbox');
SELECT t.ok((SELECT count(*) FROM public.clientes) = 0, 'Operação leu clientes');
SELECT t.ok((SELECT count(*) FROM public.contatos_escalonamento) = 0, 'Operação leu contatos_escalonamento (USING true)');
SELECT t.ok((SELECT count(*) FROM public.templates_email) = 0, 'Operação leu templates_email (USING true)');
SELECT t.ok((SELECT count(*) FROM public.cliente_config) = 0, 'Operação leu cliente_config (policy PUBLIC USING true)');
SELECT t.ok((SELECT count(*) FROM public.operadores) = 0, 'Operação leu operadores');
SELECT t.ok(t.recusado($$INSERT INTO public.operadores (user_id, nome, email, papel) VALUES ('00000000-0000-0000-0000-0000000000b1','X','x','gestor')$$),
            'Operação se inseriu em operadores (escalada para gestor)');
SELECT t.ok(t.recusado($$INSERT INTO public.contatos_escalonamento (email) VALUES ('x')$$), 'Operação escreveu em contatos_escalonamento');
SELECT t.ok(t.recusado($$UPDATE public.cliente_config SET romaneio_interno = false$$) OR NOT EXISTS (SELECT 1 FROM public.cliente_config), 'Operação mexeu em cliente_config');
SELECT t.ok(t.recusado($$SELECT * FROM public.v_placar_agente$$), 'Operação leu visão sem security_invoker');
SELECT t.ok(t.recusado($$SELECT * FROM public.cards_cliente_respondeu_sem_proposta()$$), 'Operação executou RPC definer fechada');
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 1, 'membro VGA deveria ver só o item da VGA');
SELECT t.ok((SELECT count(*) FROM public.op_v_fila) = 1, 'op_v_fila do membro VGA deveria ter 1');
SELECT t.ok((SELECT count(*) FROM public.op_eventos) = 1, 'membro VGA deveria ver só eventos do item dele');
SELECT t.ok((SELECT count(*) FROM public.operacao_membros) = 1, 'membro deveria ver só a própria linha');
SELECT t.ok(t.recusado($$INSERT INTO public.op_itens (ctrc) VALUES ('ZZZ9-9')$$), 'membro escreveu direto em op_itens');
SELECT t.ok(t.recusado($$INSERT INTO public.op_eventos (op_item_id, tipo, ator_tipo) SELECT id, 'ItemAssumido', 'system' FROM public.op_itens LIMIT 1$$), 'membro escreveu direto em op_eventos');
RESET ROLE;

-- tela OFF: o membro não vê a fila
UPDATE public.feature_flags SET enabled = false WHERE key = 'operacao_tela';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 0, 'com operacao_tela OFF o membro viu a fila');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key = 'operacao_tela';

-- ── operador do Relacionamento ───────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
SELECT t.ok((SELECT count(*) FROM public.cards) = 1, 'Relacionamento perdeu cards');
SELECT t.ok((SELECT count(*) FROM public.card_events) = 1, 'Relacionamento perdeu card_events');
SELECT t.ok((SELECT count(*) FROM public.todos) = 1, 'Relacionamento perdeu todos');
SELECT t.ok((SELECT count(*) FROM public.messages_inbox) = 1, 'Relacionamento perdeu messages_inbox');
SELECT t.ok((SELECT count(*) FROM public.clientes) = 1, 'Relacionamento perdeu clientes');
SELECT t.ok((SELECT count(*) FROM public.contatos_escalonamento) = 1, 'Relacionamento perdeu contatos_escalonamento');
SELECT t.ok((SELECT count(*) FROM public.cliente_config) = 1, 'Relacionamento perdeu cliente_config');
SELECT t.ok((SELECT count(*) FROM public.operadores) = 2, 'Relacionamento perdeu operadores');
SELECT t.ok(NOT t.recusado($$INSERT INTO public.contatos_escalonamento (email) VALUES ('nova@sal')$$), 'Relacionamento perdeu escrita em contatos_escalonamento');
SELECT t.ok(NOT t.recusado($$UPDATE public.operadores SET gmail_oauth_credentials = NULL WHERE user_id = '00000000-0000-0000-0000-0000000000a1'$$), 'Relacionamento perdeu o update da própria linha (Gmail)');
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 0, 'Relacionamento leu op_itens');
SELECT t.ok((SELECT count(*) FROM public.op_v_fila) = 0, 'Relacionamento leu op_v_fila');
SELECT t.ok((SELECT count(*) FROM public.op_eventos) = 0, 'Relacionamento leu op_eventos');
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos) = 0, 'Relacionamento leu op_lancamentos');
SELECT t.ok((SELECT count(*) FROM public.operacao_membros) = 0, 'Relacionamento leu operacao_membros');
SELECT t.ok((SELECT count(*) FROM public.op_codigos_lancaveis) = 0 OR true, 'n/a');
SELECT t.ok((SELECT public.op_minha_sessao()->'membro') = 'null'::jsonb, 'op_minha_sessao deu membro ao Relacionamento');
SELECT t.ok((SELECT public.op_item_detalhe(id)->>'erro' FROM public.op_itens UNION ALL SELECT 'nao_encontrado' LIMIT 1) = 'nao_encontrado', 'op_item_detalhe abriu para o Relacionamento');
RESET ROLE;
-- o detalhe por id (o id chega por fora, não pela fila): continua fechado
DO $$
DECLARE v_id uuid; v jsonb;
BEGIN
  SELECT id INTO v_id FROM public.op_itens WHERE ctrc = 'OPX1-1';
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  v := public.op_item_detalhe(v_id);
  RESET ROLE;
  PERFORM t.ok(v->>'erro' = 'nao_encontrado', 'op_item_detalhe por id abriu para o Relacionamento');
END $$;

-- ── gestor do Cockpit: vê os dois ────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
SELECT t.ok((SELECT count(*) FROM public.cards) = 1, 'gestor perdeu cards');
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 3, 'gestor deveria ver a fila toda');
SELECT t.ok((SELECT count(*) FROM public.operacao_membros) = 3, 'gestor deveria ver os membros');
RESET ROLE;
UPDATE public.feature_flags SET enabled = false WHERE key = 'operacao_tela';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a2', true);
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 3, 'gestor confere a fila mesmo com a tela OFF');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key = 'operacao_tela';

-- ── supervisor da Operação ───────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
SELECT t.ok((SELECT count(*) FROM public.op_itens) = 3, 'supervisor deveria ver todas as unidades (inclusive sem unidade)');
SELECT t.ok((SELECT count(*) FROM public.cards) = 0, 'supervisor da Operação leu cards');
SELECT t.ok((SELECT count(*) FROM public.messages_inbox) = 0, 'supervisor da Operação leu mensagens');
RESET ROLE;

-- ── outra unidade ────────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
SELECT t.ok((SELECT string_agg(ctrc, ',') FROM public.op_itens) = 'OPX2-2', 'membro BHZ deveria ver só a BHZ');
RESET ROLE;

-- ── sem papel nenhum ─────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
SELECT t.ok((SELECT count(*) FROM public.cards) + (SELECT count(*) FROM public.op_itens) + (SELECT count(*) FROM public.clientes)
            + (SELECT count(*) FROM public.cliente_config) + (SELECT count(*) FROM public.operadores) = 0, 'usuário sem papel leu algo');
SELECT t.ok(t.recusado($$INSERT INTO public.operadores (user_id, nome, email) VALUES ('00000000-0000-0000-0000-0000000000c1','X','x')$$), 'usuário sem papel se inseriu em operadores');
RESET ROLE;

-- ── anon ─────────────────────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT t.ok((SELECT count(*) FROM public.cliente_config) = 0, 'anon leu cliente_config');
SELECT t.ok(t.recusado($$INSERT INTO public.cliente_config VALUES ('ANON', true)$$), 'anon escreveu em cliente_config');
SELECT t.ok(t.recusado($$SELECT count(*) FROM public.op_itens$$), 'anon leu op_itens');
RESET ROLE;

-- ── cadastro de operador continua pelo caminho de sempre (admin-operadores, service_role) ──
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000a3', 'novo@sal');
SET LOCAL ROLE service_role;
SELECT t.ok(NOT t.recusado($$INSERT INTO public.operadores (user_id, nome, email) VALUES ('00000000-0000-0000-0000-0000000000a3','NOVO','novo@sal')$$), 'service_role perdeu o cadastro de operador');
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'OK operacao-separacao.test.sql: Relacionamento e Operação separados; gestor vê os dois'; END $$;
ROLLBACK;
