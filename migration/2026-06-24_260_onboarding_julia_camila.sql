-- =============================================================================
-- 2026-06-24_260 — Onboarding JULIA (seg 003/005) + CAMILA (seg 001)
-- =============================================================================
-- Caio 2026-06-24: entram 2 operadoras.
--   JULIA  (julia.barros@salexpress.com.br)  — segmentos 003 AGRO + 005 SAUDE
--          ANIMAL. 26 clientes (planilha "Agro e Animal - Julia"). Login NOVO.
--   CAMILA (auto.pecas@salexpress.com.br)    — segmento 001 AUTO PECAS. 36
--          clientes (planilha "Auto Peças"). ASSUME a caixa/segmento do ex-CARLOS
--          (offboarded mig 207). Login NOVO (auth do Carlos deletado; auto.pecas@
--          recriado do zero — decisão Caio 2026-06-24).
--
-- Decisões Caio (registradas):
--   - Camila reaproveita a linha-seed "CAMILA" (mig 007, vazia) como identidade
--     real. NÃO renomeei CARLOS→CAMILA (preserva histórico do Carlos sob "CARLOS").
--   - Gmail OAuth de AMBAS começa NULL → Caio reconecta (não dá pra gerar token
--     por migration). Até lá: logam + veem cards, mas e-mail outbound não dispara.
--   - Senha de tracking SSW não veio nas planilhas (os 49 clientes do ex-Carlos já
--     tinham senha vazia) → tracking_credentials entram com senha='' (shell de
--     contato/e-mail; sem rastreio SSW automático até alguém preencher).
--
-- Conflitos verificados ANTES: NENHUM cliente das planilhas pertence a operador
-- ativo. Os 23 overlaps da Camila são órfãos do ex-CARLOS (mig 207) — reivindicação
-- legítima. Julia: 100% clientes novos.
--
-- Auth (já feito via Admin API, fora desta migration):
--   - DELETE auth.users b2e43520... (Carlos)  [operadores.user_id já nulado antes,
--     senão o ON DELETE CASCADE apagaria a linha CARLOS]
--   - CREATE auto.pecas@  -> 561ff973-f4c9-4ff5-8153-82eb8c6f7fe2  (Camila)
--   - CREATE julia.barros@-> 157e96b7-1f4a-4b53-93d3-cc129cf82aa3  (Julia)
--
-- skill: supabase-postgres-best-practices — idempotente (ON CONFLICT), transacional,
-- reusa índices/RLS existentes (mig 025/076), event-sourcing (card_events) p/ cada
-- reatribuição de card (invariante CLAUDE.md).
-- =============================================================================
BEGIN;

-- ============================================================================
-- 1. OPERADORES
-- ============================================================================
-- 1a. CAMILA — reaproveita linha-seed; assume segmento 001 (vago, ex-CARLOS)
UPDATE public.operadores SET
  email                   = 'auto.pecas@salexpress.com.br',
  email_relacionamento    = 'auto.pecas@salexpress.com.br',
  papel                   = 'operador',
  segmentos               = '{001}',
  cockpit_ativo           = true,
  ativo                   = true,
  user_id                 = '561ff973-f4c9-4ff5-8153-82eb8c6f7fe2',
  gmail_oauth_credentials = NULL
WHERE id = '3c9b0686-e6cc-4d98-a83d-75505a532b76' AND nome = 'CAMILA';

-- 1b. JULIA — nova operadora
INSERT INTO public.operadores
  (nome, email, email_relacionamento, papel, segmentos, carteira, cockpit_ativo, ativo, user_id)
VALUES
  ('JULIA','julia.barros@salexpress.com.br','julia.barros@salexpress.com.br',
   'operador','{003,005}','{}'::text[], true, true,
   '157e96b7-1f4a-4b53-93d3-cc129cf82aa3')
ON CONFLICT (nome) DO UPDATE SET
  email=EXCLUDED.email, email_relacionamento=EXCLUDED.email_relacionamento,
  segmentos=EXCLUDED.segmentos, cockpit_ativo=true, ativo=true,
  user_id=EXCLUDED.user_id;

-- 1c. CARLOS — aposenta (user_id/oauth já nulados antes do delete do auth)
UPDATE public.operadores SET ativo=false, cockpit_ativo=false
WHERE nome='CARLOS';

-- ============================================================================
-- 2. STAGING dos clientes das planilhas
-- ============================================================================
CREATE TEMP TABLE _onb (
  op          text,
  cnpj        text,
  nome        text,
  responsavel text,
  emails      text[],
  phone       text,
  op_id       uuid
) ON COMMIT DROP;

INSERT INTO _onb(op,cnpj,nome,responsavel,emails,phone) VALUES
  ('julia','92341312000934','BASSO PANCOTTE LTDA','Monique',ARRAY['sac@baspan.com.br']::text[],'54997138026'),
  ('julia','07932725000167','AVANTE SAUDE ANIMAL LTDA','Sonia',ARRAY['gestao-logistica@avantesa.com.br']::text[],'3190816822'),
  ('julia','38510210000100','CENTRAL DE ABAST.VETERIN.LTDA','Kathleen',ARRAY['devolucao@centralveterinaria.com.br']::text[],'3499298833'),
  ('julia','21437447001417','ADUBOS REAL SA','Thiago',ARRAY['thiago.santos@distribuidoradinac.com.br']::text[],'3599418118'),
  ('julia','27338151000100','CASAL COMERCIO E SERVICOS LTDA','Deise',ARRAY['deise.silva@nutrien.com']::text[],'3195799211'),
  ('julia','10406295000235','VIA RURAL COM DE PROD AGRO LTD','Larissa',ARRAY['sac@viaruralcorp.com.br']::text[],'6282740028'),
  ('julia','10680755000138','VETBR SAUDE ANIMAL LTDA','João',ARRAY['joaopedroleite@vetbr.com.br']::text[],'3597420639'),
  ('julia','05551606000139','DISTRIBUIDORA DISVET ARAXA LTD','Rosane',ARRAY['transporte@disvet.vet.br']::text[],'3499441058'),
  ('julia','35225170000159','VANSIL SAUDE ANIMAL REGIONAL 005 LTDA','Fabiano',ARRAY['jaquelinepinheiro@vansil.ind.br']::text[],'19996895431'),
  ('julia','02986234000690','SUPERMIX VALE DISTRIBUIDORA S.','Leonardo',ARRAY['leonardo.nascimento@pet2pet.com.br']::text[],'3195961193'),
  ('julia','29997296000572','J.A AGRO UBE','Luciana',ARRAY['logistica2@jasaudeanimal.com.br']::text[],'16997606343'),
  ('julia','08174605000100','FABIANO CARLOS DE OLIVEIRA EPP','Fabiano',ARRAY['fabianodistribuidora@gmail.com']::text[],'3299968326'),
  ('julia','63982896000171','ABASE COMERCIO E REPRESENTACOE (C.)','Beatriz',ARRAY['beatriz.menezes@covetrus.com','devolucoes@covetrus.com']::text[],'19982749666'),
  ('julia','53529379000198','SOMOS DISTRIBUIDORA LTDA','Talita',ARRAY['estoqueagroto@supersafra.com']::text[],'3335295568'),
  ('julia','10568922000153','BH VET DISTRIBUIDORA DE PRODUT','Temer',ARRAY['logistica@bhvet.com.br']::text[],'3193398548'),
  ('julia','18103861000160','PARAGRO PRODS AGROP LTDA','luiz Gustavo',ARRAY['paragrocd@paragro.agr.br']::text[],'35999294324'),
  ('julia','44683227000154','ATACAAGRO CENTRAL DE LOGISTICA','Eduardo',ARRAY['eduardo.atacaagro@gmail.com']::text[],'3598440524'),
  ('julia','27748346000129','SOLUCAO PET DISTRIBUIDORA EIRELI','Izabela',ARRAY['comercial@solucaopetmg.com.br']::text[],'3175452041'),
  ('julia','42940676000105','A VETERINARIA DISTRIBUIDORA LTDA.','Joyce',ARRAY['joyce@aveterinaria.com']::text[],'3197259981'),
  ('julia','57178664000162','ALFA MAIS DISTRIBUIDORA LTDA','vanessa',ARRAY['alfa@alfamais1.com']::text[],'3188846000'),
  ('julia','73174377000130','FARMABASE SAUDE ANIMAL LTDA','Marcos',ARRAY['marcos.santos@farmabase.com']::text[],'3784219676'),
  ('julia','19802033000264','VETTS ATACADO VETERINARIO LTDA','Leonardo',ARRAY['leonardo.nascimento@pet2pet.com.br']::text[],'3195961193'),
  ('julia','21437447002146','ADUBOS REAL S.A.','Thiago',ARRAY['thiago.santos@distribuidoradinac.com.br']::text[],'3599418118'),
  ('julia','10406295000669','VIARURAL COMERCIO DE PRODUTOS','Larissa',ARRAY['sac@viaruralcorp.com.br']::text[],'6282740028'),
  ('julia','28138113001653','CASA DO ADUBO LTDA','Jessica',ARRAY['santos.jessica@casadoadubo.com.br']::text[],'3133940106'),
  ('julia','35710254000188','CENTRAL RURAL AGRONEGOCIOS LTD (C.)',NULL,ARRAY[]::text[],NULL),
  ('camila','54120119000127','AMPMG DISTRIBUIDORA DE PECAS A','SAC',ARRAY['transporte@asamultipecas.com.br']::text[],'6232563230'),
  ('camila','11509676001284','AUTO NORTE DISTRIBUIDORA DE PECAS LTDA','Bartolomeu',ARRAY['barto.muniz@autonorte.com.br']::text[],'7933052800'),
  ('camila','31474836000666','AUTO PECAS ALONSO LTDA ME','Juliana',ARRAY['sac.global@edgarautopecas.com.br']::text[],'28999448062'),
  ('camila','62395546001380','CAR CENTRAL AUTOPCS.ROLAM.LT','Bianca',ARRAY['bianca.silva@brautoparts.com.br']::text[],'3530680921'),
  ('camila','45987005017678','COMERCIAL AUTOMOTIVA S.A.','Ana Claudia',ARRAY['aoliveira@celerelog.com.br']::text[],'1156705670'),
  ('camila','61136701000651','COML JAHU BORRACHA AUTO PECAS C','Douglas',ARRAY['douglas.barbosa@jahu.com.br']::text[],'1136190000'),
  ('camila','26013236000156','DISTRIB MINEIRA DE FILTRO (A.)','Henrique',ARRAY['controladoria@dmfautomotivos.com.br']::text[],NULL),
  ('camila','12049403001186','EMBREPAR DO BRASIL - EIRELI','Ana Brandão',ARRAY['adm02.bh@embrepar.com.br']::text[],'3125662943'),
  ('camila','08897417001778','F W DISTRIBUIDORA - BELO HORIZONTE','Elizandra',ARRAY['sacfw@furacao.com.br']::text[],'1921013000'),
  ('camila','08897417000291','F W DISTRIBUIDORA - CAMPINAS','Elizandra',ARRAY['sacfw@furacao.com.br']::text[],'1921013000'),
  ('camila','22761584007406','FORTBRAS AUTOPECAS S.A.','Pamela',ARRAY['pamela.santos@fortbras.com.br']::text[],NULL),
  ('camila','38843249000727','G E B AUTO PECAS ALTERNATIVAS','Liliane',ARRAY['sac@gb.com.br']::text[],'1135279963'),
  ('camila','81676009001190','GIRANDO COMERCIO DE PECAS LTDA','Viane/João',ARRAY['vendas.contagem@rolemar.com','contagem@rolemar.com']::text[],'3137686675'),
  ('camila','04098359000102','GMI DISTRIBUIDORA LTDA','Eduardo',ARRAY['logistica02@gmibh.com.br']::text[],'3134393613'),
  ('camila','02125218000874','HIPERCG COMERCIO E IMPORTACAO DE PECAS LTDA','Jaqueline',ARRAY['jaqueline.hipercg@gmail.com']::text[],'38991098703'),
  ('camila','88613922001430','IMDEPA ROLAMENTOS IMPORTACAO E COMERCIO LTDA','Daiana',ARRAY['daiana.rupp@imdepa.com.br']::text[],'51993222614'),
  ('camila','44337958000148','IMPAR ATACADISTA DE PECAS LTDA','Elias',ARRAY['elias@imparford.com.br']::text[],'37991097422'),
  ('camila','06250329000197','MACROLUB ATACADO AUTOMOTIVO LTDA','Hugo',ARRAY['logistica@rmservicos.net']::text[],'27997921963'),
  ('camila','18707422000167','MARKA VEICULOS E PECAS S/A','Reinaldo',ARRAY['reinaldo@imparford.com.br']::text[],NULL),
  ('camila','07571746003896','MG VIDROS AUTOMOTIVOS LTDA','João L Farias',ARRAY['ocorrencias.frete@autoglass.com.br']::text[],'2721443306'),
  ('camila','48771454000192','MIX LUB DISTRIBUDIORA LTDA','Milene',ARRAY['mixtopdistribuidora@yahoo.com.br','ctegrupomixtop@yahoo.com.br']::text[],NULL),
  ('camila','65773814000538','NEWKAR DISTRIBUIDORA DE PECAS','Breno',ARRAY['transporte2@newkarminas.com.br']::text[],'3121386538'),
  ('camila','50641385000144','PATRAL MINAS PECAS LTDA','Tiago',ARRAY['tiago.leite@patral.com.br']::text[],NULL),
  ('camila','13188654000132','PREMIER ATACADISTA DE IPATINGA LTDA','Logística',ARRAY['logistica@premieratacadista.com.br']::text[],'3172383864'),
  ('camila','10619557000592','PTD COMERCIO DE PECAS LTDA','Maryna Fernandes',ARRAY['financeiro.bh@ptd.com.br']::text[],'31993870484'),
  ('camila','05916095000101','REDE ANCORA MG IMPORTADORA EXP E DI STR DE AUTO PECAS SA','Robson',ARRAY['robson.amorim@redeancora.com.br']::text[],'31972358280'),
  ('camila','12612199000198','RET COMERCIO DE AUTO PECAS LTDA','Flavia',ARRAY['flavia.guimaraes@infinitysp.com.br']::text[],'2730891823'),
  ('camila','08237002000453','SK AUTOMOTIVE S/A','Jose hombert',ARRAY['jose.hombert@skautomotive.com.br']::text[],'34931929198'),
  ('camila','01784496000528','SOCIAL DISTRIBUIDORA LTDA - FILIAL MG','Kaiky',ARRAY['transporte@socialdistribuidora.com.br']::text[],NULL),
  ('camila','54264319000315','SUPPORT DO BRASIL SOLUCOES AUTOMOTIVAS S.A.','Jose Antonio',ARRAY['jose.antonio@supportdobrasil.com.br']::text[],'31995716697'),
  ('camila','90136409001951','TSD LOGISTICA E DISTRIBUIDORA LTDA (TOLI)','Patricia',ARRAY['jayne.cristovam@tolidistribuidora.com.br','patricia.locatelli@tolidistribuidora.com.br']::text[],'5496502058'),
  ('camila','03747886000472','TVH BRASIL PECAS LTDA','SAC',ARRAY['joao.benvegnu@tvh.com','posvendas@tvh.com']::text[],'19996700139'),
  ('camila','41916347000166','UNIFORT LTDA','Virginia/Gustavo',ARRAY['sac@unifort.com.br','julia.silva@unifort.com.br']::text[],'3197052788'),
  ('camila','07395207000151','UNIVERSAL AUTOMOTIVE SYSTEMS S/A','SAC',ARRAY['transporte@universalautomotive.com.br','carolina.baatsck@universalautomotive.com.br']::text[],'11949330139'),
  ('camila','04771370001074','VESPOR AUTOMOTIVE DISTRIBUIDORA DE AUTO PECA LTDA','SAC',ARRAY['cav@vespor.com.br']::text[],'4488432191'),
  ('camila','31454296000144','XINIC COMERCIO E SERVICOS DE PRODUTOS AUTOMOTIVOS EIRELI','SAC',ARRAY['financeiro@xinic.com.br','ana.nunes@xinic.com.br']::text[],'3171465899');

-- resolve op_id
UPDATE _onb SET op_id = (SELECT id FROM public.operadores WHERE nome='CAMILA') WHERE op='camila';
UPDATE _onb SET op_id = (SELECT id FROM public.operadores WHERE nome='JULIA')  WHERE op='julia';

-- ============================================================================
-- 3. tracking_credentials (shell de contato; senha vazia, igual ex-Carlos)
-- ============================================================================
INSERT INTO public.tracking_credentials
  (documento, nome_amigavel, senha, notes, ativo, operador_responsavel_id, updated_by)
SELECT cnpj, nome, '', 'onboarding mig 260', true, op_id, op_id
FROM _onb
ON CONFLICT (documento) DO UPDATE SET
  nome_amigavel           = EXCLUDED.nome_amigavel,
  ativo                   = true,
  operador_responsavel_id = EXCLUDED.operador_responsavel_id,
  updated_by              = EXCLUDED.updated_by,
  notes                   = COALESCE(public.tracking_credentials.notes,'') || ' | onboarding mig 260';

-- ============================================================================
-- 4. clientes (catálogo CNPJ → nome → segmento) — ANTES de contatos (FK
--    contatos_cliente.documento_cliente -> clientes.cnpj_cpf)
-- ============================================================================
INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
SELECT cnpj, nome,
       CASE op WHEN 'camila' THEN '001' ELSE NULL END,
       CASE op WHEN 'camila' THEN 'AUTO PECAS' ELSE 'AGRO / SAUDE ANIMAL' END,
       true
FROM _onb
ON CONFLICT (cnpj_cpf) DO UPDATE SET
  nome=EXCLUDED.nome, ativo=true,
  segmento_codigo=COALESCE(EXCLUDED.segmento_codigo, public.clientes.segmento_codigo),
  segmento_nome=EXCLUDED.segmento_nome;

-- ============================================================================
-- 5. contatos_cliente — rewrite (DELETE + INSERT emails + dominios), espelha RPC
-- ============================================================================
DELETE FROM public.contatos_cliente
WHERE documento_cliente IN (SELECT cnpj FROM _onb);

-- emails (ordem = posição no array); 1º email leva responsavel + telefone na obs
INSERT INTO public.contatos_cliente
  (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, observacao, ativo, operador_responsavel_id)
SELECT o.cnpj, 'email', e.email, e.ord, 'geral',
       CASE WHEN e.ord=1 THEN o.responsavel END,
       CASE WHEN e.ord=1 AND o.phone IS NOT NULL THEN 'tel: '||o.phone END,
       true, o.op_id
FROM _onb o
CROSS JOIN LATERAL unnest(o.emails) WITH ORDINALITY AS e(email, ord);

-- dominios distintos por cliente
INSERT INTO public.contatos_cliente
  (documento_cliente, tipo, identificador, ordem, tipo_uso, ativo, operador_responsavel_id)
SELECT DISTINCT o.cnpj, 'dominio', lower(split_part(e.email,'@',2)), 1, 'geral', true, o.op_id
FROM _onb o
CROSS JOIN LATERAL unnest(o.emails) AS e(email)
WHERE split_part(e.email,'@',2) <> '';

-- ============================================================================
-- 6. carteira (CNPJs exatos) nos operadores — visibilidade RLS precisa
-- ============================================================================
UPDATE public.operadores SET carteira = (SELECT array_agg(cnpj ORDER BY cnpj) FROM _onb WHERE op='camila')
WHERE nome='CAMILA';
UPDATE public.operadores SET carteira = (SELECT array_agg(cnpj ORDER BY cnpj) FROM _onb WHERE op='julia')
WHERE nome='JULIA';

-- ============================================================================
-- 7. Reatribuição de cards ativos por segmento (event-sourced)
-- ============================================================================
DO $$
DECLARE
  v_camila uuid; v_julia uuid; v_cnt int;
BEGIN
  SELECT id INTO v_camila FROM public.operadores WHERE nome='CAMILA';
  SELECT id INTO v_julia  FROM public.operadores WHERE nome='JULIA';

  -- 7a. seg 001 → CAMILA
  WITH afet AS (
    SELECT id, responsavel_relacionamento resp_old, assigned_operator_id aid_old
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND agent_state->>'segmento_cliente' LIKE '001%'
      AND (assigned_operator_id IS DISTINCT FROM v_camila OR segmento_codigo IS DISTINCT FROM '001')
  ), upd AS (
    UPDATE public.cards c SET
      responsavel_relacionamento='CAMILA', assigned_operator_id=v_camila, segmento_codigo='001'
    FROM afet a WHERE c.id=a.id
    RETURNING c.id, a.resp_old, a.aid_old
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','onboarding_mig_260',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo','CAMILA','motivo','Onboarding Camila — segmento 001 (ex-CARLOS)','segmento','001')
  FROM upd;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'seg 001 -> CAMILA: % cards', v_cnt;

  -- 7b. seg 003 + 005 → JULIA
  WITH afet AS (
    SELECT id, responsavel_relacionamento resp_old, assigned_operator_id aid_old,
           left(agent_state->>'segmento_cliente',3) seg
    FROM public.cards
    WHERE state NOT IN ('RESOLVIDO','CANCELADO')
      AND (agent_state->>'segmento_cliente' LIKE '003%' OR agent_state->>'segmento_cliente' LIKE '005%')
      AND assigned_operator_id IS DISTINCT FROM v_julia
  ), upd AS (
    UPDATE public.cards c SET
      responsavel_relacionamento='JULIA', assigned_operator_id=v_julia,
      segmento_codigo=a.seg
    FROM afet a WHERE c.id=a.id
    RETURNING c.id, a.resp_old, a.aid_old, a.seg
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id,'OperadorReatribuido','system','onboarding_mig_260',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo','JULIA','motivo','Onboarding Julia — segmento '||seg,'segmento',seg)
  FROM upd;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RAISE NOTICE 'seg 003/005 -> JULIA: % cards', v_cnt;
END $$;

COMMIT;
