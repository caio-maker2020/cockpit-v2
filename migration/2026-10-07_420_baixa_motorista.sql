-- =============================================================================
-- 2026-10-07_420 — Baixa do motorista: o Roteirizador manda a baixa (entrega ou
--                  insucesso) e o Cockpit grava no SSW pela conta ai.salex
--                  (ADR 0040, "Ponte v3: baixa do motorista").
-- =============================================================================
-- TUDO NASCE INERTE:
--   - 2 flags OFF: baixa_motorista_receber (endpoint + worker),
--     baixa_motorista_lancar_ssw (o worker leva baixas ao SSW; freio relido
--     antes de cada lançamento);
--   - canal SEM default ativo: baixa_motorista_config.canal = NULL
--     ('webapi' | 'portal101' só por migration TIPO B, com dono);
--   - lista fechada de códigos de INSUCESSO: VAZIA (a 01 da entrega é
--     implícita e NÃO mora nesta lista);
--   - lista de PILOTO (base e/ou motorista): VAZIA;
--   - SEM cron nesta migration (o cron do worker é a mig 421, aplicada só na
--     hora de ligar);
--   - sem PONTE_OPERACAO_TOKEN o endpoint responde 503 (dupla trava).
-- Aplicar este arquivo não muda NADA do que roda hoje.
--
-- O que cria:
--   1. feature_flags (2, OFF).
--   2. baixa_motorista_config — 1 linha, canal NULL.
--   3. baixa_motorista_codigos — lista fechada de insucesso (vazia); trigger
--      recusa código que não seja da Operação no ocorrencias_dicionario.
--   4. baixa_motorista_piloto — quem pode ter a baixa lançada (vazia).
--   5. baixas_motorista — 1 linha por baixa; PK baixa_id = idempotência.
--   6. RPC baixa_motorista_reservar — a VAZÃO: advisory lock, teto 3/min,
--      janela global de 60 s, quarentena de login, insucesso antes de entrega.
--   7. RPC baixa_motorista_expirar — prazo (fim do dia seguinte) e lançamento
--      interrompido → erro.
--   8. smoke test (só no nascimento).
--
-- ─── NOTAS DE RISCO (para quem for aplicar) ──────────────────────────────────
-- (a) TABELAS QUENTES: nenhum ALTER, nenhuma FK, nenhum lock em cards,
--     card_events ou audit_log. A baixa NÃO tem card (exceção do ADR 0040):
--     nada aqui referencia cards. O worker só LÊ cards (state por CTRC) e grava
--     audit_log com card_id NULL e external_system='ssw' (CHECK de hoje aceita).
-- (b) SEM VALIDATE, sem backfill, sem UPDATE/DELETE de dado existente.
-- (c) SECURITY DEFINER com search_path='' e EXECUTE só para service_role.
--     RLS ligada SEM policy nas 4 tabelas: só service_role (que ignora RLS).
-- (d) CLASSIFICAÇÃO: conteúdo TIPO A (só acrescenta); o classificador do
--     scripts/dbq.py acusa DROP TRIGGER IF EXISTS (objetos DESTE arquivo) e
--     CREATE OR REPLACE de funções NOVAS. Em dúvida, TIPO B (--autorizado-por).
-- (e) DEPENDÊNCIAS: public.set_updated_at() (mig 001/011),
--     public.ocorrencias_dicionario (mig 008/204), public.feature_flags (001).
--     NÃO depende das migs 414/415/416 (ponte v1/v2).
-- (f) REVERSÃO (pelo trilho, TIPO B):
--       DROP FUNCTION IF EXISTS public.baixa_motorista_expirar(integer);
--       DROP FUNCTION IF EXISTS public.baixa_motorista_reservar(integer, integer);
--       DROP TABLE IF EXISTS public.baixas_motorista;
--       DROP TABLE IF EXISTS public.baixa_motorista_piloto;
--       DROP TABLE IF EXISTS public.baixa_motorista_codigos;   -- leva o trigger
--       DROP FUNCTION IF EXISTS public.baixa_motorista_codigo_e_operacao();
--       DROP TABLE IF EXISTS public.baixa_motorista_config;
--       DELETE FROM public.feature_flags WHERE key LIKE 'baixa_motorista_%';
--     Ocorrências já lançadas no SSW não se desfazem; o audit_log fica.
-- (g) ORDEM DE ATIVAÇÃO: ADR 0040, "Como ligar". Esta migration é o passo 1;
--     a 421 (cron) vem depois do deploy das 2 funções.
--
-- ⚠ NÃO APLICADA (nem dry-run) — arquivo entregue ao time do Cockpit.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08).
--
-- AUTORIZACAO (TIPO B): preencher no --autorizado-por ao aplicar
--   "<quem>, <quando>: <ordem/motivo>".
-- =============================================================================

-- 0. Esta execução está CRIANDO as tabelas? (smoke do bloco 8 só no nascimento)
DO $$
BEGIN
  PERFORM set_config(
    'cockpit.mig420_nascimento',
    CASE WHEN to_regclass('public.baixas_motorista') IS NULL THEN 'true' ELSE 'false' END,
    false);
END $$;

-- 1. Flags — todas OFF -------------------------------------------------------------
INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('baixa_motorista_receber', false,
   'ADR 0040: POST/GET ponte-baixa-entrega recebe a baixa do motorista (entrega/insucesso) e o worker '
   'processar-baixas-motorista roda. Sem SSW sozinha. OFF = 503 e worker skipped.'),
  ('baixa_motorista_lancar_ssw', false,
   'ADR 0040: o worker leva as baixas ao SSW (conta ai.salex, canal de baixa_motorista_config), '
   'até 2/min (teto 3), quarentena de 30 min após login recusado (INV-159). Freio relido antes de '
   'cada lançamento. OFF = as baixas ESPERAM na fila (e expiram no fim do dia seguinte).')
ON CONFLICT (key) DO NOTHING;

-- 2. Config: o canal do SSW (sem default ativo) ------------------------------------
CREATE TABLE IF NOT EXISTS public.baixa_motorista_config (
  id              boolean PRIMARY KEY DEFAULT true,
  -- NULL = nenhum canal: nada vai ao SSW mesmo com a flag ON.
  canal           text,
  autorizado_por  text,
  autorizado_em   date,
  observacao      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bmc_singleton CHECK (id),
  CONSTRAINT bmc_canal CHECK (canal IS NULL OR canal IN ('webapi', 'portal101')),
  CONSTRAINT bmc_canal_exige_dono CHECK (canal IS NULL OR (autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);
COMMENT ON TABLE public.baixa_motorista_config IS
  'ADR 0040: canal da baixa do motorista no SSW. webapi = ocorrenciaParceiro (1 imagem, dataHoraEvento); '
  'portal101 = lancarOcorrenciaPortal (opção 101). NULL = desligado. Mudar = migration TIPO B com dono.';
INSERT INTO public.baixa_motorista_config (id, canal) VALUES (true, NULL) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS bmc_set_updated_at ON public.baixa_motorista_config;
CREATE TRIGGER bmc_set_updated_at
  BEFORE UPDATE ON public.baixa_motorista_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.baixa_motorista_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.baixa_motorista_config FROM anon, authenticated;

-- 3. Lista fechada de códigos de INSUCESSO (VAZIA) ---------------------------------
CREATE TABLE IF NOT EXISTS public.baixa_motorista_codigos (
  codigo          smallint PRIMARY KEY,
  criterio        text NOT NULL,
  ativo           boolean NOT NULL DEFAULT false,
  pedido_por      text,
  autorizado_por  text,
  autorizado_em   date,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bmcod_faixa CHECK (codigo BETWEEN 1 AND 999),
  -- 01 é a entrega (implícita, nunca da lista); 49 é devolver ao Relacionamento
  -- (ponte v2); 54/59 são do cliente. Nunca aqui.
  CONSTRAINT bmcod_nunca CHECK (codigo NOT IN (1, 49, 54, 59)),
  CONSTRAINT bmcod_criterio_escrito CHECK (char_length(btrim(criterio)) >= 10),
  CONSTRAINT bmcod_ativo_exige_dono
    CHECK (NOT ativo OR (pedido_por IS NOT NULL AND autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);
COMMENT ON TABLE public.baixa_motorista_codigos IS
  'ADR 0040: ocorrências de INSUCESSO que o motorista pode baixar pelo app. VAZIA por padrão. '
  'Só responsabilidade Operação (trigger): oc de Relacionamento lançada por ai.salex seria lida pelo '
  'decidirVisibilidadePorSsw como ação do próprio Cockpit e a tratativa ficaria invisível.';

CREATE OR REPLACE FUNCTION public.baixa_motorista_codigo_e_operacao()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ocorrencias_dicionario d
     WHERE d.codigo = NEW.codigo AND d.responsabilidade = 'Operação'
  ) THEN
    RAISE EXCEPTION 'oc % não é de responsabilidade da Operação no ocorrencias_dicionario: a baixa do motorista só lança insucesso da Operação (ADR 0040)', NEW.codigo;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bmcod_operacao ON public.baixa_motorista_codigos;
CREATE TRIGGER bmcod_operacao
  BEFORE INSERT OR UPDATE ON public.baixa_motorista_codigos
  FOR EACH ROW EXECUTE FUNCTION public.baixa_motorista_codigo_e_operacao();

DROP TRIGGER IF EXISTS bmcod_set_updated_at ON public.baixa_motorista_codigos;
CREATE TRIGGER bmcod_set_updated_at
  BEFORE UPDATE ON public.baixa_motorista_codigos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.baixa_motorista_codigos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.baixa_motorista_codigos FROM anon, authenticated;

-- 4. Piloto: base e/ou motorista (VAZIO) --------------------------------------------
-- Uma linha casa quando: (base IS NULL OR base = baixa.base) AND
-- (motorista_id IS NULL OR motorista_id = baixa.motorista_id). Só base = a base
-- inteira; só motorista = aquele motorista; os dois = o motorista naquela base.
CREATE TABLE IF NOT EXISTS public.baixa_motorista_piloto (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base            text,
  motorista_id    text,
  ativo           boolean NOT NULL DEFAULT false,
  pedido_por      text,
  autorizado_por  text,
  autorizado_em   date,
  observacao      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bmp_alvo CHECK (base IS NOT NULL OR motorista_id IS NOT NULL),
  CONSTRAINT bmp_base_formato CHECK (base IS NULL OR base ~ '^[A-Z0-9]{2,10}$'),
  CONSTRAINT bmp_ativo_exige_dono
    CHECK (NOT ativo OR (pedido_por IS NOT NULL AND autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bmp_alvo
  ON public.baixa_motorista_piloto (coalesce(base, ''), coalesce(motorista_id, ''));

DROP TRIGGER IF EXISTS bmp_set_updated_at ON public.baixa_motorista_piloto;
CREATE TRIGGER bmp_set_updated_at
  BEFORE UPDATE ON public.baixa_motorista_piloto
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.baixa_motorista_piloto ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.baixa_motorista_piloto FROM anon, authenticated;

-- 5. Baixas --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.baixas_motorista (
  baixa_id              uuid PRIMARY KEY,               -- idempotência: o mesmo id nunca executa 2x
  seq                   bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- ordem de chegada (desempate da fila)
  tipo                  text NOT NULL,
  codigo_ocorrencia     smallint NOT NULL,
  ctrc                  text NOT NULL,                  -- da BAIXA (sem card) — o tripé confere no SSW
  nf                    text NOT NULL,
  ocorrido_em           timestamptz NOT NULL,           -- hora REAL do evento (vai ao SSW)
  recebido_em_origem    timestamptz NOT NULL,
  recebedor_nome        text,
  recebedor_documento   text,
  geo_lat               double precision,
  geo_lng               double precision,
  geo_precisao_m        double precision,
  evidencia_id          text,
  evidencia_sha256      text,
  evidencia_mime        text,
  motorista_id          text NOT NULL,
  motorista_nome        text NOT NULL,
  rota_sugestao_id      text NOT NULL,
  rota_id               text NOT NULL,
  rota_veiculo_indice   integer NOT NULL,
  rota_placa            text,
  base                  text NOT NULL,
  hash_baixa            text NOT NULL,
  recebido_em           timestamptz NOT NULL DEFAULT now(),
  prazo_em              timestamptz NOT NULL,           -- fim do dia seguinte ao ocorrido (São Paulo)
  status                text NOT NULL DEFAULT 'recebido',
  status_em             timestamptz NOT NULL DEFAULT now(),
  tentativas            smallint NOT NULL DEFAULT 0,    -- falhas ANTES do submit (nada gravado)
  reservado_em          timestamptz,
  ultima_categoria      text,                           -- 'sessao_invalida' liga a quarentena
  ultima_falha_em       timestamptz,
  categoria             text,                           -- categoria do status final
  motivo                text,
  protocolo             text,
  canal                 text,
  finalizado_em         timestamptz,
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bm_tipo CHECK (tipo IN ('entrega', 'insucesso')),
  CONSTRAINT bm_entrega_e_01 CHECK ((tipo = 'entrega') = (codigo_ocorrencia = 1)),
  CONSTRAINT bm_insucesso_nunca CHECK (tipo <> 'insucesso' OR codigo_ocorrencia NOT IN (1, 49, 54, 59)),
  CONSTRAINT bm_codigo_faixa CHECK (codigo_ocorrencia BETWEEN 1 AND 999),
  CONSTRAINT bm_ctrc_normalizado CHECK (ctrc = upper(btrim(ctrc)) AND ctrc ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  CONSTRAINT bm_nf_normalizada CHECK (nf ~ '^[1-9][0-9]{0,11}$'),
  CONSTRAINT bm_ocorrido_nao_futuro CHECK (ocorrido_em <= recebido_em + interval '5 minutes'),
  CONSTRAINT bm_evidencia_inteira CHECK (
    (evidencia_id IS NULL AND evidencia_sha256 IS NULL AND evidencia_mime IS NULL)
    OR (evidencia_id IS NOT NULL AND evidencia_sha256 ~ '^[0-9a-f]{64}$'
        AND evidencia_mime IN ('image/jpeg', 'application/pdf'))),
  CONSTRAINT bm_geo CHECK (
    (geo_lat IS NULL AND geo_lng IS NULL AND geo_precisao_m IS NULL)
    OR (geo_lat BETWEEN -90 AND 90 AND geo_lng BETWEEN -180 AND 180 AND geo_precisao_m >= 0)),
  CONSTRAINT bm_motorista CHECK (btrim(motorista_id) <> '' AND char_length(btrim(motorista_nome)) >= 2),
  CONSTRAINT bm_base CHECK (base ~ '^[A-Z0-9]{2,10}$'),
  CONSTRAINT bm_status CHECK (status IN ('recebido', 'na_fila', 'lancando', 'executado', 'ja_no_ssw', 'recusado', 'erro')),
  CONSTRAINT bm_final_tem_fim CHECK ((status IN ('executado', 'ja_no_ssw', 'recusado', 'erro')) = (finalizado_em IS NOT NULL)),
  CONSTRAINT bm_lancando_reservado CHECK (status <> 'lancando' OR reservado_em IS NOT NULL),
  CONSTRAINT bm_canal CHECK (canal IS NULL OR canal IN ('webapi', 'portal101'))
);
COMMENT ON TABLE public.baixas_motorista IS
  'ADR 0040: baixa do motorista vinda do app do Roteirizador. PK baixa_id = idempotência. SEM card: '
  'CTRC/NF da baixa, conferidos pelo tripé no SSW antes do submit. Status do contrato: recebido, '
  'na_fila (lancando sai como na_fila), executado, ja_no_ssw, recusado, erro.';

-- Fila do worker (parcial = só o que não terminou).
CREATE INDEX IF NOT EXISTS idx_bm_fila
  ON public.baixas_motorista (status, ocorrido_em) WHERE status IN ('recebido', 'na_fila', 'lancando');
-- Vazão: contagem da janela de 60 s.
CREATE INDEX IF NOT EXISTS idx_bm_reservado
  ON public.baixas_motorista (reservado_em) WHERE reservado_em IS NOT NULL;
-- Duplicidade por CTRC e consulta por nota.
CREATE INDEX IF NOT EXISTS idx_bm_ctrc
  ON public.baixas_motorista (ctrc, recebido_em DESC);
-- Quarentena de login.
CREATE INDEX IF NOT EXISTS idx_bm_quarentena
  ON public.baixas_motorista (ultima_falha_em) WHERE ultima_categoria = 'sessao_invalida';

ALTER TABLE public.baixas_motorista ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.baixas_motorista FROM anon, authenticated;

-- 6. VAZÃO do SSW: reserva no máximo N baixas por janela de 60 s ----------------------
-- Mesma conta de vagasDeLancamento() (_shared/ponte-operacao-worker.ts, importada
-- pelo baixa-motorista-worker.ts): vagas = min(p_limite, 3) − reservadas nos
-- últimos 60 s; quarentena → 0. Advisory lock próprio: duas execuções do worker ao
-- mesmo tempo nunca enxergam a mesma vaga, e a contagem é GLOBAL (INV-159).
-- Ordem: INSUCESSO antes de ENTREGA (o insucesso precisa entrar antes de a 01
-- encerrar o CTRC), depois a hora real do evento.
CREATE OR REPLACE FUNCTION public.baixa_motorista_reservar(
  p_limite_por_minuto integer DEFAULT 2,
  p_quarentena_min integer DEFAULT 30
) RETURNS SETOF public.baixas_motorista
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limite integer := least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3);  -- teto duro: 3/min
  v_agora timestamptz;
  v_reservados integer;
  v_vagas integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('baixa_motorista_ssw_vazao'));
  v_agora := clock_timestamp();  -- lido DEPOIS do lock

  -- Quarentena: um login recusado recente para a baixa inteira (INV-159 d: esperar).
  IF EXISTS (
    SELECT 1 FROM public.baixas_motorista
     WHERE ultima_categoria = 'sessao_invalida'
       AND ultima_falha_em > v_agora - make_interval(mins => greatest(coalesce(p_quarentena_min, 30), 1))
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_reservados
    FROM public.baixas_motorista
   WHERE reservado_em > v_agora - interval '60 seconds';
  v_vagas := v_limite - v_reservados;
  IF v_vagas <= 0 THEN
    RETURN;
  END IF;

  -- UPDATE … RETURNING não garante ordem: o CTE devolve as reservadas JÁ na ordem
  -- em que o worker lança (insucesso primeiro).
  RETURN QUERY
  WITH r AS (
    UPDATE public.baixas_motorista t
       SET status = 'lancando', reservado_em = v_agora, status_em = v_agora, atualizado_em = v_agora
     WHERE t.baixa_id IN (
       SELECT q.baixa_id FROM public.baixas_motorista q
        WHERE q.status = 'na_fila'
          AND q.prazo_em > v_agora
        ORDER BY (q.tipo = 'insucesso') DESC, q.ocorrido_em, q.seq
        LIMIT v_vagas
        FOR UPDATE SKIP LOCKED)
    RETURNING t.*)
  SELECT * FROM r ORDER BY (r.tipo = 'insucesso') DESC, r.ocorrido_em, r.seq;
END;
$$;
REVOKE ALL ON FUNCTION public.baixa_motorista_reservar(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baixa_motorista_reservar(integer, integer) TO service_role;

-- 7. Prazos: TTL e lançamento interrompido → erro ------------------------------------
-- Lançamento interrompido NUNCA é relançado às cegas: vira erro e alguém confere no
-- SSW — duplicar a 01 (ou uma oc de insucesso) é pior que atrasar.
CREATE OR REPLACE FUNCTION public.baixa_motorista_expirar(
  p_travado_min integer DEFAULT 15
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.baixas_motorista
     SET status = 'erro',
         categoria = CASE WHEN status = 'lancando' THEN 'lancamento_interrompido' ELSE 'expirado' END,
         motivo = CASE WHEN status = 'lancando'
           THEN 'lançamento interrompido no meio: conferir no SSW antes de lançar de novo'
           ELSE 'passou do fim do dia seguinte ao ocorrido sem ir ao SSW: lançar à mão' END,
         finalizado_em = now(),
         status_em = now(),
         atualizado_em = now()
   WHERE (status = 'lancando' AND reservado_em < now() - make_interval(mins => greatest(coalesce(p_travado_min, 15), 5)))
      OR (status IN ('recebido', 'na_fila') AND prazo_em < now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.baixa_motorista_expirar(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.baixa_motorista_expirar(integer) TO service_role;

-- 8. Smoke test (só no NASCIMENTO — reaplicar depois de ligar não derruba) ---------
DO $$
DECLARE
  v_ligadas integer;
  v_codigos integer;
  v_piloto integer;
  v_canal text;
BEGIN
  IF current_setting('cockpit.mig420_nascimento', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'mig 420 reaplicada: smoke de nascimento pulado.';
    RETURN;
  END IF;
  SELECT count(*) INTO v_ligadas FROM public.feature_flags
   WHERE key IN ('baixa_motorista_receber', 'baixa_motorista_lancar_ssw') AND enabled IS TRUE;
  IF v_ligadas > 0 THEN
    RAISE EXCEPTION 'mig 420: % flag(s) da baixa do motorista nasceram LIGADAS', v_ligadas;
  END IF;
  SELECT count(*) INTO v_codigos FROM public.baixa_motorista_codigos WHERE ativo;
  SELECT count(*) INTO v_piloto FROM public.baixa_motorista_piloto WHERE ativo;
  SELECT canal INTO v_canal FROM public.baixa_motorista_config WHERE id;
  IF v_codigos > 0 OR v_piloto > 0 OR v_canal IS NOT NULL THEN
    RAISE EXCEPTION 'mig 420: nasceu ativa (codigos=%, piloto=%, canal=%)', v_codigos, v_piloto, v_canal;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-baixas-motorista') THEN
    RAISE NOTICE 'ATENCAO: cron processar-baixas-motorista já existe (mig 421 aplicada antes?).';
  END IF;
  RAISE NOTICE 'OK mig 420: flags OFF, canal NULL, listas vazias, nenhum cron novo — tudo inerte.';
END $$;
