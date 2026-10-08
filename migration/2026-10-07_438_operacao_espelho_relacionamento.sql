-- =============================================================================
-- 2026-10-07_438 — Operação: o encaminhamento ao Relacionamento vai para um
--                  ESPELHO por padrão (ADR 0041 D12; INV-189, emenda).
-- =============================================================================
-- Decisão do dono (07/10): "não quero que nada vá ao Cockpit Relacionamento de verdade
-- por enquanto; tem que ir para um espelho que não aparece na produção de verdade".
--
-- MODO DE ENCAMINHAMENTO (op_config.operacao_encaminhar_modo):
--   'espelho' (PADRÃO, e o valor quando a linha falta ou é inválida) — encaminhar
--      (clique ou automático) NÃO cria pedido na ponte, NÃO cria card, NÃO lança 49.
--      Grava em op_relacionamento_espelho tudo o que o card teria (CTRC, NF, texto da
--      49, motivo, sugestão de origem, quem, quando, state/lock previstos) com status
--      'recebido_no_espelho'; o item da Operação fecha (motivo encaminhado_espelho) com o
--      evento "encaminhada ao espelho do Relacionamento às HH:MM". Não depende da flag
--      ponte_operacao_pedidos.
--   'real' — o caminho da D11 (pedido devolver_ao_relacionamento da ponte). SÓ por
--      migration TIPO B com --autorizado-por: o CHECK exige autorizado_por e
--      autorizado_em, e ninguém além do dono do banco escreve em op_config.
--        UPDATE public.op_config SET valor = 'real', autorizado_por = '<quem>',
--               autorizado_em = now(), motivo = '<por quê>' WHERE chave = 'operacao_encaminhar_modo';
--
-- O ESPELHO NÃO APARECE NO RELACIONAMENTO: nenhuma view/RPC/kanban de cards lê a
-- tabela; RLS só deixa ler gestor do Cockpit e supervisor_op; escrita só por RPC.
-- Leitura para a página "Espelho do Relacionamento": op_espelho_relacionamento_listar.
-- Avaliação para treino ("teria aceitado / teria recusado + motivo"):
-- op_espelho_relacionamento_avaliar.
--
-- O materializador não traz de volta, na MESMA oc, a nota que foi para o espelho
-- (op_ctrcs_no_espelho); oc nova = situação nova, a nota volta à fila.
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Nenhuma tabela do Relacionamento é tocada. CHECKs alterados só em tabelas da
--     430/436 (novas). Substitui op__checar_encaminhamento e op__promover_encaminhamento
--     da 436 (mesmas assinaturas).
-- (b) DEPENDÊNCIAS: 436 (e por ela 418, que fica inerte).
-- (c) CLASSIFICAÇÃO: TIPO B.
-- (d) REVERSÃO (TIPO B): reaplicar os blocos das duas funções da 436;
--       DROP FUNCTION IF EXISTS public.op_espelho_relacionamento_avaliar(uuid, boolean, text),
--         public.op_espelho_relacionamento_listar(integer, text), public.op_ctrcs_no_espelho(),
--         public.op_encaminhar_modo();
--       DROP TABLE IF EXISTS public.op_relacionamento_espelho, public.op_config;
--     ATENÇÃO: sem op_encaminhar_modo() as funções da 438 não compilam — reverter as
--     duas funções ANTES do DROP.
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_encaminhamentos') IS NULL THEN
    RAISE EXCEPTION 'mig 438 exige a 436 aplicada antes';
  END IF;
END $$;

-- 1. Configuração com dono ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_config (
  chave           text PRIMARY KEY,
  valor           text NOT NULL,
  autorizado_por  text,
  autorizado_em   timestamptz,
  motivo          text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opcfg_chave CHECK (chave IN ('operacao_encaminhar_modo')),
  CONSTRAINT opcfg_modo CHECK (chave <> 'operacao_encaminhar_modo' OR valor IN ('espelho', 'real')),
  -- 'real' só com dono escrito (migration TIPO B com --autorizado-por).
  CONSTRAINT opcfg_real_exige_dono CHECK (valor <> 'real'
    OR (char_length(btrim(coalesce(autorizado_por, ''))) >= 2 AND autorizado_em IS NOT NULL
        AND char_length(btrim(coalesce(motivo, ''))) >= 10))
);
COMMENT ON TABLE public.op_config IS
  'ADR 0041 D12: configuração da Operação com dono. operacao_encaminhar_modo = espelho (padrão) | real '
  '(real só por migration TIPO B com --autorizado-por).';
INSERT INTO public.op_config (chave, valor) VALUES ('operacao_encaminhar_modo', 'espelho')
ON CONFLICT (chave) DO NOTHING;
DROP TRIGGER IF EXISTS opcfg_set_updated_at ON public.op_config;
CREATE TRIGGER opcfg_set_updated_at BEFORE UPDATE ON public.op_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.op_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_config FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.op_config TO service_role;

-- Fail-safe: linha ausente ou valor estranho = 'espelho'.
CREATE OR REPLACE FUNCTION public.op_encaminhar_modo()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN (SELECT c.valor FROM public.op_config c WHERE c.chave = 'operacao_encaminhar_modo') = 'real'
              THEN 'real' ELSE 'espelho' END;
$$;
REVOKE ALL ON FUNCTION public.op_encaminhar_modo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_encaminhar_modo() TO authenticated, service_role;

-- 2. O espelho ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_relacionamento_espelho (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_encaminhamento_id  uuid NOT NULL UNIQUE REFERENCES public.op_encaminhamentos(id),
  op_item_id            uuid NOT NULL REFERENCES public.op_itens(id),
  ctrc                  text NOT NULL,
  nf                    text,
  unidade               text,
  oc_base               smallint,
  texto                 text NOT NULL,
  texto_49              text NOT NULL,
  motivo                text,
  sugestao              jsonb,
  origem                text NOT NULL,
  confianca             numeric(4,3),
  solicitado_por        uuid,
  solicitado_por_nome   text NOT NULL,
  card_previsto         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'recebido_no_espelho',
  recebido_em           timestamptz NOT NULL DEFAULT now(),
  teria_aceitado        boolean,
  avaliacao_motivo      text,
  avaliado_por_nome     text,
  avaliado_em           timestamptz,
  CONSTRAINT opesp_status CHECK (status IN ('recebido_no_espelho', 'avaliado')),
  CONSTRAINT opesp_origem CHECK (origem IN ('manual', 'auto')),
  CONSTRAINT opesp_avaliado CHECK ((status = 'avaliado') = (teria_aceitado IS NOT NULL AND avaliado_em IS NOT NULL)),
  CONSTRAINT opesp_recusa_motivo CHECK (teria_aceitado IS DISTINCT FROM false
    OR char_length(btrim(coalesce(avaliacao_motivo, ''))) >= 5)
);
COMMENT ON TABLE public.op_relacionamento_espelho IS
  'ADR 0041 D12: o que o Relacionamento TERIA recebido da Operação (modo espelho). Não é lido por nada do '
  'Relacionamento (nenhuma view/RPC/kanban de cards). Só gestor e supervisor_op leem.';
CREATE INDEX IF NOT EXISTS idx_opesp_recebido ON public.op_relacionamento_espelho (recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_opesp_ctrc ON public.op_relacionamento_espelho (ctrc, recebido_em DESC);

ALTER TABLE public.op_relacionamento_espelho ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_relacionamento_espelho FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_relacionamento_espelho FROM authenticated;
GRANT SELECT ON public.op_relacionamento_espelho TO authenticated;
DROP POLICY IF EXISTS opesp_select ON public.op_relacionamento_espelho;
CREATE POLICY opesp_select ON public.op_relacionamento_espelho FOR SELECT TO authenticated
  USING ((SELECT public.op_eh_gestor()) OR (SELECT public.eh_supervisor_op()));

-- 3. CHECKs das tabelas da 430/436 ----------------------------------------------------
ALTER TABLE public.op_encaminhamentos ADD COLUMN IF NOT EXISTS modo text;
ALTER TABLE public.op_encaminhamentos DROP CONSTRAINT IF EXISTS openc_status;
ALTER TABLE public.op_encaminhamentos ADD CONSTRAINT openc_status
  CHECK (status IN ('agendado', 'enviado', 'espelhado', 'desfeito', 'cancelado'));
ALTER TABLE public.op_encaminhamentos DROP CONSTRAINT IF EXISTS openc_modo;
ALTER TABLE public.op_encaminhamentos ADD CONSTRAINT openc_modo CHECK (
  modo IS NULL OR (modo = 'espelho' AND status = 'espelhado' AND pedido_id IS NULL) OR (modo = 'real' AND status = 'enviado'));
ALTER TABLE public.op_itens DROP CONSTRAINT IF EXISTS opi_motivo;
ALTER TABLE public.op_itens ADD CONSTRAINT opi_motivo CHECK (motivo_encerramento IS NULL OR motivo_encerramento IN
  ('saiu_da_operacao', 'card_relacionamento_ativo', 'nota_finalizada', 'oc_documental', 'encaminhado_relacionamento',
   'encaminhado_espelho'));
ALTER TABLE public.op_eventos DROP CONSTRAINT IF EXISTS ope_tipo;
ALTER TABLE public.op_eventos ADD CONSTRAINT ope_tipo CHECK (tipo IN (
  'ItemMaterializado', 'ItemAtualizado', 'ItemEncerrado', 'ItemAssumido', 'SugestaoGerada',
  'LancamentoSolicitado', 'SugestaoAceita', 'LancamentoCancelado', 'LancamentoLancadoNoSsw',
  'LancamentoRecusado', 'LancamentoErro', 'LancamentoExpirado', 'LancamentoConfirmado',
  'LancamentoNaoConfirmado', 'LoopMaterializacaoBloqueado',
  'EncaminhamentoAgendado', 'EncaminhadoAoRelacionamento', 'EncaminhamentoDesfeito', 'EncaminhamentoCancelado',
  'EncaminhadoAoEspelho'));

-- 4. A cerca e o envio, agora com o modo (substituem os da 436) -----------------------
CREATE OR REPLACE FUNCTION public.op__checar_encaminhamento(p_item_id uuid, p_texto text, p_humano boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_i public.op_itens%ROWTYPE;
  v_sup boolean := false;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_nome text := 'Agente da Operação';
  v_modo text := public.op_encaminhar_modo();
BEGIN
  IF p_humano THEN
    SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_membro_da_operacao', 'motivo', 'só membros ativos da Operação encaminham');
    END IF;
    IF NOT public.op_flag('operacao_tela') THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'tela_desligada', 'motivo', 'a tela da Operação está desligada');
    END IF;
    IF NOT v_m.pode_lancar THEN
      RETURN jsonb_build_object('ok', false, 'erro', 'sem_permissao_de_lancar', 'motivo', 'seu acesso é só de leitura');
    END IF;
    v_sup := v_m.papel_op = 'supervisor_op';
    v_nome := v_m.nome;
  END IF;
  -- Modo 'real' depende da ponte; modo 'espelho' (padrão) não toca a ponte e não depende dela.
  IF v_modo = 'real' AND NOT public.op_flag('ponte_operacao_pedidos') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'encaminhar_desligado',
      'motivo', 'o encaminhamento ao Relacionamento está desligado (ponte_operacao_pedidos)');
  END IF;

  SELECT * INTO v_i FROM public.op_itens WHERE id = p_item_id;
  IF NOT FOUND OR v_i.status = 'encerrado' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'item_fechado', 'motivo', 'o item não está mais na fila');
  END IF;
  IF p_humano AND NOT v_sup AND (v_i.unidade IS NULL OR NOT (v_i.unidade = ANY (v_m.unidades))) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'fora_da_sua_unidade', 'motivo', 'o item é de outra unidade');
  END IF;
  IF p_humano AND v_i.assumido_por IS NOT NULL AND v_i.assumido_por <> v_m.id AND NOT v_sup THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'assumido_por_outro',
      'motivo', 'o item foi assumido por ' || coalesce(v_i.assumido_por_nome, 'outra pessoa'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.cards c WHERE c.ctrc = v_i.ctrc AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'tratativa_aberta_no_relacionamento',
      'motivo', 'a nota já tem tratativa aberta no Relacionamento');
  END IF;
  IF v_i.cod_ultima_ocorrencia IN (1, 30, 32, 2, 34) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nota_finalizada', 'motivo', 'a nota está finalizada ou em ocorrência documental');
  END IF;
  IF v_i.cod_ultima_ocorrencia IN (6, 9, 16) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nota_em_extravio',
      'motivo', 'nota em extravio: o card de extravio nasce pelo sync de extravios, não por encaminhamento');
  END IF;
  IF v_i.cod_ultima_ocorrencia = 49 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'ja_e_a_ultima_oc', 'motivo', 'a 49 já é a última ocorrência da nota');
  END IF;
  IF EXISTS (SELECT 1 FROM public.op_lancamentos l WHERE l.op_item_id = v_i.id AND l.status IN ('fila', 'lancando', 'lancado')) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'lancamento_em_andamento', 'motivo', 'há um lançamento deste item em andamento');
  END IF;
  IF p_humano AND EXISTS (SELECT 1 FROM public.op_encaminhamentos e WHERE e.op_item_id = v_i.id AND e.status = 'agendado') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'encaminhamento_em_andamento',
      'motivo', 'já há um encaminhamento agendado; desfaça-o ou espere');
  END IF;

  -- Texto: o da pessoa; vazio → o da sugestão de encaminhamento, se houver.
  IF v_texto = '' AND v_i.sugestao->>'acao' = 'encaminhar_relacionamento' THEN
    v_texto := btrim(coalesce(v_i.sugestao->>'texto', ''));
  END IF;
  IF char_length(v_texto) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'texto_obrigatorio', 'motivo', 'escreva o motivo do encaminhamento');
  END IF;
  IF char_length(v_texto) > 400 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'texto_longo', 'motivo', 'texto acima de 400 caracteres');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'membro_id', CASE WHEN p_humano THEN v_m.id END,
    'membro_nome', v_nome,
    'membro_email', CASE WHEN p_humano THEN v_m.email END,
    'texto', v_texto,
    'confirmacao', md5(concat_ws('|', v_i.id::text, v_i.ctrc, coalesce(v_i.nf, ''), coalesce(v_i.cod_ultima_ocorrencia::text, ''),
                                 'encaminhar', v_texto)),
    'previa', jsonb_build_object(
      'op_item_id', v_i.id, 'ctrc', v_i.ctrc, 'nf', v_i.nf, 'unidade', v_i.unidade, 'oc_atual', v_i.cod_ultima_ocorrencia,
      'modo', v_modo,
      'destino', CASE WHEN v_modo = 'real'
                      THEN 'Relacionamento (vira card no Cockpit do Relacionamento; a nota sai da fila da Operação)'
                      ELSE 'ESPELHO do Relacionamento (não vira card, não lança 49; a nota sai da fila da Operação)' END,
      'texto', v_texto,
      'codigo_oc_ssw', 49,
      'texto_ssw_49', public.op__texto_49(v_texto, v_i.unidade, v_nome),
      'observacao', CASE WHEN v_modo = 'real'
                         THEN 'o card nasce antes da 49; a 49 vai ao SSW pela conta de serviço quando o lançamento da ponte estiver ligado'
                         ELSE 'modo espelho: nada vai ao Relacionamento de verdade; fica registrado no Espelho do Relacionamento' END));
END;
$$;

CREATE OR REPLACE FUNCTION public.op__promover_encaminhamento(p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_e public.op_encaminhamentos%ROWTYPE;
  v_i public.op_itens%ROWTYPE;
  v_chk jsonb;
  v_motivo text;
  v_pedido uuid := gen_random_uuid();
  v_quem_id text;
  v_canc integer;
  v_hhmm text := to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI');
  v_modo text := public.op_encaminhar_modo();
  v_esp uuid;
BEGIN
  SELECT * INTO v_e FROM public.op_encaminhamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_e.status <> 'agendado' THEN
    RETURN 'nao_agendado';
  END IF;
  SELECT * INTO v_i FROM public.op_itens WHERE id = v_e.op_item_id FOR UPDATE;
  IF v_modo = 'real' AND NOT public.op_flag('ponte_operacao_pedidos') THEN
    RETURN 'aguardando_ponte';  -- fica agendado; expira em 24 h
  END IF;
  IF v_i.cod_ultima_ocorrencia IS DISTINCT FROM v_e.oc_base THEN
    v_motivo := 'oc_mudou';
  ELSE
    v_chk := public.op__checar_encaminhamento(v_e.op_item_id, v_e.texto, false);
    IF NOT (v_chk->>'ok')::boolean THEN
      v_motivo := v_chk->>'erro';
    END IF;
  END IF;
  IF v_motivo IS NOT NULL THEN
    UPDATE public.op_encaminhamentos SET status = 'cancelado', motivo_fim = v_motivo, finalizado_em = now() WHERE id = p_id;
    IF v_i.id IS NOT NULL THEN
      PERFORM public.op__evento(v_i.id, 'EncaminhamentoCancelado', 'system', 'sugerir-operacao', NULL,
        jsonb_build_object('encaminhamento_id', p_id, 'motivo', v_motivo));
    END IF;
    RETURN 'cancelado:' || v_motivo;
  END IF;

  -- ── MODO ESPELHO (padrão): nada de ponte, card ou 49. Só o registro do que o card teria. ──
  IF v_modo <> 'real' THEN
    INSERT INTO public.op_relacionamento_espelho (op_encaminhamento_id, op_item_id, ctrc, nf, unidade, oc_base, texto,
        texto_49, motivo, sugestao, origem, confianca, solicitado_por, solicitado_por_nome, card_previsto)
    VALUES (v_e.id, v_i.id, v_e.ctrc, v_i.nf, v_e.unidade, v_e.oc_base, v_e.texto,
        public.op__texto_49(v_e.texto, v_e.unidade, v_e.solicitado_por_nome),
        coalesce(nullif(v_e.sugestao->>'justificativa', ''), nullif(v_e.sugestao->>'motivo', ''), v_e.texto),
        v_e.sugestao, v_e.origem, v_e.confianca, v_e.solicitado_por, v_e.solicitado_por_nome,
        jsonb_build_object(
          'state', CASE WHEN v_e.oc_base IN (54, 59) THEN 'AGUARDANDO_CLIENTE' ELSE 'AGUARDANDO_VALIDACAO_HUMANA' END,
          'lock', v_e.oc_base IS NULL OR v_e.oc_base NOT IN (54, 59),
          'evento', 'DevolvidoPelaOperacao', 'codigo_oc_ssw', 49, 'pagador', v_i.pagador,
          'destinatario', v_i.destinatario, 'cidade_destino', v_i.cidade_destino, 'uf_destino', v_i.uf_destino,
          'instrucao_ultima_ocorrencia', v_i.instrucao_ultima_ocorrencia))
    RETURNING id INTO v_esp;
    UPDATE public.op_encaminhamentos SET status = 'espelhado', modo = 'espelho', enviado_em = now() WHERE id = p_id;
    UPDATE public.op_itens SET status = 'encerrado', encerrado_em = now(), motivo_encerramento = 'encaminhado_espelho'
     WHERE id = v_i.id;
    PERFORM public.op__evento(v_i.id, 'EncaminhadoAoEspelho',
      CASE WHEN v_e.solicitado_por IS NOT NULL THEN 'membro_op' ELSE 'system' END,
      coalesce(v_e.solicitado_por::text, 'agente-operacao'), v_e.solicitado_por_nome,
      jsonb_build_object('encaminhamento_id', p_id, 'espelho_id', v_esp, 'origem', v_e.origem, 'texto', v_e.texto,
                         'encaminhada_em', now(), 'modo', 'espelho',
                         'resumo', 'encaminhada ao espelho do Relacionamento às ' || v_hhmm));
    RETURN 'espelhado';
  END IF;

  -- ── MODO REAL (só com migration TIPO B autorizada; ver op_config) ──
  v_quem_id := CASE WHEN v_e.solicitado_por IS NOT NULL THEN 'op_membro:' || v_e.solicitado_por::text ELSE 'agente-operacao' END;
  INSERT INTO public.ponte_operacao_pedidos (pedido_id, tipo, ctrc, codigo_ocorrencia, texto, base, nf,
      solicitado_por_id, solicitado_por_nome, solicitado_por_email, criado_em_origem, hash_pedido,
      origem, op_encaminhamento_id)
  VALUES (v_pedido, 'devolver_ao_relacionamento', v_e.ctrc, 49, v_e.texto, v_e.unidade, v_i.nf,
      v_quem_id, v_e.solicitado_por_nome, v_e.solicitado_por_email, v_e.created_at,
      encode(sha256(convert_to(concat_ws('|', 'devolver_ao_relacionamento', v_e.ctrc, '49', v_e.texto,
                                         coalesce(v_e.unidade, ''), v_quem_id, coalesce(v_i.nf, '')), 'UTF8')), 'hex'),
      'cockpit_operacao', v_e.id);

  UPDATE public.op_encaminhamentos SET status = 'enviado', modo = 'real', pedido_id = v_pedido, enviado_em = now() WHERE id = p_id;
  UPDATE public.op_itens SET status = 'encerrado', encerrado_em = now(), motivo_encerramento = 'encaminhado_relacionamento'
   WHERE id = v_i.id;
  WITH canc AS (
    UPDATE public.op_lancamentos SET status = 'cancelado', finalizado_em = now(), atualizado_em = now(),
           detalhe = 'o item foi encaminhado ao Relacionamento'
     WHERE op_item_id = v_i.id AND status = 'fila' RETURNING 1)
  SELECT count(*) INTO v_canc FROM canc;
  -- O que a Operação vê: só que foi encaminhada e quando. NUNCA o card.
  PERFORM public.op__evento(v_i.id, 'EncaminhadoAoRelacionamento',
    CASE WHEN v_e.solicitado_por IS NOT NULL THEN 'membro_op' ELSE 'system' END,
    coalesce(v_e.solicitado_por::text, 'agente-operacao'), v_e.solicitado_por_nome,
    jsonb_build_object('encaminhamento_id', p_id, 'origem', v_e.origem, 'texto', v_e.texto,
                       'encaminhada_em', now(), 'resumo', 'encaminhada ao Relacionamento às ' || v_hhmm,
                       'lancamentos_cancelados', v_canc));
  RETURN 'enviado';
END;
$$;

REVOKE ALL ON FUNCTION public.op__checar_encaminhamento(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__promover_encaminhamento(uuid) FROM PUBLIC, anon, authenticated;

-- op_encaminhar_relacionamento da 436 só aceitava 'enviado' como sucesso.
CREATE OR REPLACE FUNCTION public.op_encaminhar_relacionamento(p_op_item_id uuid, p_texto text, p_confirmacao text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_chk jsonb;
  v_i public.op_itens%ROWTYPE;
  v_id uuid;
  v_res text;
BEGIN
  SELECT * INTO v_i FROM public.op_itens WHERE id = p_op_item_id FOR UPDATE;
  v_chk := public.op__checar_encaminhamento(p_op_item_id, p_texto, true);
  IF NOT (v_chk->>'ok')::boolean THEN RETURN v_chk; END IF;
  IF p_confirmacao IS NULL OR p_confirmacao <> v_chk->>'confirmacao' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'previa_desatualizada',
      'motivo', 'o que seria encaminhado mudou desde a prévia; confira de novo',
      'previa', v_chk->'previa', 'confirmacao', v_chk->>'confirmacao');
  END IF;
  INSERT INTO public.op_encaminhamentos (op_item_id, ctrc, nf, unidade, oc_base, texto, origem, sugestao, confianca,
      executar_apos, solicitado_por, solicitado_por_nome, solicitado_por_email)
  VALUES (v_i.id, v_i.ctrc, v_i.nf, v_i.unidade, v_i.cod_ultima_ocorrencia, v_chk->>'texto', 'manual',
      CASE WHEN v_i.sugestao->>'acao' = 'encaminhar_relacionamento' THEN v_i.sugestao END, NULL,
      now(), (v_chk->>'membro_id')::uuid, v_chk->>'membro_nome', v_chk->>'membro_email')
  RETURNING id INTO v_id;
  v_res := public.op__promover_encaminhamento(v_id);
  IF v_res NOT IN ('enviado', 'espelhado') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_enviado', 'motivo', v_res, 'encaminhamento_id', v_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'encaminhamento_id', v_id, 'status', v_res,
                            'modo', CASE WHEN v_res = 'espelhado' THEN 'espelho' ELSE 'real' END, 'previa', v_chk->'previa');
END;
$$;
REVOKE ALL ON FUNCTION public.op_encaminhar_relacionamento(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_encaminhar_relacionamento(uuid, text, text) TO authenticated;

-- 5. Leitura e avaliação do espelho (gestor e supervisor_op) -------------------------
CREATE OR REPLACE FUNCTION public.op_espelho_relacionamento_listar(p_limite integer DEFAULT 200, p_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (public.op_eh_gestor() OR public.eh_supervisor_op()) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_acesso_ao_espelho',
      'motivo', 'o espelho do Relacionamento é só do gestor e do supervisor da Operação');
  END IF;
  RETURN jsonb_build_object('ok', true, 'modo', public.op_encaminhar_modo(), 'itens', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', x.id, 'ctrc', x.ctrc, 'nf', x.nf, 'unidade', x.unidade, 'oc_base', x.oc_base,
             'descricao_oc', d.descricao, 'texto', x.texto, 'texto_49', x.texto_49, 'motivo', x.motivo,
             'origem', x.origem, 'confianca', x.confianca, 'sugestao', x.sugestao,
             'solicitado_por_nome', x.solicitado_por_nome, 'recebido_em', x.recebido_em,
             'card_previsto', x.card_previsto, 'status', x.status, 'teria_aceitado', x.teria_aceitado,
             'avaliacao_motivo', x.avaliacao_motivo, 'avaliado_por_nome', x.avaliado_por_nome, 'avaliado_em', x.avaliado_em)
           ORDER BY x.recebido_em DESC)
      FROM (SELECT * FROM public.op_relacionamento_espelho e
             WHERE p_status IS NULL OR e.status = p_status
             ORDER BY e.recebido_em DESC
             LIMIT least(greatest(coalesce(p_limite, 200), 1), 1000)) x
      LEFT JOIN public.ocorrencias_dicionario d ON d.codigo = x.oc_base), '[]'::jsonb));
END;
$$;

-- "Teria aceitado / teria recusado + motivo" — para treinar (regras aprendidas e evals).
CREATE OR REPLACE FUNCTION public.op_espelho_relacionamento_avaliar(p_espelho_id uuid, p_teria_aceitado boolean, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_nome text;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
BEGIN
  IF NOT (public.op_eh_gestor() OR public.eh_supervisor_op()) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_acesso_ao_espelho');
  END IF;
  IF p_teria_aceitado IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'decisao_obrigatoria', 'motivo', 'diga se teria aceitado ou recusado');
  END IF;
  IF NOT p_teria_aceitado AND char_length(coalesce(v_motivo, '')) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio', 'motivo', 'recusa exige o porquê (mínimo 5 caracteres)');
  END IF;
  SELECT coalesce((SELECT o.nome FROM public.operadores o WHERE o.user_id = auth.uid() LIMIT 1),
                  (SELECT m.nome FROM public.operacao_membros m WHERE m.user_id = auth.uid() AND m.ativo LIMIT 1),
                  'desconhecido') INTO v_nome;
  UPDATE public.op_relacionamento_espelho
     SET status = 'avaliado', teria_aceitado = p_teria_aceitado, avaliacao_motivo = v_motivo,
         avaliado_por_nome = v_nome, avaliado_em = now()
   WHERE id = p_espelho_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_encontrado');
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_espelho_id, 'status', 'avaliado', 'teria_aceitado', p_teria_aceitado);
END;
$$;
REVOKE ALL ON FUNCTION public.op_espelho_relacionamento_listar(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_espelho_relacionamento_avaliar(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_espelho_relacionamento_listar(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_espelho_relacionamento_avaliar(uuid, boolean, text) TO authenticated;

-- 6. O materializador não traz de volta, na MESMA oc, a nota que foi para o espelho ----
CREATE OR REPLACE FUNCTION public.op_ctrcs_no_espelho()
RETURNS TABLE (ctrc text, oc_base smallint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT ON (e.ctrc) e.ctrc, e.oc_base FROM public.op_relacionamento_espelho e
   WHERE e.recebido_em > now() - interval '30 days'
   ORDER BY e.ctrc, e.recebido_em DESC;
$$;
REVOKE ALL ON FUNCTION public.op_ctrcs_no_espelho() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_ctrcs_no_espelho() TO service_role;

DO $$
BEGIN
  IF public.op_encaminhar_modo() <> 'espelho' THEN
    RAISE NOTICE 'mig 438: op_config já estava em modo % (autorizado antes) — mantido', public.op_encaminhar_modo();
  END IF;
  RAISE NOTICE 'OK mig 438: encaminhamento em modo % (espelho = nada vai ao Relacionamento real)', public.op_encaminhar_modo();
END $$;
