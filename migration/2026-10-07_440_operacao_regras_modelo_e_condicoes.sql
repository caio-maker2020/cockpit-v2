-- =============================================================================
-- 2026-10-07_440 — Operação: regra aprendida com `instrucao_modelo`, condições extras
--                  (`previsao_vencida`, `ocorrencias_anteriores_min`) e `alternativa`
--                  no "aguardar" (ADR 0041 D10, emenda do minerador; INV-188).
-- =============================================================================
-- NUMERAÇÃO: a faixa 434–439 desta frente acabou; 440–449 eram da Operação (ADR 0041) e
-- esta mig usa a 440 com o aval do coordenador (07/10).
--
-- 1. estado.instrucao_modelo — a instrução normalizada (maiúsculas, sem acento, espaços
--    colapsados) com todo token que contém dígito trocado por "#":
--      regex (após normalizar): [A-Z0-9]*[0-9][A-Z0-9]*   (global) → "#"
--      ex.: "Malote 4521 - dia 03/10" → "MALOTE # - DIA #/#"
--    Casa por IGUALDADE com modeloDaInstrucao(instrução do item). Exclusiva com
--    instrucao_padrao (a exata é mais específica: 16 × 8). O minerador do v3 usa a MESMA
--    função (_shared/operacao-sugestao.ts → modeloDaInstrucao / REGEX_TOKEN_COM_DIGITO).
-- 2. Condições extras: estado.previsao_vencida (true = previsão de entrega já passou;
--    false = ainda no prazo; item sem previsão não casa nenhum dos dois) e
--    estado.ocorrencias_anteriores_min (ocorrências da nota antes da atual; item sem esse
--    dado NÃO casa — hoje o Bastão não traz a contagem, então essas regras ficam inertes
--    até a fonte existir). Cada condição extra soma 1 de especificidade.
-- 3. alternativa (só em "aguardar"): {acao: lancar_ocorrencia|encaminhar_relacionamento,
--    codigo|null, texto ≤ 70, confianca 0..1, casos ≥ 0, taxa_acao 0..1} — o que a Operação
--    fez quando NÃO esperou; copiada para op_itens.sugestao.alternativa.
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Só a tabela da 434 e a RPC da 439 (inertes). Nenhum dado existente.
-- (b) op_sugestao_ia_candidatos muda o retorno (+ previsao_entrega): DROP + CREATE.
-- (c) DEPENDÊNCIAS: 434–439.
-- (d) CLASSIFICAÇÃO: TIPO B.
-- (e) REVERSÃO (TIPO B): reaplicar os blocos de op_sugestao_ia_candidatos (439) e de
--     op_regra_sugestao_valida (434); ALTER TABLE public.op_regras_sugestao
--       DROP COLUMN IF EXISTS estado_instrucao_modelo, DROP COLUMN IF EXISTS estado_previsao_vencida,
--       DROP COLUMN IF EXISTS estado_ocorrencias_anteriores_min, DROP COLUMN IF EXISTS alternativa;
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'op_regras_sugestao' AND column_name = 'estado_instrucao_padrao') THEN
    RAISE EXCEPTION 'mig 440 exige a 439 aplicada antes';
  END IF;
END $$;

ALTER TABLE public.op_regras_sugestao
  ADD COLUMN IF NOT EXISTS estado_instrucao_modelo text,
  ADD COLUMN IF NOT EXISTS estado_previsao_vencida boolean,
  ADD COLUMN IF NOT EXISTS estado_ocorrencias_anteriores_min integer,
  ADD COLUMN IF NOT EXISTS alternativa jsonb;

ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_modelo;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_modelo CHECK (estado_instrucao_modelo IS NULL OR (
  estado_instrucao_modelo = upper(estado_instrucao_modelo) AND estado_instrucao_modelo = btrim(estado_instrucao_modelo)
  AND estado_instrucao_modelo !~ '\s{2}' AND estado_instrucao_modelo !~ '[\t\n\r]'
  AND estado_instrucao_modelo !~ '[0-9]'                                 -- todo dígito já virou #
  AND char_length(estado_instrucao_modelo) BETWEEN 1 AND 500));
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_instrucao_exclusiva;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_instrucao_exclusiva
  CHECK (estado_instrucao_padrao IS NULL OR estado_instrucao_modelo IS NULL);
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_ocorrencias;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_ocorrencias
  CHECK (estado_ocorrencias_anteriores_min IS NULL OR estado_ocorrencias_anteriores_min BETWEEN 0 AND 1000);
ALTER TABLE public.op_regras_sugestao DROP CONSTRAINT IF EXISTS oprs_alternativa;
ALTER TABLE public.op_regras_sugestao ADD CONSTRAINT oprs_alternativa CHECK (alternativa IS NULL OR (
  acao = 'aguardar'
  AND jsonb_typeof(alternativa) = 'object'
  AND alternativa->>'acao' IN ('lancar_ocorrencia', 'encaminhar_relacionamento')
  AND ((alternativa->>'acao' = 'lancar_ocorrencia' AND jsonb_typeof(alternativa->'codigo') = 'number'
        AND (alternativa->>'codigo')::integer NOT IN (49, 54, 59, 33, 44, 6, 9, 16, 14, 41, 56, 1)
        AND (alternativa->>'codigo')::integer <> estado_oc)
       OR (alternativa->>'acao' = 'encaminhar_relacionamento' AND coalesce(jsonb_typeof(alternativa->'codigo'), 'null') = 'null'))
  AND jsonb_typeof(alternativa->'texto') = 'string' AND char_length(btrim(alternativa->>'texto')) BETWEEN 3 AND 70
  AND jsonb_typeof(alternativa->'confianca') = 'number' AND (alternativa->>'confianca')::numeric BETWEEN 0 AND 1
  AND jsonb_typeof(alternativa->'casos') = 'number' AND (alternativa->>'casos')::numeric >= 0
  AND (alternativa->>'casos')::numeric = trunc((alternativa->>'casos')::numeric)
  AND jsonb_typeof(alternativa->'taxa_acao') = 'number' AND (alternativa->>'taxa_acao')::numeric BETWEEN 0 AND 1));

-- O código da alternativa também tem de ser da Operação no dicionário.
CREATE OR REPLACE FUNCTION public.op_regra_sugestao_valida()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.codigo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ocorrencias_dicionario d WHERE d.codigo = NEW.codigo AND d.responsabilidade = 'Operação') THEN
    RAISE EXCEPTION 'regra %: oc % não é de responsabilidade da Operação no ocorrencias_dicionario (ADR 0041 D10)', NEW.id, NEW.codigo;
  END IF;
  IF jsonb_typeof(NEW.alternativa->'codigo') = 'number' AND NOT EXISTS (
    SELECT 1 FROM public.ocorrencias_dicionario d
     WHERE d.codigo = (NEW.alternativa->>'codigo')::integer AND d.responsabilidade = 'Operação') THEN
    RAISE EXCEPTION 'regra %: alternativa com oc % fora da Operação (ADR 0041 D10)', NEW.id, NEW.alternativa->>'codigo';
  END IF;
  RETURN NEW;
END;
$$;

-- Candidatos da IA trazem a previsão (a regra com previsao_vencida é relida antes de chamar).
DROP FUNCTION IF EXISTS public.op_sugestao_ia_candidatos(integer);
CREATE FUNCTION public.op_sugestao_ia_candidatos(p_limite integer DEFAULT 30)
RETURNS TABLE (op_item_id uuid, cod_ultima_ocorrencia smallint, data_ultima_ocorrencia timestamptz,
               instrucao_ultima_ocorrencia text, unidade text, cidade_destino text, uf_destino text, pagador text,
               cnpj_pagador text, reavaliacao boolean, previsao_entrega timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.cod_ultima_ocorrencia, i.data_ultima_ocorrencia, i.instrucao_ultima_ocorrencia,
         i.unidade, i.cidade_destino, i.uf_destino, i.pagador, i.cnpj_pagador,
         (i.sugestao IS NOT NULL) AS reavaliacao, i.previsao_entrega
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

REVOKE ALL ON FUNCTION public.op_sugestao_ia_candidatos(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_sugestao_ia_candidatos(integer) TO service_role;

DO $$
BEGIN
  RAISE NOTICE 'OK mig 440: instrucao_modelo, previsao_vencida, ocorrencias_anteriores_min e alternativa em op_regras_sugestao';
END $$;
