-- =============================================================================
-- Teste da mig 438 (ADR 0041 D12; INV-189, emenda espelho). Postgres descartável.
-- Prova: modo padrão = espelho; encaminhar (clique e automático) NÃO cria pedido na
-- ponte, NÃO cria card, NÃO mexe em card_events/todos — mesmo com a flag da ponte ON;
-- grava o espelho com o que o card teria; o item fecha com "encaminhada ao espelho";
-- só gestor e supervisor_op leem; o operador do Relacionamento e o operador da
-- Operação não; 'real' só com dono escrito; avaliação "teria aceitado/recusado".
-- =============================================================================
BEGIN;
CREATE SCHEMA t3;
CREATE FUNCTION t3.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t3.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
CREATE TABLE t3.v (k text PRIMARY KEY, j jsonb);
CREATE FUNCTION t3.item(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_itens WHERE ctrc = p_ctrc ORDER BY created_at DESC LIMIT 1 $$;
CREATE FUNCTION t3.esp(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_relacionamento_espelho WHERE ctrc = p_ctrc ORDER BY recebido_em DESC LIMIT 1 $$;
-- foto do Relacionamento e da ponte (lida como dono)
CREATE FUNCTION t3.foto() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT concat_ws('|', (SELECT count(*) FROM public.cards), (SELECT count(*) FROM public.card_events),
                   (SELECT count(*) FROM public.todos), (SELECT count(*) FROM public.ponte_operacao_pedidos),
                   (SELECT coalesce(max(updated_at)::text, '') FROM public.cards)) $$;
GRANT USAGE ON SCHEMA t3 TO authenticated, service_role;
GRANT ALL ON t3.v TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t3 TO authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal'), ('00000000-0000-0000-0000-0000000000b3', 'sup@sal'),
  ('00000000-0000-0000-0000-0000000000a1', 'rel@sal'), ('00000000-0000-0000-0000-0000000000a9', 'gestor@sal');
INSERT INTO public.operadores (user_id, nome, email, papel) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'LARISSA', 'rel@sal', 'operador'),
  ('00000000-0000-0000-0000-0000000000a9', 'CAIO', 'gestor@sal', 'gestor');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true),
  ('00000000-0000-0000-0000-0000000000b3', 'Sup Op', 'sup@sal', 'supervisor_op', '{}', true);
-- um card qualquer do Relacionamento (outro CTRC), para provar que nada nele muda
INSERT INTO public.cards (nf, ctrc, state, pagador) VALUES ('9999', 'REL9-9', 'AGUARDANDO_VALIDACAO_HUMANA', 'X');
INSERT INTO public.card_events (card_id, event_type) SELECT id, 'CardCriado' FROM public.cards;
INSERT INTO public.todos (card_id, status) SELECT id, 'pendente' FROM public.cards;

-- ── modo: padrão espelho; 'real' só com dono ─────────────────────────────────
SELECT t3.ok(public.op_encaminhar_modo() = 'espelho', 'modo padrão não é espelho');
SELECT t3.ok(t3.recusado($$UPDATE public.op_config SET valor = 'real' WHERE chave = 'operacao_encaminhar_modo'$$), 'real sem dono aceito');
SELECT t3.ok(t3.recusado($$UPDATE public.op_config SET valor = 'outro' WHERE chave = 'operacao_encaminhar_modo'$$), 'modo inválido aceito');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);
SELECT t3.ok(t3.recusado($$UPDATE public.op_config SET valor = 'real', autorizado_por = 'eu', autorizado_em = now(), motivo = 'quero muito ligar' $$), 'gestor mudou o modo pela API');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT t3.ok(t3.recusado($$UPDATE public.op_config SET valor = 'real', autorizado_por = 'eu', autorizado_em = now(), motivo = 'quero muito ligar' $$), 'service_role mudou o modo');
RESET ROLE;

-- ── itens e flags (a flag da PONTE ligada de propósito: espelho não pode usá-la) ─
UPDATE public.feature_flags SET enabled = true WHERE key IN ('operacao_tela', 'ponte_operacao_pedidos', 'ponte_operacao_lancar_ssw', 'operacao_encaminhar_auto');
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia, pagador, sugestao) VALUES
  ('ES1-1', '4001', 'VGA', 15, 'ACME', jsonb_build_object('versao_contrato', 2, 'acao', 'encaminhar_relacionamento', 'fonte', 'agente_ia',
     'base_regra', 'agente_ia', 'codigo', NULL, 'texto', 'cliente ausente: combinar reentrega', 'confianca', 0.93, 'oc_base', 15,
     'justificativa', 'instrução diz cliente ausente')),
  ('ES2-2', '4002', 'VGA', 15, 'ACME', jsonb_build_object('versao_contrato', 2, 'acao', 'encaminhar_relacionamento', 'fonte', 'regra_aprendida',
     'base_regra', 'historico:x', 'codigo', NULL, 'texto', 'recusa: pedir autorização', 'confianca', 0.95, 'oc_base', 15));
INSERT INTO t3.v SELECT 'foto0', to_jsonb(t3.foto());

-- clique
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO t3.v SELECT 'p1', public.op_previa_encaminhamento(t3.item('ES1-1'), '');
SELECT t3.ok((SELECT j->'previa'->>'modo' FROM t3.v WHERE k='p1') = 'espelho', 'prévia não diz que é espelho');
SELECT t3.ok((SELECT j->'previa'->>'destino' FROM t3.v WHERE k='p1') LIKE 'ESPELHO%', 'prévia não avisa o destino espelho');
INSERT INTO t3.v SELECT 'e1', public.op_encaminhar_relacionamento(t3.item('ES1-1'), '', (SELECT j->>'confirmacao' FROM t3.v WHERE k='p1'));
SELECT t3.ok((SELECT j->>'status' FROM t3.v WHERE k='e1') = 'espelhado' AND (SELECT j->>'modo' FROM t3.v WHERE k='e1') = 'espelho',
  'clique não foi ao espelho: ' || (SELECT j::text FROM t3.v WHERE k='e1'));
RESET ROLE;
-- automático (janela vencida)
SET LOCAL ROLE service_role;
SELECT t3.ok(public.op_encaminhar_auto(0.9, 10, 20) = 1, 'auto não agendou ES2');
RESET ROLE;
UPDATE public.op_encaminhamentos SET executar_apos = now() - interval '1 minute' WHERE ctrc = 'ES2-2';
SET LOCAL ROLE service_role;
SELECT t3.ok((public.op_encaminhamentos_promover(20)->>'espelhado')::integer = 1, 'auto não foi ao espelho');
RESET ROLE;

-- NADA no Relacionamento real nem na ponte
SELECT t3.ok(t3.foto() = (SELECT j #>> '{}' FROM t3.v WHERE k='foto0'), 'cards/card_events/todos/ponte mudaram: ' || t3.foto());
SELECT t3.ok((SELECT count(*) FROM public.op_encaminhamentos WHERE pedido_id IS NOT NULL) = 0, 'encaminhamento com pedido da ponte');
-- o espelho tem o que o card teria
SELECT t3.ok((SELECT count(*) FROM public.op_relacionamento_espelho) = 2, 'espelho sem as 2 notas');
SELECT t3.ok((SELECT texto_49 = 'cliente ausente: combinar reentrega (pedido da operação VGA por Joao VGA)'
                     AND nf = '4001' AND status = 'recebido_no_espelho' AND origem = 'manual'
                     AND motivo = 'instrução diz cliente ausente'
                     AND card_previsto->>'state' = 'AGUARDANDO_VALIDACAO_HUMANA' AND (card_previsto->>'lock')::boolean
                     AND sugestao->>'fonte' = 'agente_ia'
                FROM public.op_relacionamento_espelho WHERE ctrc = 'ES1-1'), 'conteúdo do espelho');
SELECT t3.ok((SELECT origem = 'auto' AND solicitado_por_nome = 'Agente da Operação (automático)' FROM public.op_relacionamento_espelho WHERE ctrc = 'ES2-2'), 'espelho do auto');
SELECT t3.ok((SELECT bool_and(status = 'encerrado' AND motivo_encerramento = 'encaminhado_espelho') FROM public.op_itens WHERE ctrc IN ('ES1-1', 'ES2-2')), 'item não fechou');
SELECT t3.ok((SELECT payload->>'resumo' FROM public.op_eventos WHERE op_item_id = t3.item('ES1-1') AND tipo = 'EncaminhadoAoEspelho')
  LIKE 'encaminhada ao espelho do Relacionamento às __:__', 'evento do espelho');
SET LOCAL ROLE service_role;
SELECT t3.ok((SELECT oc_base FROM public.op_ctrcs_no_espelho() WHERE ctrc = 'ES1-1') = 15, 'op_ctrcs_no_espelho');
RESET ROLE;

-- ── quem lê o espelho ────────────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);  -- operador do Relacionamento
SELECT t3.ok((SELECT count(*) FROM public.op_relacionamento_espelho) = 0, 'operador do Relacionamento leu o espelho');
SELECT t3.ok(public.op_espelho_relacionamento_listar()->>'erro' = 'sem_acesso_ao_espelho', 'operador do Relacionamento listou');
SELECT t3.ok(public.op_espelho_relacionamento_avaliar(t3.esp('ES1-1'), true, NULL)->>'erro' = 'sem_acesso_ao_espelho', 'operador do Relacionamento avaliou');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);  -- operador da Operação
SELECT t3.ok((SELECT count(*) FROM public.op_relacionamento_espelho) = 0, 'operador_op leu o espelho');
SELECT t3.ok(public.op_espelho_relacionamento_listar()->>'erro' = 'sem_acesso_ao_espelho', 'operador_op listou');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);  -- supervisor_op
SELECT t3.ok((SELECT count(*) FROM public.op_relacionamento_espelho) = 2, 'supervisor_op não leu');
INSERT INTO t3.v SELECT 'l1', public.op_espelho_relacionamento_listar();
SELECT t3.ok((SELECT jsonb_array_length(j->'itens') FROM t3.v WHERE k='l1') = 2 AND (SELECT j->>'modo' FROM t3.v WHERE k='l1') = 'espelho', 'listar');
SELECT t3.ok((SELECT j->'itens'->0 ? 'texto_49' AND j->'itens'->0 ? 'card_previsto' FROM t3.v WHERE k='l1'), 'listar sem o que o card teria');
SELECT t3.ok(public.op_espelho_relacionamento_avaliar(t3.esp('ES1-1'), false, '')->>'erro' = 'motivo_obrigatorio', 'recusa sem motivo');
SELECT t3.ok((public.op_espelho_relacionamento_avaliar(t3.esp('ES1-1'), false, 'cliente já tinha reagendado')->>'ok')::boolean, 'recusa com motivo');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a9', true);  -- gestor
SELECT t3.ok((public.op_espelho_relacionamento_avaliar(t3.esp('ES2-2'), true)->>'ok')::boolean, 'gestor avaliou');
SELECT t3.ok(jsonb_array_length(public.op_espelho_relacionamento_listar(50, 'avaliado')->'itens') = 2, 'filtro por status');
SELECT t3.ok(t3.recusado($$UPDATE public.op_relacionamento_espelho SET status = 'avaliado'$$), 'escrita direta no espelho');
RESET ROLE;
SELECT t3.ok((SELECT teria_aceitado = false AND avaliado_por_nome = 'Sup Op' FROM public.op_relacionamento_espelho WHERE ctrc = 'ES1-1'), 'avaliação gravada');
SELECT t3.ok((SELECT avaliado_por_nome FROM public.op_relacionamento_espelho WHERE ctrc = 'ES2-2') = 'CAIO', 'avaliador gestor');

-- ── nada do Relacionamento lê o espelho: só funções op_* o citam, e nenhuma view ─
SELECT t3.ok(NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND definition ILIKE '%op_relacionamento_espelho%'), 'view lê o espelho');
SELECT t3.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.prosrc ILIKE '%op_relacionamento_espelho%' AND p.proname NOT LIKE 'op\_%'),
  'função fora da Operação lê o espelho');

-- no fim, a foto do Relacionamento continua a mesma
SELECT t3.ok(t3.foto() = (SELECT j #>> '{}' FROM t3.v WHERE k='foto0'), 'Relacionamento mudou no fim');
DO $$ BEGIN RAISE NOTICE 'OK operacao-espelho.test.sql'; END $$;
ROLLBACK;
