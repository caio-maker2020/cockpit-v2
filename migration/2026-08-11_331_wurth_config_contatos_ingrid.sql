-- ============================================================================
-- 2026-08-11_331 — WÜRTH (vídeos 11/08) + CONTATOS DOS 3 GRUPOS DA INGRID.
--
-- Decisões do Caio (11/08, após os vídeos da Ingrid):
--   • Extravios Würth = trilho PRATI puro: romaneio NUNCA é pedido ao cliente,
--     busca na plataforma interna POR NF, template que não pede romaneio.
--   • Robô da intranet SUGERE (21 com a Obs / 44 com modal padrão) e a Ingrid
--     aprova. Nada autônomo além da oc 13 (SBD).
--   • Varredura 2x/dia (08h e 16h BRT) + botão BUSCAR INTRANET no card.
--   • Prefixos do CTRC → login: AMB/WTB = AMPLA (Betim); WTC/ARP = SAL (Cotia).
--   • Contatos da tabela enviada pelo Caio; Sonepar atende DIMENSIONAL+NORTEL
--     e responde em THREAD NOVA (marca responde_em_thread_nova). Würth também
--     (a CCE chega em e-mail novo).
-- ============================================================================

-- Bloco 1: Würth no trilho romaneio-interno (config pura) ---------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Botão BUSCAR INTRANET no front: visibilidade dirigida por config, nunca
-- hardcode de CNPJ no front (lição da regra oc59).
ALTER TABLE public.cliente_config
  ADD COLUMN IF NOT EXISTS intranet_wurth boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.cliente_config.intranet_wurth IS
  'Cliente com retorno via intranet Würth: robô 2x/dia + botão BUSCAR INTRANET no card. Caio 2026-08-11.';

INSERT INTO public.cliente_config
  (cnpj_pagador, nome_cliente, usa_romaneio_interno, template_email_extravio_total,
   romaneio_escopo, romaneio_busca_chave, intranet_wurth, notes, ativo)
VALUES
  ('43648971000155', 'WURTH DO BRASIL PECAS DE FIXAC',      true, 'EXTRAVIO_TOTAL_NOTIFICACAO', 'sempre', 'nf', true,
   'Würth/Ingrid 2026-08-11: extravios 100% por e-mail (intranet não aceita oc manual); romaneio buscado na plataforma interna POR NF; NUNCA pedir romaneio ao cliente. Retornos operacionais (21/44/CCE) vêm na intranet.', true),
  ('43648971004908', 'WURTH DO BRASIL PECAS DE FIXAC',      true, 'EXTRAVIO_TOTAL_NOTIFICACAO', 'sempre', 'nf', true,
   'Würth/Ingrid 2026-08-11 (ver 43648971000155).', true),
  ('43648971005203', 'WURTH DO BRASIL PECAS DE FIXACAO LTDA', true, 'EXTRAVIO_TOTAL_NOTIFICACAO', 'sempre', 'nf', true,
   'Würth/Ingrid 2026-08-11 (ver 43648971000155).', true),
  ('43648971005386', 'WURTH DO BRASIL',                      true, 'EXTRAVIO_TOTAL_NOTIFICACAO', 'sempre', 'nf', true,
   'Würth/Ingrid 2026-08-11 (ver 43648971000155).', true)
ON CONFLICT (cnpj_pagador) DO UPDATE SET
  usa_romaneio_interno = EXCLUDED.usa_romaneio_interno,
  template_email_extravio_total = EXCLUDED.template_email_extravio_total,
  romaneio_escopo = EXCLUDED.romaneio_escopo,
  romaneio_busca_chave = EXCLUDED.romaneio_busca_chave,
  intranet_wurth = EXCLUDED.intranet_wurth,
  notes = EXCLUDED.notes,
  ativo = true;

-- Guarda: PRATI e SBD intactas
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cliente_config
             WHERE cnpj_pagador = '73856593001057'
               AND (romaneio_escopo <> 'sempre' OR romaneio_busca_chave <> 'nf' OR intranet_wurth)) THEN
    RAISE EXCEPTION 'GUARDA: PRATI alterada';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cliente_config
             WHERE cnpj_pagador = '53296273003298'
               AND (romaneio_escopo <> 'so_parcial' OR romaneio_busca_chave <> 'numero_remessa_danfe' OR intranet_wurth)) THEN
    RAISE EXCEPTION 'GUARDA: SBD alterada';
  END IF;
END $g$;
COMMIT;

-- Bloco 2: dedupe dos retornos da intranet ------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.wurth_retornos_processados (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nf            text NOT NULL,
  data_solucao  text NOT NULL,   -- cru do relatório (chave de dedupe, não semântica)
  solucao       text NOT NULL,
  observacao    text,
  card_id       uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  login_usado   text NOT NULL,   -- 'sal' | 'ampla'
  processado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nf, data_solucao, solucao)
);
COMMENT ON TABLE public.wurth_retornos_processados IS
  'Dedupe do robô da intranet Würth: a mesma linha (nf+data_solucao+solucao) nunca gera 2 sugestões. Linha NOVA da mesma NF (ciclo novo) processa de novo. Caio 2026-08-11.';
ALTER TABLE public.wurth_retornos_processados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wurth_retornos_select ON public.wurth_retornos_processados;
CREATE POLICY wurth_retornos_select ON public.wurth_retornos_processados
  FOR SELECT TO authenticated USING (true);
COMMIT;

-- Bloco 3: contatos dos 3 grupos (tabela do Caio 11/08) -----------------------
-- Idempotente por (documento, email): DELETE escopado + INSERT.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $seed$
DECLARE
  v_ingrid uuid;
  v_doc text;
  v_docs_dim_nortel text[] := ARRAY[
    '06913480000320','06913480001563','06913480002616',           -- DIMENSIONAL
    '46044053002906','46044053004607','46044053005417'];          -- NORTEL
  v_docs_wurth text[] := ARRAY[
    '43648971000155','43648971004908','43648971005203','43648971005386'];
BEGIN
  SELECT id INTO v_ingrid FROM operadores WHERE nome = 'INGRID';
  IF v_ingrid IS NULL THEN RAISE EXCEPTION 'INGRID não existe'; END IF;

  -- SBD --------------------------------------------------------------------
  DELETE FROM contatos_cliente WHERE documento_cliente = '53296273003298'
    AND tipo_uso = 'logistico' AND operador_responsavel_id = v_ingrid;
  INSERT INTO contatos_cliente
    (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id, observacao)
  VALUES
    ('53296273003298','email','ocorrenciassudeste@sbdinc.com',1,'logistico','Diversos',true,v_ingrid,'principal (tabela Caio 11/08)'),
    ('53296273003298','email','hugo.prado@sbdinc.com',2,'logistico','Hugo',true,v_ingrid,NULL),
    ('53296273003298','email','Tabata.Wahasugui@sbdinc.com',3,'logistico','Tabata',true,v_ingrid,NULL),
    ('53296273003298','email','Felipe.Idalo@sbdinc.com',4,'logistico','Felipe',true,v_ingrid,NULL),
    ('53296273003298','email','Julio.Santiago@sbdinc.com',5,'logistico','Julio',true,v_ingrid,NULL),
    ('53296273003298','email','Pablo.Santos@sbdinc.com',6,'logistico','Pablo',true,v_ingrid,NULL);

  -- WÜRTH (4 CNPJs; CCE chega em e-mail novo → responde_em_thread_nova) -----
  FOREACH v_doc IN ARRAY v_docs_wurth LOOP
    DELETE FROM contatos_cliente WHERE documento_cliente = v_doc
      AND tipo_uso = 'logistico' AND operador_responsavel_id = v_ingrid;
    INSERT INTO contatos_cliente
      (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id, responde_em_thread_nova, observacao)
    VALUES
      (v_doc,'email','backoffice.transportes@wurth.com.br',1,'logistico','Diversos',true,v_ingrid,true,'principal (tabela Caio 11/08)'),
      (v_doc,'email','Cristiane.Barros@wurth.com.br',2,'logistico','Cristiane',true,v_ingrid,true,NULL),
      (v_doc,'email','CIDA.NUNES@wurth.com.br',3,'logistico','Cida',true,v_ingrid,true,NULL),
      (v_doc,'email','ALEXANDRO.MODOLO@wurth.com.br',4,'logistico','Alexandro',true,v_ingrid,true,NULL);
  END LOOP;

  -- SONEPAR → atende DIMENSIONAL + NORTEL (resposta em thread nova) ---------
  FOREACH v_doc IN ARRAY v_docs_dim_nortel LOOP
    DELETE FROM contatos_cliente WHERE documento_cliente = v_doc
      AND tipo_uso = 'logistico' AND operador_responsavel_id = v_ingrid;
    INSERT INTO contatos_cliente
      (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa, ativo, operador_responsavel_id, responde_em_thread_nova, observacao)
    VALUES
      (v_doc,'email','gabriela.moura@b2c.srv.br',1,'logistico','Gabriela',true,v_ingrid,true,'Sonepar atende Dim/Nortel (tabela Caio 11/08)'),
      (v_doc,'email','maria.rodrigues@b2c.srv.br',2,'logistico','Maria',true,v_ingrid,true,NULL),
      (v_doc,'email','milena.souza_ext@sonepar.com.br',3,'logistico','Milena',true,v_ingrid,true,NULL),
      (v_doc,'email','cleia.moura@b2c.srv.br',4,'logistico','Cleia',true,v_ingrid,true,NULL),
      (v_doc,'email','jean.barbosa@sonepar.com.br',5,'logistico','Jean',true,v_ingrid,true,NULL),
      (v_doc,'email','lucas.cruz@sonepar.com.br',6,'logistico','Lucas',true,v_ingrid,true,NULL),
      (v_doc,'email','daniele.soares@b2c.srv.br',7,'logistico','Daniele',true,v_ingrid,true,NULL),
      (v_doc,'email','alex.melo@sonepar.com.br',8,'logistico','Alex',true,v_ingrid,true,NULL);
  END LOOP;
END $seed$;

-- Flag do robô (nasce OFF; ligar nomeada no merge final)
INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('wurth_intranet_enabled', false,
        'Ingrid/Würth: robô da intranet (2x/dia + botão BUSCAR INTRANET). Sugere 21/44; nunca lança sozinho.')
ON CONFLICT (key) DO NOTHING;
COMMIT;

-- Bloco 4: cron do robô — 08h e 16h BRT (11h/19h UTC) -------------------------
SELECT cron.unschedule('robo-intranet-wurth-2x-dia')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'robo-intranet-wurth-2x-dia');

SELECT cron.schedule(
  'robo-intranet-wurth-2x-dia',
  '0 11,19 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/robo-intranet-wurth',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) AS request_id;
  $cron$
);
