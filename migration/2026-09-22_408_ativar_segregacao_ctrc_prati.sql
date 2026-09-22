-- =============================================================================
-- 408 — ATIVA a marcação "Segregar CTRC" para a PRATI
-- =============================================================================
-- Carlos 2026-09-22. Este é o ato que LIGA a feature entregue pela mig 407.
-- Até aqui tudo estava instalado e inerte: flag `false`, os 2 CNPJs com
-- `ativo=false`, e `cliente_pode_segregar_ctrc()` devolvendo `false`.
--
-- O QUE MUDA PRA OPERADORA: nos cards de extravio da PRATI com proposta de
-- oc 54 ou 59, passa a aparecer a caixa "Segregar CTRC" na hora de aprovar.
-- Medido em produção AGORA, imediatamente antes de aplicar:
--   - 637 cards da PRATI;
--   - 42 propostas de 54/59 abertas, das quais 10 estão em card de extravio;
--   - essas 10 vivem em 9 cards — essa é a superfície exata que muda hoje.
--
-- O QUE **NÃO** MUDA: ligar não segrega nada sozinho. Continua sendo escolha
-- humana em CADA card, e a cerca do executor revalida as 4 condições do zero
-- (whitelist + oc ∈ {54,59} + card de extravio ∈ {6,9,16,49} + origem humana
-- comprovada). Robô nunca segrega.
--
-- PRÉ-CONDIÇÕES CONFERIDAS ANTES DE APLICAR (não presumidas — medidas):
--   a) mig 407 aplicada: tabela, RPC e flag existem;
--   b) as 26 edge functions DEPLOYADAS (2026-09-22 13:04Z, executor v167,
--      sync-bastao v268, vinculador v141) — `deploy_pendente.py` zerado.
--      Ligar a flag com edge velha produziria "segregação fantasma": a tela
--      promete, o SSW recebe f8=N, nenhum evento explica a diferença;
--   c) ZERO caminho automático: dos 42 todos de 54/59 da PRATI, NENHUM tem
--      `auto_approval_rule`; zero `acoes_agendadas` do tipo
--      `executar_acao_autonoma` armadas nesses cards; e a flag global
--      `autonomia_fatias_enabled` está `false`.
--
-- ⚠ IRREVERSIBILIDADE — a razão de tudo isto ser tão cercado: segregar bloqueia
--   o CT-e para transferência, movimentação e entrega. A carga PARA no armazém.
--   **O Cockpit NÃO desfaz.** A retirada é MANUAL, pela opção 091 do SSW, feita
--   por um operador. Desligar esta migration impede NOVAS segregações; NÃO
--   solta nenhuma carga já barrada.
--
-- ⚠ O TESTE REAL NÃO ACONTECEU, e o registro precisa dizer isso. A mig 407
--   semeou a observação "Aguardando teste real no CT-e de teste antes de
--   ativar". O CT-e de teste disponível (AMB633145-9 / NF 1, pagador AMPLA
--   ODONTO, CNPJ 54058693000100) **não é da PRATI**, então testá-lo exigiria
--   liberar temporariamente um CNPJ fora do escopo — o oposto da regra
--   "EXCLUSIVAMENTE para a PRATI". O Carlos foi informado disso e decidiu
--   ativar assim mesmo. O bloco 2 abaixo REESCREVE aquela observação para o
--   registro não continuar afirmando uma condição que foi dispensada.
--
-- RECEITA DE REVERSÃO (pelo trilho, TIPO B) — impede novas segregações:
--   UPDATE public.feature_flags SET enabled=false
--     WHERE key='segregacao_ctrc_enabled';
--   -- (opcional, mais cirúrgico: desativar só um CNPJ)
--   UPDATE public.cliente_config_segregacao_ctrc SET ativo=false
--     WHERE cnpj_pagador IN ('73856593001057','73856593000166');
--   Efeito: a caixa some da tela e o executor volta a recusar. NÃO retira
--   segregação já lançada no SSW — isso é manual, opção 091, sempre.
--
-- ⚠ SEM BEGIN/COMMIT interno (política de migrations, 13/08): o `scripts/dbq.py`
--   já embrulha o arquivo na transação dele.
--
-- AUTORIZACAO (ritual de deploy, passo 5) — TIPO B exige declaracao:
--   "Carlos, 2026-09-22: ordem no chat — escolheu 'Ligar agora para a PRATI'
--    quando perguntado se ativava ou deixava desligado, ciente de que o teste
--    real no CT-e não ocorreu e de que a retirada da segregação é manual
--    (SSW opção 091). Escopo inalterado: só PRATI, só oc 54/59, só card de
--    extravio, só aprovação humana."
-- Autonomia do Carlos pra TIPO B: docs/POLITICA_MIGRATIONS.md seção 3.
-- Âncoras: mig 407; ADR 0033; INV-158; commit de merge 81d5e7f.
-- =============================================================================

-- 1. Kill-switch mestre: ON ----------------------------------------------------
-- Enquanto esta flag estiver false, `cliente_pode_segregar_ctrc` devolve false
-- para todo mundo e a cerca do executor recusa, mesmo com CNPJ ativo. É o
-- botão de pânico: desligar aqui mata a feature inteira sem deploy.
UPDATE public.feature_flags
   SET enabled = true,
       description = 'Carlos 2026-09-22: LIGADA. Libera a marcação "Segregar CTRC" '
                     '(campo f8 da tela 101) para os CNPJs ativos em '
                     'cliente_config_segregacao_ctrc, nas ocs 54/59 dos cards de '
                     'extravio, apenas em aprovação humana comprovada. Desligar aqui '
                     'impede NOVAS segregações; NÃO solta carga já barrada (091 é manual).'
 WHERE key = 'segregacao_ctrc_enabled';

-- 2. Os 2 CNPJs do grupo PRATI: ativos ----------------------------------------
-- `autorizado_por` e `autorizado_em` passam a registrar quem mandou LIGAR —
-- é essa a pergunta que importa quando uma carga aparece parada no armazém e
-- alguém precisa saber a quem recorrer. O escopo (quais CNPJs) continua sendo
-- do Caio, 21/09; a ativação é do Carlos, hoje. Os dois ficam escritos.
-- A observação antiga ("Aguardando teste real ... antes de ativar") é
-- REESCRITA: deixar o texto velho faria o banco afirmar uma condição que foi
-- conscientemente dispensada.
UPDATE public.cliente_config_segregacao_ctrc
   SET ativo = true,
       autorizado_por = 'Caio (escopo, chat 21/09); ATIVADO por Carlos (chat 22/09)',
       autorizado_em = DATE '2026-09-22',
       observacao = CASE cnpj_pagador
         WHEN '73856593001057' THEN
           'Estabelecimento com movimento. Medido em 22/09 na ativação: 637 cards no '
           'grupo PRATI, 42 propostas de 54/59 abertas, 10 delas em card de extravio '
           '(9 cards) — essa era a superfície no momento de ligar. Ativado SEM o teste '
           'real no CT-e: o CT-e de teste (AMB633145-9, AMPLA ODONTO) não é da PRATI e '
           'usá-lo exigiria liberar CNPJ fora do escopo. Decisão do Carlos, 22/09.'
         WHEN '73856593000166' THEN
           'Sem card até 22/09. Ativado junto para o grupo não ficar pela metade — se '
           'um card deste estabelecimento aparecer, a regra já vale (lição da mig 387 / '
           'oc 13). Mesma decisão do Carlos, 22/09, sem teste real no CT-e.'
         ELSE observacao END
 WHERE cnpj_pagador IN ('73856593001057', '73856593000166');

-- 3. Smoke test — a migration derruba a si mesma se o efeito não for o esperado
-- Cada checagem abaixo corresponde a uma promessa feita no cabeçalho. Sem isto
-- a migration "aplica" e só descobriríamos o contrário na tela da operadora.
DO $$
DECLARE
  v_flag       boolean;
  v_ativos     int;
  v_sem_dono   int;
  v_rpc_1057   boolean;
  v_rpc_0166   boolean;
  v_rpc_outro  boolean;
  v_cruzada    int;
BEGIN
  SELECT enabled INTO v_flag FROM public.feature_flags
   WHERE key = 'segregacao_ctrc_enabled';
  IF v_flag IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 408: a flag mestra nao ficou ON (valor=%)', v_flag;
  END IF;

  SELECT count(*) INTO v_ativos
    FROM public.cliente_config_segregacao_ctrc WHERE ativo;
  IF v_ativos <> 2 THEN
    RAISE EXCEPTION 'mig 408: esperava exatamente 2 CNPJs ativos, achei %', v_ativos;
  END IF;

  -- O CHECK da mig 407 ja proibe ativo sem dono; aqui e cinto e suspensorio,
  -- porque "ordem de barrar carga sem dono" e o pior modo de falha do registro.
  SELECT count(*) INTO v_sem_dono
    FROM public.cliente_config_segregacao_ctrc
   WHERE ativo AND (autorizado_por IS NULL OR btrim(autorizado_por) = ''
                    OR autorizado_em IS NULL);
  IF v_sem_dono > 0 THEN
    RAISE EXCEPTION 'mig 408: % CNPJ(s) ativo(s) sem dono registrado', v_sem_dono;
  END IF;

  -- O canal que a TELA usa tem de concordar com a tabela. Se divergir, a
  -- operadora ve (ou nao ve) a caixa por motivo que ninguem consegue explicar.
  SELECT public.cliente_pode_segregar_ctrc('73856593001057') INTO v_rpc_1057;
  SELECT public.cliente_pode_segregar_ctrc('73856593000166') INTO v_rpc_0166;
  IF v_rpc_1057 IS DISTINCT FROM true OR v_rpc_0166 IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'mig 408: RPC nao liberou a PRATI (1057=%, 0166=%)',
      v_rpc_1057, v_rpc_0166;
  END IF;

  -- Fail-closed preservado: quem NAO esta na lista continua recebendo false.
  -- Uso o CNPJ do CT-e de teste (AMPLA ODONTO), que e justamente o que NAO
  -- pode passar a poder segregar por efeito colateral desta ativacao.
  SELECT public.cliente_pode_segregar_ctrc('54058693000100') INTO v_rpc_outro;
  IF v_rpc_outro IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'mig 408: cliente FORA da whitelist passou a poder segregar (%)',
      v_rpc_outro;
  END IF;

  -- Trava cruzada do INV-158: barrar a carga e deixar a carga seguir sao
  -- ordens contraditorias para o mesmo CNPJ.
  IF to_regclass('public.cliente_config_seguir_parcial_auto') IS NOT NULL THEN
    SELECT count(*) INTO v_cruzada
      FROM public.cliente_config_segregacao_ctrc s
      JOIN public.cliente_config_seguir_parcial_auto p
        ON p.cnpj_pagador = s.cnpj_pagador
     WHERE s.ativo AND p.ativo;
    IF v_cruzada > 0 THEN
      RAISE EXCEPTION 'mig 408: % CNPJ(s) ativo(s) nas DUAS listas (segregar x seguir parcial) — ordens contraditorias', v_cruzada;
    END IF;
  END IF;

  RAISE NOTICE 'mig 408 OK: flag ON, 2 CNPJs ativos com dono, RPC libera a PRATI e barra quem esta fora, sem conflito com a 55 automatica.';
END $$;
