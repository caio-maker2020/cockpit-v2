-- =============================================================================
-- 2026-10-07_439 — Operação: sugestão "aguardar", 01 nunca sugerida e estado das
--                  regras aprendidas com instrução e pagador (ADR 0041 D10, emenda
--                  "treino real"; INV-188).
-- =============================================================================
-- Achados do treino real (W5: 300 notas reais + backtest de 30 dias):
--   1. o prompt 1.0.0 mandou 135 notas oc 41 "comprovante no malote" para encaminhar.
--      Entra a ação "aguardar" (nada a fazer agora, com motivo e QUANDO reavaliar) no
--      contrato v2 da sugestão (aditivo). Sem botão de lançar: op_aceitar_sugestao
--      recusa (sugestao_e_aguardar). 01 (entregue) nunca é sugerida (entrega é do
--      motorista). O agente reavalia um "aguardar" vencido no máximo 3 vezes na mesma oc.
--   2. 188 regras boas ficaram fora porque dependem da instrução da última oc (122) e
--      do pagador (66). O estado ganha `estado_instrucao_padrao` (igualdade após
--      normalizar: maiúsculas, sem acento, espaços colapsados — a normalização é feita
--      no gerador da carga e no código; aqui o CHECK confere maiúsculas/espaços) e
--      `estado_pagador_cnpj` (só dígitos, 14 ou 11). Hierarquia de especificidade no
--      código: pagador (8) + instrução (4) + unidade (2) + dias parado (1).
--
-- Formato do regras.json (carga TIPO B, ver RegraAprendidaOperacao):
--   {"id", "estado": {"oc", "unidade"?, "dias_parado_min"?, "instrucao_padrao"?, "pagador_cnpj"?},
--    "acao": "lancar_ocorrencia"|"encaminhar_relacionamento"|"aguardar", "codigo"|null, "texto" ≤ 70,
--    "reavaliar_em_horas"? (só aguardar, 1..720), "confianca", "casos", "base_regra"}
--   → INSERT INTO public.op_regras_sugestao (id, estado_oc, estado_unidade, estado_dias_parado_min,
--       estado_instrucao_padrao, estado_pagador_cnpj, acao, codigo, texto, reavaliar_em_horas,
--       confianca, casos, base_regra, carga) VALUES (...) ON CONFLICT (id) DO UPDATE SET ...;
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Só tabelas/funções das migs 434/435/436 (novas, inertes). Nenhum dado existente.
-- (b) op_sugestao_ia_candidatos muda o retorno (+ cnpj_pagador): DROP + CREATE.
-- (c) DEPENDÊNCIAS: 434, 435, 436.
-- (d) CLASSIFICAÇÃO: TIPO B.
-- (e) REVERSÃO (TIPO B): reaplicar os blocos das funções das 435/436;
--       ALTER TABLE public.op_regras_sugestao DROP COLUMN IF EXISTS estado_instrucao_padrao,
--         DROP COLUMN IF EXISTS estado_pagador_cnpj, DROP COLUMN IF EXISTS reavaliar_em_horas;
--       (recriar oprs_acao/oprs_acao_codigo da 434; só sem linhas 'aguardar')
--       ALTER TABLE public.op_sugestao_ia_cache DROP COLUMN IF EXISTS reavaliacoes, DROP COLUMN IF EXISTS atualizado_em;
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_encaminhamentos') IS NULL OR to_regclass('public.op_sugestao_ia_cache') IS NULL THEN
    RAISE EXCEPTION 'mig 439 exige as 434, 435 e 436 aplicadas antes';
  END IF;
END $$;

-- 1. Estado das regras aprendidas + "aguardar" + 01 proibida --------------------------
ALTER TABLE public.op_regras_sugestao
  ADD COLUMN IF NOT EXISTS estado_instrucao_padrao text,
  ADD COLUMN IF NOT EXISTS estado_pagador_cnpj text,
  ADD COLUMN IF NOT EXISTS reavaliar_em_horas integer;
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_instrucao;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_instrucao CHECK (estado_instrucao_padrao IS NULL OR (
  estado_instrucao_padrao = upper(estado_instrucao_padrao) AND estado_instrucao_padrao = btrim(estado_instrucao_padrao)
  AND estado_instrucao_padrao !~ '\s{2}' AND estado_instrucao_padrao !~ '[\t\n\r]'
  AND char_length(estado_instrucao_padrao) BETWEEN 1 AND 500));
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_pagador;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_pagador CHECK (estado_pagador_cnpj IS NULL
  OR estado_pagador_cnpj ~ '^([0-9]{11}|[0-9]{14})$');
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_acao;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_acao
  CHECK (acao IN ('lancar_ocorrencia', 'encaminhar_relacionamento', 'aguardar'));
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_acao_codigo;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_acao_codigo CHECK (
  (acao = 'lancar_ocorrencia' AND codigo IS NOT NULL AND codigo NOT IN (49, 54, 59, 33, 44, 6, 9, 16, 41, 56, 1)
     AND codigo <> estado_oc)
  OR (acao IN ('encaminhar_relacionamento', 'aguardar') AND codigo IS NULL));
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_reavaliar;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_reavaliar CHECK (reavaliar_em_horas IS NULL
  OR (acao = 'aguardar' AND reavaliar_em_horas BETWEEN 1 AND 720));

-- 2. Contrato da sugestão do agente: + aguardar, − 01 ----------------------------------
CREATE OR REPLACE FUNCTION public.op__sugestao_valida(p_s jsonb, p_oc integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_acao text := p_s->>'acao';
  v_cod integer;
  v_conf numeric;
  v_h numeric;
BEGIN
  IF p_s IS NULL OR jsonb_typeof(p_s) <> 'object' THEN RETURN 'nao_e_objeto'; END IF;
  IF (p_s->>'versao_contrato') IS DISTINCT FROM '2' THEN RETURN 'versao_contrato'; END IF;
  IF (p_s->>'fonte') IS DISTINCT FROM 'agente_ia' OR (p_s->>'base_regra') IS DISTINCT FROM 'agente_ia' THEN RETURN 'fonte'; END IF;
  IF v_acao IS NULL OR v_acao NOT IN ('lancar_ocorrencia', 'encaminhar_relacionamento', 'aguardar') THEN RETURN 'acao'; END IF;
  IF jsonb_typeof(p_s->'texto') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_s->>'texto')) NOT BETWEEN 3 AND 70 THEN RETURN 'texto'; END IF;
  IF (p_s->>'oc_base') IS DISTINCT FROM p_oc::text THEN RETURN 'oc_base'; END IF;
  IF jsonb_typeof(p_s->'confianca') IS DISTINCT FROM 'number' THEN RETURN 'confianca'; END IF;
  v_conf := (p_s->>'confianca')::numeric;
  IF v_conf < 0 OR v_conf > 1 THEN RETURN 'confianca'; END IF;
  IF v_acao = 'lancar_ocorrencia' THEN
    IF jsonb_typeof(p_s->'codigo') IS DISTINCT FROM 'number' THEN RETURN 'codigo'; END IF;
    v_cod := (p_s->>'codigo')::integer;
    IF v_cod IN (49, 54, 59, 33, 44, 6, 9, 16, 41, 56, 1) THEN RETURN 'codigo_proibido'; END IF;
    IF v_cod = p_oc THEN RETURN 'repete_oc_atual'; END IF;
  ELSIF p_s ? 'codigo' AND jsonb_typeof(p_s->'codigo') IS DISTINCT FROM 'null' THEN
    RETURN v_acao || '_com_codigo';
  END IF;
  IF v_acao = 'aguardar' THEN
    IF jsonb_typeof(p_s->'reavaliar_em_horas') IS DISTINCT FROM 'number' THEN RETURN 'reavaliar'; END IF;
    v_h := (p_s->>'reavaliar_em_horas')::numeric;
    IF v_h <> trunc(v_h) OR v_h < 1 OR v_h > 720 THEN RETURN 'reavaliar'; END IF;
    IF jsonb_typeof(p_s->'reavaliar_em') IS DISTINCT FROM 'string' THEN RETURN 'reavaliar_em'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.op__sugestao_valida(jsonb, integer) FROM PUBLIC, anon, authenticated;

-- 3. Reavaliar "aguardar" vencido (no máximo 3 vezes por item + oc) ---------------------
ALTER TABLE public.op_sugestao_ia_cache
  ADD COLUMN IF NOT EXISTS reavaliacoes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS atualizado_em timestamptz;

DROP FUNCTION IF EXISTS public.op_sugestao_ia_candidatos(integer);
CREATE FUNCTION public.op_sugestao_ia_candidatos(p_limite integer DEFAULT 30)
RETURNS TABLE (op_item_id uuid, cod_ultima_ocorrencia smallint, data_ultima_ocorrencia timestamptz,
               instrucao_ultima_ocorrencia text, unidade text, cidade_destino text, uf_destino text, pagador text,
               cnpj_pagador text, reavaliacao boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.cod_ultima_ocorrencia, i.data_ultima_ocorrencia, i.instrucao_ultima_ocorrencia,
         i.unidade, i.cidade_destino, i.uf_destino, i.pagador, i.cnpj_pagador,
         (i.sugestao IS NOT NULL) AS reavaliacao
    FROM public.op_itens i
    LEFT JOIN public.op_sugestao_ia_cache c
      ON c.op_item_id = i.id AND c.cod_ultima_ocorrencia = i.cod_ultima_ocorrencia
   WHERE i.status IN ('aberto', 'assumido')
     AND i.cod_ultima_ocorrencia IS NOT NULL
     AND (
       (i.sugestao IS NULL AND c.op_item_id IS NULL)
       OR (i.sugestao->>'fonte' = 'agente_ia' AND i.sugestao->>'acao' = 'aguardar'
           AND (i.sugestao->>'reavaliar_em')::timestamptz <= now()
           AND c.op_item_id IS NOT NULL AND c.reavaliacoes < 3))
   ORDER BY (i.sugestao IS NOT NULL), i.updated_at DESC
   LIMIT least(greatest(coalesce(p_limite, 0), 0), 100);
$$;

CREATE OR REPLACE FUNCTION public.op_gravar_sugestao_ia(
  p_op_item_id uuid, p_oc integer, p_status text, p_sugestao jsonb, p_motivo text,
  p_modelo text, p_versao_prompt text, p_tokens_entrada integer, p_tokens_saida integer, p_duracao_ms integer
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text := p_status;
  v_sug jsonb := p_sugestao;
  v_motivo text := p_motivo;
  v_prob text;
  v_ok boolean;
  v_id uuid;
  v_c public.op_sugestao_ia_cache%ROWTYPE;
  v_reav boolean := false;
BEGIN
  IF v_status NOT IN ('ok', 'sem_sugestao', 'descartada', 'falha') OR v_status IS NULL THEN
    RAISE EXCEPTION 'status inválido: %', p_status;
  END IF;
  IF v_status = 'ok' THEN
    v_prob := public.op__sugestao_valida(v_sug, p_oc);
    IF v_prob IS NOT NULL THEN
      v_status := 'descartada';
      v_motivo := 'recusada_no_banco:' || v_prob;
    END IF;
  END IF;
  IF v_status <> 'ok' THEN v_sug := NULL; END IF;

  INSERT INTO public.op_sugestao_ia_cache (op_item_id, cod_ultima_ocorrencia, status, sugestao, motivo, modelo,
                                           versao_prompt, tokens_entrada, tokens_saida, duracao_ms)
  VALUES (p_op_item_id, p_oc, v_status, v_sug, left(v_motivo, 300), p_modelo, p_versao_prompt,
          coalesce(p_tokens_entrada, 0), coalesce(p_tokens_saida, 0), p_duracao_ms)
  ON CONFLICT (op_item_id, cod_ultima_ocorrencia) DO NOTHING
  RETURNING true INTO v_ok;
  IF v_ok IS NULL THEN
    -- Já houve chamada nesta (item, oc). Só passa se for a REAVALIAÇÃO de um "aguardar"
    -- vencido do agente, até 3 vezes; senão é cache.
    SELECT * INTO v_c FROM public.op_sugestao_ia_cache
     WHERE op_item_id = p_op_item_id AND cod_ultima_ocorrencia = p_oc FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.op_itens i
                    WHERE i.id = p_op_item_id AND i.sugestao->>'fonte' = 'agente_ia' AND i.sugestao->>'acao' = 'aguardar'
                      AND (i.sugestao->>'reavaliar_em')::timestamptz <= now())
       OR v_c.reavaliacoes >= 3 THEN
      RETURN 'cache';
    END IF;
    UPDATE public.op_sugestao_ia_cache
       SET status = v_status, sugestao = v_sug, motivo = left(v_motivo, 300), modelo = p_modelo,
           versao_prompt = p_versao_prompt, tokens_entrada = tokens_entrada + coalesce(p_tokens_entrada, 0),
           tokens_saida = tokens_saida + coalesce(p_tokens_saida, 0), duracao_ms = p_duracao_ms,
           reavaliacoes = reavaliacoes + 1, atualizado_em = now(), gravada_no_item = false
     WHERE op_item_id = p_op_item_id AND cod_ultima_ocorrencia = p_oc;
    v_reav := true;
  END IF;
  IF v_status <> 'ok' THEN
    RETURN v_status;  -- na reavaliação que falha, o "aguardar" antigo fica (e o teto de 3 segura o custo)
  END IF;

  -- Só no item ainda aberto, na MESMA oc, sem sugestão (ou com o "aguardar" do agente que
  -- está sendo reavaliado). A de regra vence.
  UPDATE public.op_itens SET sugestao = v_sug, sugestao_em = now()
   WHERE id = p_op_item_id AND status IN ('aberto', 'assumido') AND cod_ultima_ocorrencia = p_oc
     AND (sugestao IS NULL OR (v_reav AND sugestao->>'fonte' = 'agente_ia' AND sugestao->>'acao' = 'aguardar'))
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN 'item_mudou';
  END IF;
  UPDATE public.op_sugestao_ia_cache SET gravada_no_item = true
   WHERE op_item_id = p_op_item_id AND cod_ultima_ocorrencia = p_oc;
  PERFORM public.op__evento(p_op_item_id, 'SugestaoGerada', 'system', 'sugerir-operacao', NULL,
    v_sug || jsonb_build_object('reavaliacao', v_reav));
  RETURN CASE WHEN v_reav THEN 'reavaliada' ELSE 'gravada' END;
END;
$$;
REVOKE ALL ON FUNCTION public.op_sugestao_ia_candidatos(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_gravar_sugestao_ia(uuid, integer, text, jsonb, text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_sugestao_ia_candidatos(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_gravar_sugestao_ia(uuid, integer, text, jsonb, text, text, text, integer, integer, integer) TO service_role;

-- 4. "Aguardar" não tem botão de lançar ------------------------------------------------
CREATE OR REPLACE FUNCTION public.op_aceitar_sugestao(p_op_item_id uuid, p_confirmacao text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_s jsonb;
BEGIN
  SELECT sugestao INTO v_s FROM public.op_itens WHERE id = p_op_item_id;
  IF v_s->>'acao' = 'encaminhar_relacionamento' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sugestao_e_encaminhamento',
      'motivo', 'a sugestão é encaminhar ao Relacionamento: use op_previa_encaminhamento / op_encaminhar_relacionamento');
  END IF;
  IF v_s->>'acao' = 'aguardar' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sugestao_e_aguardar',
      'motivo', 'a sugestão é aguardar: ' || coalesce(v_s->>'texto', '') || ' (reavaliar em ' || coalesce(v_s->>'reavaliar_em', '?') || ')');
  END IF;
  IF v_s IS NULL OR v_s->>'codigo' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_sugestao', 'motivo', 'este item não tem sugestão');
  END IF;
  RETURN public.op__solicitar(p_op_item_id, (v_s->>'codigo')::integer, coalesce(v_s->>'texto', ''), p_confirmacao,
                              'sugestao', v_s->>'regra_id');
END;
$$;
REVOKE ALL ON FUNCTION public.op_aceitar_sugestao(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_aceitar_sugestao(uuid, text) TO authenticated;

DO $$
BEGIN
  RAISE NOTICE 'OK mig 439: aguardar no contrato, 01 nunca sugerida, estado com instrução/pagador, reavaliação ≤ 3';
END $$;
