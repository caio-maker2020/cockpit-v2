-- =============================================================================
-- Teste da mig 440 (ADR 0041 D10, emenda do minerador; INV-188). Postgres descartável.
-- instrucao_modelo (forma, exclusiva com a exata), condições extras, alternativa do aguardar.
-- =============================================================================
BEGIN;
CREATE SCHEMA t5;
CREATE FUNCTION t5.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t5.recusado(cmd text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE cmd; RETURN false; EXCEPTION WHEN others THEN RETURN true; END $$;
CREATE FUNCTION t5.ins(p_extra text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'INSERT INTO public.op_regras_sugestao (id, estado_oc, acao, codigo, texto, confianca, casos, base_regra, carga'
    || split_part(p_extra, '|', 1) || ') VALUES (''r'' || md5(random()::text), 41, ' || split_part(p_extra, '|', 2) || ', 0.9, 10, ''hist'', ''teste''' || split_part(p_extra, '|', 3) || ')';
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $$;

GRANT USAGE ON SCHEMA t5 TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t5 TO authenticated, service_role;

-- válidas
SELECT t5.ok(t5.ins(', estado_instrucao_modelo|''aguardar'', NULL, ''malote a caminho''|, ''MALOTE # - DIA #/#'''), 'modelo válido recusado');
SELECT t5.ok(t5.ins(', estado_previsao_vencida, estado_ocorrencias_anteriores_min|''lancar_ocorrencia'', 36, ''chegou''|, true, 3'), 'condições extras recusadas');
SELECT t5.ok(t5.ins(', alternativa|''aguardar'', NULL, ''aguardar malote''|, ''{"acao":"lancar_ocorrencia","codigo":36,"texto":"chegou na base","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa válida recusada');
SELECT t5.ok(t5.ins(', alternativa|''aguardar'', NULL, ''aguardar malote''|, ''{"acao":"encaminhar_relacionamento","codigo":null,"texto":"cliente cobra","confianca":0.3,"casos":5,"taxa_acao":0.1}'''), 'alternativa encaminhar recusada');
-- inválidas
SELECT t5.ok(NOT t5.ins(', estado_instrucao_modelo|''aguardar'', NULL, ''malote''|, ''MALOTE 12 - DIA #/#'''), 'modelo com dígito entrou');
SELECT t5.ok(NOT t5.ins(', estado_instrucao_modelo|''aguardar'', NULL, ''malote''|, ''malote # - dia #/#'''), 'modelo minúsculo entrou');
SELECT t5.ok(NOT t5.ins(', estado_instrucao_modelo, estado_instrucao_padrao|''aguardar'', NULL, ''malote''|, ''MALOTE #'', ''MALOTE 1'''), 'modelo + exata entrou');
SELECT t5.ok(NOT t5.ins(', estado_ocorrencias_anteriores_min|''lancar_ocorrencia'', 36, ''chegou''|, -1'), 'ocorrências negativas');
SELECT t5.ok(NOT t5.ins(', alternativa|''lancar_ocorrencia'', 36, ''chegou''|, ''{"acao":"lancar_ocorrencia","codigo":37,"texto":"veiculo","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa fora de aguardar');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"lancar_ocorrencia","codigo":49,"texto":"tratativa","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa 49');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"lancar_ocorrencia","codigo":1,"texto":"entregue","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa 01');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"lancar_ocorrencia","codigo":11,"texto":"endereco","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa fora da Operação (trigger)');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"aguardar","codigo":null,"texto":"aguardar","confianca":0.4,"casos":12,"taxa_acao":0.25}'''), 'alternativa aguardar');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"lancar_ocorrencia","codigo":36,"texto":"chegou","confianca":0.4,"casos":12,"taxa_acao":1.5}'''), 'taxa_acao > 1');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"encaminhar_relacionamento","codigo":36,"texto":"cliente","confianca":0.4,"casos":12,"taxa_acao":0.2}'''), 'encaminhar com código');
SELECT t5.ok(NOT t5.ins(', alternativa|''aguardar'', NULL, ''aguardar''|, ''{"acao":"lancar_ocorrencia","codigo":36,"texto":"chegou","confianca":0.4,"casos":1.5,"taxa_acao":0.2}'''), 'casos fracionário');
-- candidatos trazem a previsão
INSERT INTO public.op_itens (ctrc, nf, unidade, cod_ultima_ocorrencia, previsao_entrega) VALUES ('PV1-1', '6001', 'VGA', 13, '2026-10-06');
SET LOCAL ROLE service_role;
SELECT t5.ok((SELECT c.previsao_entrega IS NOT NULL FROM public.op_sugestao_ia_candidatos(50) c
               JOIN public.op_itens i ON i.id = c.op_item_id WHERE i.ctrc = 'PV1-1'), 'candidato sem previsão');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'OK operacao-regras-modelo.test.sql'; END $$;
ROLLBACK;
