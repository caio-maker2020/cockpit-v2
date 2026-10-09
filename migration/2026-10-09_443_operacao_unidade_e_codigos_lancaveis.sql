-- =============================================================================
-- 2026-10-09_443 — Operação: carga de op_regra_unidade_por_oc e op_codigos_lancaveis
--                  (tabelas da mig 430, nascidas VAZIAS; ADR 0041 D4/D5, ADR 0042).
-- =============================================================================
-- NUMERAÇÃO: 443. Conferido em 09/10 com `git ls-tree` em todas as branches remotas:
-- 441/442 são da integração matheuscastro12-eng/operacao-e-motorista (PR #47); nenhuma 443.
--
-- CLASSIFICAÇÃO: TIPO B (liga regra de produção).
-- AUTORIZACAO (TIPO B): "Matheus, 2026-10-09: ordem direta no chat para ligar setores/unidade/códigos da Operação"
--
-- 1. UNIDADE (op_regra_unidade_por_oc). Fonte: regra do Pendências (docs/PENDENCIAS-REGRAS.md
--    §2: "Para REVERSA/DEVOLUÇÃO, a base é a operacional atual. Para o resto, é a base de
--    destino"; ADR 0042 tabela "op_regra_unidade_por_oc ... candidata para a semente").
--    No Bastão a "base de destino" em CÓDIGO de unidade é `unidade_destino`; `base_destino`
--    vem como NOME de cidade ('BELO HORIZONTE', 'VARGINHA') e não casa com
--    operacao_membros.unidades — por isso não é usado. Leitura do Bastão em 09/10 (1000
--    pendências responsavel_atual=operacao): unidade_destino preenchida em 100%, 98% casam
--    com alguma unidade de membro (sobra DIE). Nenhuma era REVERSA/DEVOLUÇÃO (tipo_documento:
--    NORMAL, SUBCONTRATO/REDESPACHO RECEPCAO, CORTESIA).
--      genérica  → unidade_destino (prioridade 100)
--      genérica  → unidade_atual   (prioridade 200, só se unidade_destino vier vazia)
--      oc 58 (devolução, setor DEVOLUCAO no mapa da 441) → unidade_atual (base operacional atual)
--    A tabela só chaveia por oc; REVERSA/DEVOLUÇÃO por tipo_documento não é expressável aqui.
--
-- 2. CÓDIGOS LANÇÁVEIS (op_codigos_lancaveis). Interseção de:
--    (a) setor OPERACAO no mapa do Pendências (mig 441; pendency-tracker@a884368 pendencia.ts:63-86);
--    (b) ocorrencias_dicionario.responsabilidade = 'Operação' (o trigger opcl_da_operacao exige);
--    (c) fora do CHECK opcl_proibidos (49,54,59,33,44,6,9,16,14);
--    (d) fora das finalizadoras/documentais que nunca entram na fila (ADR 0041 D4: 1, 30, 32; 2, 34)
--        e das de encerramento do Pendências (regraPendencia.ts:84: 22);
--    (e) apareceu como última oc de pendência da Operação no Bastão (leitura de 09/10, ~2,3 mil
--        pendências responsavel_atual=operacao). Ficam de fora por não aparecerem: 4, 25, 45, 48, 50.
--    57 fica fora: é 'Relacionamento' no dicionário (o trigger recusaria) — divergência anotada na 441 (d).
--    41 e 56 exigem texto (CHECK opcl_texto_41_56).
--    Efeito hoje: NENHUM lançamento sai — flag operacao_lancar_ssw desligada e pode_lancar=false
--    para os 90 membros.
--
-- REVERSÃO:
--   DELETE FROM public.op_codigos_lancaveis WHERE autorizado_em = '2026-10-09' AND pedido_por = 'Matheus';
--   DELETE FROM public.op_regra_unidade_por_oc WHERE autorizado_por LIKE 'Matheus, 2026-10-09%';
--   (depois rodar materializar-fila-operacao: os itens voltam sem unidade)
-- ⚠ SEM BEGIN/COMMIT interno.
-- =============================================================================

INSERT INTO public.op_regra_unidade_por_oc (codigo_oc, campo_bastao, prioridade, ativo, observacao, autorizado_por)
SELECT v.oc, v.campo, v.prio, true, v.obs,
       'Matheus, 2026-10-09: ordem direta no chat para ligar setores/unidade/códigos da Operação'
  FROM (VALUES
    (NULL::smallint, 'unidade_destino', 100, 'Pendências: base de destino (PENDENCIAS-REGRAS.md §2)'),
    (NULL::smallint, 'unidade_atual',   200, 'Fallback quando unidade_destino vazia'),
    (58::smallint,   'unidade_atual',   100, 'Pendências: devolução = base operacional atual (PENDENCIAS-REGRAS.md §2)')
  ) v(oc, campo, prio, obs)
 WHERE NOT EXISTS (SELECT 1 FROM public.op_regra_unidade_por_oc r
                    WHERE r.codigo_oc IS NOT DISTINCT FROM v.oc AND r.campo_bastao = v.campo);

INSERT INTO public.op_codigos_lancaveis (codigo, criterio, exige_texto, ativo, pedido_por, autorizado_por, autorizado_em, observacao)
SELECT d.codigo,
       'Setor OPERACAO no mapa do Pendências e Operação no dicionário: ' || d.descricao,
       d.codigo IN (41, 56), true, 'Matheus', 'Matheus', DATE '2026-10-09',
       'mig 443; fonte: pendencia.ts:63-86 ∩ ocorrencias_dicionario ∩ histórico do Bastão (09/10)'
  FROM public.ocorrencias_dicionario d
 WHERE d.codigo IN (5, 7, 12, 13, 15, 21, 24, 27, 29, 36, 37, 38, 39, 40, 41, 51, 52, 55, 56)
ON CONFLICT (codigo) DO NOTHING;

DO $$
DECLARE v_c integer; v_r integer;
BEGIN
  SELECT count(*) INTO v_c FROM public.op_codigos_lancaveis WHERE ativo;
  SELECT count(*) INTO v_r FROM public.op_regra_unidade_por_oc WHERE ativo;
  IF v_c < 19 OR v_r < 3 THEN
    RAISE EXCEPTION 'mig 443: esperava 19 códigos e 3 regras ativas; tem % e %', v_c, v_r;
  END IF;
  RAISE NOTICE 'OK mig 443: % códigos lançáveis, % regras de unidade', v_c, v_r;
END $$;
