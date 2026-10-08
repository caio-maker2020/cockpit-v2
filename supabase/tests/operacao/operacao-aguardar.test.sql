-- =============================================================================
-- Teste da mig 439 (ADR 0041 D10, emenda do treino real; INV-188). Postgres descartável.
-- Cobre: estado da regra aprendida com instrução normalizada e pagador; "aguardar" na
-- regra e no contrato do agente; 01 nunca sugerida; "aguardar" sem botão de lançar;
-- reavaliação do "aguardar" vencido no máximo 3 vezes por item + oc.
-- =============================================================================
BEGIN;
CREATE SCHEMA t4;
CREATE FUNCTION t4.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t4.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
CREATE FUNCTION t4.item(p_ctrc text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.op_itens WHERE ctrc = p_ctrc ORDER BY created_at DESC LIMIT 1 $$;
GRANT USAGE ON SCHEMA t4 TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t4 TO authenticated, service_role;

-- ── regras aprendidas: estado novo, aguardar, 01 ─────────────────────────────
INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_instrucao_padrao, acao, codigo, texto, reavaliar_em_horas,
  confianca, casos, base_regra, carga)
VALUES ('h41-malote', 41, 'COMPROVANTE NO MALOTE', 'aguardar', NULL, 'comprovante no malote: aguardar chegada', 48, 0.9, 135, 'treino:W5', 'teste');
INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_pagador_cnpj, acao, codigo, texto, confianca, casos, base_regra, carga)
VALUES ('h13-acme', 13, '12345678000199', 'lancar_ocorrencia', 36, 'chegou na base', 0.8, 20, 'treino:W5', 'teste');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_instrucao_padrao, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('x1', 41, 'comprovante no malote', 'aguardar', NULL, 'aguardar', 0.9, 10, 'h', 'teste')$$), 'instrução minúscula entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_instrucao_padrao, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('x2', 41, 'COMPROVANTE  NO MALOTE', 'aguardar', NULL, 'aguardar', 0.9, 10, 'h', 'teste')$$), 'instrução com espaço duplo entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_pagador_cnpj, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('x3', 13, '12.345.678/0001-99', 'lancar_ocorrencia', 36, 'chegou', 0.9, 10, 'h', 'teste')$$), 'CNPJ com máscara entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('x4', 13, 'lancar_ocorrencia', 1, 'entregue', 0.9, 10, 'h', 'teste')$$), 'regra com 01 entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga)
  VALUES ('x5', 41, 'aguardar', 36, 'aguardar', 0.9, 10, 'h', 'teste')$$), 'aguardar com código entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, reavaliar_em_horas, confianca, casos, base_regra, carga)
  VALUES ('x6', 13, 'lancar_ocorrencia', 36, 'chegou', 24, 0.9, 10, 'h', 'teste')$$), 'reavaliar fora de aguardar entrou');
SELECT t4.ok(t4.recusado($$INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, reavaliar_em_horas, confianca, casos, base_regra, carga)
  VALUES ('x7', 41, 'aguardar', NULL, 'aguardar', 721, 0.9, 10, 'h', 'teste')$$), 'reavaliar > 720 entrou');

-- ── contrato do agente no banco ──────────────────────────────────────────────
SELECT t4.ok(public.op__sugestao_valida('{"versao_contrato":2,"fonte":"agente_ia","base_regra":"agente_ia","acao":"aguardar","codigo":null,"texto":"comprovante no malote","confianca":0.8,"oc_base":41,"reavaliar_em_horas":48,"reavaliar_em":"2026-10-09T12:00:00Z"}', 41) IS NULL, 'aguardar válido recusado');
SELECT t4.ok(public.op__sugestao_valida('{"versao_contrato":2,"fonte":"agente_ia","base_regra":"agente_ia","acao":"aguardar","codigo":null,"texto":"comprovante no malote","confianca":0.8,"oc_base":41}', 41) = 'reavaliar', 'aguardar sem reavaliar aceito');
SELECT t4.ok(public.op__sugestao_valida('{"versao_contrato":2,"fonte":"agente_ia","base_regra":"agente_ia","acao":"aguardar","codigo":36,"texto":"x x x","confianca":0.8,"oc_base":41,"reavaliar_em_horas":4,"reavaliar_em":"x"}', 41) = 'aguardar_com_codigo', 'aguardar com código aceito');
SELECT t4.ok(public.op__sugestao_valida('{"versao_contrato":2,"fonte":"agente_ia","base_regra":"agente_ia","acao":"lancar_ocorrencia","codigo":1,"texto":"entregue","confianca":0.8,"oc_base":41}', 41) = 'codigo_proibido', '01 aceita');

-- ── aguardar no item: sem botão de lançar; reavaliação ≤ 3 ─────────────────────
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'op.vga@sal');
INSERT INTO public.operacao_membros (user_id, nome, email, papel_op, unidades, pode_lancar) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'Joao VGA', 'op.vga@sal', 'operador_op', '{VGA}', true);
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia, cnpj_pagador) VALUES ('AG1-1', '5001', 'VGA', 41, '12345678000199');
SET LOCAL ROLE service_role;
SELECT t4.ok((SELECT cnpj_pagador FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t4.item('AG1-1')) = '12345678000199', 'candidato sem cnpj');
SELECT t4.ok(public.op_gravar_sugestao_ia(t4.item('AG1-1'), 41, 'ok',
  jsonb_build_object('versao_contrato', 2, 'fonte', 'agente_ia', 'base_regra', 'agente_ia', 'acao', 'aguardar', 'codigo', NULL,
    'texto', 'comprovante no malote', 'confianca', 0.8, 'oc_base', 41, 'reavaliar_em_horas', 1, 'reavaliar_em', (now() + interval '1 hour')::text),
  NULL, 'm', '1.1.0', 1, 1, 1) = 'gravada', 'aguardar não gravou');
SELECT t4.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t4.item('AG1-1')) = 0, 'aguardar no prazo virou candidato');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
SELECT t4.ok(public.op_aceitar_sugestao(t4.item('AG1-1'), 'x')->>'erro' = 'sugestao_e_aguardar', 'aguardar virou lançamento');
RESET ROLE;
-- vence o prazo → reavalia até 3 vezes
UPDATE public.op_itens SET sugestao = jsonb_set(sugestao, '{reavaliar_em}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = t4.item('AG1-1');
SET LOCAL ROLE service_role;
SELECT t4.ok((SELECT reavaliacao FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t4.item('AG1-1')), 'aguardar vencido não voltou como reavaliação');
SELECT t4.ok(public.op_gravar_sugestao_ia(t4.item('AG1-1'), 41, 'falha', NULL, 'timeout', 'm', '1.1.0', 0, 0, 0) = 'falha', 'reavaliação 1');
SELECT t4.ok(public.op_gravar_sugestao_ia(t4.item('AG1-1'), 41, 'falha', NULL, 'timeout', 'm', '1.1.0', 0, 0, 0) = 'falha', 'reavaliação 2');
SELECT t4.ok(public.op_gravar_sugestao_ia(t4.item('AG1-1'), 41, 'ok',
  jsonb_build_object('versao_contrato', 2, 'fonte', 'agente_ia', 'base_regra', 'agente_ia', 'acao', 'lancar_ocorrencia', 'codigo', 36,
    'texto', 'chegou na base', 'confianca', 0.7, 'oc_base', 41), NULL, 'm', '1.1.0', 1, 1, 1) = 'reavaliada', 'reavaliação 3 não trocou a sugestão');
RESET ROLE;
SELECT t4.ok((SELECT sugestao->>'acao' FROM public.op_itens WHERE id = t4.item('AG1-1')) = 'lancar_ocorrencia', 'item não recebeu a reavaliação');
SELECT t4.ok((SELECT reavaliacoes FROM public.op_sugestao_ia_cache WHERE op_item_id = t4.item('AG1-1')) = 3, 'contador de reavaliações');
-- 4ª: teto
UPDATE public.op_itens SET sugestao = jsonb_build_object('versao_contrato', 2, 'fonte', 'agente_ia', 'base_regra', 'agente_ia', 'acao', 'aguardar',
  'codigo', NULL, 'texto', 'aguardar', 'confianca', 0.8, 'oc_base', 41, 'reavaliar_em_horas', 1, 'reavaliar_em', (now() - interval '1 minute')::text)
 WHERE id = t4.item('AG1-1');
SET LOCAL ROLE service_role;
SELECT t4.ok((SELECT count(*) FROM public.op_sugestao_ia_candidatos(50) c WHERE c.op_item_id = t4.item('AG1-1')) = 0, 'passou do teto de 3 reavaliações');
SELECT t4.ok(public.op_gravar_sugestao_ia(t4.item('AG1-1'), 41, 'falha', NULL, 'x', 'm', 'v', 0, 0, 0) = 'cache', 'gravou depois do teto');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'OK operacao-aguardar.test.sql'; END $$;
ROLLBACK;
