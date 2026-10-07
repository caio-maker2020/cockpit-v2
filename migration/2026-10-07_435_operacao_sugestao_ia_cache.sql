-- =============================================================================
-- 2026-10-07_435 — Operação: cache e gravação da sugestão do AGENTE DE IA
--                  (camada 2; ADR 0041 D10; INV-188).
-- =============================================================================
-- O agente só é chamado para item NOVO ou cuja oc MUDOU: a chave do cache é
-- (op_item_id, cod_ultima_ocorrencia). Toda chamada — ok, sem sugestão, descartada
-- ou falha — grava 1 linha aqui; a mesma (item, oc) nunca é paga duas vezes.
-- A sugestão vai para op_itens.sugestao (em sombra) com o evento SugestaoGerada.
-- Nada é lançado: aceitar continua sendo prévia + clique (op_aceitar_sugestao).
--
-- O que cria:
--   1. op_sugestao_ia_cache (RLS, só service_role).
--   2. op_sugestao_ia_candidatos(p_limite) — itens abertos/assumidos, com oc, SEM
--      sugestão e SEM cache para (item, oc). service_role.
--   3. op_gravar_sugestao_ia(...) — grava o cache e, se ok, a sugestão no item
--      (só se o item ainda está aberto, na MESMA oc e sem sugestão — regra que
--      chegou depois vence), com o evento. Revalida o contrato da sugestão no
--      banco (defesa em profundidade: código proibido nunca entra). service_role.
--
-- TUDO NASCE INERTE: a tabela nasce vazia; nada chama as RPCs enquanto a edge
-- sugerir-operacao não estiver deployada com a flag operacao_sugestao_ia ON (434).
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Nenhum ALTER em tabela existente. FK para op_itens (tabela nova da 430,
--     fora do caminho quente do Relacionamento).
-- (b) SECURITY DEFINER com search_path = ''; EXECUTE só service_role.
-- (c) DEPENDÊNCIAS: 430 (op_itens, op__evento) e 434 (flag).
-- (d) CLASSIFICAÇÃO: TIPO B (CREATE OR REPLACE de funções novas).
-- (e) REVERSÃO (TIPO B):
--       DROP FUNCTION IF EXISTS public.op_gravar_sugestao_ia(uuid, integer, text, jsonb, text, text, text, integer, integer, integer);
--       DROP FUNCTION IF EXISTS public.op_sugestao_ia_candidatos(integer);
--       DROP FUNCTION IF EXISTS public.op__sugestao_valida(jsonb, integer);
--       DROP TABLE IF EXISTS public.op_sugestao_ia_cache;
--     As sugestões já gravadas em op_itens.sugestao ficam (somem na próxima oc).
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_regras_sugestao') IS NULL THEN
    RAISE EXCEPTION 'mig 435 exige a 434 aplicada antes (op_regras_sugestao ausente)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.op_sugestao_ia_cache (
  op_item_id             uuid NOT NULL REFERENCES public.op_itens(id),
  cod_ultima_ocorrencia  smallint NOT NULL,
  status                 text NOT NULL,
  sugestao               jsonb,
  motivo                 text,
  modelo                 text,
  versao_prompt          text,
  tokens_entrada         integer NOT NULL DEFAULT 0,
  tokens_saida           integer NOT NULL DEFAULT 0,
  duracao_ms             integer,
  gravada_no_item        boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (op_item_id, cod_ultima_ocorrencia),
  CONSTRAINT opsc_status CHECK (status IN ('ok', 'sem_sugestao', 'descartada', 'falha')),
  CONSTRAINT opsc_ok_tem_sugestao CHECK ((status = 'ok') = (sugestao IS NOT NULL))
);
COMMENT ON TABLE public.op_sugestao_ia_cache IS
  'ADR 0041 D10: 1 linha por chamada ao agente da Operação, chave (item, oc). A mesma (item, oc) '
  'nunca é chamada de novo — nem depois de falha. Também é o registro para medir (status, modelo, tokens).';
CREATE INDEX IF NOT EXISTS idx_opsc_criado ON public.op_sugestao_ia_cache (created_at DESC);
ALTER TABLE public.op_sugestao_ia_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_sugestao_ia_cache FROM PUBLIC, anon, authenticated;

-- Contrato da sugestão do agente (versão 2), revalidado no banco. Devolve o problema ou NULL.
CREATE OR REPLACE FUNCTION public.op__sugestao_valida(p_s jsonb, p_oc integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_acao text := p_s->>'acao';
  v_cod integer;
  v_conf numeric;
BEGIN
  IF p_s IS NULL OR jsonb_typeof(p_s) <> 'object' THEN RETURN 'nao_e_objeto'; END IF;
  IF (p_s->>'versao_contrato') IS DISTINCT FROM '2' THEN RETURN 'versao_contrato'; END IF;
  IF (p_s->>'fonte') IS DISTINCT FROM 'agente_ia' OR (p_s->>'base_regra') IS DISTINCT FROM 'agente_ia' THEN RETURN 'fonte'; END IF;
  IF v_acao IS NULL OR v_acao NOT IN ('lancar_ocorrencia', 'encaminhar_relacionamento') THEN RETURN 'acao'; END IF;
  IF jsonb_typeof(p_s->'texto') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_s->>'texto')) NOT BETWEEN 3 AND 70 THEN RETURN 'texto'; END IF;
  IF (p_s->>'oc_base') IS DISTINCT FROM p_oc::text THEN RETURN 'oc_base'; END IF;
  IF jsonb_typeof(p_s->'confianca') IS DISTINCT FROM 'number' THEN RETURN 'confianca'; END IF;
  v_conf := (p_s->>'confianca')::numeric;
  IF v_conf < 0 OR v_conf > 1 THEN RETURN 'confianca'; END IF;
  IF v_acao = 'lancar_ocorrencia' THEN
    IF jsonb_typeof(p_s->'codigo') IS DISTINCT FROM 'number' THEN RETURN 'codigo'; END IF;
    v_cod := (p_s->>'codigo')::integer;
    IF v_cod IN (49, 54, 59, 33, 44, 6, 9, 16, 41, 56) THEN RETURN 'codigo_proibido'; END IF;
    IF v_cod = p_oc THEN RETURN 'repete_oc_atual'; END IF;
  ELSIF p_s ? 'codigo' AND jsonb_typeof(p_s->'codigo') IS DISTINCT FROM 'null' THEN
    RETURN 'encaminhar_com_codigo';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.op_sugestao_ia_candidatos(p_limite integer DEFAULT 30)
RETURNS TABLE (op_item_id uuid, cod_ultima_ocorrencia smallint, data_ultima_ocorrencia timestamptz,
               instrucao_ultima_ocorrencia text, unidade text, cidade_destino text, uf_destino text, pagador text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.cod_ultima_ocorrencia, i.data_ultima_ocorrencia, i.instrucao_ultima_ocorrencia,
         i.unidade, i.cidade_destino, i.uf_destino, i.pagador
    FROM public.op_itens i
   WHERE i.status IN ('aberto', 'assumido')
     AND i.sugestao IS NULL
     AND i.cod_ultima_ocorrencia IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.op_sugestao_ia_cache c
                      WHERE c.op_item_id = i.id AND c.cod_ultima_ocorrencia = i.cod_ultima_ocorrencia)
   ORDER BY i.updated_at DESC
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
    RETURN 'cache';  -- outra rodada já gravou esta (item, oc)
  END IF;
  IF v_status <> 'ok' THEN
    RETURN v_status;
  END IF;

  -- Só no item ainda aberto, na MESMA oc e sem sugestão (a de regra vence a do agente).
  UPDATE public.op_itens SET sugestao = v_sug, sugestao_em = now()
   WHERE id = p_op_item_id AND status IN ('aberto', 'assumido')
     AND cod_ultima_ocorrencia = p_oc AND sugestao IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN 'item_mudou';
  END IF;
  UPDATE public.op_sugestao_ia_cache SET gravada_no_item = true
   WHERE op_item_id = p_op_item_id AND cod_ultima_ocorrencia = p_oc;
  PERFORM public.op__evento(p_op_item_id, 'SugestaoGerada', 'system', 'sugerir-operacao', NULL, v_sug);
  RETURN 'gravada';
END;
$$;

REVOKE ALL ON FUNCTION public.op__sugestao_valida(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_sugestao_ia_candidatos(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_gravar_sugestao_ia(uuid, integer, text, jsonb, text, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_sugestao_ia_candidatos(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_gravar_sugestao_ia(uuid, integer, text, jsonb, text, text, text, integer, integer, integer) TO service_role;

DO $$
BEGIN
  RAISE NOTICE 'OK mig 435: op_sugestao_ia_cache + op_sugestao_ia_candidatos + op_gravar_sugestao_ia (service_role)';
END $$;
