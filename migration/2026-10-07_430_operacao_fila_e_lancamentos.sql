-- =============================================================================
-- 2026-10-07_430 — Operação no Cockpit: fila própria e lançamento no SSW pelo
--                  clique humano (ADR 0041). Backend; a tela vem depois.
-- =============================================================================
-- A Operação vê a fila DELA (o que o Bastão diz que está com a Operação, sem nota
-- com tratativa aberta no Relacionamento) e LANÇA ocorrências no SSW: a pessoa
-- clica, confirma a prévia, e o sistema grava pela conta de serviço ai.salex.
--
-- TUDO NASCE INERTE:
--   - 3 flags OFF: operacao_fila (materializador), operacao_lancar_ssw (worker e
--     pedido de lançamento), operacao_tela (RLS dos membros e visão op_v_fila);
--   - op_codigos_lancaveis: VAZIA (nenhum código pode ser lançado);
--   - op_regra_unidade_por_oc: VAZIA (item sem unidade só aparece ao supervisor e
--     ao gestor);
--   - operacao_membros: VAZIA (ninguém da Operação tem acesso);
--   - SEM cron aqui (migs 432 e 433, aplicadas só na hora de ligar).
-- Aplicar este arquivo não muda NADA do que roda hoje. O Relacionamento não lê
-- nenhuma tabela nova; nenhuma tabela existente é alterada.
--
-- O que cria:
--   1. feature_flags (3, OFF).
--   2. operacao_membros + funções current_op_membro_id(), current_op_unidades(),
--      eh_supervisor_op(), op_eh_gestor(), op_flag(). operadores.papel NÃO muda.
--   3. op_codigos_lancaveis (vazia; CHECK proíbe 49/54/59/33/44/6/9/16; 41/56
--      exigem texto; trigger exige responsabilidade 'Operação' no dicionário;
--      ativo exige dono).
--   4. op_regra_unidade_por_oc (vazia).
--   5. op_itens (1 aberto por CTRC — índice único parcial), op_eventos
--      (append-only), op_lancamentos (a fila do SSW; 1 ativo por item),
--      op_acoes_executadas_ssw (idempotência; UNIQUE(op_item_id, codigo_oc, ctrc)),
--      op_materializacoes (rodadas do materializador, para o vigia).
--   6. RLS: SELECT por unidade (membro), tudo (supervisor da Operação e gestor do
--      Cockpit). ESCRITA só por RPC SECURITY DEFINER com search_path ''.
--   7. RPCs da tela (authenticated): op_minha_sessao, op_codigos_disponiveis,
--      op_item_detalhe, op_assumir, op_previa_lancamento, op_solicitar_lancamento,
--      op_aceitar_sugestao, op_cancelar_lancamento; visão op_v_fila.
--   8. RPCs do worker e do materializador (service_role): op_materializar_aplicar,
--      op_reservar_lancamentos, op_devolver_para_fila, op_cerca_na_hora,
--      op_finalizar_lancamento, op_expirar_lancamentos, op_lancamentos_a_confirmar,
--      op_registrar_confirmacao, op_vigia_resumo.
--   9. smoke (só no nascimento).
--
-- ─── NOTAS DE RISCO ──────────────────────────────────────────────────────────
-- (a) TABELAS QUENTES: nenhum ALTER, nenhuma FK, nenhum trigger em cards,
--     card_events, todos ou audit_log. As RPCs só LEEM cards (a cerca de card
--     ativo, por cards.ctrc = CTRC, índice idx_cards_ctrc).
-- (b) SEM backfill, sem UPDATE/DELETE de dado existente.
-- (c) SECURITY DEFINER com search_path = '' em todas as funções; EXECUTE revogado
--     de PUBLIC/anon e concedido só a quem chama (authenticated para a tela,
--     service_role para worker/materializador). As de tela conferem a pessoa
--     (auth.uid() → operacao_membros) DENTRO da função.
-- (d) CLASSIFICAÇÃO: conteúdo TIPO A (só acrescenta). O classificador do
--     scripts/dbq.py acusa os DROP TRIGGER/VIEW IF EXISTS (objetos DESTE arquivo,
--     para reaplicar) e os CREATE OR REPLACE de funções NOVAS → aplicar como
--     TIPO B com --autorizado-por.
-- (e) DEPENDÊNCIAS: public.set_updated_at() (mig 001), public.ocorrencias_dicionario
--     (mig 008/204), public.feature_flags e public.operadores (mig 001),
--     auth.uid() (Supabase). A reserva de vazão conta TAMBÉM a ponte da operação
--     (ponte_operacao_pedidos, mig 415) quando ela existir — EXECUTE dinâmico com
--     to_regclass, então esta mig não depende da 415.
-- (f) REVERSÃO (TIPO B):
--       DROP VIEW IF EXISTS public.op_v_fila;
--       DROP FUNCTION IF EXISTS <cada função op_* / current_op_* / eh_supervisor_op / op__*>;
--       DROP TABLE IF EXISTS public.op_materializacoes, public.op_acoes_executadas_ssw,
--         public.op_lancamentos, public.op_eventos, public.op_itens,
--         public.op_regra_unidade_por_oc, public.op_codigos_lancaveis,
--         public.operacao_membros;
--       DELETE FROM public.feature_flags WHERE key IN ('operacao_fila','operacao_lancar_ssw','operacao_tela');
--     Ocorrências já lançadas no SSW não se desfazem.
--
-- ⚠ NÃO APLICADA (nem dry-run) — arquivo entregue ao time do Cockpit.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations).
-- AUTORIZACAO (TIPO B): "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

DO $$
BEGIN
  PERFORM set_config('cockpit.mig430_nascimento',
    CASE WHEN to_regclass('public.op_itens') IS NULL THEN 'true' ELSE 'false' END, false);
END $$;

-- 1. Flags — todas OFF --------------------------------------------------------------
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('operacao_fila', false,
   'ADR 0041: materializar-fila-operacao lê o Bastão (responsável Operação) e mantém op_itens. '
   'Sem SSW. OFF = edge responde skipped.'),
  ('operacao_lancar_ssw', false,
   'ADR 0041: a Operação pede lançamento (op_solicitar_lancamento/op_aceitar_sugestao) e o worker '
   'processar-lancamentos-operacao lança pelo envelope da Operação (ai.salex), 2/min teto 3, '
   'quarentena 30 min. OFF = nenhum pedido novo e nada chega ao SSW; relida antes de cada lançamento.'),
  ('operacao_tela', false,
   'ADR 0041: a tela da Operação. OFF = membros da Operação não leem op_itens/op_v_fila '
   '(o gestor do Cockpit continua vendo, para conferir).')
ON CONFLICT (key) DO NOTHING;

-- 2. Membros da Operação -------------------------------------------------------------
-- Tabela PRÓPRIA: operadores.papel continua 'operador'|'gestor' e é do Relacionamento.
-- Quem está aqui e não está em operadores NÃO lê nada do Relacionamento (mig 431).
CREATE TABLE IF NOT EXISTS public.operacao_membros (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  email       text NOT NULL,
  papel_op    text NOT NULL DEFAULT 'operador_op',
  -- Siglas de unidade (base/filial do SSW) que o membro enxerga. Maiúsculas.
  unidades    text[] NOT NULL DEFAULT '{}',
  -- Nasce FALSE: ver a fila não dá direito a lançar.
  pode_lancar boolean NOT NULL DEFAULT false,
  ativo       boolean NOT NULL DEFAULT true,
  criado_por  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opm_papel CHECK (papel_op IN ('operador_op', 'supervisor_op')),
  CONSTRAINT opm_nome CHECK (char_length(btrim(nome)) >= 2),
  CONSTRAINT opm_unidades_maiusculas CHECK (array_to_string(unidades, ',') = upper(btrim(array_to_string(unidades, ','))))
);
COMMENT ON TABLE public.operacao_membros IS
  'ADR 0041: pessoas da área de Operação no Cockpit. Separada de operadores (Relacionamento). '
  'unidades = o que o membro vê; supervisor_op vê todas; pode_lancar nasce false.';

DROP TRIGGER IF EXISTS opm_set_updated_at ON public.operacao_membros;
CREATE TRIGGER opm_set_updated_at BEFORE UPDATE ON public.operacao_membros
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.current_op_membro_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id FROM public.operacao_membros m WHERE m.user_id = auth.uid() AND m.ativo LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_op_unidades()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT m.unidades FROM public.operacao_membros m
                    WHERE m.user_id = auth.uid() AND m.ativo LIMIT 1), '{}'::text[]);
$$;

CREATE OR REPLACE FUNCTION public.eh_supervisor_op()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.operacao_membros m
                  WHERE m.user_id = auth.uid() AND m.ativo AND m.papel_op = 'supervisor_op');
$$;

-- Gestor do Cockpit (operadores.papel = 'gestor'): o único que vê os dois lados.
CREATE OR REPLACE FUNCTION public.op_eh_gestor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.operadores o WHERE o.user_id = auth.uid() AND o.papel = 'gestor');
$$;

CREATE OR REPLACE FUNCTION public.op_flag(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT f.enabled FROM public.feature_flags f WHERE f.key = p_key), false);
$$;

-- Predicado único de visibilidade de item (RLS e RPCs).
CREATE OR REPLACE FUNCTION public.op_pode_ver_unidade(p_unidade text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.op_eh_gestor()
      OR (public.op_flag('operacao_tela') AND (
            public.eh_supervisor_op()
         OR (p_unidade IS NOT NULL AND public.current_op_membro_id() IS NOT NULL
             AND p_unidade = ANY (public.current_op_unidades()))));
$$;

REVOKE ALL ON FUNCTION public.current_op_membro_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_op_unidades() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eh_supervisor_op() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_eh_gestor() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_flag(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_pode_ver_unidade(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_op_membro_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_op_unidades() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.eh_supervisor_op() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.op_eh_gestor() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.op_flag(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.op_pode_ver_unidade(text) TO authenticated, service_role;

ALTER TABLE public.operacao_membros ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operacao_membros FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.operacao_membros FROM authenticated;
GRANT SELECT ON public.operacao_membros TO authenticated;
DROP POLICY IF EXISTS opm_select ON public.operacao_membros;
CREATE POLICY opm_select ON public.operacao_membros FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.eh_supervisor_op()) OR (SELECT public.op_eh_gestor()));

-- 3. Códigos que a Operação pode lançar (VAZIA) ------------------------------------
CREATE TABLE IF NOT EXISTS public.op_codigos_lancaveis (
  codigo          smallint PRIMARY KEY,
  criterio        text NOT NULL,
  exige_texto     boolean NOT NULL DEFAULT false,
  ativo           boolean NOT NULL DEFAULT false,
  pedido_por      text,
  autorizado_por  text,
  autorizado_em   date,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opcl_faixa CHECK (codigo BETWEEN 1 AND 999),
  -- 49 nunca pelo menu genérico; 54/59 do cliente; 33/44 com documento; 6/9/16 extravio.
  -- 14 (saída para entrega) nasce do ROMANEIO e nunca é lançada à mão (Caio 08/10).
  CONSTRAINT opcl_proibidos CHECK (codigo NOT IN (49, 54, 59, 33, 44, 6, 9, 16, 14)),
  -- 41/56 existem pelo texto do operador (INV-046).
  CONSTRAINT opcl_texto_41_56 CHECK (codigo NOT IN (41, 56) OR exige_texto),
  CONSTRAINT opcl_criterio CHECK (char_length(btrim(criterio)) >= 10),
  CONSTRAINT opcl_ativo_exige_dono
    CHECK (NOT ativo OR (pedido_por IS NOT NULL AND autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);
COMMENT ON TABLE public.op_codigos_lancaveis IS
  'ADR 0041 D5: ocorrências que a Operação pode lançar pelo Cockpit. VAZIA. Só responsabilidade '
  'Operação no dicionário (trigger); proibidos por CHECK; ativo exige quem pediu + quem autorizou. '
  'Ligar código = migration TIPO B com --autorizado-por.';

CREATE OR REPLACE FUNCTION public.op_codigo_e_da_operacao()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ocorrencias_dicionario d
                  WHERE d.codigo = NEW.codigo AND d.responsabilidade = 'Operação') THEN
    RAISE EXCEPTION 'oc % não é de responsabilidade da Operação no ocorrencias_dicionario (ADR 0041 D5)', NEW.codigo;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS opcl_da_operacao ON public.op_codigos_lancaveis;
CREATE TRIGGER opcl_da_operacao BEFORE INSERT OR UPDATE ON public.op_codigos_lancaveis
  FOR EACH ROW EXECUTE FUNCTION public.op_codigo_e_da_operacao();
DROP TRIGGER IF EXISTS opcl_set_updated_at ON public.op_codigos_lancaveis;
CREATE TRIGGER opcl_set_updated_at BEFORE UPDATE ON public.op_codigos_lancaveis
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.op_codigos_lancaveis ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_codigos_lancaveis FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_codigos_lancaveis FROM authenticated;
GRANT SELECT ON public.op_codigos_lancaveis TO authenticated;
DROP POLICY IF EXISTS opcl_select ON public.op_codigos_lancaveis;
CREATE POLICY opcl_select ON public.op_codigos_lancaveis FOR SELECT TO authenticated
  USING ((SELECT public.current_op_membro_id()) IS NOT NULL OR (SELECT public.op_eh_gestor()));

-- 4. Regra de unidade por oc (VAZIA) -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_regra_unidade_por_oc (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_oc     smallint,                         -- NULL = vale para qualquer oc
  campo_bastao  text NOT NULL,
  prioridade    integer NOT NULL DEFAULT 100,
  ativo         boolean NOT NULL DEFAULT false,
  observacao    text,
  autorizado_por text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opru_campo CHECK (campo_bastao IN ('unidade_atual', 'unidade_destino', 'base_destino', 'unidade_origem', 'filial')),
  CONSTRAINT opru_oc CHECK (codigo_oc IS NULL OR codigo_oc BETWEEN 1 AND 999),
  CONSTRAINT opru_ativo_exige_dono CHECK (NOT ativo OR autorizado_por IS NOT NULL)
);
COMMENT ON TABLE public.op_regra_unidade_por_oc IS
  'ADR 0041 D4: de qual campo do Bastão sai a unidade do item, por oc (específica vence a genérica, '
  'depois prioridade). VAZIA = item sem unidade (só supervisor/gestor veem).';
ALTER TABLE public.op_regra_unidade_por_oc ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_regra_unidade_por_oc FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_regra_unidade_por_oc FROM authenticated;
GRANT SELECT ON public.op_regra_unidade_por_oc TO authenticated;
DROP POLICY IF EXISTS opru_select ON public.op_regra_unidade_por_oc;
CREATE POLICY opru_select ON public.op_regra_unidade_por_oc FOR SELECT TO authenticated
  USING ((SELECT public.eh_supervisor_op()) OR (SELECT public.op_eh_gestor()));

-- 5. Itens da fila -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_itens (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ctrc                        text NOT NULL,
  nf                          text,
  unidade                     text,
  status                      text NOT NULL DEFAULT 'aberto',
  bastao_pendencia_id         text,
  cod_ultima_ocorrencia       smallint,
  instrucao_ultima_ocorrencia text,
  data_ultima_ocorrencia      timestamptz,
  responsavel_atual           text,
  pagador                     text,
  cnpj_pagador                text,
  destinatario                text,
  cidade_destino              text,
  uf_destino                  text,
  previsao_entrega            timestamptz,
  atraso_original             integer,
  qtd_volumes                 integer,
  -- Caio 08/10: tipo do CT-e (Bastão.tipo_documento: NORMAL, DEVOLUCAO, REDESPACHO, REVERSA…) — filtro da tela.
  tipo_cte                    text,
  snapshot_hash               text,
  -- Sugestão por regra pura, EM SOMBRA (ADR 0041 D6). Nunca lança sozinha.
  sugestao                    jsonb,
  sugestao_em                 timestamptz,
  assumido_por                uuid REFERENCES public.operacao_membros(id),
  assumido_por_nome           text,
  assumido_em                 timestamptz,
  motivo_encerramento         text,
  encerrado_em                timestamptz,
  materializado_em            timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opi_ctrc CHECK (ctrc = upper(btrim(ctrc)) AND ctrc ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  CONSTRAINT opi_nf CHECK (nf IS NULL OR nf ~ '^[1-9][0-9]{0,11}$'),
  CONSTRAINT opi_unidade CHECK (unidade IS NULL OR unidade = upper(btrim(unidade))),
  CONSTRAINT opi_tipo_cte CHECK (tipo_cte IS NULL OR (tipo_cte = upper(btrim(tipo_cte)) AND char_length(tipo_cte) BETWEEN 1 AND 40)),
  CONSTRAINT opi_status CHECK (status IN ('aberto', 'assumido', 'lancamento_pendente', 'aguardando_confirmacao', 'encerrado')),
  CONSTRAINT opi_encerrado CHECK ((status = 'encerrado') = (encerrado_em IS NOT NULL)),
  CONSTRAINT opi_motivo CHECK (motivo_encerramento IS NULL OR motivo_encerramento IN
    ('saiu_da_operacao', 'card_relacionamento_ativo', 'nota_finalizada', 'oc_documental'))
);
COMMENT ON TABLE public.op_itens IS
  'ADR 0041: a fila da Operação, materializada do Bastão. 1 item ABERTO por CTRC (índice único '
  'parcial). Nunca contém CTRC com card ativo do Relacionamento.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_op_itens_ctrc_aberto ON public.op_itens (ctrc) WHERE status <> 'encerrado';
CREATE INDEX IF NOT EXISTS idx_op_itens_unidade_aberto ON public.op_itens (unidade, status) WHERE status <> 'encerrado';
CREATE INDEX IF NOT EXISTS idx_op_itens_ctrc_criado ON public.op_itens (ctrc, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_itens_encerrados_24h ON public.op_itens (created_at) WHERE status = 'encerrado';

DROP TRIGGER IF EXISTS opi_set_updated_at ON public.op_itens;
CREATE TRIGGER opi_set_updated_at BEFORE UPDATE ON public.op_itens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.op_itens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_itens FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_itens FROM authenticated;
GRANT SELECT ON public.op_itens TO authenticated;
DROP POLICY IF EXISTS opi_select ON public.op_itens;
CREATE POLICY opi_select ON public.op_itens FOR SELECT TO authenticated
  USING ((SELECT public.op_pode_ver_unidade(unidade)));

-- 5b. Eventos (append-only simples) --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_eventos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  op_item_id  uuid NOT NULL REFERENCES public.op_itens(id),
  tipo        text NOT NULL,
  ator_tipo   text NOT NULL,
  ator_id     text,
  ator_nome   text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ope_ator CHECK (ator_tipo IN ('membro_op', 'system')),
  CONSTRAINT ope_tipo CHECK (tipo IN (
    'ItemMaterializado', 'ItemAtualizado', 'ItemEncerrado', 'ItemAssumido', 'SugestaoGerada',
    'LancamentoSolicitado', 'SugestaoAceita', 'LancamentoCancelado', 'LancamentoLancadoNoSsw',
    'LancamentoRecusado', 'LancamentoErro', 'LancamentoExpirado', 'LancamentoConfirmado',
    'LancamentoNaoConfirmado', 'LoopMaterializacaoBloqueado'))
);
CREATE INDEX IF NOT EXISTS idx_op_eventos_item ON public.op_eventos (op_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_eventos_tipo ON public.op_eventos (tipo, created_at DESC);

CREATE OR REPLACE FUNCTION public.op_eventos_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'op_eventos é append-only (ADR 0041): % recusado', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS ope_append_only ON public.op_eventos;
CREATE TRIGGER ope_append_only BEFORE UPDATE OR DELETE ON public.op_eventos
  FOR EACH ROW EXECUTE FUNCTION public.op_eventos_append_only();
DROP TRIGGER IF EXISTS ope_append_only_truncate ON public.op_eventos;
CREATE TRIGGER ope_append_only_truncate BEFORE TRUNCATE ON public.op_eventos
  FOR EACH STATEMENT EXECUTE FUNCTION public.op_eventos_append_only();

ALTER TABLE public.op_eventos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_eventos FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_eventos FROM authenticated;
GRANT SELECT ON public.op_eventos TO authenticated;
DROP POLICY IF EXISTS ope_select ON public.op_eventos;
CREATE POLICY ope_select ON public.op_eventos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.op_itens i WHERE i.id = op_eventos.op_item_id));  -- RLS de op_itens decide

-- 5c. Lançamentos (a fila do SSW) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_lancamentos (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_item_id               uuid NOT NULL REFERENCES public.op_itens(id),
  ctrc                     text NOT NULL,
  nf                       text,
  codigo_oc                smallint NOT NULL,
  texto_operador           text NOT NULL DEFAULT '',
  texto_ssw                text NOT NULL,
  confirmacao              text NOT NULL,            -- token da prévia que a pessoa confirmou
  origem                   text NOT NULL DEFAULT 'manual',
  sugestao_regra_id        text,
  solicitado_por           uuid NOT NULL REFERENCES public.operacao_membros(id),
  solicitado_por_nome      text NOT NULL,
  solicitado_em            timestamptz NOT NULL DEFAULT now(),
  status                   text NOT NULL DEFAULT 'fila',
  reservado_em             timestamptz,
  lancado_em               timestamptz,
  acao_ssw_id              uuid,
  protocolo                text,
  categoria_erro           text,
  detalhe                  text,
  confirmacao_tentativas   integer NOT NULL DEFAULT 0,
  confirmacao_tentada_em   timestamptz,
  confirmado_em            timestamptz,
  confirmado_por           text,
  oc_vista_na_confirmacao  smallint,
  finalizado_em            timestamptz,
  atualizado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opl_status CHECK (status IN ('fila', 'lancando', 'lancado', 'confirmado', 'nao_confirmado', 'recusado', 'erro', 'cancelado')),
  CONSTRAINT opl_origem CHECK (origem IN ('manual', 'sugestao')),
  CONSTRAINT opl_codigo CHECK (codigo_oc BETWEEN 1 AND 999 AND codigo_oc NOT IN (49, 54, 59, 33, 44, 6, 9, 16, 14)),
  CONSTRAINT opl_texto_41_56 CHECK (codigo_oc NOT IN (41, 56) OR char_length(btrim(texto_operador)) >= 10),
  CONSTRAINT opl_texto_ssw CHECK (char_length(texto_ssw) BETWEEN 1 AND 500),
  CONSTRAINT opl_confirmado_por CHECK (confirmado_por IS NULL OR confirmado_por IN ('bastao', 'ssw'))
);
COMMENT ON TABLE public.op_lancamentos IS
  'ADR 0041 D7: cada linha é o CLIQUE de um membro da Operação (solicitado_por) sobre a prévia que ele '
  'confirmou (confirmacao). O worker só executa o que está aqui; nunca cria, nunca relança.';
-- Um lançamento ativo por item: duplo clique, duas abas ou duas pessoas não lançam 2x.
CREATE UNIQUE INDEX IF NOT EXISTS uq_op_lancamentos_ativo ON public.op_lancamentos (op_item_id)
  WHERE status IN ('fila', 'lancando', 'lancado');
CREATE INDEX IF NOT EXISTS idx_opl_fila ON public.op_lancamentos (solicitado_em) WHERE status = 'fila';
CREATE INDEX IF NOT EXISTS idx_opl_reservado ON public.op_lancamentos (reservado_em) WHERE reservado_em IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opl_lancado ON public.op_lancamentos (lancado_em) WHERE status = 'lancado';
CREATE INDEX IF NOT EXISTS idx_opl_quarentena ON public.op_lancamentos (finalizado_em) WHERE categoria_erro = 'sessao_invalida';
CREATE INDEX IF NOT EXISTS idx_opl_item ON public.op_lancamentos (op_item_id, solicitado_em DESC);

ALTER TABLE public.op_lancamentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_lancamentos FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_lancamentos FROM authenticated;
GRANT SELECT ON public.op_lancamentos TO authenticated;
DROP POLICY IF EXISTS opl_select ON public.op_lancamentos;
CREATE POLICY opl_select ON public.op_lancamentos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.op_itens i WHERE i.id = op_lancamentos.op_item_id));

-- 5d. Idempotência do envelope da Operação -------------------------------------------
CREATE TABLE IF NOT EXISTS public.op_acoes_executadas_ssw (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_item_id               uuid NOT NULL REFERENCES public.op_itens(id),
  op_lancamento_id         uuid REFERENCES public.op_lancamentos(id),
  codigo_oc                smallint NOT NULL,
  ctrc                     text NOT NULL,
  nf                       text,
  sucesso                  boolean,
  iniciado_em              timestamptz NOT NULL DEFAULT now(),
  finalizado_em            timestamptz,
  motivo_erro              text,
  portal_response_excerpt  text,
  protocolo                text,
  CONSTRAINT opa_unico UNIQUE (op_item_id, codigo_oc, ctrc)
);
COMMENT ON TABLE public.op_acoes_executadas_ssw IS
  'ADR 0041 D7: idempotência do envelope lancarSswPortalOperacao (espelho de acoes_executadas_ssw, '
  'que é por card). INSERT antes do SSW; UNIQUE(op_item_id, codigo_oc, ctrc).';
CREATE INDEX IF NOT EXISTS idx_opa_ctrc ON public.op_acoes_executadas_ssw (ctrc, iniciado_em DESC);
ALTER TABLE public.op_acoes_executadas_ssw ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_acoes_executadas_ssw FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.op_acoes_executadas_ssw FROM authenticated;
GRANT SELECT ON public.op_acoes_executadas_ssw TO authenticated;
DROP POLICY IF EXISTS opa_select ON public.op_acoes_executadas_ssw;
CREATE POLICY opa_select ON public.op_acoes_executadas_ssw FOR SELECT TO authenticated
  USING ((SELECT public.eh_supervisor_op()) OR (SELECT public.op_eh_gestor()));

-- 5e. Rodadas do materializador (para o vigia) ---------------------------------------
CREATE TABLE IF NOT EXISTS public.op_materializacoes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  iniciado_em    timestamptz NOT NULL DEFAULT now(),
  finalizado_em  timestamptz,
  ok             boolean,
  resumo         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_opmat_iniciado ON public.op_materializacoes (iniciado_em DESC);
ALTER TABLE public.op_materializacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.op_materializacoes FROM anon, authenticated;

-- 6. Funções internas (sem EXECUTE para ninguém além do dono) ------------------------
CREATE OR REPLACE FUNCTION public.op__evento(p_item uuid, p_tipo text, p_ator_tipo text, p_ator_id text, p_ator_nome text, p_payload jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.op_eventos (op_item_id, tipo, ator_tipo, ator_id, ator_nome, payload)
  VALUES (p_item, p_tipo, p_ator_tipo, p_ator_id, p_ator_nome, coalesce(p_payload, '{}'::jsonb));
$$;

-- Item volta ao estado "de trabalho" depois que um lançamento termina.
CREATE OR REPLACE FUNCTION public.op__liberar_item(p_item uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.op_itens
     SET status = CASE WHEN assumido_por IS NOT NULL THEN 'assumido' ELSE 'aberto' END
   WHERE id = p_item AND status IN ('lancamento_pendente', 'aguardando_confirmacao');
$$;

-- O texto que vai na Instrução do SSW: o da pessoa + a origem (≤ 500).
CREATE OR REPLACE FUNCTION public.op__texto_ssw(p_texto text, p_unidade text, p_nome text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT left(
    CASE WHEN char_length(btrim(coalesce(p_texto, ''))) > 0
         THEN btrim(p_texto) || ' (Operação' || coalesce(' ' || p_unidade, '') || ' por ' || p_nome || ')'
         ELSE 'Lançado pela Operação' || coalesce(' ' || p_unidade, '') || ' por ' || p_nome
    END, 500);
$$;

-- Token da prévia: muda se mudar o item (CTRC, NF, oc atual), o código ou o texto.
CREATE OR REPLACE FUNCTION public.op__token(p_item_id uuid, p_ctrc text, p_nf text, p_oc_atual smallint, p_codigo integer, p_texto_ssw text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT md5(concat_ws('|', p_item_id::text, p_ctrc, coalesce(p_nf, ''), coalesce(p_oc_atual::text, ''), p_codigo::text, p_texto_ssw));
$$;

-- A CERCA, relida em toda prévia e em todo pedido (ADR 0041 D5). Devolve
-- {ok:true, previa, confirmacao, membro_id, membro_nome, texto_ssw} ou {ok:false, erro, motivo}.
CREATE OR REPLACE FUNCTION public.op__checar_lancamento(p_item_id uuid, p_codigo integer, p_texto text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_i public.op_itens%ROWTYPE;
  v_sup boolean;
  v_desc text;
  v_exige boolean;
  v_texto text := btrim(coalesce(p_texto, ''));
  v_texto_ssw text;
  v_card uuid;
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_membro_da_operacao', 'motivo', 'só membros ativos da Operação lançam pela fila');
  END IF;
  IF NOT public.op_flag('operacao_tela') OR NOT public.op_flag('operacao_lancar_ssw') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'lancamento_desligado', 'motivo', 'o lançamento pela Operação está desligado');
  END IF;
  IF NOT v_m.pode_lancar THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_permissao_de_lancar', 'motivo', 'seu acesso é só de leitura');
  END IF;
  v_sup := v_m.papel_op = 'supervisor_op';

  SELECT * INTO v_i FROM public.op_itens WHERE id = p_item_id;
  IF NOT FOUND OR v_i.status = 'encerrado' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'item_fechado', 'motivo', 'o item não está mais na fila');
  END IF;
  IF NOT v_sup AND (v_i.unidade IS NULL OR NOT (v_i.unidade = ANY (v_m.unidades))) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'fora_da_sua_unidade', 'motivo', 'o item é de outra unidade');
  END IF;
  IF v_i.assumido_por IS NOT NULL AND v_i.assumido_por <> v_m.id AND NOT v_sup THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'assumido_por_outro',
      'motivo', 'o item foi assumido por ' || coalesce(v_i.assumido_por_nome, 'outra pessoa'));
  END IF;

  -- Cerca do Relacionamento: CTRC com card ATIVO não é da Operação.
  SELECT c.id INTO v_card FROM public.cards c
   WHERE c.ctrc = v_i.ctrc AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO') LIMIT 1;
  IF v_card IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'tratativa_aberta_no_relacionamento',
      'motivo', 'a nota tem tratativa aberta no Relacionamento; a Operação não lança por cima');
  END IF;
  IF v_i.cod_ultima_ocorrencia IN (1, 30, 32, 2, 34) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nota_finalizada', 'motivo', 'a nota está finalizada ou em ocorrência documental');
  END IF;
  IF v_i.nf IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_nf_para_tripe', 'motivo', 'sem NF para o tripé CTRC + NF + localização');
  END IF;

  -- Lista de códigos relida AGORA (e o dicionário).
  IF p_codigo IS NULL OR p_codigo IN (49, 54, 59, 33, 44, 6, 9, 16, 14) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'codigo_proibido', 'motivo', 'a Operação nunca lança este código');
  END IF;
  SELECT d.descricao, l.exige_texto INTO v_desc, v_exige
    FROM public.op_codigos_lancaveis l
    JOIN public.ocorrencias_dicionario d ON d.codigo = l.codigo AND d.responsabilidade = 'Operação'
   WHERE l.codigo = p_codigo AND l.ativo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'codigo_nao_permitido', 'motivo', 'o código não está na lista da Operação');
  END IF;
  IF (v_exige OR p_codigo IN (41, 56)) AND char_length(v_texto) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'texto_obrigatorio', 'motivo', 'este código exige o seu texto (mínimo 10 caracteres)');
  END IF;
  IF char_length(v_texto) > 400 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'texto_longo', 'motivo', 'texto acima de 400 caracteres');
  END IF;
  IF v_i.cod_ultima_ocorrencia = p_codigo THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'ja_e_a_ultima_oc', 'motivo', 'esta já é a última ocorrência da nota');
  END IF;
  IF EXISTS (SELECT 1 FROM public.op_lancamentos l WHERE l.op_item_id = v_i.id AND l.status IN ('fila', 'lancando', 'lancado')) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'lancamento_em_andamento', 'motivo', 'já existe um lançamento deste item em andamento');
  END IF;

  v_texto_ssw := public.op__texto_ssw(v_texto, v_i.unidade, v_m.nome);
  RETURN jsonb_build_object(
    'ok', true,
    'membro_id', v_m.id,
    'membro_nome', v_m.nome,
    'texto_operador', v_texto,
    'texto_ssw', v_texto_ssw,
    'confirmacao', public.op__token(v_i.id, v_i.ctrc, v_i.nf, v_i.cod_ultima_ocorrencia, p_codigo, v_texto_ssw),
    'previa', jsonb_build_object(
      'op_item_id', v_i.id, 'ctrc', v_i.ctrc, 'nf', v_i.nf, 'unidade', v_i.unidade,
      'oc_atual', v_i.cod_ultima_ocorrencia, 'codigo_oc', p_codigo, 'descricao_oc', v_desc,
      'texto_ssw', v_texto_ssw, 'conta_ssw', 'ai.salex (conta de serviço)'));
END;
$$;

-- Pedido de lançamento (interno): trava o item, relê a cerca, confere o token,
-- assume se livre, grava o pedido e o evento. Tudo numa transação.
CREATE OR REPLACE FUNCTION public.op__solicitar(p_item_id uuid, p_codigo integer, p_texto text, p_confirmacao text, p_origem text, p_regra_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_chk jsonb;
  v_i public.op_itens%ROWTYPE;
  v_membro uuid;
  v_nome text;
  v_lanc uuid;
BEGIN
  PERFORM 1 FROM public.op_itens WHERE id = p_item_id FOR UPDATE;
  v_chk := public.op__checar_lancamento(p_item_id, p_codigo, p_texto);
  IF NOT (v_chk->>'ok')::boolean THEN
    RETURN v_chk;
  END IF;
  IF p_confirmacao IS NULL OR p_confirmacao <> v_chk->>'confirmacao' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'previa_desatualizada',
      'motivo', 'o que seria lançado mudou desde a prévia; confira de novo antes de confirmar',
      'previa', v_chk->'previa', 'confirmacao', v_chk->>'confirmacao');
  END IF;
  v_membro := (v_chk->>'membro_id')::uuid;
  v_nome := v_chk->>'membro_nome';
  SELECT * INTO v_i FROM public.op_itens WHERE id = p_item_id;

  IF v_i.assumido_por IS DISTINCT FROM v_membro THEN
    UPDATE public.op_itens SET assumido_por = v_membro, assumido_por_nome = v_nome, assumido_em = now() WHERE id = p_item_id;
    PERFORM public.op__evento(p_item_id, 'ItemAssumido', 'membro_op', v_membro::text, v_nome,
      jsonb_build_object('de', v_i.assumido_por, 'via', 'pedido_de_lancamento'));
  END IF;

  BEGIN
    INSERT INTO public.op_lancamentos (op_item_id, ctrc, nf, codigo_oc, texto_operador, texto_ssw, confirmacao,
                                       origem, sugestao_regra_id, solicitado_por, solicitado_por_nome)
    VALUES (p_item_id, v_i.ctrc, v_i.nf, p_codigo, v_chk->>'texto_operador', v_chk->>'texto_ssw', p_confirmacao,
            p_origem, p_regra_id, v_membro, v_nome)
    RETURNING id INTO v_lanc;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'lancamento_em_andamento', 'motivo', 'já existe um lançamento deste item em andamento');
  END;

  UPDATE public.op_itens SET status = 'lancamento_pendente' WHERE id = p_item_id;
  PERFORM public.op__evento(p_item_id, CASE WHEN p_origem = 'sugestao' THEN 'SugestaoAceita' ELSE 'LancamentoSolicitado' END,
    'membro_op', v_membro::text, v_nome,
    jsonb_build_object('lancamento_id', v_lanc, 'codigo_oc', p_codigo, 'texto_ssw', v_chk->>'texto_ssw',
                       'regra_id', p_regra_id, 'previa', v_chk->'previa'));
  RETURN jsonb_build_object('ok', true, 'lancamento_id', v_lanc, 'status', 'fila', 'previa', v_chk->'previa');
END;
$$;

REVOKE ALL ON FUNCTION public.op__evento(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__liberar_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__texto_ssw(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__token(uuid, text, text, smallint, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__checar_lancamento(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op__solicitar(uuid, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- 7. RPCs da TELA (authenticated) -----------------------------------------------------

-- Quem sou eu na Operação e o que está ligado. Qualquer authenticated pode chamar;
-- quem não é membro nem gestor recebe membro=null e nada mais.
CREATE OR REPLACE FUNCTION public.op_minha_sessao()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_gestor boolean := public.op_eh_gestor();
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND AND NOT v_gestor THEN
    RETURN jsonb_build_object('membro', NULL, 'eh_gestor', false);
  END IF;
  RETURN jsonb_build_object(
    'membro', CASE WHEN v_m.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_m.id, 'nome', v_m.nome, 'email', v_m.email, 'papel_op', v_m.papel_op,
      'unidades', to_jsonb(v_m.unidades), 'pode_lancar', v_m.pode_lancar) END,
    'eh_gestor', v_gestor,
    'eh_supervisor', coalesce(v_m.papel_op = 'supervisor_op', false),
    'flags', jsonb_build_object(
      'operacao_tela', public.op_flag('operacao_tela'),
      'operacao_lancar_ssw', public.op_flag('operacao_lancar_ssw'),
      'operacao_fila', public.op_flag('operacao_fila')));
END;
$$;

CREATE OR REPLACE FUNCTION public.op_codigos_disponiveis()
RETURNS TABLE (codigo smallint, descricao text, exige_texto boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.codigo, d.descricao, (l.exige_texto OR l.codigo IN (41, 56))
    FROM public.op_codigos_lancaveis l
    JOIN public.ocorrencias_dicionario d ON d.codigo = l.codigo AND d.responsabilidade = 'Operação'
   WHERE l.ativo
     AND (public.current_op_membro_id() IS NOT NULL OR public.op_eh_gestor())
   ORDER BY l.codigo;
$$;

CREATE OR REPLACE FUNCTION public.op_item_detalhe(p_op_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_i public.op_itens%ROWTYPE;
BEGIN
  SELECT * INTO v_i FROM public.op_itens WHERE id = p_op_item_id;
  IF NOT FOUND OR NOT public.op_pode_ver_unidade(v_i.unidade) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_encontrado');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'item', to_jsonb(v_i) - 'snapshot_hash' - 'cnpj_pagador',
    'descricao_oc', (SELECT d.descricao FROM public.ocorrencias_dicionario d WHERE d.codigo = v_i.cod_ultima_ocorrencia),
    'eventos', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC)
                           FROM (SELECT * FROM public.op_eventos WHERE op_item_id = v_i.id ORDER BY created_at DESC LIMIT 50) e), '[]'::jsonb),
    'lancamentos', coalesce((SELECT jsonb_agg(to_jsonb(l) - 'confirmacao' ORDER BY l.solicitado_em DESC)
                           FROM (SELECT * FROM public.op_lancamentos WHERE op_item_id = v_i.id ORDER BY solicitado_em DESC LIMIT 20) l), '[]'::jsonb),
    'codigos_disponiveis', coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM public.op_codigos_disponiveis() c), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.op_assumir(p_op_item_id uuid, p_forcar boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_i public.op_itens%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_membro_da_operacao');
  END IF;
  IF NOT public.op_flag('operacao_tela') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'tela_desligada');
  END IF;
  SELECT * INTO v_i FROM public.op_itens WHERE id = p_op_item_id FOR UPDATE;
  IF NOT FOUND OR v_i.status = 'encerrado' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'item_fechado');
  END IF;
  IF v_m.papel_op <> 'supervisor_op' AND (v_i.unidade IS NULL OR NOT (v_i.unidade = ANY (v_m.unidades))) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'fora_da_sua_unidade');
  END IF;
  IF v_i.assumido_por = v_m.id THEN
    RETURN jsonb_build_object('ok', true, 'op_item_id', v_i.id, 'assumido_por', v_m.id, 'status', v_i.status, 'ja_era_seu', true);
  END IF;
  IF v_i.assumido_por IS NOT NULL AND NOT (p_forcar AND v_m.papel_op = 'supervisor_op') THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'assumido_por_outro', 'assumido_por_nome', v_i.assumido_por_nome);
  END IF;
  UPDATE public.op_itens
     SET assumido_por = v_m.id, assumido_por_nome = v_m.nome, assumido_em = now(),
         status = CASE WHEN status = 'aberto' THEN 'assumido' ELSE status END
   WHERE id = v_i.id
  RETURNING * INTO v_i;
  PERFORM public.op__evento(v_i.id, 'ItemAssumido', 'membro_op', v_m.id::text, v_m.nome,
    jsonb_build_object('forcado', coalesce(p_forcar, false)));
  RETURN jsonb_build_object('ok', true, 'op_item_id', v_i.id, 'assumido_por', v_m.id, 'status', v_i.status);
END;
$$;

-- Prévia do que será lançado (sem gravar nada). O front mostra e pede o OK.
CREATE OR REPLACE FUNCTION public.op_previa_lancamento(p_op_item_id uuid, p_codigo_oc integer, p_texto text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v jsonb := public.op__checar_lancamento(p_op_item_id, p_codigo_oc, p_texto);
BEGIN
  RETURN v - 'membro_id' - 'membro_nome' - 'texto_operador';
END;
$$;

-- O clique: lança (entra na fila do worker) exatamente o que a prévia mostrou.
CREATE OR REPLACE FUNCTION public.op_solicitar_lancamento(p_op_item_id uuid, p_codigo_oc integer, p_texto text, p_confirmacao text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.op__solicitar(p_op_item_id, p_codigo_oc, p_texto, p_confirmacao, 'manual', NULL);
$$;

-- Aceitar a sugestão em sombra: 1 clique sobre a prévia (op_previa_lancamento com o
-- código e o texto da sugestão). Relê a cerca e a lista como qualquer pedido.
CREATE OR REPLACE FUNCTION public.op_aceitar_sugestao(p_op_item_id uuid, p_confirmacao text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_s jsonb;
BEGIN
  SELECT sugestao INTO v_s FROM public.op_itens WHERE id = p_op_item_id;
  IF v_s IS NULL OR v_s->>'codigo' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'sem_sugestao', 'motivo', 'este item não tem sugestão');
  END IF;
  RETURN public.op__solicitar(p_op_item_id, (v_s->>'codigo')::integer, coalesce(v_s->>'texto', ''), p_confirmacao,
                              'sugestao', v_s->>'regra_id');
END;
$$;

-- Desistir enquanto ainda está na fila (antes de ir ao SSW).
CREATE OR REPLACE FUNCTION public.op_cancelar_lancamento(p_lancamento_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_m public.operacao_membros%ROWTYPE;
  v_l public.op_lancamentos%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.operacao_membros WHERE user_id = auth.uid() AND ativo;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_membro_da_operacao');
  END IF;
  SELECT * INTO v_l FROM public.op_lancamentos WHERE id = p_lancamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_encontrado');
  END IF;
  IF v_l.solicitado_por <> v_m.id AND v_m.papel_op <> 'supervisor_op' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'nao_e_seu');
  END IF;
  IF v_l.status <> 'fila' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'ja_saiu_da_fila', 'status', v_l.status);
  END IF;
  UPDATE public.op_lancamentos SET status = 'cancelado', finalizado_em = now(), atualizado_em = now(),
         detalhe = 'cancelado por ' || v_m.nome WHERE id = v_l.id;
  PERFORM public.op__liberar_item(v_l.op_item_id);
  PERFORM public.op__evento(v_l.op_item_id, 'LancamentoCancelado', 'membro_op', v_m.id::text, v_m.nome,
    jsonb_build_object('lancamento_id', v_l.id, 'codigo_oc', v_l.codigo_oc));
  RETURN jsonb_build_object('ok', true, 'lancamento_id', v_l.id, 'status', 'cancelado');
END;
$$;

REVOKE ALL ON FUNCTION public.op_minha_sessao() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_codigos_disponiveis() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_item_detalhe(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_assumir(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_previa_lancamento(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_solicitar_lancamento(uuid, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_aceitar_sugestao(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.op_cancelar_lancamento(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.op_minha_sessao() TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_codigos_disponiveis() TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_item_detalhe(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_assumir(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_previa_lancamento(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_solicitar_lancamento(uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_aceitar_sugestao(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.op_cancelar_lancamento(uuid) TO authenticated;

-- A fila (visão com security_invoker: a RLS de op_itens/op_lancamentos decide quem vê o quê).
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
       i.materializado_em, i.updated_at
  FROM public.op_itens i
  LEFT JOIN public.ocorrencias_dicionario d ON d.codigo = i.cod_ultima_ocorrencia
  LEFT JOIN LATERAL (
    SELECT x.* FROM public.op_lancamentos x
     WHERE x.op_item_id = i.id
     ORDER BY x.solicitado_em DESC LIMIT 1) l ON true
 WHERE i.status <> 'encerrado';
REVOKE ALL ON public.op_v_fila FROM anon;
GRANT SELECT ON public.op_v_fila TO authenticated;

-- 8. RPCs do WORKER e do MATERIALIZADOR (service_role) ------------------------------

-- Grava o plano do materializador numa transação (ADR 0041 D4).
CREATE OR REPLACE FUNCTION public.op_materializar_aplicar(p_upserts jsonb, p_encerrar jsonb, p_confirmar jsonb, p_bloqueados text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  u jsonb;
  e jsonb;
  c jsonb;
  v_ant public.op_itens%ROWTYPE;
  v_id uuid;
  v_ctrc text;
  n_criados integer := 0; n_atualizados integer := 0; n_encerrados integer := 0;
  n_confirmados integer := 0; n_cancelados integer := 0; n_loop integer := 0; n_conflito integer := 0;
  v_cancel integer;
BEGIN
  FOR u IN SELECT * FROM jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) LOOP
    SELECT * INTO v_ant FROM public.op_itens WHERE ctrc = u->>'ctrc' AND status <> 'encerrado' FOR UPDATE;
    IF NOT FOUND THEN
      BEGIN
        INSERT INTO public.op_itens (ctrc, nf, unidade, bastao_pendencia_id, cod_ultima_ocorrencia,
            instrucao_ultima_ocorrencia, data_ultima_ocorrencia, responsavel_atual, pagador, cnpj_pagador,
            destinatario, cidade_destino, uf_destino, previsao_entrega, atraso_original, qtd_volumes, tipo_cte,
            snapshot_hash, sugestao, sugestao_em)
        VALUES (u->>'ctrc', u->>'nf', u->>'unidade', u->>'bastao_pendencia_id', (u->>'cod_ultima_ocorrencia')::smallint,
            u->>'instrucao_ultima_ocorrencia', (u->>'data_ultima_ocorrencia')::timestamptz, u->>'responsavel_atual',
            u->>'pagador', u->>'cnpj_pagador', u->>'destinatario', u->>'cidade_destino', u->>'uf_destino',
            (u->>'previsao_entrega')::timestamptz, (u->>'atraso_original')::integer, (u->>'qtd_volumes')::integer,
            nullif(upper(btrim(u->>'tipo_cte')), ''),
            u->>'snapshot_hash', CASE WHEN jsonb_typeof(u->'sugestao') = 'object' THEN u->'sugestao' END,
            CASE WHEN jsonb_typeof(u->'sugestao') = 'object' THEN now() END)
        RETURNING id INTO v_id;
      EXCEPTION WHEN unique_violation THEN
        n_conflito := n_conflito + 1;  -- outra rodada criou no meio; a próxima atualiza
        CONTINUE;
      END;
      PERFORM public.op__evento(v_id, 'ItemMaterializado', 'system', 'materializar-fila-operacao', NULL,
        jsonb_build_object('cod_ultima_ocorrencia', u->'cod_ultima_ocorrencia', 'unidade', u->'unidade', 'nf', u->'nf'));
      IF jsonb_typeof(u->'sugestao') = 'object' THEN
        PERFORM public.op__evento(v_id, 'SugestaoGerada', 'system', 'materializar-fila-operacao', NULL, u->'sugestao');
      END IF;
      n_criados := n_criados + 1;
    ELSE
      UPDATE public.op_itens SET
          nf = u->>'nf', unidade = u->>'unidade', bastao_pendencia_id = u->>'bastao_pendencia_id',
          cod_ultima_ocorrencia = (u->>'cod_ultima_ocorrencia')::smallint,
          instrucao_ultima_ocorrencia = u->>'instrucao_ultima_ocorrencia',
          data_ultima_ocorrencia = (u->>'data_ultima_ocorrencia')::timestamptz,
          responsavel_atual = u->>'responsavel_atual', pagador = u->>'pagador', cnpj_pagador = u->>'cnpj_pagador',
          destinatario = u->>'destinatario', cidade_destino = u->>'cidade_destino', uf_destino = u->>'uf_destino',
          previsao_entrega = (u->>'previsao_entrega')::timestamptz, atraso_original = (u->>'atraso_original')::integer,
          qtd_volumes = (u->>'qtd_volumes')::integer, tipo_cte = nullif(upper(btrim(u->>'tipo_cte')), ''),
          snapshot_hash = u->>'snapshot_hash',
          sugestao = CASE WHEN jsonb_typeof(u->'sugestao') = 'object' THEN u->'sugestao' END,
          sugestao_em = CASE WHEN (CASE WHEN jsonb_typeof(u->'sugestao') = 'object' THEN u->'sugestao' END) IS DISTINCT FROM v_ant.sugestao
                             THEN now() ELSE v_ant.sugestao_em END,
          materializado_em = now()
       WHERE id = v_ant.id;
      IF (u->>'cod_ultima_ocorrencia')::smallint IS DISTINCT FROM v_ant.cod_ultima_ocorrencia
         OR (u->>'unidade') IS DISTINCT FROM v_ant.unidade OR (u->>'nf') IS DISTINCT FROM v_ant.nf THEN
        PERFORM public.op__evento(v_ant.id, 'ItemAtualizado', 'system', 'materializar-fila-operacao', NULL,
          jsonb_build_object('oc_antes', v_ant.cod_ultima_ocorrencia, 'oc_depois', u->'cod_ultima_ocorrencia',
                             'unidade_antes', v_ant.unidade, 'unidade_depois', u->'unidade',
                             'nf_antes', v_ant.nf, 'nf_depois', u->'nf'));
      END IF;
      IF jsonb_typeof(u->'sugestao') = 'object' AND (u->'sugestao') IS DISTINCT FROM v_ant.sugestao THEN
        PERFORM public.op__evento(v_ant.id, 'SugestaoGerada', 'system', 'materializar-fila-operacao', NULL, u->'sugestao');
      END IF;
      n_atualizados := n_atualizados + 1;
    END IF;
  END LOOP;

  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_encerrar, '[]'::jsonb)) LOOP
    UPDATE public.op_itens SET status = 'encerrado', encerrado_em = now(), motivo_encerramento = e->>'motivo'
     WHERE id = (e->>'op_item_id')::uuid AND status <> 'encerrado'
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      -- Pedido ainda NA FILA de item que saiu: não vai mais ao SSW. Em voo/lançado segue (confirmação).
      WITH canc AS (
        UPDATE public.op_lancamentos SET status = 'cancelado', finalizado_em = now(), atualizado_em = now(),
               detalhe = 'o item saiu da fila da Operação antes do lançamento (' || (e->>'motivo') || ')'
         WHERE op_item_id = v_id AND status = 'fila' RETURNING 1)
      SELECT count(*) INTO v_cancel FROM canc;
      n_cancelados := n_cancelados + v_cancel;
      PERFORM public.op__evento(v_id, 'ItemEncerrado', 'system', 'materializar-fila-operacao', NULL,
        jsonb_build_object('motivo', e->>'motivo', 'lancamentos_cancelados', v_cancel));
      n_encerrados := n_encerrados + 1;
    END IF;
    v_id := NULL;
  END LOOP;

  FOR c IN SELECT * FROM jsonb_array_elements(coalesce(p_confirmar, '[]'::jsonb)) LOOP
    IF public.op_registrar_confirmacao((c->>'lancamento_id')::uuid, 'confirmado', (c->>'oc_vista')::integer,
         'o Bastão mostra a oc lançada como a última', 'bastao') THEN
      n_confirmados := n_confirmados + 1;
    END IF;
  END LOOP;

  -- Guard INV-040: registra 1x por 24 h no item mais recente do CTRC.
  FOREACH v_ctrc IN ARRAY coalesce(p_bloqueados, '{}'::text[]) LOOP
    SELECT id INTO v_id FROM public.op_itens WHERE ctrc = v_ctrc ORDER BY created_at DESC LIMIT 1;
    IF v_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.op_eventos WHERE op_item_id = v_id AND tipo = 'LoopMaterializacaoBloqueado'
         AND created_at > now() - interval '24 hours') THEN
      PERFORM public.op__evento(v_id, 'LoopMaterializacaoBloqueado', 'system', 'materializar-fila-operacao', NULL,
        jsonb_build_object('ctrc', v_ctrc, 'regra', 'INV-040: 3+ itens encerrados do CTRC em 24 h'));
      n_loop := n_loop + 1;
    END IF;
    v_id := NULL;
  END LOOP;

  RETURN jsonb_build_object('criados', n_criados, 'atualizados', n_atualizados, 'encerrados', n_encerrados,
    'lancamentos_cancelados', n_cancelados, 'confirmados', n_confirmados, 'loop_registrados', n_loop,
    'conflitos', n_conflito);
END;
$$;

-- VAZÃO do SSW (INV-159): mesma conta da ponte (ADR 0039 D5) e MESMO advisory lock,
-- contando também os pedidos da ponte reservados na janela — a conta ai.salex é uma só.
CREATE OR REPLACE FUNCTION public.op_reservar_lancamentos(
  p_limite_por_minuto integer DEFAULT 2,
  p_ttl_horas integer DEFAULT 4,
  p_quarentena_min integer DEFAULT 30
) RETURNS SETOF public.op_lancamentos
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limite integer := least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3);  -- teto duro: 3/min
  v_agora timestamptz;
  v_reservados integer;
  v_ponte integer := 0;
  v_ponte_quarentena integer := 0;
  v_quarentena interval := make_interval(mins => greatest(coalesce(p_quarentena_min, 30), 1));
  v_vagas integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ponte_operacao_ssw_vazao'));
  v_agora := clock_timestamp();

  IF EXISTS (SELECT 1 FROM public.op_lancamentos
              WHERE categoria_erro = 'sessao_invalida' AND finalizado_em > v_agora - v_quarentena) THEN
    RETURN;
  END IF;
  IF to_regclass('public.ponte_operacao_pedidos') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FILTER (WHERE reservado_em > $1 - interval ''60 seconds''),
                    count(*) FILTER (WHERE categoria_erro = ''sessao_invalida'' AND finalizado_em > $1 - $2)
               FROM public.ponte_operacao_pedidos
              WHERE reservado_em > $1 - $2 OR finalizado_em > $1 - $2'
      INTO v_ponte, v_ponte_quarentena USING v_agora, v_quarentena;
    IF v_ponte_quarentena > 0 THEN
      RETURN;  -- login recusado na ponte também põe a Operação em quarentena
    END IF;
  END IF;

  SELECT count(*) INTO v_reservados FROM public.op_lancamentos WHERE reservado_em > v_agora - interval '60 seconds';
  v_vagas := v_limite - v_reservados - coalesce(v_ponte, 0);
  IF v_vagas <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.op_lancamentos t
     SET status = 'lancando', reservado_em = v_agora, atualizado_em = v_agora
   WHERE t.id IN (
     SELECT q.id FROM public.op_lancamentos q
      WHERE q.status = 'fila'
        AND q.solicitado_em > v_agora - make_interval(hours => greatest(coalesce(p_ttl_horas, 4), 1))
      ORDER BY q.solicitado_em
      LIMIT v_vagas
      FOR UPDATE SKIP LOCKED)
  RETURNING t.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.op_devolver_para_fila(p_ids uuid[])
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (
    UPDATE public.op_lancamentos SET status = 'fila', reservado_em = NULL, atualizado_em = now()
     WHERE id = ANY (coalesce(p_ids, '{}'::uuid[])) AND status = 'lancando' RETURNING 1)
  SELECT count(*)::integer FROM d;
$$;

-- A cerca relida pelo worker imediatamente antes de lançar.
CREATE OR REPLACE FUNCTION public.op_cerca_na_hora(p_lancamento_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'card_ativo', EXISTS (SELECT 1 FROM public.cards c
                           WHERE c.ctrc = l.ctrc AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')),
    'codigo_ativo', EXISTS (SELECT 1 FROM public.op_codigos_lancaveis k
                              JOIN public.ocorrencias_dicionario d ON d.codigo = k.codigo AND d.responsabilidade = 'Operação'
                             WHERE k.codigo = l.codigo_oc AND k.ativo),
    'item_aberto', EXISTS (SELECT 1 FROM public.op_itens i WHERE i.id = l.op_item_id AND i.status <> 'encerrado'),
    'nf_item', (SELECT i.nf FROM public.op_itens i WHERE i.id = l.op_item_id))
  FROM public.op_lancamentos l WHERE l.id = p_lancamento_id;
$$;

CREATE OR REPLACE FUNCTION public.op_finalizar_lancamento(
  p_id uuid, p_status text, p_detalhe text, p_categoria text DEFAULT NULL,
  p_acao_ssw_id uuid DEFAULT NULL, p_protocolo text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_l public.op_lancamentos%ROWTYPE;
BEGIN
  IF p_status NOT IN ('lancado', 'recusado', 'erro') THEN
    RAISE EXCEPTION 'status final inválido: %', p_status;
  END IF;
  UPDATE public.op_lancamentos
     SET status = p_status,
         detalhe = left(p_detalhe, 1000),
         categoria_erro = p_categoria,
         acao_ssw_id = p_acao_ssw_id,
         protocolo = p_protocolo,
         lancado_em = CASE WHEN p_status = 'lancado' THEN now() END,
         finalizado_em = CASE WHEN p_status = 'lancado' THEN NULL ELSE now() END,
         atualizado_em = now()
   WHERE id = p_id AND status = 'lancando'
  RETURNING * INTO v_l;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_status = 'lancado' THEN
    UPDATE public.op_itens SET status = 'aguardando_confirmacao' WHERE id = v_l.op_item_id AND status <> 'encerrado';
  ELSE
    PERFORM public.op__liberar_item(v_l.op_item_id);
  END IF;
  PERFORM public.op__evento(v_l.op_item_id,
    CASE p_status WHEN 'lancado' THEN 'LancamentoLancadoNoSsw' WHEN 'recusado' THEN 'LancamentoRecusado' ELSE 'LancamentoErro' END,
    'system', 'processar-lancamentos-operacao', NULL,
    jsonb_build_object('lancamento_id', v_l.id, 'codigo_oc', v_l.codigo_oc, 'detalhe', left(p_detalhe, 500),
                       'categoria', p_categoria, 'acao_ssw_id', p_acao_ssw_id, 'protocolo', p_protocolo,
                       'solicitado_por', jsonb_build_object('id', v_l.solicitado_por, 'nome', v_l.solicitado_por_nome)));
  RETURN true;
END;
$$;

-- Prazos. Lançamento interrompido NUNCA é relançado às cegas: vira erro e alguém confere.
CREATE OR REPLACE FUNCTION public.op_expirar_lancamentos(p_ttl_horas integer DEFAULT 4, p_travado_min integer DEFAULT 15)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    UPDATE public.op_lancamentos
       SET status = 'erro',
           categoria_erro = CASE WHEN status = 'lancando' THEN 'lancamento_interrompido' ELSE 'expirado' END,
           detalhe = CASE WHEN status = 'lancando'
             THEN 'lançamento interrompido no meio: conferir no SSW antes de pedir de novo'
             ELSE 'expirou na fila sem ir ao SSW em ' || greatest(coalesce(p_ttl_horas, 4), 1) || ' h; se ainda vale, peça de novo' END,
           finalizado_em = now(), atualizado_em = now()
     WHERE (status = 'lancando' AND reservado_em < now() - make_interval(mins => greatest(coalesce(p_travado_min, 15), 5)))
        OR (status = 'fila' AND solicitado_em < now() - make_interval(hours => greatest(coalesce(p_ttl_horas, 4), 1)))
    RETURNING id, op_item_id, codigo_oc, categoria_erro, detalhe
  LOOP
    PERFORM public.op__liberar_item(r.op_item_id);
    PERFORM public.op__evento(r.op_item_id, 'LancamentoExpirado', 'system', 'processar-lancamentos-operacao', NULL,
      jsonb_build_object('lancamento_id', r.id, 'codigo_oc', r.codigo_oc, 'categoria', r.categoria_erro, 'detalhe', r.detalhe));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.op_lancamentos_a_confirmar(p_timeout_min integer DEFAULT 90, p_limite integer DEFAULT 1)
RETURNS SETOF public.op_lancamentos LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT * FROM public.op_lancamentos
   WHERE status = 'lancado'
     AND lancado_em < now() - make_interval(mins => greatest(coalesce(p_timeout_min, 90), 90))  -- nunca antes de 90 min
     AND (confirmacao_tentada_em IS NULL OR confirmacao_tentada_em < now() - interval '30 minutes')
   ORDER BY lancado_em
   LIMIT least(greatest(coalesce(p_limite, 1), 1), 5);
$$;

-- Resultado da confirmação. NUNCA relança: confirma, marca para conferência humana, ou adia a leitura.
CREATE OR REPLACE FUNCTION public.op_registrar_confirmacao(
  p_id uuid, p_resultado text, p_oc_vista integer, p_detalhe text, p_por text DEFAULT 'ssw'
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_l public.op_lancamentos%ROWTYPE;
BEGIN
  IF p_resultado NOT IN ('confirmado', 'nao_confirmado', 'tentar_de_novo') THEN
    RAISE EXCEPTION 'resultado inválido: %', p_resultado;
  END IF;
  IF p_resultado = 'tentar_de_novo' THEN
    UPDATE public.op_lancamentos SET confirmacao_tentativas = confirmacao_tentativas + 1,
           confirmacao_tentada_em = now(), detalhe = left(p_detalhe, 1000), atualizado_em = now()
     WHERE id = p_id AND status = 'lancado';
    RETURN FOUND;
  END IF;
  UPDATE public.op_lancamentos
     SET status = p_resultado,
         confirmado_em = CASE WHEN p_resultado = 'confirmado' THEN now() END,
         confirmado_por = CASE WHEN p_resultado = 'confirmado' THEN p_por END,
         oc_vista_na_confirmacao = p_oc_vista::smallint,
         confirmacao_tentada_em = CASE WHEN p_por = 'ssw' THEN now() ELSE confirmacao_tentada_em END,
         confirmacao_tentativas = confirmacao_tentativas + CASE WHEN p_por = 'ssw' THEN 1 ELSE 0 END,
         detalhe = left(p_detalhe, 1000), finalizado_em = now(), atualizado_em = now()
   WHERE id = p_id AND status = 'lancado'
  RETURNING * INTO v_l;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM public.op__liberar_item(v_l.op_item_id);
  PERFORM public.op__evento(v_l.op_item_id,
    CASE p_resultado WHEN 'confirmado' THEN 'LancamentoConfirmado' ELSE 'LancamentoNaoConfirmado' END,
    'system', 'processar-lancamentos-operacao', NULL,
    jsonb_build_object('lancamento_id', v_l.id, 'codigo_oc', v_l.codigo_oc, 'oc_vista', p_oc_vista, 'por', p_por,
                       'detalhe', left(p_detalhe, 500)));
  RETURN true;
END;
$$;

-- Vigia (health-check, INV-058): números da fila do SSW e do materializador.
CREATE OR REPLACE FUNCTION public.op_vigia_resumo()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'flag_fila', public.op_flag('operacao_fila'),
    'flag_lancar', public.op_flag('operacao_lancar_ssw'),
    'fila_parada_30min', (SELECT count(*) FROM public.op_lancamentos WHERE status = 'fila' AND solicitado_em < now() - interval '30 minutes'),
    'lancando_travado', (SELECT count(*) FROM public.op_lancamentos WHERE status = 'lancando' AND reservado_em < now() - interval '15 minutes'),
    'lancado_sem_confirmar_6h', (SELECT count(*) FROM public.op_lancamentos WHERE status = 'lancado' AND lancado_em < now() - interval '6 hours'),
    'nao_confirmados_24h', (SELECT count(*) FROM public.op_lancamentos WHERE status = 'nao_confirmado' AND finalizado_em > now() - interval '24 hours'),
    'erros_24h', (SELECT count(*) FROM public.op_lancamentos WHERE status = 'erro' AND finalizado_em > now() - interval '24 hours'),
    'sessao_invalida_24h', (SELECT count(*) FROM public.op_lancamentos WHERE categoria_erro = 'sessao_invalida' AND finalizado_em > now() - interval '24 hours'),
    'ultima_materializacao_ok', (SELECT max(finalizado_em) FROM public.op_materializacoes WHERE ok),
    'itens_abertos', (SELECT count(*) FROM public.op_itens WHERE status <> 'encerrado'));
$$;

REVOKE ALL ON FUNCTION public.op_materializar_aplicar(jsonb, jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_reservar_lancamentos(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_devolver_para_fila(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_cerca_na_hora(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_finalizar_lancamento(uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_expirar_lancamentos(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_lancamentos_a_confirmar(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_registrar_confirmacao(uuid, text, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_vigia_resumo() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_codigo_e_da_operacao() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.op_eventos_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.op_materializar_aplicar(jsonb, jsonb, jsonb, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_reservar_lancamentos(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_devolver_para_fila(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_cerca_na_hora(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_finalizar_lancamento(uuid, text, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_expirar_lancamentos(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_lancamentos_a_confirmar(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_registrar_confirmacao(uuid, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.op_vigia_resumo() TO service_role;

-- 9. Smoke (só no NASCIMENTO) -----------------------------------------------------------
DO $$
DECLARE
  v_ligadas integer;
  v_codigos integer;
  v_regras integer;
  v_membros integer;
BEGIN
  IF current_setting('cockpit.mig430_nascimento', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'mig 430 reaplicada: smoke de nascimento pulado.';
    RETURN;
  END IF;
  SELECT count(*) INTO v_ligadas FROM public.feature_flags
   WHERE key IN ('operacao_fila', 'operacao_lancar_ssw', 'operacao_tela') AND enabled IS TRUE;
  SELECT count(*) INTO v_codigos FROM public.op_codigos_lancaveis WHERE ativo;
  SELECT count(*) INTO v_regras FROM public.op_regra_unidade_por_oc WHERE ativo;
  SELECT count(*) INTO v_membros FROM public.operacao_membros;
  IF v_ligadas > 0 OR v_codigos > 0 OR v_regras > 0 OR v_membros > 0 THEN
    RAISE EXCEPTION 'mig 430 não nasceu inerte: flags ON=%, códigos ativos=%, regras ativas=%, membros=%',
      v_ligadas, v_codigos, v_regras, v_membros;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname IN ('materializar-fila-operacao', 'processar-lancamentos-operacao')) THEN
    RAISE NOTICE 'ATENCAO: cron da Operação já existe (migs 432/433 aplicadas antes?).';
  END IF;
  RAISE NOTICE 'OK mig 430: flags OFF, lista de códigos vazia, regras vazias, sem membros, sem cron — inerte.';
END $$;
