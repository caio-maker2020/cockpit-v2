-- =============================================================================
-- 2026-09-21_407 — cliente_config_segregacao_ctrc: whitelist do "Segregar CTRC"
-- =============================================================================
-- Caio 21/09: a PRATI pediu poder BARRAR a carga junto com a ocorrência de
-- cliente do card de extravio. No portal SSW isso é o campo "Segregar CTRC"
-- da tela 101 (campo `f8`), marcado no MESMO submit da ocorrência — não é tela
-- separada, não é uma segunda chamada.
--
-- Campo confirmado lendo o HTML real do form act=O (diag-form-ocorrencia no
-- CT-e de teste AMB588507-8), não por inferência:
--     <input name="f8" exc="1" id="8" value="N" maxlength="1" ...>
-- O outro campo S/N da MESMA tela é o `f11` = "Resposta a um Fale Conosco".
--
-- ⚠ Segregar bloqueia o CT-e para transferência, movimentação e entrega (não
--   romaneia). A RETIRADA é MANUAL pelo operador no SSW (opção 091) — o Cockpit
--   NÃO desfaz. É a única ação do fluxo sem volta pelo sistema. Por isso a cerca
--   em `_shared/segregacao-ctrc.ts` exige, cumulativamente: CNPJ nesta whitelist
--   + oc ∈ {54,59} + aprovação HUMANA (todo sem auto_approval_rule). Robô nunca
--   segrega.
--
-- Molde: cliente_config_seguir_parcial_auto (mig 379) e cliente_config_oc13
-- (mig 121) — cada exceção operacional tem sua tabela dedicada, auditável e
-- fácil de desmontar isoladamente. NÃO reusa cliente_config (semântica de
-- romaneio/indenização + limiar de dias da oc 49 autônoma; misturar ali mexeria
-- no gatilho da 49 da PRATI, que hoje está em 2 dias úteis).
--
-- TIPO B (docs/POLITICA_MIGRATIONS.md) — exige --autorizado-por. O classificador
-- do `scripts/dbq.py` acusa "DROP de objeto": os DROP TRIGGER/POLICY IF EXISTS
-- abaixo, ambos sobre objetos criados NESTA MESMA migration (drop-then-create
-- para idempotência). Risco real zero, mas a política manda: em dúvida, TIPO B.
--
-- Por que é inerte ao aplicar:
--   - CREATE TABLE/INDEX IF NOT EXISTS — aditivo;
--   - flag NASCE DESLIGADA (enabled=false);
--   - seed entra com ativo=FALSE nos 2 CNPJs — nada muda de comportamento.
--   Ligar é ato separado e explícito (UPDATE ... SET ativo=true, TIPO B).
--
-- RECEITA DE REVERSÃO (rodar pelo trilho, `scripts/dbq.py`, TIPO B):
--   DROP FUNCTION IF EXISTS public.cliente_pode_segregar_ctrc(text);
--   DROP TABLE IF EXISTS public.cliente_config_segregacao_ctrc;   -- leva junto
--     o índice parcial, o trigger de updated_at e a policy RESTRICTIVE
--   DELETE FROM public.feature_flags WHERE key = 'segregacao_ctrc_enabled';
--   Efeito: `carregarCnpjsSegregacao` volta a devolver conjunto VAZIO
--   (fail-closed) e a RPC do front some → a marcação desaparece da tela. NÃO
--   retira segregações já lançadas no SSW: isso é manual (opção 091), sempre.
--
-- REAPLICÁVEL DEPOIS DO GO-LIVE (corrigido 21/09, auditoria pré-merge): o smoke
-- test do bloco 5 exige tudo OFF, o que só é verdade no NASCIMENTO. Depois de
-- ativar a PRATI de verdade, reaplicar o arquivo derrubaria a própria migration
-- com "nasceram ativos". O bloco 0 marca se ESTA execução está criando a tabela
-- e o bloco 5 só roda as checagens nesse caso.
--
-- skill supabase-postgres-best-practices: NÃO está instalada nesta máquina
-- (tentei invocar, retornou "Unknown skill"). Regras aplicadas manualmente a
-- partir dos precedentes do repo: idempotente; schema-qualified; RLS habilitada
-- com policy RESTRICTIVE negando anon/authenticated (service_role apenas, igual
-- à mig 379); CHECK de 14 dígitos no CNPJ; índice parcial em ativo; trigger de
-- updated_at reusando public.set_updated_at(); sem SECURITY DEFINER novo; sem
-- view (logo, sem risco de perder security_invoker); transação única e curta.
--
-- ⚠ Blast radius ao APLICAR: ZERO. Tabela nova + flag OFF + 2 linhas inativas.
--   Enquanto a tabela não existir, o loader devolve conjunto VAZIO (fail-closed)
--   e ninguém segrega — a Edge Function tolera a ausência sem quebrar.
-- ⚠ Blast radius ao ATIVAR (ato posterior): a operadora passa a PODER marcar
--   "Segregar CTRC" ao aprovar uma oc 54/59 dos cards de extravio desses CNPJs.
--   Continua sendo escolha dela em cada card — ativar não segrega nada sozinho.
--   Medido em produção (21/09): CNPJ ...1057 tem 631 cards e 5 em extravio
--   (4 oc 06 + 1 oc 09); CNPJ ...0166 está cadastrado e ativo mas sem card.
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, regra 13/08): o
--   `scripts/dbq.py` já envolve o arquivo na transação dele.
--
-- AUTORIZACAO (ritual de deploy, passo 5) — TIPO B exige declaracao:
--   "Carlos, 2026-09-21: ordem no chat — 'Ok, autorizo' (mexer no motor/Edge
--    Functions) + 'siga com a produção'. Escopo fechado no chat: só PRATI, só
--    oc 54/59, só ação manual da operadora, somente nos cards de extravio."
-- Autonomia do Carlos pra TIPO B: docs/POLITICA_MIGRATIONS.md secao 3 (rev 02/09).
-- =============================================================================

-- 0. Esta execução está CRIANDO a tabela, ou ela já existia? -------------------
-- Precisa ser medido ANTES do CREATE TABLE do bloco 1 — depois dele a tabela
-- existe sempre e a pergunta perde o sentido. O bloco 5 (smoke) usa esta marca:
-- as checagens "tudo nasce OFF" só valem no nascimento; numa reaplicação depois
-- do go-live a PRATI estará ativa e o smoke derrubaria a própria migration.
-- Marca de sessão (is_local=false) porque precisa sobreviver de um statement ao
-- outro dentro do mesmo arquivo; some no fim da sessão/rollback, não persiste
-- nada no banco.
DO $$
BEGIN
  PERFORM set_config(
    'cockpit.mig407_nascimento',
    CASE WHEN to_regclass('public.cliente_config_segregacao_ctrc') IS NULL
         THEN 'true' ELSE 'false' END,
    false);
END $$;

-- 1. Whitelist ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cliente_config_segregacao_ctrc (
  cnpj_pagador text PRIMARY KEY,
  nome_cliente text NOT NULL,
  -- Nasce FALSE de propósito: aplicar a migration não libera nada.
  ativo boolean NOT NULL DEFAULT false,
  -- Quem pediu a barragem e quando. A segregação trava carga física e a
  -- retirada é manual — precisa ser rastreável de quem partiu a ordem.
  autorizado_por text,
  autorizado_em date,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cliente_config_segregacao_ctrc_cnpj_digits
    CHECK (cnpj_pagador ~ '^\d{14}$'),
  -- Ligar um CNPJ sem dono registrado fica PROIBIDO no banco, não só no
  -- comentário: segregar trava carga física e a retirada é manual (opção 091).
  -- Se ninguém assinou a ordem, não há a quem voltar quando a carga parar.
  -- Custo zero hoje: as 2 linhas nascem inativas e já vêm com autorizado_por/em.
  CONSTRAINT cliente_config_segregacao_ctrc_ativo_exige_dono
    CHECK (NOT ativo OR (autorizado_por IS NOT NULL AND autorizado_em IS NOT NULL))
);

-- Índice parcial: o lookup do executor é sempre "quais estão ativos".
CREATE INDEX IF NOT EXISTS idx_cliente_config_segregacao_ctrc_ativo
  ON public.cliente_config_segregacao_ctrc (cnpj_pagador) WHERE ativo;

DROP TRIGGER IF EXISTS cliente_config_segregacao_ctrc_set_updated_at
  ON public.cliente_config_segregacao_ctrc;
CREATE TRIGGER cliente_config_segregacao_ctrc_set_updated_at
  BEFORE UPDATE ON public.cliente_config_segregacao_ctrc
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cliente_config_segregacao_ctrc ENABLE ROW LEVEL SECURITY;

-- Mesma política da mig 379 / cliente_config_oc13: service_role apenas. As edge
-- functions rodam com service_role; gestão por SQL via trilho (scripts/dbq.py).
DROP POLICY IF EXISTS cliente_config_segregacao_ctrc_service_only
  ON public.cliente_config_segregacao_ctrc;
CREATE POLICY cliente_config_segregacao_ctrc_service_only
  ON public.cliente_config_segregacao_ctrc
  AS RESTRICTIVE TO anon, authenticated
  USING (false);

COMMENT ON TABLE public.cliente_config_segregacao_ctrc IS
  'Caio 2026-09-21: CNPJs cuja operadora PODE marcar "Segregar CTRC" (campo f8 '
  'da tela 101 do SSW) ao lançar a oc 54/59 de um card de extravio. Segregar '
  'bloqueia o CT-e para transferência/movimentação/entrega e a RETIRADA é '
  'MANUAL no SSW (opção 091) — o Cockpit não desfaz. Estar ativo aqui NÃO '
  'segrega nada sozinho: só habilita a marcação, que é escolha humana em cada '
  'card. Robô nunca segrega (cerca exige todo sem auto_approval_rule). '
  'ativo=false por default. Gestão via SQL pelo trilho.';
COMMENT ON COLUMN public.cliente_config_segregacao_ctrc.autorizado_por IS
  'Quem pediu a barragem (cliente/área). A carga fica parada até alguém '
  'retirar a segregação à mão no SSW — a ordem precisa ter dono.';

-- 2. Kill-switch sem deploy --------------------------------------------------
-- Nasce OFF. Mesmo com CNPJ ativo=true, a marcação não é honrada com a flag OFF.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'segregacao_ctrc_enabled',
  false,
  'Caio 2026-09-21: libera a marcação "Segregar CTRC" (campo f8 da tela 101) '
  'para os CNPJs em cliente_config_segregacao_ctrc (ativo=true), nas ocs 54/59 '
  'dos cards de extravio, apenas em aprovação humana. OFF = ninguém segrega, '
  'comportamento atual para todo mundo. Kill-switch sem deploy.'
)
ON CONFLICT (key) DO NOTHING;

-- 3. Seed — os 2 CNPJs do grupo PRATI, AMBOS INATIVOS -------------------------
-- Caio 21/09 respondeu "os dois" quando perguntei o escopo de CNPJ. Conferido
-- em produção na mesma data: ambos existem em `clientes` e estão ativos; o
-- ...1057 tem 631 cards, o ...0166 ainda não tem nenhum (entra preventivamente,
-- para a regra não nascer cega à metade do grupo — lição da mig 387/oc 13).
INSERT INTO public.cliente_config_segregacao_ctrc
  (cnpj_pagador, nome_cliente, ativo, autorizado_por, autorizado_em, observacao)
VALUES
  ('73856593001057', 'PRATI DONADUZZI E CIA LTDA', false, 'Caio (chat 21/09)', '2026-09-21', 'Estabelecimento com movimento (631 cards). Aguardando teste real no CT-e de teste antes de ativar.'),
  ('73856593000166', 'PRATI DONADUZZI E CIA LTDA', false, 'Caio (chat 21/09)', '2026-09-21', 'Sem card até 21/09. Cadastrado para o grupo não nascer pela metade.')
ON CONFLICT (cnpj_pagador) DO NOTHING;

-- 4. Canal mínimo pro front ---------------------------------------------------
-- O front roda como `authenticated` e NÃO consegue ler esta tabela (policy
-- RESTRICTIVE acima). Sem um canal, a query falharia com permission denied e o
-- default `false` esconderia a marcação para TODOS — exatamente o bug do botão
-- "Buscar intranet Würth" (mig 335). Mesma solução: expor UM boolean por CNPJ,
-- sem abrir a tabela nem revelar a lista de clientes.
-- Devolve true só quando a flag mestra está ON E o CNPJ está ativo na whitelist.
CREATE OR REPLACE FUNCTION public.cliente_pode_segregar_ctrc(p_cnpj text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    coalesce(
      (SELECT enabled FROM public.feature_flags WHERE key = 'segregacao_ctrc_enabled'),
      false)
    AND EXISTS (
      SELECT 1
        FROM public.cliente_config_segregacao_ctrc
       WHERE cnpj_pagador = regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g')
         AND ativo);
$$;

REVOKE ALL ON FUNCTION public.cliente_pode_segregar_ctrc(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_pode_segregar_ctrc(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.cliente_pode_segregar_ctrc(text) IS
  'Front: a operadora pode marcar "Segregar CTRC" nos cards deste CNPJ pagador? '
  'Expõe só um boolean (cliente_config_segregacao_ctrc é service-only). '
  'true exige flag segregacao_ctrc_enabled ON + CNPJ ativo na whitelist. '
  'Mostrar a marcação NÃO segrega nada: o executor revalida a cerca completa '
  '(cliente + oc 54/59 + aprovação humana) antes de mandar S no campo f8. '
  'Molde: card_eh_intranet_wurth (mig 335). Caio 2026-09-21.';

-- 5. Smoke test de NASCIMENTO --------------------------------------------------
-- INV-158 (novo; INV-142 é o invariante da oc 55 automática da mig 379 e estava
-- emprestado aqui por engano): nada da segregação pode nascer LIGADO.
--
-- Só roda quando ESTA execução criou a tabela (marca do bloco 0). Numa
-- reaplicação depois do go-live a PRATI estará ativa e a flag ON — situação
-- legítima que NÃO pode derrubar a migration. O que trava a regressão em regime
-- permanente é o /verify-cockpit, não este bloco: aqui é só a prova de que
-- APLICAR o arquivo não liga nada.
DO $$
DECLARE
  v_nascimento boolean :=
    coalesce(nullif(current_setting('cockpit.mig407_nascimento', true), ''), 'true')::boolean;
  v_linhas integer;
  v_ativos integer;
  v_flag boolean;
BEGIN
  IF NOT v_nascimento THEN
    RAISE NOTICE 'mig 407: cliente_config_segregacao_ctrc já existia antes desta execução — smoke de nascimento pulado (reaplicação pós go-live é legítima).';
    RETURN;
  END IF;

  SELECT count(*) INTO v_linhas FROM public.cliente_config_segregacao_ctrc;
  IF v_linhas < 2 THEN
    RAISE EXCEPTION 'Seed falhou: esperado >= 2 CNPJs da PRATI, encontrado %', v_linhas;
  END IF;

  -- INV-158: nada pode nascer ligado.
  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_segregacao_ctrc WHERE ativo;
  IF v_ativos <> 0 THEN
    RAISE EXCEPTION 'INV-158 violado: % CNPJ(s) nasceram ativos — o seed deve ser inerte', v_ativos;
  END IF;

  SELECT enabled INTO v_flag
    FROM public.feature_flags WHERE key = 'segregacao_ctrc_enabled';
  IF v_flag IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'INV-158 violado: flag segregacao_ctrc_enabled deveria nascer OFF (valor=%)', v_flag;
  END IF;

  -- A RPC do front tem de nascer dizendo "não pode" para os CNPJs seedados —
  -- prova de que aplicar esta migration não faz a marcação aparecer pra ninguém.
  IF public.cliente_pode_segregar_ctrc('73856593001057') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'INV-158 violado: cliente_pode_segregar_ctrc deveria nascer false (flag OFF + seed inativo)';
  END IF;

  -- Trava cruzada: segregar ("não pode movimentar") e seguir-parcial-auto
  -- ("autorizado a seguir para entrega") são ordens contraditórias. Um CNPJ ativo
  -- nas duas listas é erro de configuração.
  --
  -- ⚠ ESTE BLOCO É SÓ A CHECAGEM DE NASCIMENTO — roda UMA vez, na aplicação,
  --   quando por construção tudo está inativo. Ele NÃO protege a contradição
  --   depois: quem ligar os dois CNPJs amanhã, por UPDATE, não passa por aqui.
  --   A GUARDA PERMANENTE dessa contradição vive no /verify-cockpit
  --   (.claude/commands/verify-cockpit.md, item INV-158), que roda a cada
  --   commit/deploy e olha o estado REAL do banco. Decisão 21/09: NÃO resolver
  --   com trigger — trigger em tabela de config espalha regra de negócio no
  --   banco e quebra o UPDATE de ligar/desligar num lugar difícil de depurar.
  -- to_regclass: se a tabela da mig 379 não existir neste ambiente, a checagem
  -- é pulada em vez de abortar a migration inteira por uma dependência que não
  -- é dela. (plpgsql planeja a query só quando chega nela, então o IF protege.)
  IF to_regclass('public.cliente_config_seguir_parcial_auto') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.cliente_config_segregacao_ctrc s
        JOIN public.cliente_config_seguir_parcial_auto p USING (cnpj_pagador)
       WHERE s.ativo AND p.ativo
    ) THEN
      RAISE EXCEPTION
        'INV-158 violado: CNPJ ativo em segregacao_ctrc E em seguir_parcial_auto '
        '(uma manda bloquear a carga, a outra manda seguir para entrega)';
    END IF;
  ELSE
    RAISE NOTICE 'mig 407: cliente_config_seguir_parcial_auto não existe neste ambiente — trava cruzada pulada.';
  END IF;
END $$;
