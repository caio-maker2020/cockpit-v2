-- =============================================================================
-- Teste das RPCs da Operação (mig 430; ADR 0041 D5–D7; INV-181..186).
-- Roda SÓ no Postgres descartável (rodar-local.sh). Transação com ROLLBACK.
-- Cobre: cerca (card ativo, unidade, lista, proibidos, texto 41/56), token da
-- prévia, 1 lançamento ativo por item, assumir, sugestão aceita, CHECKs/trigger da
-- lista, append-only, vazão (teto 3 + janela + quarentena, inclusive da ponte),
-- prazos (interrompido vira erro, nunca volta à fila), confirmação só após 90 min,
-- materialização (cria, atualiza, encerra cancelando a fila, confirma).
-- =============================================================================
BEGIN;
CREATE SCHEMA t;
CREATE FUNCTION t.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
GRANT USAGE ON SCHEMA t TO authenticated, service_role;

CREATE TABLE t.v (k text PRIMARY KEY, j jsonb);
-- id do item lido como o dono (a RLS de quem está testando não pode esconder o alvo do teste)
CREATE FUNCTION t.item(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_itens WHERE ctrc = p_ctrc AND status <> 'encerrado' $$;
GRANT ALL ON t.v TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'rel@sal'), ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal'),
  ('00000000-0000-0000-0000-0000000000b2', 'op.bhz@sal'), ('00000000-0000-0000-0000-0000000000b4', 'leitura@sal');
INSERT INTO public.operadores (user_id, nome, email) VALUES ('00000000-0000-0000-0000-0000000000a1', 'LARISSA', 'rel@sal');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Ana BHZ', 'op.bhz@sal', 'operador_op', '{BHZ}', true),
  ('00000000-0000-0000-0000-0000000000b4', 'So Leitura', 'leitura@sal', 'operador_op', '{VGA}', false);

-- ── lista de códigos: CHECKs e trigger ───────────────────────────────────────
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio) VALUES (49, 'criterio qualquer longo')$$), '49 entrou na lista');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio) VALUES (54, 'criterio qualquer longo')$$), '54 entrou na lista');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio) VALUES (33, 'criterio qualquer longo')$$), '33 entrou na lista');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio) VALUES (6, 'criterio qualquer longo')$$), '6 entrou na lista');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio) VALUES (11, 'endereco e do Relacionamento')$$), 'oc do Relacionamento entrou na lista (trigger)');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio, exige_texto) VALUES (41, 'informacao complementar', false)$$), '41 sem exige_texto');
SELECT t.ok(t.recusado($$INSERT INTO public.op_codigos_lancaveis (codigo, criterio, ativo) VALUES (36, 'chegou na base de entrega', true)$$), 'ativo sem dono');
INSERT INTO public.op_codigos_lancaveis (codigo, criterio, ativo, pedido_por, autorizado_por, autorizado_em) VALUES
  (36, 'fato da rota: chegou na base de entrega', true, 'Fulano (VGA)', 'Caio', '2026-10-07');
INSERT INTO public.op_codigos_lancaveis (codigo, criterio, exige_texto, ativo, pedido_por, autorizado_por, autorizado_em) VALUES
  (41, 'informação complementar da rota', true, true, 'Fulano (VGA)', 'Caio', '2026-10-07');
INSERT INTO public.op_codigos_lancaveis (codigo, criterio, ativo) VALUES (37, 'problema no veiculo (inativo)', false);

INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia) VALUES
  ('VGA1-1', '1001', 'VGA', 13), ('VGA2-2', '1002', 'VGA', 13), ('VGA3-3', '1003', 'VGA', 13),
  ('VGA4-4', '1004', 'VGA', 13), ('VGA5-5', '1005', 'VGA', 13), ('VGA6-6', NULL, 'VGA', 13),
  ('VGA7-7', '1007', 'VGA', 36);
-- CTRC com card ATIVO no Relacionamento (não deveria nem estar na fila; a cerca segura de novo)
INSERT INTO public.cards (nf, ctrc, state) VALUES ('1003', 'VGA3-3', 'AGUARDANDO_CLIENTE');
-- append-only
INSERT INTO public.op_eventos (op_item_id, tipo, ator_tipo) SELECT id, 'ItemMaterializado', 'system' FROM public.op_itens WHERE ctrc = 'VGA1-1';
SELECT t.ok(t.recusado($$UPDATE public.op_eventos SET payload = '{}'$$), 'op_eventos aceitou UPDATE');
SELECT t.ok(t.recusado($$DELETE FROM public.op_eventos$$), 'op_eventos aceitou DELETE');

-- ── flags OFF: nada se pede ───────────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t.ok(public.op_previa_lancamento(t.item('VGA1-1'), 36, 'chegou')->>'erro' IS NOT NULL, 'prévia com flags OFF');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key IN ('operacao_tela', 'operacao_lancar_ssw');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
-- prévia ok
INSERT INTO t.v SELECT 'p1', public.op_previa_lancamento(t.item('VGA1-1'), 36, '  chegou na base  ');
SELECT t.ok((SELECT (j->>'ok')::boolean FROM t.v WHERE k='p1'), 'prévia válida recusada: ' || (SELECT j::text FROM t.v WHERE k='p1'));
SELECT t.ok((SELECT j->'previa'->>'texto_ssw' FROM t.v WHERE k='p1') = 'chegou na base (Operação VGA por Joao VGA)', 'texto_ssw da prévia');
SELECT t.ok((SELECT j->'previa'->>'ctrc' FROM t.v WHERE k='p1') = 'VGA1-1' AND (SELECT j->'previa'->>'nf' FROM t.v WHERE k='p1') = '1001', 'CTRC/NF da prévia vêm do item');
SELECT t.ok((SELECT j ? 'membro_id' FROM t.v WHERE k='p1') IS FALSE, 'prévia vazou campo interno');
-- token errado → não grava
SELECT t.ok(public.op_solicitar_lancamento(t.item('VGA1-1'), 36, '  chegou na base  ', 'token-errado')->>'erro' = 'previa_desatualizada', 'token errado aceito');
-- texto diferente do da prévia → token não bate
SELECT t.ok(public.op_solicitar_lancamento(t.item('VGA1-1'), 36, 'outro texto',
            (SELECT j->>'confirmacao' FROM t.v WHERE k='p1'))->>'erro' = 'previa_desatualizada', 'texto trocado depois da prévia foi aceito');
-- o clique certo
INSERT INTO t.v SELECT 's1', public.op_solicitar_lancamento(t.item('VGA1-1'), 36, '  chegou na base  ',
            (SELECT j->>'confirmacao' FROM t.v WHERE k='p1'));
SELECT t.ok((SELECT (j->>'ok')::boolean FROM t.v WHERE k='s1'), 'solicitar válido recusado: ' || (SELECT j::text FROM t.v WHERE k='s1'));
-- duplo clique
SELECT t.ok(public.op_solicitar_lancamento(t.item('VGA1-1'), 36, '  chegou na base  ',
            (SELECT j->>'confirmacao' FROM t.v WHERE k='p1'))->>'erro' = 'lancamento_em_andamento', 'duplo clique gerou 2º lançamento');
-- cercas
SELECT t.ok(public.op_previa_lancamento(t.item('VGA3-3'), 36, 'x')->>'erro' = 'tratativa_aberta_no_relacionamento', 'card ativo não barrou');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA2-2'), 49, 'x')->>'erro' = 'codigo_proibido', '49 não barrou');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA2-2'), 37, 'x')->>'erro' = 'codigo_nao_permitido', 'código inativo não barrou');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA2-2'), 21, 'x')->>'erro' = 'codigo_nao_permitido', 'código fora da lista não barrou');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA2-2'), 41, 'curto')->>'erro' = 'texto_obrigatorio', '41 sem texto não barrou (INV-046)');
SELECT t.ok((public.op_previa_lancamento(t.item('VGA2-2'), 41, 'veículo quebrou na BR-381')->>'ok')::boolean, '41 com texto recusado');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA6-6'), 36, 'x')->>'erro' = 'sem_nf_para_tripe', 'item sem NF não barrou');
SELECT t.ok(public.op_previa_lancamento(t.item('VGA7-7'), 36, 'x')->>'erro' = 'ja_e_a_ultima_oc', 'repetir a última oc não barrou');
-- assumir
SELECT t.ok((public.op_assumir(t.item('VGA2-2'))->>'ok')::boolean, 'assumir falhou');
RESET ROLE;

-- outra unidade e quem não pode lançar
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
SELECT t.ok(public.op_previa_lancamento(t.item('VGA2-2'), 36, 'x')->>'erro' = 'fora_da_sua_unidade', 'outra unidade não barrou');
SELECT t.ok(public.op_assumir(t.item('VGA2-2'))->>'erro' IN ('fora_da_sua_unidade', 'item_fechado'), 'outra unidade assumiu');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b4', true);
SELECT t.ok(public.op_previa_lancamento(t.item('VGA4-4'), 36, 'x')->>'erro' = 'sem_permissao_de_lancar', 'membro só-leitura lançou');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
SELECT t.ok(public.op_solicitar_lancamento(t.item('VGA4-4'), 36, 'x', 'x')->>'erro' = 'nao_e_membro_da_operacao', 'Relacionamento pediu lançamento pela Operação');
RESET ROLE;

-- sugestão em sombra aceita com 1 clique sobre a prévia
UPDATE public.op_itens SET sugestao = '{"regra_id":"r1","codigo":36,"texto":"chegou na base","lancavel":true}' WHERE ctrc = 'VGA4-4';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO t.v SELECT 'p4', public.op_previa_lancamento(t.item('VGA4-4'), 36, 'chegou na base');
INSERT INTO t.v SELECT 's4', public.op_aceitar_sugestao(t.item('VGA4-4'), (SELECT j->>'confirmacao' FROM t.v WHERE k='p4'));
SELECT t.ok((SELECT (j->>'ok')::boolean FROM t.v WHERE k='s4'), 'aceitar sugestão falhou: ' || (SELECT j::text FROM t.v WHERE k='s4'));
SELECT t.ok(public.op_aceitar_sugestao(t.item('VGA5-5'), 'x')->>'erro' = 'sem_sugestao', 'aceitou sem sugestão');
RESET ROLE;
SELECT t.ok((SELECT origem FROM public.op_lancamentos WHERE id = (SELECT (j->>'lancamento_id')::uuid FROM t.v WHERE k='s4')) = 'sugestao', 'origem sugestao');
SELECT t.ok((SELECT count(*) FROM public.op_eventos e JOIN public.op_itens i ON i.id = e.op_item_id WHERE i.ctrc='VGA4-4' AND e.tipo='SugestaoAceita') = 1, 'evento SugestaoAceita');
SELECT t.ok((SELECT status FROM public.op_itens WHERE ctrc='VGA1-1') = 'lancamento_pendente', 'item não ficou lancamento_pendente');
SELECT t.ok((SELECT assumido_por_nome FROM public.op_itens WHERE ctrc='VGA1-1') = 'Joao VGA', 'pedir lançamento não assumiu o item livre');

-- ── VAZÃO: mais 3 pedidos na fila (total 5), teto 3 por janela ───────────────
INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome)
SELECT i.id, i.ctrc, i.nf, 36, 'x (Operação VGA por Joao VGA)', 'tk', m.id, m.nome
  FROM public.op_itens i, public.operacao_membros m
 WHERE i.ctrc IN ('VGA2-2', 'VGA5-5', 'VGA7-7') AND m.nome = 'Joao VGA';
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(50, 4, 30)) = 3, 'teto de 3 por minuto furado');
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(50, 4, 30)) = 0, 'janela de 60 s furada');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE status = 'lancando') = 3, '3 reservados');
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE status = 'fila') = 2, '2 na fila');
-- devolver para a fila (freio) e finalizar
SET LOCAL ROLE service_role;
SELECT public.op_devolver_para_fila(ARRAY(SELECT id FROM public.op_lancamentos WHERE status='lancando' AND ctrc='VGA7-7'));
SELECT t.ok(public.op_finalizar_lancamento((SELECT id FROM public.op_lancamentos WHERE status='lancando' ORDER BY solicitado_em LIMIT 1), 'lancado', 'oc 36 lançada', NULL, NULL, 'seq1'), 'finalizar lancado');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_itens WHERE status = 'aguardando_confirmacao') = 1, 'item não foi para aguardando_confirmacao');
-- finalizar de novo o mesmo: não reescreve
SET LOCAL ROLE service_role;
SELECT t.ok(NOT public.op_finalizar_lancamento((SELECT id FROM public.op_lancamentos WHERE status='lancado' LIMIT 1), 'erro', 'x'), 'reescreveu lançamento finalizado');
RESET ROLE;

-- ── confirmação: nunca antes de 90 min ───────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos_a_confirmar(90, 5)) = 0, 'confirmação antes de 90 min');
RESET ROLE;
UPDATE public.op_lancamentos SET lancado_em = now() - interval '30 minutes' WHERE status = 'lancado';
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos_a_confirmar(10, 5)) = 0, 'timeout menor que 90 min foi aceito');
RESET ROLE;
UPDATE public.op_lancamentos SET lancado_em = now() - interval '2 hours' WHERE status = 'lancado';
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos_a_confirmar(90, 5)) = 1, 'lançamento vencido não apareceu para confirmar');
SELECT public.op_registrar_confirmacao((SELECT id FROM public.op_lancamentos WHERE status='lancado'), 'tentar_de_novo', NULL, 'leitura falhou');
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos_a_confirmar(90, 5)) = 0, 'tentativa não espaçou 30 min');
SELECT t.ok(public.op_registrar_confirmacao((SELECT id FROM public.op_lancamentos WHERE status='lancado'), 'confirmado', 36, 'ssw mostra 36'), 'confirmar');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE status='confirmado' AND confirmado_por='ssw') = 1, 'confirmado_por ssw');
SELECT t.ok((SELECT count(*) FROM public.op_itens WHERE status='aguardando_confirmacao') = 0, 'item não liberou após confirmar');

-- ── prazos: interrompido vira erro e NUNCA volta à fila ──────────────────────
UPDATE public.op_lancamentos SET reservado_em = now() - interval '20 minutes' WHERE status = 'lancando';
SET LOCAL ROLE service_role;
SELECT t.ok(public.op_expirar_lancamentos(4, 15) >= 1, 'expirar não pegou o interrompido');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE categoria_erro='lancamento_interrompido' AND status='erro') >= 1, 'interrompido não virou erro');
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE status='lancando') = 0, 'sobrou lançamento em voo');

-- ── quarentena: login recusado para a Operação E para a ponte ───────────────
DELETE FROM public.op_lancamentos WHERE status IN ('fila');
INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome, status, categoria_erro, finalizado_em)
SELECT i.id, i.ctrc, i.nf, 36, 'x', 'tk', m.id, m.nome, 'erro', 'sessao_invalida', now()
  FROM public.op_itens i, public.operacao_membros m WHERE i.ctrc='VGA2-2' AND m.nome='Joao VGA';
INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome)
SELECT i.id, i.ctrc, i.nf, 36, 'x', 'tk', m.id, m.nome FROM public.op_itens i, public.operacao_membros m WHERE i.ctrc='VGA5-5' AND m.nome='Joao VGA';
UPDATE public.op_lancamentos SET reservado_em = now() - interval '5 minutes' WHERE reservado_em IS NOT NULL;
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(2, 4, 30)) = 0, 'reservou em quarentena');
RESET ROLE;
UPDATE public.op_lancamentos SET finalizado_em = now() - interval '2 hours' WHERE categoria_erro = 'sessao_invalida';
-- a ponte (mig 418) com login recusado também segura a Operação
CREATE TABLE public.ponte_operacao_pedidos (pedido_id uuid PRIMARY KEY, reservado_em timestamptz, categoria_erro text, finalizado_em timestamptz);
INSERT INTO public.ponte_operacao_pedidos VALUES (gen_random_uuid(), NULL, 'sessao_invalida', now());
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(2, 4, 30)) = 0, 'quarentena da ponte ignorada');
RESET ROLE;
-- e as reservas da ponte contam na mesma janela
UPDATE public.ponte_operacao_pedidos SET categoria_erro = NULL, reservado_em = now();
INSERT INTO public.ponte_operacao_pedidos VALUES (gen_random_uuid(), now(), NULL, NULL), (gen_random_uuid(), now(), NULL, NULL);
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(3, 4, 30)) = 0, 'janela não contou a ponte (3 da ponte = teto)');
RESET ROLE;
DELETE FROM public.ponte_operacao_pedidos;
SET LOCAL ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.op_reservar_lancamentos(2, 4, 30)) = 1, 'sem quarentena e com vaga deveria reservar');
RESET ROLE;

-- ── materialização ──────────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT t.ok((public.op_materializar_aplicar(
  '[{"ctrc":"NEW1-1","nf":"2001","unidade":"VGA","bastao_pendencia_id":"b1","cod_ultima_ocorrencia":13,"snapshot_hash":"h1","sugestao":null}]',
  '[]', '[]')->>'criados')::int = 1, 'materializar não criou');
SELECT t.ok((public.op_materializar_aplicar(
  '[{"ctrc":"NEW1-1","nf":"2001","unidade":"VGA","bastao_pendencia_id":"b1","cod_ultima_ocorrencia":14,"snapshot_hash":"h2","sugestao":{"regra_id":"r","codigo":36,"texto":"t","lancavel":false}}]',
  '[]', '[]')->>'atualizados')::int = 1, 'materializar não atualizou');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_itens WHERE ctrc='NEW1-1') = 1, '2 itens abertos para o mesmo CTRC');
SELECT t.ok((SELECT string_agg(e.tipo, ',' ORDER BY e.id) FROM public.op_eventos e JOIN public.op_itens i ON i.id=e.op_item_id WHERE i.ctrc='NEW1-1')
            = 'ItemMaterializado,ItemAtualizado,SugestaoGerada', 'eventos da materialização');
-- encerrar cancela o que está na FILA
INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_ssw, confirmacao, solicitado_por, solicitado_por_nome)
SELECT i.id, i.ctrc, i.nf, 36, 'x', 'tk', m.id, m.nome FROM public.op_itens i, public.operacao_membros m WHERE i.ctrc='NEW1-1' AND m.nome='Joao VGA';
SET LOCAL ROLE service_role;
SELECT t.ok((public.op_materializar_aplicar('[]',
  jsonb_build_array(jsonb_build_object('op_item_id', t.item('NEW1-1'), 'motivo', 'card_relacionamento_ativo')),
  '[]')->>'lancamentos_cancelados')::int = 1, 'encerrar não cancelou a fila');
RESET ROLE;
SELECT t.ok((SELECT status FROM public.op_itens WHERE ctrc='NEW1-1') = 'encerrado', 'item não encerrou');
-- renasce depois de encerrado (novo item), índice parcial permite
SET LOCAL ROLE service_role;
SELECT t.ok((public.op_materializar_aplicar('[{"ctrc":"NEW1-1","nf":"2001","unidade":"VGA","bastao_pendencia_id":"b1","cod_ultima_ocorrencia":13,"snapshot_hash":"h3"}]','[]','[]')->>'criados')::int = 1, 'não renasceu');
SELECT t.ok((public.op_materializar_aplicar('[]','[]','[]', ARRAY['NEW1-1'])->>'loop_registrados')::int = 1, 'loop não registrado');
SELECT t.ok((public.op_materializar_aplicar('[]','[]','[]', ARRAY['NEW1-1'])->>'loop_registrados')::int = 0, 'loop registrado 2x em 24 h');
RESET ROLE;
-- confirmação pelo Bastão
UPDATE public.op_lancamentos SET status='lancado', lancado_em=now(), reservado_em = now() - interval '3 minutes' WHERE status='lancando';
SET LOCAL ROLE service_role;
SELECT t.ok((public.op_materializar_aplicar('[]','[]',
  jsonb_build_array(jsonb_build_object('lancamento_id', (SELECT id FROM public.op_lancamentos WHERE status='lancado' LIMIT 1), 'oc_vista', 36)))->>'confirmados')::int = 1, 'confirmação pelo Bastão');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.op_lancamentos WHERE confirmado_por='bastao') = 1, 'confirmado_por bastao');

-- ── authenticated não chama RPC de worker ───────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t.ok(t.recusado($$SELECT * FROM public.op_reservar_lancamentos(3,4,30)$$), 'membro chamou op_reservar_lancamentos');
SELECT t.ok(t.recusado($$SELECT public.op_materializar_aplicar('[]','[]','[]')$$), 'membro chamou op_materializar_aplicar');
SELECT t.ok(t.recusado($$SELECT public.op_registrar_confirmacao(gen_random_uuid(),'confirmado',1,'x')$$), 'membro chamou op_registrar_confirmacao');
SELECT t.ok(t.recusado($$SELECT public.op__solicitar(gen_random_uuid(),36,'x','x','manual',NULL)$$), 'membro chamou função interna');
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'OK operacao-rpcs.test.sql'; END $$;
ROLLBACK;
