-- =============================================================================
-- 2026-10-07_436 — Operação: ENCAMINHAR a nota ao Relacionamento (ADR 0041 D11;
--                  INV-189).
-- =============================================================================
-- Requisito do dono (07/10): "se for de relacionamento, ele já deve encaminhar pro
-- cockpit de relacionamento". A sugestão (regra ou agente) pode concluir que o
-- próximo passo é do Relacionamento (cliente a contatar, autorização de reentrega,
-- devolução, indenização…). Encaminhar = a nota SAI da fila da Operação e vira
-- CARD no Cockpit do Relacionamento.
--
-- CAMINHO ESCOLHIDO (ADR 0041 D11): reusar o pedido `devolver_ao_relacionamento`
-- da ponte (ADR 0039 D2, mig 415): o worker processar-pedidos-operacao CRIA o card
-- a partir do Bastão (decidirNascimentoCard: AGUARDANDO_VALIDACAO_HUMANA + lock,
-- guard INV-040, CNPJ fora do Cockpit, extravio, nota entregue) com os eventos
-- CardCriadoPorPedidoOperacao/DevolvidoPelaOperacao, e SÓ DEPOIS lança a 49 pelo
-- envelope do Relacionamento (lancarSswPortal, vazão e flags da ponte). NÃO é
-- "lançar a 49 e esperar o sync-bastao criar o card": se o CTRC tiver card
-- ENCERRADO, a 49 da ai.salex é lida por decidirVisibilidadePorSsw como ação do
-- próprio Cockpit (MANTER_FORA_RELACIONAMENTO, fonte identidade) e a tratativa
-- SOME do operador. Card criado antes, ativo e com lock, não passa por essa
-- decisão de reabertura.
--
-- Default = 1 CLIQUE (decisão do dono): op_previa_encaminhamento mostra o texto,
-- op_encaminhar_relacionamento confirma pelo token e envia na hora.
-- Flag `operacao_encaminhar_auto` (OFF): a edge sugerir-operacao AGENDA sozinha o
-- encaminhamento das sugestões com confiança ≥ limiar (piso 0,8), com evento e
-- uma JANELA PARA DESFAZER (piso 10 min); só depois ele é enviado.
--
-- O que cria/muda:
--   1. flag operacao_encaminhar_auto (OFF).
--   2. ponte_operacao_pedidos: + origem ('roteirizador' | 'cockpit_operacao'),
--      + op_encaminhamento_id. Tabela da 415 (nova, sem tráfego): ADD COLUMN com
--      default constante = só metadado.
--   3. op_itens.motivo_encerramento aceita 'encaminhado_relacionamento';
--      op_eventos.tipo aceita EncaminhamentoAgendado, EncaminhadoAoRelacionamento,
--      EncaminhamentoDesfeito, EncaminhamentoCancelado. (CHECKs das tabelas da 430.)
--   4. op_encaminhamentos (RLS como op_eventos: quem vê o item vê o encaminhamento).
--   5. RPCs da tela (authenticated): op_previa_encaminhamento,
--      op_encaminhar_relacionamento, op_desfazer_encaminhamento,
--      op_encaminhamentos_do_item. op_aceitar_sugestao recusa sugestão de
--      encaminhamento (erro sugestao_e_encaminhamento). op_v_fila ganha as colunas
--      do encaminhamento agendado.
--   6. RPCs de serviço (service_role): op_encaminhar_auto, op_encaminhamentos_promover,
--      op_ctrcs_encaminhamento_pendente.
--
-- SEPARAÇÃO (ADR 0041 D2): a Operação NUNCA vê o card do Relacionamento. O item é
-- encerrado com o evento "encaminhada ao Relacionamento em HH:MM"; o card_id não
-- vai para nenhuma tabela/retorno legível pela Operação (só o status do pedido).
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) Nenhuma tabela quente do Relacionamento é alterada. O card nasce pelo worker
--     da ponte (mig 415/416), pelo caminho já revisado.
-- (b) Dupla trava: nada é enviado com `ponte_operacao_pedidos` OFF (o clique
--     recusa com encaminhar_desligado; os agendados esperam e expiram em 24 h).
--     A 49 só chega ao SSW com `ponte_operacao_lancar_ssw` ON; OFF = o card nasce
--     com o evento "a 49 não foi lançada" (ADR 0039 D5).
-- (c) Auto-encaminhamento é exceção à 0039 D2 ("pedido tem pessoa por trás"):
--     por isso flag própria, limiar com piso, janela de desfazer e evento.
-- (d) DEPENDÊNCIAS: 430, 431 (opcional), 434, 435 e **415** (ponte_operacao_pedidos).
-- (e) CLASSIFICAÇÃO: TIPO B (ALTER de CHECK, DROP/CREATE VIEW, CREATE OR REPLACE).
-- (f) REVERSÃO (TIPO B):
--       DROP FUNCTION IF EXISTS public.op_encaminhamentos_promover(integer), public.op_encaminhar_auto(numeric, integer, integer),
--         public.op_ctrcs_encaminhamento_pendente(), public.op_encaminhamentos_do_item(uuid),
--         public.op_desfazer_encaminhamento(uuid), public.op_encaminhar_relacionamento(uuid, text, text),
--         public.op_previa_encaminhamento(uuid, text), public.op__promover_encaminhamento(uuid),
--         public.op__checar_encaminhamento(uuid, text, boolean), public.op__texto_49(text, text, text);
--       DROP TABLE IF EXISTS public.op_encaminhamentos;
--       (op_v_fila e op_aceitar_sugestao: reaplicar os blocos da 430)
--       ALTER TABLE public.ponte_operacao_pedidos DROP COLUMN IF EXISTS op_encaminhamento_id, DROP COLUMN IF EXISTS origem;
--       DELETE FROM public.feature_flags WHERE key = 'operacao_encaminhar_auto';
--     Cards já criados e 49 já lançadas não se desfazem.
--
-- ⚠ NÃO APLICADA (nem dry-run). ⚠ SEM BEGIN/COMMIT interno.
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.op_sugestao_ia_cache') IS NULL THEN
    RAISE EXCEPTION 'mig 436 exige a 435 aplicada antes';
  END IF;
  IF to_regclass('public.ponte_operacao_pedidos') IS NULL THEN
    RAISE EXCEPTION 'mig 436 exige a 415 (ponte_operacao_pedidos) aplicada antes: o encaminhamento é um pedido devolver_ao_relacionamento';
  END IF;
END $$;

-- 1. Flag -------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('operacao_encaminhar_auto', false,
   'ADR 0041 D11: a edge sugerir-operacao AGENDA sozinha o encaminhamento ao Relacionamento das '
   'sugestões de encaminhamento com confiança >= limiar (piso 0.8), com evento e janela para desfazer '
   '(piso 10 min). OFF = só pelo clique (prévia + confirmação).')
ON CONFLICT (key) DO NOTHING;

-- 2. Pedido da ponte ganha a origem ------------------------------------------------
ALTER TABLE public.ponte_operacao_pedidos
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'roteirizador',
  ADD COLUMN IF NOT EXISTS op_encaminhamento_id uuid;
ALTER TABLE public.ponte_operacao_pedidos DROP CONSTRAINT IF EXISTS pop_origem;
ALTER TABLE public.ponte_operacao_pedidos ADD CONSTRAINT pop_origem CHECK (
  origem IN ('roteirizador', 'cockpit_operacao')
  AND (origem = 'roteirizador' OR (tipo = 'devolver_ao_relacionamento' AND op_encaminhamento_id IS NOT NULL)));

-- 3. CHECKs das tabelas da 430 ------------------------------------------------------
ALTER TABLE public.op_itens DROP CONSTRAINT IF EXISTS opi_motivo;
ALTER TABLE public.op_itens ADD CONSTRAINT opi_motivo CHECK (motivo_encerramento IS NULL OR motivo_encerramento IN
  ('saiu_da_operacao', 'card_relacionamento_ativo', 'nota_finalizada', 'oc_documental', 'encaminhado_relacionamento'));
ALTER TABLE public.op_eventos DROP CONSTRAINT IF EXISTS ope_tipo;
ALTER TABLE public.op_eventos ADD CONSTRAINT ope_tipo CHECK (tipo IN (
  'ItemMaterializado', 'ItemAtualizado', 'ItemEncerrado', 'ItemAssumido', 'SugestaoGerada',
  'LancamentoSolicitado', 'SugestaoAceita', 'LancamentoCancelado', 'LancamentoLancadoNoSsw',
  'LancamentoRecusado', 'LancamentoErro', 'LancamentoExpirado', 'LancamentoConfirmado',
  'LancamentoNaoConfirmado', 'LoopMaterializacaoBloqueado',
  'EncaminhamentoAgendado', 'EncaminhadoAoRelacionamento', 'EncaminhamentoDesfeito', 'EncaminhamentoCancelado'));

-- 4. Encaminhamentos ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_encaminhamentos (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_item_id            uuid NOT NULL REFERENCES public.op_itens(id),
  ctrc                  text NOT NULL,
  nf                    text,
  unidade               text,
  oc_base               smallint,
  texto                 text NOT NULL,
  origem                text NOT NULL,
  sugestao              jsonb,
  confianca             numeric(4,3),
  status                text NOT NULL DEFAULT 'agendado',
  executar_apos         timestamptz NOT NULL,
  solicitado_por        uuid REFERENCES public.operacao_membros(id),
  solicitado_por_nome   text NOT NULL,
  solicitado_por_email  text,
  pedido_id             uuid,                      -- ponte_operacao_pedidos.pedido_id (sem FK: tabela da ponte)
  motivo_fim            text,
  desfeito_por_nome     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  enviado_em            timestamptz,
  finalizado_em         timestamptz,
  CONSTRAINT openc_origem CHECK (origem IN ('manual', 'auto')),
  CONSTRAINT openc_quem CHECK ((origem = 'manual') = (solicitado_por IS NOT NULL)),
  CONSTRAINT openc_status CHECK (status IN ('agendado', 'enviado', 'desfeito', 'cancelado')),
  CONSTRAINT openc_enviado CHECK ((status = 'enviado') = (pedido_id IS NOT NULL)),
  CONSTRAINT openc_texto CHECK (char_length(btrim(texto)) BETWEEN 3 AND 400),
  CONSTRAINT openc_auto_conf CHECK (origem = 'manual' OR confianca >= 0.8)
);
COMMENT ON TABLE public.op_encaminhamentos IS
  'ADR 0041 D11: encaminhamento de um item da Operação ao Relacionamento. agendado → enviado (vira '
  'pedido devolver_ao_relacionamento da ponte; o worker cria o card e lança a 49) | desfeito | cancelado.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_openc_item_agendado ON public.op_encaminhamentos (op_item_id) WHERE status = 'agendado';
CREATE INDEX IF NOT EXISTS idx_openc_agendado ON public.op_encaminhamentos (executar_apos) WHERE status = 'agendado';
CREATE INDEX IF NOT EXISTS idx_openc_item ON public.op_encaminhamentos (op_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_openc_enviado ON public.op_encaminhamentos (pedido_id) WHERE status = 'enviado';

ALTER TABLE public.op_encaminhamentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_encaminhamentos FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_encaminhamentos FROM authenticated;
GRANT SELECT ON public.op_encaminhamentos TO authenticated;
DROP POLICY IF EXISTS openc_select ON public.op_encaminhamentos;
CREATE POLICY openc_select ON public.op_encaminhamentos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.op_itens i WHERE i.id = op_encaminhamentos.op_item_id));  -- RLS de op_itens decide

-- 5. Peças internas -------------------------------------------------------------------
-- O texto que vai na Instrução da 49: o MESMO formato do montarTextoSsw da ponte.
CREATE OR REPLACE FUNCTION public.op__texto_49(p_texto text, p_unidade text, p_nome text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT left(btrim(p_texto) || ' (pedido da operação' || CASE WHEN coalesce(p_unidade, '') <> '' THEN ' ' || p_unidade ELSE '' END
              || ' por ' || p_nome || ')', 500);
$$;

-- A cerca do encaminhamento. p_humano = clique (exige membro e permissão); false = agente.
-- Devolve {ok:true, previa, confirmacao, membro_id, membro_nome, membro_email, texto} ou {ok:false, erro, motivo}.
CREATE OR REPLACE FUNCTION public.op__checar_encaminhamento(p_item_id uuid, p_texto text, p_humano boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_i public.op_itens%ROWTYPE;
  v_sup boolean := false;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_nome text := 'Agente da Operação';
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
  IF NOT public.op_flag('ponte_operacao_pedidos') THEN
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
      'destino', 'Relacionamento (vira card no Cockpit do Relacionamento; a nota sai da fila da Operação)',
      'texto', v_texto,
      'codigo_oc_ssw', 49,
      'texto_ssw_49', public.op__texto_49(v_texto, v_i.unidade, v_nome),
      'observacao', 'o card nasce antes da 49; a 49 vai ao SSW pela conta de serviço quando o lançamento da ponte estiver ligado'));
END;
$$;

-- Envia um encaminhamento agendado: relê a cerca, cria o pedido da ponte, encerra o item.
-- Devolve 'enviado' | 'nao_agendado' | 'aguardando_ponte' | 'cancelado:<motivo>'.
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
BEGIN
  SELECT * INTO v_e FROM public.op_encaminhamentos WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_e.status <> 'agendado' THEN
    RETURN 'nao_agendado';
  END IF;
  SELECT * INTO v_i FROM public.op_itens WHERE id = v_e.op_item_id FOR UPDATE;
  IF NOT public.op_flag('ponte_operacao_pedidos') THEN
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

  v_quem_id := CASE WHEN v_e.solicitado_por IS NOT NULL THEN 'op_membro:' || v_e.solicitado_por::text ELSE 'agente-operacao' END;
  INSERT INTO public.ponte_operacao_pedidos (pedido_id, tipo, ctrc, codigo_ocorrencia, texto, base, nf,
      solicitado_por_id, solicitado_por_nome, solicitado_por_email, criado_em_origem, hash_pedido,
      origem, op_encaminhamento_id)
  VALUES (v_pedido, 'devolver_ao_relacionamento', v_e.ctrc, 49, v_e.texto, v_e.unidade, v_i.nf,
      v_quem_id, v_e.solicitado_por_nome, v_e.solicitado_por_email, v_e.created_at,
      encode(sha256(convert_to(concat_ws('|', 'devolver_ao_relacionamento', v_e.ctrc, '49', v_e.texto,
                                         coalesce(v_e.unidade, ''), v_quem_id, coalesce(v_i.nf, '')), 'UTF8')), 'hex'),
      'cockpit_operacao', v_e.id);

  UPDATE public.op_encaminhamentos SET status = 'enviado', pedido_id = v_pedido, enviado_em = now() WHERE id = p_id;
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

REVOKE ALL ON FUNCTION public.op__texto_49(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__checar_encaminhamento(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__promover_encaminhamento(uuid) FROM PUBLIC, anon, authenticated;

-- 6. RPCs da TELA -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.op_previa_encaminhamento(p_op_item_id uuid, p_texto text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v jsonb := public.op__checar_encaminhamento(p_op_item_id, p_texto, true);
BEGIN
  IF NOT (v->>'ok')::boolean THEN RETURN v; END IF;
  RETURN jsonb_build_object('ok', true, 'texto', v->>'texto', 'confirmacao', v->>'confirmacao', 'previa', v->'previa');
END;
$$;

-- 1 clique: confere o token da prévia e ENVIA na hora (sem janela: a pessoa já viu a prévia).
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
  IF v_res <> 'enviado' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_enviado', 'motivo', v_res, 'encaminhamento_id', v_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'encaminhamento_id', v_id, 'status', 'enviado', 'previa', v_chk->'previa');
END;
$$;

-- Desfazer: só enquanto AGENDADO (nada saiu da Operação ainda).
CREATE OR REPLACE FUNCTION public.op_desfazer_encaminhamento(p_encaminhamento_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_e public.op_encaminhamentos%ROWTYPE;
  v_unidade text;
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_membro_da_operacao');
  END IF;
  SELECT * INTO v_e FROM public.op_encaminhamentos WHERE id = p_encaminhamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_encontrado');
  END IF;
  SELECT unidade INTO v_unidade FROM public.op_itens WHERE id = v_e.op_item_id;
  IF v_m.papel_op <> 'supervisor_op' AND (v_unidade IS NULL OR NOT (v_unidade = ANY (v_m.unidades))) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'fora_da_sua_unidade');
  END IF;
  IF v_e.status <> 'agendado' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'ja_enviado', 'status', v_e.status,
      'motivo', 'o encaminhamento já saiu da Operação (ou foi cancelado); fale com o Relacionamento');
  END IF;
  UPDATE public.op_encaminhamentos SET status = 'desfeito', desfeito_por_nome = v_m.nome, finalizado_em = now(),
         motivo_fim = 'desfeito por ' || v_m.nome WHERE id = v_e.id;
  PERFORM public.op__evento(v_e.op_item_id, 'EncaminhamentoDesfeito', 'membro_op', v_m.id::text, v_m.nome,
    jsonb_build_object('encaminhamento_id', v_e.id, 'origem', v_e.origem));
  RETURN jsonb_build_object('ok', true, 'encaminhamento_id', v_e.id, 'status', 'desfeito');
END;
$$;

-- O que a Operação pode saber do encaminhamento: o status do PEDIDO, nunca o card.
CREATE OR REPLACE FUNCTION public.op_encaminhamentos_do_item(p_op_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_unidade text;
BEGIN
  SELECT unidade INTO v_unidade FROM public.op_itens WHERE id = p_op_item_id;
  IF NOT FOUND OR NOT public.op_pode_ver_unidade(v_unidade) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_encontrado');
  END IF;
  RETURN jsonb_build_object('ok', true, 'encaminhamentos', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', e.id, 'status', e.status, 'origem', e.origem, 'texto', e.texto, 'confianca', e.confianca,
             'executar_apos', e.executar_apos, 'solicitado_por_nome', e.solicitado_por_nome,
             'enviado_em', e.enviado_em, 'motivo_fim', e.motivo_fim, 'created_at', e.created_at,
             'pedido_status', p.status, 'pedido_resultado', p.categoria_erro,
             'ocorrencia_lancada', p.ocorrencia_lancada) ORDER BY e.created_at DESC)
      FROM public.op_encaminhamentos e
      LEFT JOIN public.ponte_operacao_pedidos p ON p.pedido_id = e.pedido_id
     WHERE e.op_item_id = p_op_item_id), '[]'::jsonb));
END;
$$;

-- Sugestão de ENCAMINHAMENTO não é aceita pelo botão de lançar: tem botão próprio.
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
  IF v_s IS NULL OR v_s->>'codigo' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_sugestao', 'motivo', 'este item não tem sugestão');
  END IF;
  RETURN public.op__solicitar(p_op_item_id, (v_s->>'codigo')::integer, coalesce(v_s->>'texto', ''), p_confirmacao,
                              'sugestao', v_s->>'regra_id');
END;
$$;

REVOKE ALL ON FUNCTION public.op_previa_encaminhamento(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_encaminhar_relacionamento(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_desfazer_encaminhamento(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_encaminhamentos_do_item(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_aceitar_sugestao(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_previa_encaminhamento(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_encaminhar_relacionamento(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_desfazer_encaminhamento(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_encaminhamentos_do_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_aceitar_sugestao(uuid, text) TO authenticated;

-- A fila ganha o encaminhamento agendado (para o aviso "será encaminhada às HH:MM — desfazer").
DROP VIEW IF EXISTS public.op_v_fila;
CREATE VIEW public.op_v_fila WITH (security_invoker = true) AS
SELECT i.id AS op_item_id,
       i.ctrc, i.nf, i.unidade, i.status,
       i.cod_ultima_ocorrencia, d.descricao AS descricao_oc,
       i.data_ultima_ocorrencia, i.instrucao_ultima_ocorrencia,
       i.pagador, i.destinatario, i.cidade_destino, i.uf_destino,
       i.previsao_entrega, i.atraso_original, i.qtd_volumes, i.tipo_cte,
       i.assumido_por, i.assumido_por_nome, i.assumido_em,
       i.sugestao, i.sugestao_em,
       l.id AS lancamento_id, l.status AS lancamento_status, l.codigo_oc AS lancamento_codigo_oc,
       l.solicitado_por_nome AS lancamento_solicitado_por_nome, l.solicitado_em AS lancamento_solicitado_em,
       i.materializado_em, i.updated_at,
       e.id AS encaminhamento_id, e.origem AS encaminhamento_origem, e.executar_apos AS encaminhamento_executar_apos,
       e.texto AS encaminhamento_texto
  FROM public.op_itens i
  LEFT JOIN public.ocorrencias_dicionario d ON d.codigo = i.cod_ultima_ocorrencia
  LEFT JOIN LATERAL (
    SELECT x.* FROM public.op_lancamentos x
     WHERE x.op_item_id = i.id
     ORDER BY x.solicitado_em DESC LIMIT 1) l ON true
  LEFT JOIN public.op_encaminhamentos e ON e.op_item_id = i.id AND e.status = 'agendado'
 WHERE i.status <> 'encerrado';
REVOKE ALL ON public.op_v_fila FROM anon;
GRANT SELECT ON public.op_v_fila TO authenticated;

-- 7. RPCs de SERVIÇO --------------------------------------------------------------------
-- Agenda (não envia) o encaminhamento das sugestões confiantes. Flag relida aqui.
CREATE OR REPLACE FUNCTION public.op_encaminhar_auto(p_limiar numeric DEFAULT 0.9, p_janela_min integer DEFAULT 30,
                                                     p_limite integer DEFAULT 20)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limiar numeric := least(1, greatest(0.8, coalesce(p_limiar, 0.9)));
  v_janela integer := least(1440, greatest(10, coalesce(p_janela_min, 30)));
  r record;
  v_chk jsonb;
  v_id uuid;
  n integer := 0;
BEGIN
  IF NOT public.op_flag('operacao_encaminhar_auto') THEN RETURN 0; END IF;
  FOR r IN
    SELECT i.* FROM public.op_itens i
     WHERE i.status = 'aberto'                       -- assumido = uma pessoa está cuidando: não atropela
       AND i.sugestao->>'acao' = 'encaminhar_relacionamento'
       AND jsonb_typeof(i.sugestao->'confianca') = 'number'
       AND (i.sugestao->>'confianca')::numeric >= v_limiar
       AND (i.sugestao->>'oc_base') = i.cod_ultima_ocorrencia::text
       AND NOT EXISTS (SELECT 1 FROM public.op_encaminhamentos e
                        WHERE e.op_item_id = i.id AND (e.status = 'agendado'
                          -- uma pessoa desfez nesta mesma oc: o agente não insiste
                          OR (e.status = 'desfeito' AND e.oc_base IS NOT DISTINCT FROM i.cod_ultima_ocorrencia)))
     ORDER BY i.updated_at
     LIMIT least(greatest(coalesce(p_limite, 0), 0), 50)
     FOR UPDATE OF i SKIP LOCKED
  LOOP
    v_chk := public.op__checar_encaminhamento(r.id, r.sugestao->>'texto', false);
    CONTINUE WHEN NOT (v_chk->>'ok')::boolean;
    INSERT INTO public.op_encaminhamentos (op_item_id, ctrc, nf, unidade, oc_base, texto, origem, sugestao, confianca,
        executar_apos, solicitado_por_nome)
    VALUES (r.id, r.ctrc, r.nf, r.unidade, r.cod_ultima_ocorrencia, v_chk->>'texto', 'auto', r.sugestao,
        (r.sugestao->>'confianca')::numeric, now() + make_interval(mins => v_janela), 'Agente da Operação (automático)')
    RETURNING id INTO v_id;
    PERFORM public.op__evento(r.id, 'EncaminhamentoAgendado', 'system', 'sugerir-operacao', 'Agente da Operação',
      jsonb_build_object('encaminhamento_id', v_id, 'origem', 'auto', 'confianca', r.sugestao->'confianca',
                         'limiar', v_limiar, 'executar_apos', now() + make_interval(mins => v_janela),
                         'texto', v_chk->>'texto', 'fonte_sugestao', r.sugestao->>'fonte',
                         'base_regra', r.sugestao->>'base_regra'));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Envia os agendados vencidos e expira os parados há mais de 24 h.
CREATE OR REPLACE FUNCTION public.op_encaminhamentos_promover(p_limite integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_res text;
  v_out jsonb := '{}'::jsonb;
  v_exp integer;
BEGIN
  WITH exp AS (
    UPDATE public.op_encaminhamentos SET status = 'cancelado', motivo_fim = 'expirado', finalizado_em = now()
     WHERE status = 'agendado' AND executar_apos < now() - interval '24 hours' RETURNING op_item_id, id)
  SELECT count(*) INTO v_exp FROM exp;
  v_out := jsonb_build_object('expirados', v_exp);
  FOR r IN SELECT id FROM public.op_encaminhamentos
            WHERE status = 'agendado' AND executar_apos <= now()
            ORDER BY executar_apos LIMIT least(greatest(coalesce(p_limite, 0), 0), 100)
  LOOP
    v_res := split_part(public.op__promover_encaminhamento(r.id), ':', 1);
    v_out := jsonb_set(v_out, ARRAY[v_res], to_jsonb(coalesce((v_out->>v_res)::integer, 0) + 1));
  END LOOP;
  RETURN v_out;
END;
$$;

-- CTRCs encaminhados cujo pedido ainda não terminou: o materializador não os traz de volta.
CREATE OR REPLACE FUNCTION public.op_ctrcs_encaminhamento_pendente()
RETURNS TABLE (ctrc text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT e.ctrc FROM public.op_encaminhamentos e
    JOIN public.ponte_operacao_pedidos p ON p.pedido_id = e.pedido_id
   WHERE e.status = 'enviado' AND p.status = 'recebido'
  UNION
  SELECT DISTINCT e.ctrc FROM public.op_encaminhamentos e WHERE e.status = 'enviado' AND e.enviado_em > now() - interval '15 minutes';
$$;

REVOKE ALL ON FUNCTION public.op_encaminhar_auto(numeric, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_encaminhamentos_promover(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_ctrcs_encaminhamento_pendente() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_encaminhar_auto(numeric, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_encaminhamentos_promover(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_ctrcs_encaminhamento_pendente() TO service_role;

DO $$
BEGIN
  RAISE NOTICE 'OK mig 436: encaminhamento ao Relacionamento (op_encaminhamentos, RPCs) + flag operacao_encaminhar_auto (enabled=%)',
    (SELECT enabled FROM public.feature_flags WHERE key = 'operacao_encaminhar_auto');
END $$;
