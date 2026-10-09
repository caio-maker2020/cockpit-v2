-- =============================================================================
-- Teste da mig 444 (teto de idade). Postgres descartável, depois da 434–441.
-- =============================================================================
BEGIN;
CREATE SCHEMA t6;
CREATE FUNCTION t6.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF; END $$;
CREATE FUNCTION t6.ins(p_min text, p_max text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_dias_parado_min, estado_dias_parado_max, acao, codigo, texto, confianca, casos, base_regra, carga)'
    || ' VALUES (''r'' || md5(random()::text), 7, ' || p_min || ', ' || p_max || ', ''aguardar'', NULL, ''segue sozinha'', 0.9, 10, ''hist'', ''teste'')';
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $$;

SELECT t6.ok(t6.ins('NULL', 'NULL'), 'sem teto recusado');
SELECT t6.ok(t6.ins('NULL', '3'), 'teto 3 recusado');
SELECT t6.ok(t6.ins('3', '3'), 'piso = teto recusado');
SELECT t6.ok(t6.ins('1', '365'), 'teto 365 recusado');
SELECT t6.ok(NOT t6.ins('NULL', '0'), 'teto 0 entrou');
SELECT t6.ok(NOT t6.ins('NULL', '366'), 'teto 366 entrou');
SELECT t6.ok(NOT t6.ins('7', '3'), 'teto < piso entrou');

ROLLBACK;
