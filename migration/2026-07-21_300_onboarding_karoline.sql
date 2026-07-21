-- =============================================================================
-- 2026-07-21_300 — Onboarding KAROLINE (assume clientes de LARISSA + CENTERVIDA de ISA E KAROL)
-- =============================================================================
-- Caio 2026-07-21: entra a operadora KAROLINE (karoline.eduarda@salexpress.com.br),
-- que assume 21 clientes farma/hospitalar. 20 são hoje da LARISSA; 1 (CENTERVIDA,
-- CNPJ 10369301000140) é hoje do ISA E KAROL (a mig 288 moveu de Larissa→ISA/KAROL
-- em 02/07; a planilha nova reverte pra Karoline — "planilha = verdade"). 1 filial
-- MED CENTER (00874929000573) está sem carteira (órfão) e entra limpo.
--
-- Reatribuição de DONO (dado, não bug), escopada aos 21 CNPJs da planilha.
--
-- DECISÕES DO CAIO (2026-07-21):
--   1. KAROLINE = operadora NOVA e independente (≠ "Karol" do ISA E KAROL). nome='KAROLINE'.
--   2. Carteira-only: segmentos='{}'. Só os 21 CNPJs.
--   3. Ativar JUNTO (ativo=true, cockpit_ativo=true) — cards vivos não podem orfanar.
--   4. Reatribui SÓ cards ATIVOS: state NOT IN (RESOLVIDO,CANCELADO,TRANSFERIDO). Os
--      TRANSFERIDO (histórico/superado, fora do índice uniq_cards_nf_active) ficam
--      atribuídos a quem tratou — histórico intacto, blast radius mínimo (~74 cards).
--   5. Move de QUALQUER dono atual (Larissa OU ISA E KAROL OU órfão) → Karoline.
--   6. E-mail: respostas caem no card da Karoline (thread→card→dono) E fisicamente na
--      caixa Gmail dela via filtro forward-only na conta da Larissa (ver PLANO_ONBOARDING.md).
--
-- VÍNCULO EM 4 CAMADAS (espelha mig 288): carteira / contatos_cliente /
-- tracking_credentials / cards+card_events.
--
-- GUARDAS (abortam tudo): G1 _onb vazia; G2 user_id sentinela; G3 LARISSA+ISA E KAROL
-- existem; G4 nenhum CNPJ em operador ATIVO inesperado (≠ LARISSA/ISA E KAROL/KAROLINE).
--
-- INVARIANTES: nunca toca state/nf; zera cards.segmento_codigo (sem vazamento);
-- match por agent_state->>cnpj_pagador (lpad14 os 2 lados); 1 card_event por card.
--
-- skill: supabase-postgres-best-practices — idempotente, transacional, blast radius
-- pequeno, schema-qualified, sem SECURITY DEFINER novo.
-- =============================================================================
BEGIN;

-- CONFIG — user_id real do auth.users da KAROLINE (criado via Admin API 2026-07-21).
CREATE TEMP TABLE _cfg ON COMMIT DROP AS
SELECT 'ed4259d6-15c6-4aa2-aafe-0963967aeb43'::uuid AS karoline_uid;

-- 1. STAGING _onb (21 clientes da planilha "Clientes - Karoline.xlsx", dedup por CNPJ)
CREATE TEMP TABLE _onb (
  cnpj text, nome text, responsavel text, emails text[], phone text,
  senha_ssw text, segmento_codigo text, segmento_nome text
) ON COMMIT DROP;

INSERT INTO _onb (cnpj, nome, responsavel, emails, phone, senha_ssw, segmento_codigo, segmento_nome) VALUES
  ('00874929000140','MED CENTER COML LTDA','SAC',ARRAY['sac@medcentercomercial.com.br']::text[],NULL,'','',''),
  ('00874929000301','MED CENTER COML LTDA','MERCELO',ARRAY['marcelo@medcentercomercial.com.br']::text[],NULL,'','',''),
  ('00874929000492','MED CENTER COML LTDA','MERCELO',ARRAY['marcelo@medcentercomercial.com.br']::text[],NULL,'','',''),
  ('00874929000573','MED CENTER COML LTDA','SAC',ARRAY['sac@medcentercomercial.com.br']::text[],NULL,'','',''),
  ('01955600000176','UL QUIMICA E CIENTIFICA LTDA','ALEXANDRO',ARRAY['alexandro.poleze@unionlab.com.br']::text[],NULL,'','',''),
  ('02248312000144','CEPALAB LABORATORIOS LTDA','EDUARDO',ARRAY['eduardo.alves@cepalab.com.br']::text[],NULL,'','',''),
  ('03945035000191','ACACIA COM DE MEDIC LTDA','MARIA FERNANDA',ARRAY['auxiliologistica@acacia.med.br','logistica@acacia.med.br']::text[],NULL,'','',''),
  ('05194502000114','ALFALAGOS LTDA','SAC',ARRAY['sac1@alfalagos.com.br']::text[],NULL,'','',''),
  ('08231734000517','FUTURA COMERCIO DE PRODUTOS MEDICOS HOSPITALARES LTDA','PATRCIA',ARRAY['faturamentofuturamg@futuramedicamentos.com.br','rtfuturamg@futuramedicamentos.com.br']::text[],NULL,'','',''),
  ('09182725000112','ATIVA MED CIR EIRELI','SAC',ARRAY['bsilva@ativahospitalar.com.br','tgomes@ativahospitalar.com.br','faturamento@ativahospitalar.com.br']::text[],NULL,'','',''),
  ('10369301000140','CENTERVIDA DIAGNOSTICA LTDA','MATHEUS',ARRAY['logistica@jpdiagnostica.com.br']::text[],NULL,'','',''),
  ('11872656000110','HDL LOGISTICA HOSPITALAR LTDA','SAC',ARRAY['transporte.udi@hdlhospitalar.com.br']::text[],NULL,'','',''),
  ('12889035000293','INOVAMED HOSPITALAR LTDA','SAC',ARRAY['sac@inovamedhospitalar.com']::text[],NULL,'','',''),
  ('12927876000167','SOMA MG PROD HOSPIT LTDA','LEANDRO',ARRAY['logistica1.mg@somahospitalar.com.br','faturamento.mg@somahospitalar.com.br']::text[],NULL,'','',''),
  ('21681325000157','MULTIFARMA COML LTDA','DAYANE',ARRAY['expedicao@multifarma.com.br']::text[],NULL,'','',''),
  ('25031668000127','SAMEH SOLUCOES HOSPITALARES LTDA','LEANDRO',ARRAY['leandro.silva@sameh.com.br']::text[],NULL,'','',''),
  ('28738688000120','LEONE COMERCIO E D. DE PRODUTO','SAC',ARRAY['comercial3@lifenutri.com.br','comercial2@lifenutri.com.br']::text[],NULL,'','',''),
  ('28738688000554','LEONE COMERCIO E DISTRIBUICAO DE PRODUTOS NUTRICIONAIS LTDA','SAC',ARRAY['comercial2@lifenutri.com.br','comercial3@lifenutri.com.br']::text[],NULL,'','',''),
  ('31495759000116','SIRIO PHARMA LTDA','MARCELLY',ARRAY['farmaceutica@siriopharma.com.br']::text[],NULL,'','',''),
  ('40021146000138','LEONE E COLDIBELLI COM. E DIST (C.)','SAC',ARRAY['comercial2@lifenutri.com.br','comercial3@lifenutri.com.br']::text[],NULL,'','',''),
  ('67729178000491','COM.CIRURGI. RIOCLARENSE LTDA','CHISTIAN',ARRAY['transporte6@rioclarense.com.br','atendimento.transportes6@rioclarense.com.br','atendimento.transportes9@rioclarense.com.br','atendimento.transportes5@rioclarense.com.br','atendimento.transportes8@rioclarense.com.br','lidiane.santana@rioclarense.com.br','transporte2@rioclarense.com.br']::text[],NULL,'','','');

-- cnpj só-dígitos (sem lpad; lpad14 é aplicado só no match de card, nos 2 lados)
UPDATE _onb SET cnpj = regexp_replace(coalesce(cnpj,''), '\D', '', 'g');

-- 2. GUARDAS
DO $$
DECLARE
  v_uid uuid := (SELECT karoline_uid FROM _cfg);
  v_n int; v_larissa uuid; v_isakarol uuid; v_conflito text;
BEGIN
  SELECT count(*) INTO v_n FROM _onb;
  IF v_n = 0 THEN RAISE EXCEPTION 'STOP G1: _onb vazia.'; END IF;
  IF v_uid = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'STOP G2: user_id sentinela.'; END IF;
  SELECT id INTO v_larissa  FROM public.operadores WHERE nome='LARISSA';
  SELECT id INTO v_isakarol FROM public.operadores WHERE nome='ISA E KAROL';
  IF v_larissa IS NULL OR v_isakarol IS NULL THEN
    RAISE EXCEPTION 'STOP G3: LARISSA(%) ou ISA E KAROL(%) não encontrado.', v_larissa, v_isakarol; END IF;
  -- G4: dono ATIVO inesperado (fora das fontes aprovadas) => aborta
  SELECT string_agg(DISTINCT o.nome||':'||c.cnpj, ', ') INTO v_conflito
  FROM _onb c JOIN public.operadores o
    ON c.cnpj = ANY(o.carteira) AND o.ativo AND o.nome NOT IN ('LARISSA','ISA E KAROL','KAROLINE');
  IF v_conflito IS NOT NULL THEN
    RAISE EXCEPTION 'STOP G4: CNPJ em operador ativo inesperado: %', v_conflito; END IF;
  RAISE NOTICE 'mig 300 guardas OK: % clientes', v_n;
END $$;

-- 3. OPERADORA KAROLINE (upsert por nome UNIQUE; ativa junto)
INSERT INTO public.operadores
  (nome, email, email_relacionamento, nome_email_outbound, papel, segmentos, carteira, cockpit_ativo, ativo, user_id)
VALUES
  ('KAROLINE','karoline.eduarda@salexpress.com.br','karoline.eduarda@salexpress.com.br','Karoline',
   'operador','{}'::text[],'{}'::text[], true, true, (SELECT karoline_uid FROM _cfg))
ON CONFLICT (nome) DO UPDATE SET
  email=EXCLUDED.email, email_relacionamento=EXCLUDED.email_relacionamento,
  nome_email_outbound=EXCLUDED.nome_email_outbound, papel='operador', segmentos='{}'::text[],
  cockpit_ativo=true, ativo=true, user_id=EXCLUDED.user_id;

-- 4. VÍNCULO 4 CAMADAS + reatribuição de cards ATIVOS
DO $$
DECLARE v_karoline uuid; v_cart int; v_cli int; v_cont int; v_track int; v_cards int;
BEGIN
  SELECT id INTO v_karoline FROM public.operadores WHERE nome='KAROLINE';

  -- CAMADA 1: carteira — remove os 21 CNPJs de QUALQUER operador (≠ Karoline), seta Karoline
  UPDATE public.operadores o
     SET carteira = (SELECT coalesce(array_agg(x ORDER BY x),'{}') FROM unnest(o.carteira) x
                     WHERE x <> ALL (SELECT cnpj FROM _onb))
   WHERE o.nome <> 'KAROLINE'
     AND o.carteira && (SELECT array_agg(cnpj) FROM _onb);

  UPDATE public.operadores SET carteira = (SELECT array_agg(DISTINCT cnpj ORDER BY cnpj) FROM _onb)
   WHERE id = v_karoline;
  SELECT count(DISTINCT cnpj) INTO v_cart FROM _onb;

  -- CAMADA 4a (catálogo): clientes
  INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
  SELECT cnpj, nome, NULLIF(segmento_codigo,''), NULLIF(segmento_nome,''), true FROM _onb
  ON CONFLICT (cnpj_cpf) DO UPDATE SET nome=EXCLUDED.nome, ativo=true,
    segmento_codigo=COALESCE(EXCLUDED.segmento_codigo, public.clientes.segmento_codigo),
    segmento_nome=COALESCE(EXCLUDED.segmento_nome, public.clientes.segmento_nome);
  GET DIAGNOSTICS v_cli = ROW_COUNT;

  -- CAMADA 2: contatos_cliente (rewrite escopado)
  DELETE FROM public.contatos_cliente
   WHERE regexp_replace(documento_cliente,'\D','','g') IN (SELECT cnpj FROM _onb);
  INSERT INTO public.contatos_cliente
    (documento_cliente,tipo,identificador,ordem,tipo_uso,nome_pessoa,observacao,ativo,operador_responsavel_id)
  SELECT o.cnpj,'email',lower(e.email),e.ord,'geral',
         CASE WHEN e.ord=1 THEN o.responsavel END,
         CASE WHEN e.ord=1 AND o.phone IS NOT NULL AND o.phone<>'' THEN 'tel: '||o.phone END,
         true,v_karoline
  FROM _onb o CROSS JOIN LATERAL unnest(o.emails) WITH ORDINALITY AS e(email,ord)
  WHERE e.email IS NOT NULL AND position('@' in e.email)>1;
  INSERT INTO public.contatos_cliente
    (documento_cliente,tipo,identificador,ordem,tipo_uso,ativo,operador_responsavel_id)
  SELECT DISTINCT o.cnpj,'dominio',lower(split_part(e.email,'@',2)),1,'geral',true,v_karoline
  FROM _onb o CROSS JOIN LATERAL unnest(o.emails) AS e(email)
  WHERE split_part(coalesce(e.email,''),'@',2)<>'';
  GET DIAGNOSTICS v_cont = ROW_COUNT;

  -- CAMADA 3: tracking_credentials
  INSERT INTO public.tracking_credentials
    (documento,nome_amigavel,senha,notes,ativo,operador_responsavel_id,updated_by)
  SELECT cnpj,nome,COALESCE(NULLIF(senha_ssw,''),''),'onboarding mig 300',true,v_karoline,v_karoline FROM _onb
  ON CONFLICT (documento) DO UPDATE SET
    nome_amigavel=EXCLUDED.nome_amigavel,
    senha=CASE WHEN EXCLUDED.senha<>'' THEN EXCLUDED.senha ELSE public.tracking_credentials.senha END,
    ativo=true, operador_responsavel_id=v_karoline, updated_by=v_karoline,
    notes=COALESCE(public.tracking_credentials.notes,'')||' | onboarding mig 300';
  GET DIAGNOSTICS v_track = ROW_COUNT;

  -- CAMADA 4b: cards ATIVOS (exclui TRANSFERIDO) de QUALQUER dono → KAROLINE + card_events
  WITH afet AS (
    SELECT c.id, c.responsavel_relacionamento resp_old, c.assigned_operator_id aid_old,
           lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') cnpj
    FROM public.cards c
    WHERE lpad(regexp_replace(c.agent_state->>'cnpj_pagador','\D','','g'),14,'0') IN (SELECT lpad(cnpj,14,'0') FROM _onb)
      AND c.state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')
      AND c.assigned_operator_id IS DISTINCT FROM v_karoline
  ), upd AS (
    UPDATE public.cards c SET assigned_operator_id=v_karoline,
           responsavel_relacionamento='KAROLINE', segmento_codigo=NULL
    FROM afet a WHERE c.id=a.id RETURNING c.id, a.resp_old, a.aid_old, a.cnpj
  )
  INSERT INTO public.card_events (card_id,event_type,actor_type,actor_id,payload)
  SELECT id,'OperadorReatribuido','system','onboarding_mig_300',
    jsonb_build_object('responsavel_anterior',resp_old,'assigned_anterior',aid_old,
      'responsavel_novo','KAROLINE','cnpj_pagador',cnpj,
      'motivo','Onboarding Karoline 2026-07-21 (planilha=verdade; ativos only)')
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;

  RAISE NOTICE 'mig 300 KAROLINE: carteira=% CNPJs, clientes=%, contatos=%, tracking=%, cards_movidos=%',
    v_cart, v_cli, v_cont, v_track, v_cards;
END $$;

COMMIT;
