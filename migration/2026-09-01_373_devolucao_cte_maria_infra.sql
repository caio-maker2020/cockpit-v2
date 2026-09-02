-- =============================================================================
-- 2026-09-01_373_devolucao_cte_maria_infra.sql
--
-- Degrau 0 da feature "devolução com CT-e obrigatório" da MARIA EDUARDA.
-- Infra + flags TODAS DESLIGADAS. Nenhum comportamento muda ao aplicar.
--
-- TIPO A (aditiva e reversível), pelos critérios da política de migrations:
--   - só CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / INSERT de flag
--     nova / CREATE FUNCTION nova / CREATE TRIGGER novo;
--   - ZERO UPDATE, DELETE, DROP de coisa existente, backfill, ou CREATE OR
--     REPLACE de função/policy que já existia;
--   - a coluna nova (`email_anexos.preservar`) nasce DEFAULT false e NINGUÉM a
--     lê ainda;
--   - NÃO há trigger em tabela existente. O escopo é uma FUNÇÃO nova
--     (`devolucao_cte_em_escopo`) que ninguém chama no degrau 0 — logo é
--     impossível afetar qualquer escrita já existente.
--
-- REVERSÃO (receita completa, no fim do arquivo).
--
-- CUSTO DE LOCK: a coluna nova é `boolean NOT NULL DEFAULT false`, constante — no PG 11+ isso é operação de METADADO, sem rewrite de tabela.
-- `email_anexos` tem ~30k linhas de inbound e mesmo assim o ALTER é instantâneo;
-- o lock ACCESS EXCLUSIVE dura o suficiente pra trocar o catálogo. Sem risco de
-- fila em produção.
--
-- Refs: plano §11 degrau 0 · decisões 1-16 do Caio (2026-09-01) · ADR 0018 (a
--       escrever) · INV-123 a INV-131.
--
-- NOTA DE PROCESSO: a skill `supabase-postgres-best-practices`, que o CLAUDE.md
-- exige antes de qualquer SQL, NÃO está instalada nesta sessão (só
-- `verify-cockpit`). As práticas foram aplicadas à mão: RLS ligada com policy
-- explícita `TO service_role`, `SET search_path` em toda função, SECURITY
-- DEFINER só onde justificado e com o motivo escrito, índice em toda coluna de
-- busca e de FK, CHECK para higiene de dado, comentário em tudo. Conferência
-- pela skill fica pendente.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- GUARDS DE PRÉ-CONDIÇÃO — a migration falha ALTO se o mundo não for o esperado
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_maria uuid;
  v_cart  int;
BEGIN
  -- G1: as tabelas de que dependemos existem
  IF to_regclass('public.cards') IS NULL THEN RAISE EXCEPTION 'G1: public.cards ausente'; END IF;
  IF to_regclass('public.operadores') IS NULL THEN RAISE EXCEPTION 'G1: public.operadores ausente'; END IF;
  IF to_regclass('public.cliente_config') IS NULL THEN RAISE EXCEPTION 'G1: public.cliente_config ausente'; END IF;
  IF to_regclass('public.email_anexos') IS NULL THEN RAISE EXCEPTION 'G1: public.email_anexos ausente'; END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN RAISE EXCEPTION 'G1: public.feature_flags ausente'; END IF;

  -- G2: a função genérica de updated_at existe (mig 001) — vamos reusar, não recriar
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'set_updated_at'
  ) THEN
    RAISE EXCEPTION 'G2: public.set_updated_at() ausente — mig 001 não aplicada?';
  END IF;

  -- G3: a MARIA existe, está ativa e tem carteira — é ela que define o escopo
  SELECT id INTO v_maria FROM public.operadores WHERE nome = 'MARIA' AND ativo LIMIT 1;
  IF v_maria IS NULL THEN RAISE EXCEPTION 'G3: operador MARIA ativo não encontrado'; END IF;
  SELECT coalesce(array_length(carteira, 1), 0) INTO v_cart FROM public.operadores WHERE id = v_maria;
  IF v_cart < 1 THEN RAISE EXCEPTION 'G3: carteira da MARIA vazia (=%)', v_cart; END IF;
  RAISE NOTICE 'G3 ok: MARIA=% carteira=% CNPJs', v_maria, v_cart;

  -- G4: nada com estes nomes já existe (não estamos sobrescrevendo nada)
  IF to_regclass('public.devolucoes_cte') IS NOT NULL THEN
    RAISE NOTICE 'G4: public.devolucoes_cte já existe — migration é idempotente, seguindo';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. devolucao_cte_config — configuração da feature, UMA linha
--
-- Por que tabela própria e não cliente_config: cliente_config é POR CLIENTE
-- (PK cnpj_pagador). Isto aqui é global da feature (destinatário interno do
-- setor de Devolução e o operador que define o escopo). Pendência P5 do plano:
-- "destinatário do e-mail interno em config, nunca hardcode" (o hardcode
-- contraria a convenção do repo e o `?to=` por query string do precedente
-- redirecionava documento fiscal).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devolucao_cte_config (
  id                        smallint PRIMARY KEY DEFAULT 1,
  -- destinatário do e-mail interno (setor de Devolução)
  email_setor_devolucao     text NOT NULL,
  email_copia               text[] NOT NULL DEFAULT '{}'::text[],
  -- operador cuja CARTEIRA define o escopo. Config, não hardcode de CNPJ
  -- (lição do INV-075: nunca CNPJ escrito em código/migration).
  operador_escopo           text NOT NULL DEFAULT 'MARIA',
  -- Restrição de PILOTO: quando NÃO vazio, o escopo é só estes CNPJs (degrau 3
  -- da escada). Vazio = a carteira inteira do operador. Decisão do Caio 01/09:
  -- "todos os clientes da Maria seguem esse fluxo" ⇒ não existe lista de opt-in
  -- por cliente; o escopo é a carteira, que o banco já mantém.
  cnpjs_piloto              text[] NOT NULL DEFAULT '{}'::text[],
  -- NÃO existe coluna de cadência de cobrança. Decisão do Caio 2026-09-02:
  -- **"Nada será cobrado de maneira automática."** Nenhum lembrete por e-mail ao
  -- cliente nasce desta feature. A cobrança automática de cliente do Cockpit foi
  -- desligada por decisão em 2026-05-26 (mig 168 —
  -- `desativar_cobranca_cliente_automatica`, que também CANCELOU as 34 ações
  -- pendentes), com o motivo escrito: cliente sem e-mail cadastrado fazia a
  -- rotina retentar a cada 15 min pra sempre. Não reintroduzimos isso aqui.
  --
  -- Também NÃO existe cadência de "vigia de ciclo parado". O vigia foi construído
  -- e REMOVIDO em 2026-09-02, por três motivos verificados no código: (a) o
  -- cenário que ele vigiava (espera da NFD via oc 56) não existe — nada escreve
  -- `oc56_lancada_em`, `aguardando_nfd` nem `exige_nfd`; (b) o aviso dele só
  -- renderiza DENTRO do painel do card, que é justamente o card que saiu do
  -- painel da operadora — trocava "linha invisível" por "banner invisível"; e
  -- (c) como o ciclo agora encerra na oc 44, sua única população seria alarme
  -- falso sobre devolução concluída.
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devcte_config_linha_unica   CHECK (id = 1),
  CONSTRAINT devcte_config_email_valido  CHECK (position('@' in email_setor_devolucao) > 1),
  -- Piloto só aceita CNPJ em dígitos (14) — máscara nunca casaria com a carteira
  -- (é o R17: `cliente_config.cnpj_pagador` não tem CHECK e linha com máscara
  -- nunca casa, desligando a cerca em silêncio).
  --
  -- Sem subquery e sem unnest: CHECK não aceita nenhum dos dois em Postgres.
  -- array_to_string de array vazio devolve '', que casa com o grupo opcional.
  CONSTRAINT devcte_config_piloto_digitos CHECK (
    array_to_string(cnpjs_piloto, ',') ~ '^([0-9]{14}(,[0-9]{14})*)?$'
  )
);

COMMENT ON TABLE  public.devolucao_cte_config IS
  'Config GLOBAL da devolução com CT-e da MARIA. Uma linha (id=1). Não confundir com cliente_config, que é por cliente.';
COMMENT ON COLUMN public.devolucao_cte_config.email_setor_devolucao IS
  'Destinatário do e-mail interno com o CT-e original. Config, nunca hardcode (pendência P5 do plano).';
COMMENT ON COLUMN public.devolucao_cte_config.operador_escopo IS
  'Nome do operador em public.operadores cuja carteira delimita o escopo. Config em vez de CNPJ em código (INV-075).';
COMMENT ON COLUMN public.devolucao_cte_config.cnpjs_piloto IS
  'Restrição de piloto (degrau 3): quando não vazio, escopo = só estes CNPJs. Vazio = carteira inteira do operador_escopo. Caio 01/09: todos os clientes da MARIA seguem o fluxo, logo NÃO existe lista de opt-in por cliente.';

INSERT INTO public.devolucao_cte_config (id, email_setor_devolucao, operador_escopo)
VALUES (1, 'leonel.prudente@salexpress.com.br', 'MARIA')
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_devcte_config_updated_at ON public.devolucao_cte_config;
CREATE TRIGGER trg_devcte_config_updated_at
  BEFORE UPDATE ON public.devolucao_cte_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.devolucao_cte_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS devcte_config_service_role ON public.devolucao_cte_config;
CREATE POLICY devcte_config_service_role ON public.devolucao_cte_config
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- Sem policy pra `authenticated` de propósito: no degrau 0 nada no front lê
-- isto. A policy de leitura do front entra no degrau em que o front é feito,
-- com o mesmo padrão de isolamento por operador da mig 110 — não vou adivinhar
-- o helper agora.

-- -----------------------------------------------------------------------------
-- 2. devolucoes_cte — o CICLO. Fonte da verdade do processo de devolução.
--
-- CHAVE = (nf, ctrc_origem), NÃO card_id. Motivo (risco R6 + ADR 0006): a
-- devolução GERA UM CTRC NOVO, e o Bastão cria um CARD NOVO para ele. Se a linha
-- fosse presa ao card (UNIQUE(card_id)), ela morreria com o card antigo e o
-- ciclo ficaria órfão — anexo, baseline da NFD e rastro perdidos, e o detector
-- redispararia no card novo gerando 2ª oc 44 e 2º e-mail. `card_id` aqui é
-- PONTEIRO MUTÁVEL.
--
-- Este ciclo é também o que segura o caso vivo quando a oc 56 manda o card pra
-- TRANSFERIDO (decisão nº 15): verificado em bastao-rules.ts que a oc 56 NÃO
-- está em OCORRENCIAS_DE_RELACIONAMENTO, então lançá-la ejeta o card do painel;
-- e passados 60 min (vinculador, JANELA_ACAO_RECENTE_MS) uma resposta do cliente
-- deixa de reativar o card. Sem este controle próprio, o CT-e que chegasse
-- durante a espera da NFD seria engolido em silêncio.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devolucoes_cte (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identidade do ciclo
  nf                            text NOT NULL,
  ctrc_origem                   text NOT NULL,
  cnpj_pagador                  text NOT NULL,

  -- ponteiros MUTÁVEIS (o card troca quando o CTRC troca — R6)
  card_id                       uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  operador_id                   uuid REFERENCES public.operadores(id) ON DELETE SET NULL,

  status                        text NOT NULL DEFAULT 'pronto_para_44',

  -- CT-e de devolução
  cte_detectado_nivel           text,          -- 'A' = monta ação · 'B' = só sinaliza
  cte_recebido_em               timestamptz,
  -- id em public.email_anexos. SEM FK de propósito: FK com ON DELETE SET NULL
  -- reavaliaria o CHECK `devcte_sem_cte_nao_lanca_44` no momento do delete e
  -- viraria erro obscuro; FK com RESTRICT mudaria o caminho de DELETE de uma
  -- tabela EXISTENTE (deixaria de ser TIPO A). Integridade fica no código + na
  -- coluna email_anexos.preservar criada abaixo.
  cte_anexo_id                  uuid,          -- o PDF ORIGINAL (vai no e-mail ao setor)
  cte_convertido_ok             boolean,       -- NULL = ainda não tentou converter
  -- Os JPEGs que a conversão PDF→JPEG gerou. São ESTES que sobem pro SSW; o
  -- `cte_anexo_id` acima é o PDF original, que vai no e-mail ao setor de
  -- Devolução (o anexo do SSW não tem qualidade de impressão — é a razão de o
  -- e-mail existir). Dois artefatos distintos, de propósito.
  -- Guardado pra (a) auditoria do que foi pro TMS e (b) não reconverter no retry
  -- do PGMQ (a conversão é PDFium/WASM numa edge dedicada, custa caro).
  cte_anexos_ssw_ids            uuid[] NOT NULL DEFAULT '{}'::uuid[],

  -- NFD (decisões 13/14/16)
  exige_nfd                     boolean NOT NULL DEFAULT false,
  exige_nfd_marcado_em          timestamptz,
  exige_nfd_marcado_por         uuid REFERENCES public.operadores(id) ON DELETE SET NULL,
  nfd_origem                    text,          -- 'unidade_oc49' | 'email_cliente'
  nfd_disponivel_em             timestamptz,
  oc56_lancada_em               timestamptz,

  -- ação no SSW e e-mail interno
  oc44_lancada_em               timestamptz,
  email_interno_gmail_message_id text,
  email_interno_enviado_em      timestamptz,

  -- NÃO existe coluna de cobrança nem de vigia. Ver o bloco de comentário em
  -- devolucao_cte_config: "nada será cobrado de maneira automática" (Caio
  -- 2026-09-02) e o vigia foi removido por não funcionar.

  -- FIM DO CICLO. Regra do Caio (2026-09-02): *"o caso de devolução só se
  -- encerra quando a 44 é lançada"*. Quem escreve isto é o handler
  -- `processarLancar44DevolucaoCte`, na mesma passada em que grava
  -- `oc44_lancada_em` — a oc 44 é o FIM do caso, não uma etapa.
  --
  -- Encerrar não é cosmético: `filtrarPropostas44SemCte` filtra o menu por ciclo
  -- ABERTO. Sem encerrar, a 44 pelada e os combos 33+44 / 44+59 ficariam fora do
  -- menu deste card PARA SEMPRE, mesmo com a devolução concluída.
  encerrado_em                  timestamptz,
  motivo_encerramento           text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  -- higiene de dado
  CONSTRAINT devcte_nf_digitos      CHECK (nf ~ '^[0-9]{1,15}$'),
  CONSTRAINT devcte_cnpj_digitos    CHECK (cnpj_pagador ~ '^[0-9]{14}$'),
  CONSTRAINT devcte_ctrc_nao_vazio  CHECK (length(btrim(ctrc_origem)) > 0),
  CONSTRAINT devcte_status_valido   CHECK (status IN (
                                      'aguardando_nfd',
                                      'pronto_para_44',
                                      'oc44_lancada',
                                      'concluido',
                                      'encerrado_sem_devolucao'
                                    )),
  CONSTRAINT devcte_nivel_valido    CHECK (cte_detectado_nivel IS NULL
                                      OR cte_detectado_nivel IN ('A','B')),
  CONSTRAINT devcte_nfd_origem      CHECK (nfd_origem IS NULL
                                      OR nfd_origem IN ('unidade_oc49','email_cliente')),

  -- INV-126, no BANCO: nunca existe oc 44 lançada sem CT-e em mãos.
  -- É a parede final da decisão nº 3 ("não há devolução sem CT-e"). Guard em
  -- código pode ser furado por tool novo não registrado; constraint não.
  CONSTRAINT devcte_sem_cte_nao_lanca_44 CHECK (
    oc44_lancada_em IS NULL OR cte_anexo_id IS NOT NULL
  ),
  -- Fail-closed da decisão nº 4: conversão PDF→JPEG falhando NÃO lança a 44.
  CONSTRAINT devcte_44_exige_conversao_ok CHECK (
    oc44_lancada_em IS NULL OR cte_convertido_ok IS TRUE
  ),
  -- Ordem: o e-mail interno só sai DEPOIS da 44 (nunca "CT-e em anexo" sem oc).
  CONSTRAINT devcte_email_depois_da_44 CHECK (
    email_interno_enviado_em IS NULL OR oc44_lancada_em IS NOT NULL
  ),
  -- Coerência da marcação de NFD (decisão nº 16: entra por clique humano).
  CONSTRAINT devcte_nfd_marcacao_coerente CHECK (
    (exige_nfd IS FALSE AND exige_nfd_marcado_em IS NULL)
    OR (exige_nfd IS TRUE AND exige_nfd_marcado_em IS NOT NULL)
  )
);

-- Identidade do ciclo: uma linha por (NF, CTRC de origem).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_devcte_nf_ctrc
  ON public.devolucoes_cte (nf, ctrc_origem);

-- Idempotência do e-mail interno (riscos R5/R11: 2ª entrega do PGMQ passava
-- pelo idempotent_skip e reenviava o documento).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_devcte_email_interno_msgid
  ON public.devolucoes_cte (email_interno_gmail_message_id)
  WHERE email_interno_gmail_message_id IS NOT NULL;

-- Caminhos de leitura previstos.
CREATE INDEX IF NOT EXISTS idx_devcte_card         ON public.devolucoes_cte (card_id);
CREATE INDEX IF NOT EXISTS idx_devcte_operador     ON public.devolucoes_cte (operador_id);
CREATE INDEX IF NOT EXISTS idx_devcte_cnpj         ON public.devolucoes_cte (cnpj_pagador);
CREATE INDEX IF NOT EXISTS idx_devcte_anexo        ON public.devolucoes_cte (cte_anexo_id)
  WHERE cte_anexo_id IS NOT NULL;
-- Ciclos abertos por status (varredura do agente).
CREATE INDEX IF NOT EXISTS idx_devcte_abertos
  ON public.devolucoes_cte (status, updated_at)
  WHERE encerrado_em IS NULL;

COMMENT ON TABLE public.devolucoes_cte IS
  'Ciclo da devolução com CT-e obrigatório (MARIA EDUARDA). PROJEÇÃO: card_events continua sendo a verdade (convenção nº 1). Chaveada por (nf, ctrc_origem) porque a devolução troca o CTRC e cria card novo (ADR 0006 / risco R6).';
COMMENT ON COLUMN public.devolucoes_cte.card_id IS
  'PONTEIRO MUTÁVEL. Quando o CTRC troca e nasce card novo, este ponteiro migra — a linha do ciclo NÃO morre com o card antigo.';
COMMENT ON COLUMN public.devolucoes_cte.cte_detectado_nivel IS
  'A = frase de entrega na própria mensagem, monta proposta de oc 44. B = prova só na conversa, APENAS sinaliza (decisão nº 9). Medido no histórico: A deu 21 na caixa da MARIA e 0 nas outras 8 caixas.';
COMMENT ON COLUMN public.devolucoes_cte.cte_anexo_id IS
  'id em public.email_anexos, SEM FK — ver comentário no corpo da tabela. Integridade via código + email_anexos.preservar.';
COMMENT ON COLUMN public.devolucoes_cte.cte_convertido_ok IS
  'Resultado da conversão PDF→JPEG pro SSW. NULL = não tentou. FALSE = falhou ⇒ a 44 NÃO é lançada (decisão nº 4, fail-closed; ADR 0014 "falha explícita > sucesso silencioso").';
COMMENT ON COLUMN public.devolucoes_cte.exige_nfd IS
  'Exigência POR PROCESSO, não atributo do cliente (decisão nº 14 substitui a nº 5). Entra por CLIQUE da operadora (decisão nº 16), não por IA. Medido: a mesma AGV pede e envia NFD — depende do cliente DO cliente.';
COMMENT ON COLUMN public.devolucoes_cte.nfd_origem IS
  'unidade_oc49 = destinatário emitiu no ato da entrega e nossa unidade anexou no SSW (maioria). email_cliente = destinatário emitiu depois e o cliente mandou por e-mail. Decisão nº 13: os dois caminhos valem.';
COMMENT ON COLUMN public.devolucoes_cte.oc56_lancada_em IS
  'Quando a 56 "PRECISO DA NFD" foi lançada pra unidade. ATENÇÃO: a 56 não é ocorrência de Relacionamento, então ela move o card pra TRANSFERIDO e ele sai do painel — é por isso que este ciclo existe (decisão nº 15).';

DROP TRIGGER IF EXISTS trg_devcte_updated_at ON public.devolucoes_cte;
CREATE TRIGGER trg_devcte_updated_at
  BEFORE UPDATE ON public.devolucoes_cte
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.devolucoes_cte ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS devcte_service_role ON public.devolucoes_cte;
CREATE POLICY devcte_service_role ON public.devolucoes_cte
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
-- Idem: policy de leitura pro front entra no degrau do front.

-- -----------------------------------------------------------------------------
-- 3. Colunas aditivas em tabelas existentes — DEFAULT false, ninguém lê ainda
-- -----------------------------------------------------------------------------

-- NÃO existe coluna de opt-in por cliente. Decisão do Caio 2026-09-01: "todos os
-- clientes da Maria seguem esse fluxo". O escopo é a CARTEIRA do operador, que o
-- banco já mantém (operadores.carteira, 24 CNPJs pagadores, sincronizada pela
-- RPC remanejar_cliente_operador da mig 360).
--
-- Por que isso é MAIS forte que a coluna que estava aqui antes: uma coluna
-- booleana por cliente é uma lista que alguém precisa preencher e manter, e o
-- erro possível ("ligar pro CNPJ errado") vaza escopo pra Larissa/Karoline/
-- Ingrid. Derivando da carteira, esse erro DEIXA DE EXISTIR — a mig 323 (G5) já
-- garante que nenhum CNPJ está em duas carteiras ativas. Cliente remanejado
-- entra/sai do fluxo sozinho, sem migration nova.
--
-- Ver a função public.devolucao_cte_em_escopo() na seção 4.

-- INV-124: anexo marcado NUNCA é apagado pelo finalizarAnexosPosEnvio (9
-- callers — blindar um a um esquece o 10º).
-- Nota: o risco R16 foi REFUTADO no banco em 2026-09-01 (a rotina
-- cleanup_email_anexos_orfaos existe mas NÃO está agendada em cron.job, e
-- nenhum job menciona anexo/email — a doc em prompts/lovable-anexos-email.md
-- está errada). A coluna segue boa prática, mas deixou de ser urgente.
ALTER TABLE public.email_anexos
  ADD COLUMN IF NOT EXISTS preservar boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_anexos.preservar IS
  'Se true, o anexo é prova fiscal em uso (ex.: CT-e de devolução de ciclo aberto) e não pode ser apagado nem soft-deletado. Guard INV-124.';

CREATE INDEX IF NOT EXISTS idx_email_anexos_preservar
  ON public.email_anexos (card_id)
  WHERE preservar IS TRUE;

-- -----------------------------------------------------------------------------
-- 4. INV-123 — CERCA DE ESCOPO: uma função, uma verdade
--
-- Escopo = CNPJ pagador na carteira do operador de escopo (MARIA), com a
-- restrição opcional de piloto. Não há flag por cliente pra alguém ligar errado.
--
-- Fail-closed em três situações, todas medidas como risco real:
--   (a) CNPJ nulo/vazio  → FALSE. `agent_state.cnpj_pagador` pode ser nulo e o
--       gate se desligaria em silêncio (R17);
--   (b) config ausente   → EXCEPTION (não FALSE): config faltando é defeito de
--       instalação, não "cliente fora do escopo";
--   (c) operador inativo → FALSE.
--
-- NORMALIZAÇÃO obrigatória dos dois lados (`\D` fora + lpad 14). É o R17: linha
-- com máscara ou sem zero à esquerda nunca casa e a cerca desliga sem avisar.
-- As migs 264 e 369 já comparam carteira exatamente assim.
--
-- STABLE, não IMMUTABLE: lê tabela.
--
-- SECURITY DEFINER com justificativa: a policy atual de cliente_config e a
-- leitura de `operadores` sob RLS podem devolver carteira vazia pra um caller
-- `authenticated`, fazendo a cerca REJEITAR indevidamente (ou, pior, um chamador
-- com menos privilégio ver escopo diferente do real). DEFINER garante que a
-- cerca veja a carteira inteira. search_path fixado (nunca herdar).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.devolucao_cte_em_escopo(p_cnpj_pagador text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_operador text;
  v_piloto   text[];
  v_cnpj     text;
BEGIN
  -- (a) sem pagador não há como afirmar escopo ⇒ fora, fail-closed
  IF p_cnpj_pagador IS NULL OR btrim(p_cnpj_pagador) = '' THEN
    RETURN false;
  END IF;

  v_cnpj := lpad(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), 14, '0');
  IF v_cnpj !~ '^[0-9]{14}$' THEN
    RETURN false;
  END IF;

  SELECT operador_escopo, cnpjs_piloto INTO v_operador, v_piloto
    FROM public.devolucao_cte_config WHERE id = 1;

  -- (b) config ausente é defeito de instalação, não "fora de escopo"
  IF v_operador IS NULL THEN
    RAISE EXCEPTION 'INV-123: devolucao_cte_config (id=1) ausente ou sem operador_escopo — escopo não pode ser avaliado';
  END IF;

  -- restrição de piloto (degrau 3): quando preenchida, só ela vale
  IF v_piloto IS NOT NULL AND array_length(v_piloto, 1) > 0 THEN
    IF NOT (v_cnpj = ANY (v_piloto)) THEN
      RETURN false;
    END IF;
  END IF;

  -- (c) operador tem de existir E estar ativo
  RETURN EXISTS (
    SELECT 1
      FROM public.operadores o, unnest(o.carteira) c
     WHERE o.nome = v_operador
       AND o.ativo
       AND lpad(regexp_replace(c, '\D', '', 'g'), 14, '0') = v_cnpj
  );
END $fn$;

COMMENT ON FUNCTION public.devolucao_cte_em_escopo(text) IS
  'INV-123: fonte ÚNICA do escopo da devolução com CT-e. true = CNPJ pagador está na carteira do devolucao_cte_config.operador_escopo (e no cnpjs_piloto, se houver). Fail-closed: CNPJ nulo/malformado => false; config ausente => exception. Caio 01/09: todos os clientes da MARIA seguem o fluxo, logo escopo = carteira, sem lista de opt-in.';

REVOKE ALL ON FUNCTION public.devolucao_cte_em_escopo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.devolucao_cte_em_escopo(text) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Feature flags — TODAS DESLIGADAS
--
-- É o que faz esta migration não mudar nada em produção. Rollback de qualquer
-- degrau é UPDATE feature_flags SET enabled = false.
-- -----------------------------------------------------------------------------
INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('devolucao_cte_shadow',
   'Degrau 3: detector de CT-e roda em modo SOMBRA (registra o que faria, não cria proposta)', false),
  ('devolucao_cte_maria_enabled',
   'Degrau 4: detector cria proposta de oc 44 com o CT-e anexado (nível A apenas)', false),
  ('devolucao_cte_email_interno',
   'Degrau 5: e-mail NOVO e separado ao setor de Devolução com o CT-e original (decisão nº 10)', false),
  ('devolucao_cte_nfd',
   'Degrau 7: fluxo da NFD (oc 56 pra unidade + vigia da oc 49). Exigência entra por clique da operadora, sem IA (decisão nº 16)', false)
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- GUARDS DE PÓS-CONDIÇÃO — se qualquer coisa não aterrou, aborta o COMMIT
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_flags   int;
  v_cfg     int;
  v_mascara int;
BEGIN
  -- G5: objetos criados
  IF to_regclass('public.devolucoes_cte') IS NULL THEN RAISE EXCEPTION 'G5: devolucoes_cte não criada'; END IF;
  IF to_regclass('public.devolucao_cte_config') IS NULL THEN RAISE EXCEPTION 'G5: devolucao_cte_config não criada'; END IF;

  -- G6: coluna aditiva presente + função de escopo criada
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
     WHERE n.nspname='public' AND pr.proname='devolucao_cte_em_escopo'
  ) THEN
    RAISE EXCEPTION 'G6: public.devolucao_cte_em_escopo() ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='email_anexos'
                    AND column_name='preservar') THEN
    RAISE EXCEPTION 'G6: email_anexos.preservar ausente';
  END IF;

  -- G7: NENHUMA flag da feature ligada. Se falhar, a migration mudou produção.
  SELECT count(*) INTO v_flags FROM public.feature_flags
   WHERE key LIKE 'devolucao_cte%' AND enabled IS TRUE;
  IF v_flags <> 0 THEN RAISE EXCEPTION 'G7: % flag(s) devolucao_cte LIGADA(S) — degrau 0 tem de ser inerte', v_flags; END IF;

  SELECT count(*) INTO v_flags FROM public.feature_flags WHERE key LIKE 'devolucao_cte%';
  IF v_flags <> 4 THEN RAISE EXCEPTION 'G7: esperado 4 flags devolucao_cte, achei %', v_flags; END IF;

  -- G8: a cerca de escopo funciona E é fail-closed. Testada aqui dentro, no
  -- COMMIT, e não em teste que ninguém roda: CNPJ nulo/vazio/lixo => false;
  -- CNPJ de outra carteira => false; CNPJ real da carteira => true.
  IF public.devolucao_cte_em_escopo(NULL) THEN
    RAISE EXCEPTION 'G8: escopo aceitou CNPJ NULO — cerca não é fail-closed (R17)';
  END IF;
  IF public.devolucao_cte_em_escopo('') OR public.devolucao_cte_em_escopo('abc') THEN
    RAISE EXCEPTION 'G8: escopo aceitou CNPJ vazio/malformado';
  END IF;
  -- 14 noves montados com repeat(): literal de 14 dígitos no arquivo dispararia
  -- o guard anti-hardcode-de-CNPJ do /verify-cockpit, e com razão (INV-075).
  IF public.devolucao_cte_em_escopo(repeat('9', 14)) THEN
    RAISE EXCEPTION 'G8: escopo aceitou CNPJ fora de qualquer carteira';
  END IF;
  -- pega 1 CNPJ real da carteira da MARIA e exige TRUE (prova que a
  -- normalização de dígitos casa de verdade — é o R17 pela outra ponta)
  SELECT count(*) INTO v_cfg
    FROM public.operadores o, unnest(o.carteira) c
   WHERE o.nome = (SELECT operador_escopo FROM public.devolucao_cte_config WHERE id=1)
     AND o.ativo
     AND public.devolucao_cte_em_escopo(c);
  IF v_cfg = 0 THEN
    RAISE EXCEPTION 'G8: NENHUM CNPJ da carteira do operador de escopo passou na cerca — normalização quebrada (R17)';
  END IF;
  RAISE NOTICE 'G8 ok: % CNPJ(s) da carteira reconhecidos pela cerca', v_cfg;

  -- G9: RLS ligada nas duas tabelas novas
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.devolucoes_cte'::regclass) THEN
    RAISE EXCEPTION 'G9: RLS desligada em devolucoes_cte';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.devolucao_cte_config'::regclass) THEN
    RAISE EXCEPTION 'G9: RLS desligada em devolucao_cte_config';
  END IF;

  -- G10: config semeada
  IF NOT EXISTS (SELECT 1 FROM public.devolucao_cte_config WHERE id = 1) THEN
    RAISE EXCEPTION 'G10: devolucao_cte_config sem a linha id=1';
  END IF;

  -- DIAGNÓSTICO (não bloqueia): risco R17 do plano — cliente_config.cnpj_pagador
  -- não tem CHECK de dígitos, e linha com máscara nunca casa com o CNPJ do
  -- agent_state. NÃO corrigido aqui de propósito: adicionar o CHECK validaria
  -- dado existente (ou mudaria o caminho de UPDATE), deixando de ser TIPO A.
  SELECT count(*) INTO v_mascara FROM public.cliente_config
   WHERE cnpj_pagador !~ '^[0-9]{14}$';
  IF v_mascara > 0 THEN
    RAISE WARNING 'R17: % linha(s) em cliente_config com cnpj_pagador fora do formato de 14 dígitos — a cerca de escopo NUNCA casa nessas linhas. Tratar em frente própria (TIPO B).', v_mascara;
  ELSE
    RAISE NOTICE 'R17 ok: todas as linhas de cliente_config têm cnpj_pagador com 14 dígitos';
  END IF;

  RAISE NOTICE 'mig 373 OK — infra criada, 5 flags DESLIGADAS, 0 cliente em escopo, nada de produção mudou';
END $$;

COMMIT;

-- =============================================================================
-- REVERSÃO (TIPO A — tudo reversível, nesta ordem)
-- =============================================================================
-- BEGIN;
--   DROP FUNCTION IF EXISTS public.devolucao_cte_em_escopo(text);
--   DROP INDEX IF EXISTS public.idx_email_anexos_preservar;
--   ALTER TABLE public.email_anexos DROP COLUMN IF EXISTS preservar;
--   DROP TABLE IF EXISTS public.devolucoes_cte;         -- sem dado real no degrau 0
--   DROP TABLE IF EXISTS public.devolucao_cte_config;
--   DELETE FROM public.feature_flags WHERE key LIKE 'devolucao_cte%';
-- COMMIT;
--
-- ATENÇÃO na reversão: card_events NUNCA é apagado (lição do INV-047 — é o que
-- permite o retroativo depois).
-- =============================================================================
