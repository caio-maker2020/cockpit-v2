-- =============================================================================
-- 2026-10-09_445 — Operação: oc 57 ("Volume de destroca coletado") é do Relacionamento.
-- =============================================================================
-- A 441 copiou o mapa do Pendências (57 = OPERACAO); o dicionário do Cockpit diz
-- Relacionamento. Decisão do Matheus (09/10, chat): 57 é Relacionamento.
-- Efeito: nota com oc 57 e responsável vazio NÃO entra na fila da Operação.
-- (c) CLASSIFICAÇÃO: TIPO B.  (e) REVERSÃO: update ... set setor='OPERACAO' where codigo_oc=57.
-- AUTORIZACAO (TIPO B): "Matheus, 2026-10-09: ordem direta no chat — oc 57 é Relacionamento".
-- =============================================================================
UPDATE public.op_setor_por_oc
   SET setor = 'RELACIONAMENTO',
       fonte = 'decisão Matheus 2026-10-09 (dicionário do Cockpit: Relacionamento)'
 WHERE codigo_oc = 57;
