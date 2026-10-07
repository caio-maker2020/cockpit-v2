-- =============================================================================
-- 2026-10-07_415 — Painel da Operação: tratativa para o Roteirizador e pedidos
--                  da operação (ADR 0039). Ponte v2, lado do Cockpit.
-- =============================================================================
-- O Roteirizador passa a (A) LER o estado da tratativa por CTRC e (B) PEDIR duas
-- ações: devolver a nota ao Relacionamento (evento no card + 49 no SSW) e lançar
-- uma ocorrência de fato da rota (lista vazia por padrão). Quem executa é o
-- Cockpit, pelo envelope `lancarSswPortal`, com fila e limite de vazão (INV-159).
--
-- TUDO NASCE INERTE:
--   - 3 flags OFF: ponte_operacao_leitura, ponte_operacao_pedidos,
--     ponte_operacao_lancar_ssw;
--   - lista de códigos que a operação pode lançar: VAZIA;
--   - SEM cron nesta migration (o cron do worker é a mig 416, aplicada só na
--     hora de ligar os pedidos);
--   - sem env ROTEIRIZADOR_PONTE_TOKEN as edges respondem 503 (dupla trava).
-- Aplicar este arquivo não muda NADA do que roda hoje.
--
-- O que cria:
--   1. feature_flags (3, OFF).
--   2. ponte_operacao_codigos_permitidos — a lista (vazia) de códigos que a
--      operação pode lançar; trigger recusa código que não seja da Operação no
--      ocorrencias_dicionario; ativo exige dono (quem pediu + quem autorizou).
--   3. ponte_operacao_pedidos — 1 linha por pedido; PK pedido_id = idempotência.
--   4. RPC ponte_operacao_vincular_card — evento no card + vínculo, atômico.
--   5. RPC ponte_operacao_finalizar — status final + evento, atômico.
--   6. RPC ponte_operacao_reservar_lancamentos — a VAZÃO: advisory lock,
--      teto duro de 3/min, janela de 60 s global, quarentena de login.
--   7. RPC ponte_operacao_expirar — TTL e lançamento interrompido → erro.
--   8. smoke test (só no nascimento).
--
-- ─── NOTAS DE RISCO (para quem for aplicar) ──────────────────────────────────
-- (a) TABELAS QUENTES: nenhum ALTER, nenhum lock declarado em cards,
--     card_events ou audit_log. De propósito:
--       - ponte_operacao_pedidos.card_id NÃO tem FK para cards: criar uma FK
--         pega SHARE ROW EXCLUSIVE em cards durante o CREATE e bloqueia escrita
--         em cards (sync-bastao, executor) enquanto espera. Integridade garantida
--         pela RPC (confere o card antes de gravar). Custo: id órfão se um card
--         for apagado — cards não são apagados (card_events é RESTRICT).
--       - o audit_log NÃO muda: o worker grava com external_system='ssw', que o
--         CHECK de hoje já aceita. Não depende do item 2 da mig 414.
--       - a projeção do evento no card (estado_tratativa_dirty_at) é um UPDATE
--         de 1 linha dentro da RPC, igual ao que o trigger project_card_event já
--         faz a cada evento. O trigger project_card_event NÃO é substituído.
-- (b) SEM VALIDATE, sem backfill, sem UPDATE/DELETE de dado existente.
-- (c) SECURITY DEFINER com search_path='' e EXECUTE só para service_role, igual
--     às RPCs da mig 414. RLS ligada sem policy nas 2 tabelas (só service_role).
-- (d) CLASSIFICAÇÃO: o conteúdo real é TIPO A (só acrescenta), mas o
--     classificador do scripts/dbq.py acusa os DROP TRIGGER IF EXISTS (objetos
--     criados NESTE arquivo, drop-then-create para idempotência) e os
--     CREATE OR REPLACE de funções NOVAS. Em dúvida, TIPO B (POLITICA_MIGRATIONS):
--     aplicar com --autorizado-por.
-- (e) DEPENDÊNCIAS: public.set_updated_at() (mig 001/011),
--     public.ocorrencias_dicionario (mig 008/204), cards.estado_tratativa_dirty_at
--     (mig 404 — a RPC 4 confere se a coluna existe antes de usar).
-- (f) REVERSÃO (pelo trilho, TIPO B):
--       DROP FUNCTION IF EXISTS public.ponte_operacao_expirar(integer, integer);
--       DROP FUNCTION IF EXISTS public.ponte_operacao_reservar_lancamentos(integer, integer, integer);
--       DROP FUNCTION IF EXISTS public.ponte_operacao_finalizar(uuid, text, text, smallint, uuid, text, text, jsonb);
--       DROP FUNCTION IF EXISTS public.ponte_operacao_vincular_card(uuid, uuid, boolean, jsonb);
--       DROP TABLE IF EXISTS public.ponte_operacao_pedidos;
--       DROP TABLE IF EXISTS public.ponte_operacao_codigos_permitidos;  -- leva o trigger
--       DROP FUNCTION IF EXISTS public.ponte_operacao_codigo_e_fato_da_rota();
--       DELETE FROM public.feature_flags WHERE key LIKE 'ponte_operacao_%';
--     Os card_events já gravados (DevolvidoPelaOperacao etc.) FICAM: card_events
--     é append-only. Ocorrências já lançadas no SSW não se desfazem.
-- (g) ORDEM DE ATIVAÇÃO: ver ADR 0039, "Como ligar". Esta migration é o passo 3;
--     a 416 (cron) é o passo 6.
--
-- ⚠ NÃO APLICADA (nem dry-run) — arquivo entregue ao time do Cockpit.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08).
--
-- AUTORIZACAO (TIPO B): preencher no --autorizado-por ao aplicar
--   "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

-- 0. Esta execução está CRIANDO as tabelas? (o smoke do bloco 8 só vale no nascimento,
--    mesmo padrão da mig 407: reaplicar depois de ligar não derruba a migration).
DO $$
BEGIN
  PERFORM set_config(
    'cockpit.mig415_nascimento',
    CASE WHEN to_regclass('public.ponte_operacao_pedidos') IS NULL THEN 'true' ELSE 'false' END,
    false);
END $$;

-- 1. Flags — todas OFF -------------------------------------------------------------
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('ponte_operacao_leitura', false,
   'ADR 0039: POST ponte-tratativas — o Roteirizador lê, por CTRC, o estado da tratativa '
   '(cards + estado_tratativa) e o bloqueiaEntrega. Leitura pura. OFF = 503.'),
  ('ponte_operacao_pedidos', false,
   'ADR 0039: ponte-pedido-operacao registra pedidos da operação (devolver ao Relacionamento) '
   'e o worker processar-pedidos-operacao acha ou cria o card e grava o evento. SEM SSW. OFF = 503.'),
  ('ponte_operacao_lancar_ssw', false,
   'ADR 0039: o worker lança no SSW (49 do devolver; lancar_ocorrencia só da lista) pelo envelope '
   'lancarSswPortal, até 2/min (teto 3), quarentena de 30 min após login recusado (INV-159). '
   'OFF = nenhum pedido chega ao SSW. Kill-switch relido antes de cada lançamento.')
ON CONFLICT (key) DO NOTHING;

-- 2. Lista de códigos que a operação pode lançar (VAZIA) ---------------------------
CREATE TABLE IF NOT EXISTS public.ponte_operacao_codigos_permitidos (
  codigo          smallint PRIMARY KEY,
  -- Por que este código é FATO DA ROTA (o que a rota viu), nunca tratativa.
  criterio        text NOT NULL,
  -- Nasce FALSE: cadastrar não libera nada. Ligar é ato separado (TIPO B).
  ativo           boolean NOT NULL DEFAULT false,
  -- Quem da operação pediu o código (nome e área).
  pedido_por      text,
  -- Quem autorizou (dono da lista — ADR 0039, D4) e quando.
  autorizado_por  text,
  autorizado_em   date,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pocp_codigo_faixa CHECK (codigo BETWEEN 1 AND 999),
  -- 49 entra só por devolver_ao_relacionamento; 54/59 são do cliente. Nunca aqui.
  CONSTRAINT pocp_nunca_tratativa CHECK (codigo NOT IN (49, 54, 59)),
  CONSTRAINT pocp_criterio_escrito CHECK (char_length(btrim(criterio)) >= 10),
  CONSTRAINT pocp_ativo_exige_dono
    CHECK (NOT ativo OR (pedido_por IS NOT NULL AND autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);
COMMENT ON TABLE public.ponte_operacao_codigos_permitidos IS
  'ADR 0039 D4: ocorrências que o Roteirizador pode pedir para o Cockpit lançar no SSW '
  '(lancar_ocorrencia). VAZIA por padrão. Só fato da rota (responsabilidade Operação no '
  'ocorrencias_dicionario — trigger), nunca tratativa. ativo exige quem pediu + quem autorizou.';

-- Só código de responsabilidade 'Operação' no dicionário (fonte única, mig 204).
CREATE OR REPLACE FUNCTION public.ponte_operacao_codigo_e_fato_da_rota()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ocorrencias_dicionario d
     WHERE d.codigo = NEW.codigo AND d.responsabilidade = 'Operação'
  ) THEN
    RAISE EXCEPTION 'oc % não é de responsabilidade da Operação no ocorrencias_dicionario: a operação só lança fato da rota (ADR 0039 D4)', NEW.codigo;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pocp_fato_da_rota ON public.ponte_operacao_codigos_permitidos;
CREATE TRIGGER pocp_fato_da_rota
  BEFORE INSERT OR UPDATE ON public.ponte_operacao_codigos_permitidos
  FOR EACH ROW EXECUTE FUNCTION public.ponte_operacao_codigo_e_fato_da_rota();

DROP TRIGGER IF EXISTS pocp_set_updated_at ON public.ponte_operacao_codigos_permitidos;
CREATE TRIGGER pocp_set_updated_at
  BEFORE UPDATE ON public.ponte_operacao_codigos_permitidos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ponte_operacao_codigos_permitidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ponte_operacao_codigos_permitidos FROM anon, authenticated;

-- 3. Pedidos da operação ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ponte_operacao_pedidos (
  pedido_id                uuid PRIMARY KEY,           -- idempotência: o mesmo id nunca executa 2x
  tipo                     text NOT NULL,
  ctrc                     text NOT NULL,
  codigo_ocorrencia        smallint NOT NULL,
  texto                    text NOT NULL,
  base                     text,
  nf                       text,                       -- emenda 1: opcional, sem zeros à esquerda (igual a cards.nf)
  solicitado_por_id        text NOT NULL,
  solicitado_por_nome      text NOT NULL,
  solicitado_por_email     text,
  criado_em_origem         timestamptz,
  recebido_em              timestamptz NOT NULL DEFAULT now(),
  hash_pedido              text NOT NULL,
  status                   text NOT NULL DEFAULT 'recebido',
  etapa                    text NOT NULL DEFAULT 'vincular_card',
  card_id                  uuid,                       -- SEM FK de propósito (nota de risco a)
  card_criado_pelo_pedido  boolean NOT NULL DEFAULT false,
  card_event_id            uuid,
  reservado_em             timestamptz,
  ocorrencia_lancada       smallint,
  acao_ssw_id              uuid,                       -- acoes_executadas_ssw.id do envelope
  categoria_erro           text,
  detalhe                  text,
  executado_em             timestamptz,
  finalizado_em            timestamptz,
  atualizado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pop_tipo CHECK (tipo IN ('devolver_ao_relacionamento', 'lancar_ocorrencia')),
  CONSTRAINT pop_ctrc_normalizado CHECK (ctrc = upper(btrim(ctrc)) AND ctrc ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  CONSTRAINT pop_codigo_faixa CHECK (codigo_ocorrencia BETWEEN 1 AND 999),
  CONSTRAINT pop_devolver_e_49 CHECK (tipo <> 'devolver_ao_relacionamento' OR codigo_ocorrencia = 49),
  CONSTRAINT pop_lancar_nao_e_tratativa CHECK (tipo <> 'lancar_ocorrencia' OR codigo_ocorrencia NOT IN (49, 54, 59)),
  CONSTRAINT pop_texto CHECK (char_length(btrim(texto)) BETWEEN 3 AND 400),
  CONSTRAINT pop_nf_normalizada CHECK (nf IS NULL OR nf ~ '^[1-9][0-9]{0,11}$'),
  -- Origem humana: sem id e nome de quem clicou, o pedido não existe (ADR 0039 D2).
  CONSTRAINT pop_solicitante CHECK (btrim(solicitado_por_id) <> '' AND char_length(btrim(solicitado_por_nome)) >= 2),
  CONSTRAINT pop_status CHECK (status IN ('recebido', 'executado', 'recusado', 'erro')),
  CONSTRAINT pop_etapa CHECK (etapa IN ('vincular_card', 'vinculado', 'fila_ssw', 'lancando_ssw', 'fim')),
  CONSTRAINT pop_status_etapa CHECK ((status = 'recebido') = (etapa <> 'fim')),
  CONSTRAINT pop_lancada_so_executado CHECK (ocorrencia_lancada IS NULL OR status = 'executado')
);
COMMENT ON TABLE public.ponte_operacao_pedidos IS
  'ADR 0039: pedidos da operação vindos do Painel do Roteirizador. PK pedido_id = idempotência. '
  'Status do contrato (recebido/executado/recusado/erro) + etapa interna do worker.';

-- Worker: fila de trabalho (parcial = só o que não terminou).
CREATE INDEX IF NOT EXISTS idx_pop_trabalho
  ON public.ponte_operacao_pedidos (etapa, recebido_em) WHERE status = 'recebido';
-- Vazão: contagem da janela de 60 s.
CREATE INDEX IF NOT EXISTS idx_pop_reservado
  ON public.ponte_operacao_pedidos (reservado_em) WHERE reservado_em IS NOT NULL;
-- Duplicidade e consulta por nota.
CREATE INDEX IF NOT EXISTS idx_pop_ctrc
  ON public.ponte_operacao_pedidos (ctrc, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_pop_card
  ON public.ponte_operacao_pedidos (card_id) WHERE card_id IS NOT NULL;
-- Quarentena de login.
CREATE INDEX IF NOT EXISTS idx_pop_quarentena
  ON public.ponte_operacao_pedidos (finalizado_em) WHERE categoria_erro = 'sessao_invalida';

ALTER TABLE public.ponte_operacao_pedidos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ponte_operacao_pedidos FROM anon, authenticated;

-- 4. Vincula o pedido ao card: evento + projeção + vínculo, na mesma transação ------
-- Idempotente: pedido já vinculado devolve o card_event_id de antes.
-- Evento: DevolvidoPelaOperacao (devolver) ou OcorrenciaSolicitadaPelaOperacao
-- (lancar); CardCriadoPorPedidoOperacao antes, quando o card nasceu do pedido.
-- Projeção: só marca a memória do card para recomputar (estado_tratativa_dirty_at),
-- e só em card ATIVO. NUNCA muda state (o card que nasce do pedido já nasce no state
-- certo — ADR 0039 D2).
CREATE OR REPLACE FUNCTION public.ponte_operacao_vincular_card(
  p_pedido_id uuid,
  p_card_id uuid,
  p_card_criado boolean DEFAULT false,
  p_payload_criacao jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_p public.ponte_operacao_pedidos%ROWTYPE;
  v_card_ctrc text;
  v_card_state text;
  v_payload jsonb;
  v_evento uuid;
BEGIN
  SELECT * INTO v_p FROM public.ponte_operacao_pedidos WHERE pedido_id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido % não existe', p_pedido_id;
  END IF;
  IF v_p.card_event_id IS NOT NULL THEN
    RETURN v_p.card_event_id;
  END IF;
  IF v_p.status <> 'recebido' OR v_p.etapa <> 'vincular_card' THEN
    RAISE EXCEPTION 'pedido % não está aguardando vínculo (status %, etapa %)', p_pedido_id, v_p.status, v_p.etapa;
  END IF;

  SELECT c.ctrc, c.state INTO v_card_ctrc, v_card_state FROM public.cards c WHERE c.id = p_card_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'card % não existe', p_card_id;
  END IF;
  -- Regra de ouro: o CTRC é o do card, e o pedido só entra no card do MESMO CTRC.
  IF upper(btrim(coalesce(v_card_ctrc, ''))) <> v_p.ctrc THEN
    RAISE EXCEPTION 'CTRC do card (%) diverge do pedido (%)', v_card_ctrc, v_p.ctrc;
  END IF;
  IF v_p.tipo = 'devolver_ao_relacionamento' AND v_card_state IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO') THEN
    RAISE EXCEPTION 'devolver exige card ativo (card % está %)', p_card_id, v_card_state;
  END IF;

  v_payload := jsonb_build_object(
    'origem', 'ponte_operacao',
    'pedido_id', v_p.pedido_id,
    'tipo', v_p.tipo,
    'ctrc', v_p.ctrc,
    'codigo_ocorrencia', v_p.codigo_ocorrencia,
    'texto', v_p.texto,
    'base', v_p.base,
    'nf_pedido', v_p.nf,
    'solicitado_por', jsonb_build_object(
      'id', v_p.solicitado_por_id, 'nome', v_p.solicitado_por_nome, 'email', v_p.solicitado_por_email),
    'criado_em_origem', v_p.criado_em_origem,
    'recebido_em', v_p.recebido_em);

  IF p_card_criado THEN
    INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
    VALUES (p_card_id, 'CardCriadoPorPedidoOperacao',
            v_payload || coalesce(p_payload_criacao, '{}'::jsonb), 'system', 'ponte-pedido-operacao');
  END IF;

  INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
  VALUES (p_card_id,
          CASE v_p.tipo WHEN 'devolver_ao_relacionamento' THEN 'DevolvidoPelaOperacao'
                        ELSE 'OcorrenciaSolicitadaPelaOperacao' END,
          v_payload, 'system', 'ponte-pedido-operacao')
  RETURNING id INTO v_evento;

  -- Projeção do evento: a memória do card recomputa no próximo tick do worker dela.
  -- EXECUTE dinâmico + checagem da coluna: se a mig 404 não estiver aplicada, a
  -- projeção é pulada em vez de derrubar a RPC.
  IF v_card_state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO') AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cards' AND column_name = 'estado_tratativa_dirty_at'
  ) THEN
    EXECUTE 'UPDATE public.cards SET estado_tratativa_dirty_at = now() WHERE id = $1' USING p_card_id;
  END IF;

  UPDATE public.ponte_operacao_pedidos
     SET card_id = p_card_id,
         card_criado_pelo_pedido = coalesce(p_card_criado, false),
         card_event_id = v_evento,
         etapa = 'vinculado',
         atualizado_em = now()
   WHERE pedido_id = p_pedido_id;
  RETURN v_evento;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_operacao_vincular_card(uuid, uuid, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_operacao_vincular_card(uuid, uuid, boolean, jsonb) TO service_role;

-- 5. Finaliza o pedido (status + evento no card, atômico) ---------------------------
-- Só finaliza pedido ainda 'recebido' (status final nunca é sobrescrito). Devolve
-- false quando não havia o que finalizar.
CREATE OR REPLACE FUNCTION public.ponte_operacao_finalizar(
  p_pedido_id uuid,
  p_status text,
  p_detalhe text,
  p_ocorrencia_lancada smallint DEFAULT NULL,
  p_acao_ssw_id uuid DEFAULT NULL,
  p_categoria text DEFAULT NULL,
  p_evento_tipo text DEFAULT NULL,
  p_evento_payload jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_card uuid;
  v_sp_id text;
  v_sp_nome text;
  v_sp_email text;
BEGIN
  IF p_status NOT IN ('executado', 'recusado', 'erro') THEN
    RAISE EXCEPTION 'status final inválido: %', p_status;
  END IF;
  IF p_evento_tipo IS NOT NULL
     AND p_evento_tipo NOT IN ('PedidoOperacaoLancadoNoSsw', 'PedidoOperacaoNaoExecutado') THEN
    RAISE EXCEPTION 'evento não permitido pela ponte da operação: %', p_evento_tipo;
  END IF;

  UPDATE public.ponte_operacao_pedidos
     SET status = p_status,
         etapa = 'fim',
         detalhe = left(p_detalhe, 1000),
         ocorrencia_lancada = CASE WHEN p_status = 'executado' THEN p_ocorrencia_lancada END,
         acao_ssw_id = p_acao_ssw_id,
         categoria_erro = p_categoria,
         executado_em = CASE WHEN p_status = 'executado' THEN now() END,
         finalizado_em = now(),
         atualizado_em = now()
   WHERE pedido_id = p_pedido_id AND status = 'recebido'
  RETURNING card_id, solicitado_por_id, solicitado_por_nome, solicitado_por_email
       INTO v_card, v_sp_id, v_sp_nome, v_sp_email;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Quem pediu vai em TODO evento, venha o payload do chamador como vier (ADR 0039 D8).
  IF p_evento_tipo IS NOT NULL AND v_card IS NOT NULL THEN
    INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
    VALUES (v_card, p_evento_tipo,
            coalesce(p_evento_payload, '{}'::jsonb) || jsonb_build_object(
              'origem', 'ponte_operacao',
              'pedido_id', p_pedido_id,
              'status', p_status,
              'solicitado_por', jsonb_build_object('id', v_sp_id, 'nome', v_sp_nome, 'email', v_sp_email)),
            'system', 'processar-pedidos-operacao');
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_operacao_finalizar(uuid, text, text, smallint, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_operacao_finalizar(uuid, text, text, smallint, uuid, text, text, jsonb) TO service_role;

-- 6. VAZÃO do SSW: reserva no máximo N pedidos por janela de 60 s ---------------------
-- Mesma conta de vagasDeLancamento() (_shared/ponte-operacao-worker.ts):
--   vagas = min(p_limite, 3) − reservados nos últimos 60 s; quarentena → 0.
-- O advisory lock serializa as reservas: duas execuções do worker ao mesmo tempo
-- (cron + chamada manual) nunca enxergam a mesma vaga. A contagem é GLOBAL: chamar
-- o worker 100 vezes num minuto não passa de 3 lançamentos (INV-159).
CREATE OR REPLACE FUNCTION public.ponte_operacao_reservar_lancamentos(
  p_limite_por_minuto integer DEFAULT 2,
  p_ttl_horas integer DEFAULT 4,
  p_quarentena_min integer DEFAULT 30
) RETURNS SETOF public.ponte_operacao_pedidos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limite integer := least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3);  -- teto duro: 3/min
  v_agora timestamptz := clock_timestamp();
  v_reservados integer;
  v_vagas integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ponte_operacao_ssw_vazao'));
  v_agora := clock_timestamp();  -- relido DEPOIS do lock: quem esperou enxerga a reserva de quem passou

  -- Quarentena: um login recusado recente para a ponte inteira (INV-159 d: esperar).
  IF EXISTS (
    SELECT 1 FROM public.ponte_operacao_pedidos
     WHERE categoria_erro = 'sessao_invalida'
       AND finalizado_em > v_agora - make_interval(mins => greatest(coalesce(p_quarentena_min, 30), 1))
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_reservados
    FROM public.ponte_operacao_pedidos
   WHERE reservado_em > v_agora - interval '60 seconds';
  v_vagas := v_limite - v_reservados;
  IF v_vagas <= 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.ponte_operacao_pedidos t
     SET etapa = 'lancando_ssw', reservado_em = v_agora, atualizado_em = v_agora
   WHERE t.pedido_id IN (
     SELECT q.pedido_id FROM public.ponte_operacao_pedidos q
      WHERE q.status = 'recebido'
        AND q.etapa = 'fila_ssw'
        AND q.recebido_em > v_agora - make_interval(hours => greatest(coalesce(p_ttl_horas, 4), 1))
      ORDER BY q.recebido_em
      LIMIT v_vagas
      FOR UPDATE SKIP LOCKED)
  RETURNING t.*;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_operacao_reservar_lancamentos(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_operacao_reservar_lancamentos(integer, integer, integer) TO service_role;

-- 7. Prazos: TTL e lançamento interrompido → erro (com evento no card) ---------------
-- Lançamento interrompido NUNCA é relançado às cegas: vira erro e alguém confere no
-- SSW (acoes_executadas_ssw do card) — duplicar ocorrência é pior que atrasar.
CREATE OR REPLACE FUNCTION public.ponte_operacao_expirar(
  p_ttl_horas integer DEFAULT 4,
  p_travado_min integer DEFAULT 15
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  WITH exp AS (
    UPDATE public.ponte_operacao_pedidos
       SET status = 'erro',
           etapa = 'fim',
           categoria_erro = CASE WHEN etapa = 'lancando_ssw' THEN 'lancamento_interrompido' ELSE 'expirado' END,
           detalhe = CASE WHEN etapa = 'lancando_ssw'
             THEN 'lançamento interrompido no meio: conferir no SSW antes de pedir de novo'
             ELSE 'expirou sem execução em ' || greatest(coalesce(p_ttl_horas, 4), 1) || ' h; se ainda vale, peça de novo' END,
           finalizado_em = now(),
           atualizado_em = now()
     WHERE status = 'recebido'
       AND (
         (etapa = 'lancando_ssw' AND reservado_em < now() - make_interval(mins => greatest(coalesce(p_travado_min, 15), 5)))
         OR (etapa <> 'lancando_ssw' AND recebido_em < now() - make_interval(hours => greatest(coalesce(p_ttl_horas, 4), 1)))
       )
    RETURNING pedido_id, card_id, tipo, ctrc, codigo_ocorrencia, base, categoria_erro, detalhe,
              solicitado_por_id, solicitado_por_nome, solicitado_por_email
  ), ev AS (
    INSERT INTO public.card_events (card_id, event_type, payload, actor_type, actor_id)
    SELECT e.card_id, 'PedidoOperacaoNaoExecutado',
           jsonb_build_object(
             'origem', 'ponte_operacao', 'pedido_id', e.pedido_id, 'tipo', e.tipo, 'ctrc', e.ctrc,
             'codigo_ocorrencia', e.codigo_ocorrencia, 'base', e.base, 'status', 'erro',
             'codigo', e.categoria_erro, 'motivo', e.detalhe,
             'solicitado_por', jsonb_build_object('id', e.solicitado_por_id, 'nome', e.solicitado_por_nome, 'email', e.solicitado_por_email)),
           'system', 'processar-pedidos-operacao'
      FROM exp e
     WHERE e.card_id IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM exp;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.ponte_operacao_expirar(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ponte_operacao_expirar(integer, integer) TO service_role;

-- 8. Smoke test (só no NASCIMENTO — reaplicar depois de ligar não derruba) ---------
DO $$
DECLARE
  v_ligadas integer;
  v_codigos_ativos integer;
BEGIN
  IF current_setting('cockpit.mig415_nascimento', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'mig 415 reaplicada: smoke de nascimento pulado.';
    RETURN;
  END IF;
  SELECT count(*) INTO v_ligadas FROM public.feature_flags
   WHERE key IN ('ponte_operacao_leitura', 'ponte_operacao_pedidos', 'ponte_operacao_lancar_ssw')
     AND enabled IS TRUE;
  IF v_ligadas > 0 THEN
    RAISE EXCEPTION 'mig 415: % flag(s) da ponte da operação nasceram LIGADAS', v_ligadas;
  END IF;
  SELECT count(*) INTO v_codigos_ativos FROM public.ponte_operacao_codigos_permitidos WHERE ativo;
  IF v_codigos_ativos > 0 THEN
    RAISE EXCEPTION 'mig 415: a lista de códigos da operação nasceu com % código(s) ativo(s)', v_codigos_ativos;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-pedidos-operacao') THEN
    RAISE NOTICE 'ATENCAO: cron processar-pedidos-operacao já existe (mig 416 aplicada antes?).';
  END IF;
  RAISE NOTICE 'OK mig 415: flags OFF, lista vazia, nenhum cron novo — tudo inerte.';
END $$;
