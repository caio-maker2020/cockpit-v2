-- =============================================================================
-- 2026-08-25_353_acao_autonoma_veto_fundacoes.sql
--
-- ETAPA A do plano "Ação Autônoma com Janela de Veto" (aprovado Caio 25/08):
-- toda sugestão elegível de agente vira ação programada que executa em 60
-- minutos ÚTEIS; o operador não faz nada (certo), edita, ou cancela com
-- formulário. Esta migration entrega SÓ as fundações de schema — NADA muda
-- de comportamento: a flag master nasce OFF e cada ação da escada nasce
-- ativa=false. Deploy desta mig + edges é inerte até ordem nominal do Caio.
--
-- Componentes:
--   1. acoes_agendadas: tipo novo 'executar_acao_autonoma', status
--      'executando' (claim atômico, risco 26) e 'expirado' (TTL, risco 31),
--      claimed_at, índice único parcial (1 veto vivo por card, risco 17)
--   2. cards.acao_autonoma (espelho jsonb pro realtime do front, risco 33)
--      + trigger de espelho agendamento→card
--   3. feriados (cálculo de minutos úteis, risco 29)
--   4. feature_flags: acao_autonoma_veto_enabled OFF (risco 14)
--   5. acoes_autonomas_veto_config — a ESCADA de ativação por ação
--      (cada degrau = ordem nominal do Caio; tudo nasce ativa=false)
--   6. cancelamentos_acao_autonoma — formulário obrigatório (dado de treino)
--   7. edicoes_acao_autonoma — edição na janela (antes/depois, dado de treino)
--   8. perguntas_extras_cancelamento — banco versionado por ação
--
-- SEM begin/commit interno (regra 13/08). Idempotente (IF NOT EXISTS / DO $$).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. acoes_agendadas: tipo + status novos, claim e unicidade
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.acoes_agendadas
  DROP CONSTRAINT IF EXISTS acoes_agendadas_tipo_check;

ALTER TABLE public.acoes_agendadas
  ADD CONSTRAINT acoes_agendadas_tipo_check
  CHECK (tipo IN ('cobranca_email', 'cancelar_reentrega_ssw', 'executar_acao_autonoma'));

ALTER TABLE public.acoes_agendadas
  DROP CONSTRAINT IF EXISTS acoes_agendadas_status_check;

-- 'executando' = claim atômico do processador (pendente→executando OU aborta;
-- risco 26 — corrida cancelar×executar). 'expirado' = TTL duro estourou
-- (risco 31 — rajada atrasada pós-outage NUNCA executa).
-- 'precisa_acao'/'tratado_manualmente' preservados do CHECK vivo (migs 106/107).
ALTER TABLE public.acoes_agendadas
  ADD CONSTRAINT acoes_agendadas_status_check
  CHECK (status IN ('pendente', 'executando', 'processado', 'cancelado', 'expirado',
                    'precisa_acao', 'tratado_manualmente'));

ALTER TABLE public.acoes_agendadas
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN public.acoes_agendadas.claimed_at IS
  'Momento do claim atômico (status pendente→executando) pelo processador. '
  'Watchdog usa: executando há >15min sem processed_at = alerta. Plano veto 25/08.';

-- 1 agendamento de veto VIVO por card (risco 17). Re-análise cancela o antigo
-- (evento AcaoAutonomaSubstituida) antes de inserir o novo.
CREATE UNIQUE INDEX IF NOT EXISTS uk_acoes_agendadas_veto_vivo_por_card
  ON public.acoes_agendadas (card_id)
  WHERE tipo = 'executar_acao_autonoma' AND status IN ('pendente', 'executando');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. cards.acao_autonoma — espelho pro front (realtime já escuta cards)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS acao_autonoma jsonb;

COMMENT ON COLUMN public.cards.acao_autonoma IS
  'Espelho do agendamento de veto mais recente do card (risco 33 do plano — '
  'countdown sem realtime fantasma): {agendamento_id, acao_key, executar_em, '
  'status, hash_proposta, processed_at}. Mantido EXCLUSIVAMENTE pelo trigger '
  'trg_espelho_acao_autonoma. NULL = card sem trilho autônomo. Plano veto 25/08.';

CREATE OR REPLACE FUNCTION public.fn_espelho_acao_autonoma()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tipo <> 'executar_acao_autonoma' THEN
    RETURN NEW;
  END IF;
  UPDATE public.cards
  SET acao_autonoma = jsonb_build_object(
        'agendamento_id', NEW.id,
        'acao_key',       NEW.payload->>'acao_key',
        'executar_em',    NEW.executar_em,
        'status',         NEW.status,
        'hash_proposta',  NEW.payload->>'hash_proposta',
        'processed_at',   NEW.processed_at,
        'cancelado_motivo', NEW.cancelado_motivo
      )
  WHERE id = NEW.card_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_espelho_acao_autonoma ON public.acoes_agendadas;
CREATE TRIGGER trg_espelho_acao_autonoma
  AFTER INSERT OR UPDATE ON public.acoes_agendadas
  FOR EACH ROW EXECUTE FUNCTION public.fn_espelho_acao_autonoma();

COMMENT ON FUNCTION public.fn_espelho_acao_autonoma() IS
  'Espelha todo agendamento de veto no cards.acao_autonoma — o front escuta '
  'cards via realtime, nunca a tabela de agendamentos. Fonte única: qualquer '
  'mudança de status (claim, cancelamento, expiração, processado) reflete na '
  'hora no card. Plano veto 25/08, risco 33.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. feriados — o relógio útil não anda em feriado (risco 29)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feriados (
  data date PRIMARY KEY,
  nome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feriados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feriados_select ON public.feriados;
CREATE POLICY feriados_select ON public.feriados
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS feriados_modify_gestor ON public.feriados;
CREATE POLICY feriados_modify_gestor ON public.feriados
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

GRANT SELECT ON public.feriados TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feriados TO service_role;

COMMENT ON TABLE public.feriados IS
  'Feriados em que a Sal Express NÃO opera — o relógio de minutos úteis da '
  'janela de veto pula esses dias (adicionarMinutosUteis, _shared/minutos-uteis.ts). '
  'Carnaval/Corpus Christi incluídos por prudência (dia parado = janela só '
  'estica, nunca executa sem ninguém olhando); gestor edita se a operação '
  'funcionar nesses dias. Plano veto 25/08, risco 29.';

INSERT INTO public.feriados (data, nome) VALUES
  ('2026-01-01', 'Confraternização Universal'),
  ('2026-02-16', 'Carnaval (segunda)'),
  ('2026-02-17', 'Carnaval (terça)'),
  ('2026-04-03', 'Sexta-feira Santa'),
  ('2026-04-21', 'Tiradentes'),
  ('2026-05-01', 'Dia do Trabalho'),
  ('2026-06-04', 'Corpus Christi'),
  ('2026-09-07', 'Independência'),
  ('2026-10-12', 'Nossa Senhora Aparecida'),
  ('2026-11-02', 'Finados'),
  ('2026-11-15', 'Proclamação da República'),
  ('2026-11-20', 'Consciência Negra'),
  ('2026-12-25', 'Natal'),
  ('2027-01-01', 'Confraternização Universal'),
  ('2027-02-08', 'Carnaval (segunda)'),
  ('2027-02-09', 'Carnaval (terça)'),
  ('2027-03-26', 'Sexta-feira Santa'),
  ('2027-04-21', 'Tiradentes'),
  ('2027-05-01', 'Dia do Trabalho'),
  ('2027-05-27', 'Corpus Christi'),
  ('2027-09-07', 'Independência'),
  ('2027-10-12', 'Nossa Senhora Aparecida'),
  ('2027-11-02', 'Finados'),
  ('2027-11-15', 'Proclamação da República'),
  ('2027-11-20', 'Consciência Negra'),
  ('2027-12-25', 'Natal')
ON CONFLICT (data) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Flag master — nasce OFF (risco 14). Ligar = ordem nominal do Caio.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.feature_flags (key, description, enabled) VALUES (
  'acao_autonoma_veto_enabled',
  'Master do trilho Ação Autônoma com Janela de Veto (plano 25/08). OFF = '
  'nenhum agendamento novo é criado E o processador recusa os pendentes '
  '(kill-switch limpo, risco 10). Ligar exige ordem nominal do Caio.',
  false
)
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A ESCADA — ativação por ação, um degrau por vez (risco 14)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.acoes_autonomas_veto_config (
  acao_key     text PRIMARY KEY,          -- 'lancar_ocorrencia:21'
  ativa        boolean NOT NULL DEFAULT false,
  descricao    text,
  ativada_em   timestamptz,
  ativada_por  text,                      -- registro da ordem nominal ('Caio 2026-XX-XX')
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.acoes_autonomas_veto_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acoes_veto_config_select ON public.acoes_autonomas_veto_config;
CREATE POLICY acoes_veto_config_select ON public.acoes_autonomas_veto_config
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.acoes_autonomas_veto_config TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.acoes_autonomas_veto_config TO service_role;

COMMENT ON TABLE public.acoes_autonomas_veto_config IS
  'Escada de ativação do trilho de veto: uma linha por acao_key, TUDO nasce '
  'ativa=false. Ativar um degrau = UPDATE deliberado com ativada_por '
  'registrando a ordem nominal do Caio. Agendamento só nasce se flag master '
  'ON + acao_key ativa aqui. Plano veto 25/08.';

INSERT INTO public.acoes_autonomas_veto_config (acao_key, descricao) VALUES
  ('lancar_ocorrencia:21',        'Liberação de reentrega (inclui variante com cancelamento 24h embutido — extra permitido)'),
  ('lancar_ocorrencia:55',        'Oc 55 — texto do painel é opcional por construção'),
  ('lancar_ocorrencia:54',        'Oc 54 sem e-mail (versão deliberada)'),
  ('lancar_ocorrencia:59',        'Oc 59 sem e-mail (versão deliberada)'),
  ('lancar_oc_e_enviar_email:54', 'Oc 54 + e-mail com template e destinatário semeados'),
  ('lancar_oc_e_enviar_email:59', 'Oc 59 + e-mail com template e destinatário semeados')
ON CONFLICT (acao_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Cancelamentos — o formulário obrigatório vira dado de treino
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cancelamentos_acao_autonoma (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id          uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  agendamento_id   bigint REFERENCES public.acoes_agendadas(id) ON DELETE SET NULL,
  agent_name       text NOT NULL,
  acao_key         text NOT NULL,
  ciclo            int,                     -- ciclo do card no momento (régua 25/08)
  operador_id      uuid NOT NULL REFERENCES public.operadores(id),
  -- Respostas do formulário (estruturado, plano 25/08):
  --  o_que_leu_errado (texto), onde_olhou (array: historico_ssw|email_cliente|
  --  foto_evidencia|conhecimento_cliente|telefone_fora_cockpit|outro),
  --  info_existe_no_cockpit ('sim_interpretou_errado'|'nao_so_fora'), onde_fora,
  --  excecao_cliente (bool), excecao_qual, extras {pergunta_id: resposta}
  respostas        jsonb NOT NULL,
  snapshot_proposta jsonb NOT NULL,         -- a proposta exata que foi vetada
  -- capturada DEPOIS: a próxima ação do operador neste card = "a correção"
  correcao_capturada jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancelamentos_veto_card
  ON public.cancelamentos_acao_autonoma (card_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cancelamentos_veto_agente
  ON public.cancelamentos_acao_autonoma (agent_name, acao_key, created_at);

CREATE INDEX IF NOT EXISTS idx_cancelamentos_veto_operador
  ON public.cancelamentos_acao_autonoma (operador_id, created_at);

ALTER TABLE public.cancelamentos_acao_autonoma ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cancelamentos_veto_select ON public.cancelamentos_acao_autonoma;
CREATE POLICY cancelamentos_veto_select ON public.cancelamentos_acao_autonoma
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = cancelamentos_acao_autonoma.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

GRANT SELECT ON public.cancelamentos_acao_autonoma TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cancelamentos_acao_autonoma TO service_role;

COMMENT ON TABLE public.cancelamentos_acao_autonoma IS
  'Cada CANCELAR AÇÃO AUTÔNOMA com o formulário obrigatório respondido. '
  'INSERT só via RPC (etapa D/E) — valida popup completo. correcao_capturada '
  'preenchida depois pela captura automática da próxima ação do operador no '
  'card. É o dado estruturado de treino do agente. Plano veto 25/08.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Edições na janela — antes/depois estruturado (dado de treino)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.edicoes_acao_autonoma (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id        uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  agendamento_id bigint REFERENCES public.acoes_agendadas(id) ON DELETE SET NULL,
  agent_name     text NOT NULL,
  acao_key       text NOT NULL,
  operador_id    uuid NOT NULL REFERENCES public.operadores(id),
  campo          text NOT NULL,             -- 'texto_email' | 'template_id' | 'anexos' | ...
  valor_antes    jsonb,
  valor_depois   jsonb,
  hash_antes     text,
  hash_depois    text,                      -- vira o novo hash do agendamento (risco 23)
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edicoes_veto_card
  ON public.edicoes_acao_autonoma (card_id, created_at);

CREATE INDEX IF NOT EXISTS idx_edicoes_veto_agente
  ON public.edicoes_acao_autonoma (agent_name, acao_key, created_at);

CREATE INDEX IF NOT EXISTS idx_edicoes_veto_operador
  ON public.edicoes_acao_autonoma (operador_id, created_at);

ALTER TABLE public.edicoes_acao_autonoma ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS edicoes_veto_select ON public.edicoes_acao_autonoma;
CREATE POLICY edicoes_veto_select ON public.edicoes_acao_autonoma
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = edicoes_acao_autonoma.card_id
        AND public.card_visivel_pelo_operador_atual(c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

GRANT SELECT ON public.edicoes_acao_autonoma TO authenticated;
GRANT SELECT, INSERT ON public.edicoes_acao_autonoma TO service_role;

COMMENT ON TABLE public.edicoes_acao_autonoma IS
  'Edição LEGÍTIMA do operador dentro da janela de veto (a contagem continua; '
  'executa a versão editada). Antes/depois estruturado por campo — insumo '
  'direto de treinamento. hash_depois substitui o hash do agendamento '
  '(exceção deliberada do risco 23). Plano veto 25/08.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Perguntas extras por ação (banco versionado do formulário)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.perguntas_extras_cancelamento (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao_key     text NOT NULL,               -- a quem a pergunta se aplica
  versao       int NOT NULL DEFAULT 1,
  pergunta     text NOT NULL,
  tipo_resposta text NOT NULL DEFAULT 'texto'
               CHECK (tipo_resposta IN ('texto', 'opcoes', 'booleano')),
  opcoes       jsonb,                       -- quando tipo_resposta='opcoes'
  ativa        boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perguntas_extras_acao
  ON public.perguntas_extras_cancelamento (acao_key) WHERE ativa;

ALTER TABLE public.perguntas_extras_cancelamento ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS perguntas_extras_select ON public.perguntas_extras_cancelamento;
CREATE POLICY perguntas_extras_select ON public.perguntas_extras_cancelamento
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.perguntas_extras_cancelamento TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.perguntas_extras_cancelamento TO service_role;

COMMENT ON TABLE public.perguntas_extras_cancelamento IS
  'Banco VERSIONADO de perguntas extras do formulário de cancelamento, por '
  'acao_key. As 4 perguntas-base moram no front; estas complementam por tipo '
  'de ação. Textos validados pelo Caio antes de cada degrau da escada. '
  'Plano veto 25/08.';
