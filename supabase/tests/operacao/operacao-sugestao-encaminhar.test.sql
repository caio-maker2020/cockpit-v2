-- =============================================================================
-- Teste das migs 434–436 (ADR 0041 D10/D11; INV-188/189). Postgres descartável
-- (rodar-local.sh). Transação com ROLLBACK.
-- Cobre: regras aprendidas (CHECKs e trigger), cache da IA (1 chamada por item+oc,
-- contrato revalidado no banco, regra vence agente, item que mudou), encaminhar
-- (flags, prévia/token, 1 clique cria o pedido da ponte e encerra o item, a
-- Operação não vê o card), auto (flag, limiar com piso, janela, desfazer, não
-- insiste depois de desfeito), aceitar sugestão de encaminhamento recusa.
-- =============================================================================
BEGIN;
CREATE SCHEMA t2;
CREATE FUNCTION t2.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t2.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
CREATE TABLE t2.v (k text PRIMARY KEY, j jsonb);
CREATE FUNCTION t2.item(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_itens WHERE ctrc = p_ctrc ORDER BY created_at DESC LIMIT 1 $$;
CREATE FUNCTION t2.enc(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_encaminhamentos WHERE ctrc = p_ctrc ORDER BY created_at DESC LIMIT 1 $$;
GRANT USAGE ON SCHEMA t2 TO authenticated, service_role;
GRANT ALL ON t2.v TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t2 TO authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal'), ('00000000-0000-0000-0000-0000000000b2', 'op.bhz@sal');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Ana BHZ', 'op.bhz@sal', 'operador_op', '{BHZ}', true);

-- flags nascem OFF
SELECT t2.ok((SELECT enabled FROM public.feature_flags WHERE key = 'operacao_sugestao_ia') = false, 'operacao_sugestao_ia nasceu ON');
SELECT t2.ok((SELECT enabled FROM public.feature_flags WHERE key = 'operacao_encaminhar_auto') = false, 'operacao_encaminhar_auto nasceu ON');
SELECT t2.ok((SELECT count(*) FROM public.op_regras_sugestao) = 0, 'op_regras_sugestao nasceu com linhas');

-- ── 434: regras aprendidas ────────────────────────────────────────────────────
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('r49', 13, 'lancar_ocorrencia', 49, 'tratativa', 0.9, 10, 'hist', 'teste')$$), 'regra com 49 entrou');
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('r41', 13, 'lancar_ocorrencia', 41, 'info', 0.9, 10, 'hist', 'teste')$$), 'regra com 41 entrou');
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('r11', 13, 'lancar_ocorrencia', 11, 'endereco', 0.9, 10, 'hist', 'teste')$$), 'regra com oc do Relacionamento entrou (trigger)');
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('rEnc', 13, 'encaminhar_relacionamento', 36, 'cliente', 0.9, 10, 'hist', 'teste')$$), 'encaminhar com código entrou');
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('rLongo', 13, 'lancar_ocorrencia', 36, repeat('x', 71), 0.9, 10, 'hist', 'teste')$$), 'texto > 70 entrou');
SELECT t2.ok(t2.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('rConf', 13, 'lancar_ocorrencia', 36, 'chegou', 1.5, 10, 'hist', 'teste')$$), 'confiança > 1 entrou');
INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_unidade, acao, codigo, texto, confianca, casos, base_regra, carga) VALUES
  ('h13-vga-36', 13, 'VGA', 'lancar_ocorrencia', 36, 'chegou na base de entrega', 0.85, 40, 'historico:2026-07..09', 'teste'),
  ('h15-enc', 15, NULL, 'encaminhar_relacionamento', NULL, 'cliente precisa autorizar reentrega', 0.9, 22, 'historico:2026-07..09', 'teste');
SET LOCAL ROLE authenticated;
SELECT t2.ok(t2.recusado($$SELECT count(*) FROM public.op_regras_sugestao$$), 'authenticated leu op_regras_sugestao');
RESET ROLE;

-- ── 435: cache e gravação da IA ──────────────────────────────────────────────
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia) VALUES
  ('IA1-1', '2001', 'VGA', 21), ('IA2-2', '2002', 'VGA', 21), ('IA3-3', '2003', 'VGA', 21),
  ('EN1-1', '3001', 'VGA', 15), ('EN2-2', '3002', 'VGA', 15), ('EN3-3', '3003', 'VGA', 15),
  ('EN4-4', '3004', 'VGA', 15), ('EN5-5', '3005', 'VGA', 6);
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia, sugestao)
  VALUES ('RG1-1', '2004', 'VGA', 21, '{"versao_contrato":2,"fonte":"regra_fixa","acao":"lancar_ocorrencia","codigo":36}');

SET LOCAL ROLE authenticated;
SELECT t2.ok(t2.recusado($$SELECT * FROM public.op_sugestao_ia_candidatos(10)$$), 'authenticated chamou candidatos');
SELECT t2.ok(t2.recusado($$SELECT public.op_gravar_sugestao_ia(gen_random_uuid(), 21, 'falha', NULL, 'x', 'm', 'v', 0, 0, 0)$$), 'authenticated gravou sugestão');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT t2.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t2.item('IA1-1')) = 1, 'IA1 não é candidato');
SELECT t2.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t2.item('RG1-1')) = 0, 'item com sugestão de regra virou candidato');
-- ok → grava no item + evento + cache
INSERT INTO t2.v SELECT 'g1', to_jsonb(public.op_gravar_sugestao_ia(t2.item('IA1-1'), 21, 'ok',
  '{"versao_contrato":2,"acao":"lancar_ocorrencia","fonte":"agente_ia","base_regra":"agente_ia","regra_id":"agente_ia","codigo":36,"texto":"chegou na base","motivo":"m","lancavel":false,"confianca":0.7,"casos":null,"oc_base":21,"versao_regras":"agente:1.0.0","modelo":"claude-haiku-4-5","versao_prompt":"1.0.0","justificativa":"j"}',
  NULL, 'claude-haiku-4-5', '1.0.0', 1200, 80, 900));
SELECT t2.ok((SELECT j #>> '{}' FROM t2.v WHERE k='g1') = 'gravada', 'ok não gravou: ' || (SELECT j::text FROM t2.v WHERE k='g1'));
-- mesma (item, oc) de novo → cache, nada muda
SELECT t2.ok(public.op_gravar_sugestao_ia(t2.item('IA1-1'), 21, 'falha', NULL, 'timeout', 'm', 'v', 0, 0, 0) = 'cache', 'cache não segurou 2ª chamada');
SELECT t2.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t2.item('IA1-1')) = 0, 'IA1 segue candidato depois de gravada');
-- código proibido que escapou do TS → o banco descarta
SELECT t2.ok(public.op_gravar_sugestao_ia(t2.item('IA2-2'), 21, 'ok',
  '{"versao_contrato":2,"acao":"lancar_ocorrencia","fonte":"agente_ia","base_regra":"agente_ia","codigo":49,"texto":"tratativa","confianca":0.9,"oc_base":21}',
  NULL, 'm', 'v', 0, 0, 0) = 'descartada', 'código 49 gravado no item');
SELECT t2.ok((SELECT sugestao IS NULL FROM public.op_itens WHERE id = t2.item('IA2-2')), 'sugestão 49 chegou ao item');
SELECT t2.ok((SELECT motivo FROM public.op_sugestao_ia_cache WHERE op_item_id = t2.item('IA2-2')) LIKE 'recusada_no_banco:codigo_proibido%', 'motivo do descarte');
-- falha → só cache; e não volta a ser candidato
SELECT t2.ok(public.op_gravar_sugestao_ia(t2.item('IA3-3'), 21, 'falha', NULL, 'timeout', 'm', 'v', 0, 0, 15000) = 'falha', 'falha não registrada');
SELECT t2.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t2.item('IA3-3')) = 0, 'falha voltou a ser candidata na mesma oc');
RESET ROLE;
-- oc mudou → candidato de novo (chave nova)
UPDATE public.op_itens SET cod_ultima_ocorrencia = 36 WHERE id = t2.item('IA3-3');
SET LOCAL ROLE service_role;
SELECT t2.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t2.item('IA3-3')) = 1, 'oc nova não reabriu o candidato');
-- item mudou de oc entre a chamada e a gravação → não grava no item
SELECT t2.ok(public.op_gravar_sugestao_ia(t2.item('IA3-3'), 21, 'ok',
  '{"versao_contrato":2,"acao":"lancar_ocorrencia","fonte":"agente_ia","base_regra":"agente_ia","codigo":36,"texto":"chegou","confianca":0.9,"oc_base":21}',
  NULL, 'm', 'v', 0, 0, 0) = 'cache', 'gravou na oc velha');
RESET ROLE;
SELECT t2.ok((SELECT count(*) FROM public.op_eventos WHERE op_item_id = t2.item('IA1-1') AND tipo = 'SugestaoGerada') = 1, 'evento SugestaoGerada da IA');

-- ── 436: encaminhar ao Relacionamento ────────────────────────────────────────
UPDATE public.op_itens SET sugestao = jsonb_build_object('versao_contrato', 2, 'acao', 'encaminhar_relacionamento', 'fonte', 'agente_ia',
  'base_regra', 'agente_ia', 'regra_id', 'agente_ia', 'codigo', NULL, 'texto', 'cliente precisa autorizar reentrega',
  'confianca', 0.95, 'oc_base', 15, 'lancavel', false)
 WHERE ctrc IN ('EN1-1', 'EN2-2', 'EN3-3', 'EN4-4');
UPDATE public.op_itens SET sugestao = jsonb_set(sugestao, '{confianca}', '0.82') WHERE ctrc = 'EN4-4';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
-- aceitar sugestão de encaminhamento pelo botão de lançar → recusa
SELECT t2.ok(public.op_aceitar_sugestao(t2.item('EN1-1'), 'x')->>'erro' = 'sugestao_e_encaminhamento', 'aceitar lançou sugestão de encaminhamento');
-- flags OFF → recusa
SELECT t2.ok(public.op_previa_encaminhamento(t2.item('EN1-1'), '')->>'erro' IN ('tela_desligada', 'encaminhar_desligado'), 'prévia com flags OFF');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key IN ('operacao_tela');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t2.ok(public.op_previa_encaminhamento(t2.item('EN1-1'), '')->>'erro' = 'encaminhar_desligado', 'encaminhou com a ponte OFF');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key = 'ponte_operacao_pedidos';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
INSERT INTO t2.v SELECT 'pe1', public.op_previa_encaminhamento(t2.item('EN1-1'), '');
SELECT t2.ok((SELECT (j->>'ok')::boolean FROM t2.v WHERE k='pe1'), 'prévia de encaminhamento recusada: ' || (SELECT j::text FROM t2.v WHERE k='pe1'));
SELECT t2.ok((SELECT j->>'texto' FROM t2.v WHERE k='pe1') = 'cliente precisa autorizar reentrega', 'texto vazio não pegou o da sugestão');
SELECT t2.ok((SELECT j->'previa'->>'texto_ssw_49' FROM t2.v WHERE k='pe1')
  = 'cliente precisa autorizar reentrega (pedido da operação VGA por Joao VGA)', 'texto da 49 na prévia (mesmo formato da ponte)');
SELECT t2.ok((SELECT j ? 'membro_id' FROM t2.v WHERE k='pe1') IS FALSE, 'prévia vazou campo interno');
SELECT t2.ok(public.op_previa_encaminhamento(t2.item('EN5-5'), 'x x x')->>'erro' = 'nota_em_extravio', 'extravio encaminhado');
SELECT t2.ok(public.op_encaminhar_relacionamento(t2.item('EN1-1'), '', 'token-errado')->>'erro' = 'previa_desatualizada', 'token errado aceito');
INSERT INTO t2.v SELECT 'e1', public.op_encaminhar_relacionamento(t2.item('EN1-1'), '', (SELECT j->>'confirmacao' FROM t2.v WHERE k='pe1'));
SELECT t2.ok((SELECT (j->>'ok')::boolean FROM t2.v WHERE k='e1'), 'encaminhar recusado: ' || (SELECT j::text FROM t2.v WHERE k='e1'));
SELECT t2.ok(public.op_encaminhar_relacionamento(t2.item('EN1-1'), '', (SELECT j->>'confirmacao' FROM t2.v WHERE k='pe1'))->>'erro' = 'item_fechado', 'duplo clique encaminhou 2x');
-- a Operação não lê o pedido da ponte (nem o card)
SELECT t2.ok(t2.recusado($$SELECT count(*) FROM public.ponte_operacao_pedidos$$), 'Operação leu ponte_operacao_pedidos');
INSERT INTO t2.v SELECT 'd1', public.op_encaminhamentos_do_item(t2.item('EN1-1'));
SELECT t2.ok((SELECT j->'encaminhamentos'->0->>'status' FROM t2.v WHERE k='d1') = 'enviado', 'encaminhamentos_do_item');
SELECT t2.ok((SELECT j::text FROM t2.v WHERE k='d1') NOT LIKE '%card%', 'encaminhamentos_do_item vazou card');
RESET ROLE;
SELECT t2.ok((SELECT status = 'encerrado' AND motivo_encerramento = 'encaminhado_relacionamento' FROM public.op_itens WHERE ctrc = 'EN1-1'),
  'item não encerrou como encaminhado');
SELECT t2.ok((SELECT count(*) FROM public.ponte_operacao_pedidos p WHERE p.ctrc = 'EN1-1' AND p.tipo = 'devolver_ao_relacionamento'
  AND p.codigo_ocorrencia = 49 AND p.origem = 'cockpit_operacao' AND p.status = 'recebido' AND p.etapa = 'vincular_card'
  AND p.solicitado_por_nome = 'Joao VGA' AND p.nf = '3001' AND p.base = 'VGA') = 1, 'pedido da ponte não nasceu como devolver (vincular_card)');
SELECT t2.ok((SELECT payload->>'resumo' FROM public.op_eventos WHERE op_item_id = t2.item('EN1-1') AND tipo = 'EncaminhadoAoRelacionamento')
  LIKE 'encaminhada ao Relacionamento às __:__', 'evento "encaminhada às HH:MM"');
SET LOCAL ROLE service_role;
SELECT t2.ok((SELECT count(*) FROM public.op_ctrcs_encaminhamento_pendente() c WHERE c.ctrc = 'EN1-1') = 1, 'CTRC encaminhado não aparece como pendente (materializador o traria de volta)');
RESET ROLE;
-- ponte: origem cockpit_operacao exige devolver + vínculo
SELECT t2.ok(t2.recusado($$INSERT INTO public.ponte_operacao_pedidos (pedido_id, tipo, ctrc, codigo_ocorrencia, texto, solicitado_por_id,
  solicitado_por_nome, hash_pedido, origem) VALUES (gen_random_uuid(), 'devolver_ao_relacionamento', 'X1-1', 49, 'abc', 'x', 'xx', 'h', 'cockpit_operacao')$$),
  'pedido cockpit_operacao sem vínculo entrou');
-- ponte: pedido antigo (roteirizador) continua igual
SELECT t2.ok((SELECT count(*) FROM public.ponte_operacao_pedidos WHERE origem = 'roteirizador') = 0, 'origem default');

-- ── auto-encaminhamento ───────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT t2.ok(public.op_encaminhar_auto(0.9, 30, 20) = 0, 'auto com flag OFF agendou');
RESET ROLE;
UPDATE public.feature_flags SET enabled = true WHERE key = 'operacao_encaminhar_auto';
UPDATE public.op_itens SET assumido_por = (SELECT id FROM public.operacao_membros WHERE nome = 'Joao VGA'), assumido_por_nome = 'Joao VGA',
       status = 'assumido' WHERE ctrc = 'EN3-3';
SET LOCAL ROLE service_role;
-- limiar 0.5 vira o piso 0.8: EN2 (0.95) e EN4 (0.82) entram; EN3 está assumido (não atropela)
SELECT t2.ok(public.op_encaminhar_auto(0.5, 1, 20) = 2, 'auto: limiar/piso/assumido');
SELECT t2.ok((SELECT executar_apos > now() + interval '9 minutes' FROM public.op_encaminhamentos WHERE ctrc = 'EN2-2' AND status = 'agendado'),
  'janela abaixo do piso de 10 min');
SELECT t2.ok(public.op_encaminhar_auto(0.9, 30, 20) = 0, 'auto agendou 2x o mesmo item');
-- janela ainda aberta → promover não envia
SELECT t2.ok(coalesce((public.op_encaminhamentos_promover(20)->>'enviado')::integer, 0) = 0, 'promoveu antes da janela');
RESET ROLE;
SELECT t2.ok((SELECT status FROM public.op_itens WHERE ctrc = 'EN2-2') = 'aberto', 'item agendado saiu da fila antes da janela');
SELECT t2.ok((SELECT count(*) FROM public.op_eventos WHERE op_item_id = t2.item('EN2-2') AND tipo = 'EncaminhamentoAgendado') = 1, 'evento auditável do agendamento');
-- a fila mostra o agendado (aviso + desfazer)
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t2.ok((SELECT encaminhamento_origem FROM public.op_v_fila WHERE ctrc = 'EN2-2') = 'auto', 'op_v_fila sem o encaminhamento agendado');
-- desfazer EN4 enquanto agendado
SELECT t2.ok((public.op_desfazer_encaminhamento((SELECT id FROM public.op_encaminhamentos WHERE ctrc = 'EN4-4' AND status = 'agendado'))->>'ok')::boolean,
  'desfazer agendado falhou');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
SELECT t2.ok(public.op_desfazer_encaminhamento(t2.enc('EN2-2'))->>'erro'
  = 'fora_da_sua_unidade', 'outra unidade desfez');
RESET ROLE;
-- depois de desfeito, o agente não insiste na mesma oc
SET LOCAL ROLE service_role;
SELECT t2.ok(public.op_encaminhar_auto(0.8, 30, 20) = 0, 'agente reagendou o que a pessoa desfez');
RESET ROLE;
-- janela vence → promover envia EN2
UPDATE public.op_encaminhamentos SET executar_apos = now() - interval '1 minute' WHERE ctrc = 'EN2-2' AND status = 'agendado';
SET LOCAL ROLE service_role;
SELECT t2.ok((public.op_encaminhamentos_promover(20)->>'enviado')::integer = 1, 'promover não enviou o vencido');
RESET ROLE;
SELECT t2.ok((SELECT motivo_encerramento FROM public.op_itens WHERE ctrc = 'EN2-2') = 'encaminhado_relacionamento', 'auto não encerrou o item');
SELECT t2.ok((SELECT solicitado_por_id FROM public.ponte_operacao_pedidos WHERE ctrc = 'EN2-2') = 'agente-operacao', 'pedido auto sem autor de máquina');
-- enviado não se desfaz
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t2.ok(public.op_desfazer_encaminhamento((SELECT id FROM public.op_encaminhamentos WHERE ctrc = 'EN2-2'))->>'erro' = 'ja_enviado', 'desfez depois de enviado');
RESET ROLE;
-- oc mudou durante a janela → cancelado, não enviado
UPDATE public.op_itens SET status = 'aberto', assumido_por = NULL, assumido_por_nome = NULL WHERE ctrc = 'EN3-3';
SET LOCAL ROLE service_role;
SELECT t2.ok(public.op_encaminhar_auto(0.9, 10, 20) = 1, 'EN3 liberado não agendou');
RESET ROLE;
UPDATE public.op_itens SET cod_ultima_ocorrencia = 36 WHERE ctrc = 'EN3-3';
UPDATE public.op_encaminhamentos SET executar_apos = now() - interval '1 minute' WHERE ctrc = 'EN3-3' AND status = 'agendado';
SET LOCAL ROLE service_role;
SELECT t2.ok((public.op_encaminhamentos_promover(20)->>'cancelado')::integer = 1, 'oc mudou e mesmo assim enviou');
RESET ROLE;
SELECT t2.ok((SELECT motivo_fim FROM public.op_encaminhamentos WHERE ctrc = 'EN3-3') = 'oc_mudou', 'motivo oc_mudou');
SELECT t2.ok((SELECT status FROM public.op_itens WHERE ctrc = 'EN3-3') = 'aberto', 'item cancelado saiu da fila');

-- append-only continua
SELECT t2.ok(t2.recusado($$UPDATE public.op_eventos SET payload = '{}' WHERE tipo = 'EncaminhadoAoRelacionamento'$$), 'op_eventos aceitou UPDATE');

DO $$ BEGIN RAISE NOTICE 'OK operacao-sugestao-encaminhar.test.sql'; END $$;
ROLLBACK;
