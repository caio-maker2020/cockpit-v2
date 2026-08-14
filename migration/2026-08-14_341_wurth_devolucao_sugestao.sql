-- ============================================================================
-- Cockpit v2 — Devolução Würth SUGERIDA: por silêncio (R1) e por 2ª recusa (R2)
-- Data: 2026-08-14 (Caio, plano validado em conversa)
--
-- R1: oc 11 + 54 lançada + 10 dias corridos SEM retorno da Würth (nem e-mail,
--     nem intranet) → robô sugere oc 44 com EVIDÊNCIA da consulta na intranet
--     comprovando o silêncio naquela data. Operadora aprova — nunca autônomo.
-- R2: 2ª ocorrência 10 na mesma NF → agente sugere 44 + e-mail informando as
--     duas recusas e o prazo de logística reversa. Operadora decide (exceção:
--     lançar 54 posterior à 2ª recusa desarma a regra — stateless).
--
-- Escopo: SÓ CNPJs com cliente_config.intranet_wurth=true (hoje 4). Flag
-- master própria, nasce OFF (dry-run: só card_events, sem todo/move).
-- ============================================================================

-- ============================================================================
-- 1. Tabela de evidências do silêncio na intranet (R1)
--    UNIQUE(card_id, gatilho_ts) = idempotência POR CICLO: o robô sugere UMA
--    vez por ciclo; se a operadora ignorar/rejeitar, não re-sugere — o ciclo
--    só rearma com ocorrência-gatilho nova (gatilho_ts diferente).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.wurth_evidencias_intranet (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id            uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  nf                 text NOT NULL,
  consultado_em      timestamptz NOT NULL DEFAULT now(),
  logins_usados      text[] NOT NULL DEFAULT '{}',        -- 'sal' | 'ampla'
  gatilho_oc         integer,                             -- oc que abriu o ciclo (11)
  gatilho_ts         timestamptz NOT NULL,                -- data/hora da oc-gatilho (âncora do ciclo)
  data_54_ts         timestamptz,                         -- quando a 54 foi lançada (início dos 10 dias)
  linhas_total       integer NOT NULL DEFAULT 0,          -- linhas da consulta inteira (contexto)
  linhas_da_nf       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- linhas velhas da NF (ciclo anterior), se houver
  veredicto          text NOT NULL DEFAULT 'sem_retorno',
  html_path          text,                                -- snapshot no bucket wurth_evidencias
  modo               text NOT NULL DEFAULT 'ativo',       -- 'ativo' | 'dry_run'
  CONSTRAINT wurth_evid_veredicto_chk CHECK (veredicto IN ('sem_retorno')),
  CONSTRAINT wurth_evid_modo_chk CHECK (modo IN ('ativo', 'dry_run')),
  UNIQUE (card_id, gatilho_ts)
);
COMMENT ON TABLE public.wurth_evidencias_intranet IS
  'R1 devolução Würth por silêncio: prova de que na data da consulta NÃO havia retorno da NF na intranet posterior à ocorrência-gatilho. UNIQUE(card_id,gatilho_ts) = 1 sugestão por ciclo. Caio 2026-08-14.';

-- FK indexado (JOINs e ON DELETE SET NULL — regra schema-foreign-key-indexes)
CREATE INDEX IF NOT EXISTS idx_wurth_evid_card ON public.wurth_evidencias_intranet (card_id);

ALTER TABLE public.wurth_evidencias_intranet ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wurth_evid_select ON public.wurth_evidencias_intranet;
CREATE POLICY wurth_evid_select ON public.wurth_evidencias_intranet
  FOR SELECT TO authenticated USING (true);
-- escrita: só service_role (robô) — sem policy de INSERT/UPDATE pra authenticated

COMMIT;

-- ============================================================================
-- 2. Bucket privado pro snapshot HTML da consulta (VER EVIDÊNCIA)
--    Mesmo padrão do email_anexos (mig 063): service_role escreve,
--    authenticated lê (o front gera signed URL logado).
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'wurth_evidencias',
  'wurth_evidencias',
  false,
  5242880,  -- 5MB (HTML da consulta tem dezenas de KB)
  ARRAY['text/html', 'text/plain']::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'wurth_evidencias_service_role_all'
  ) THEN
    CREATE POLICY wurth_evidencias_service_role_all
      ON storage.objects
      FOR ALL TO service_role
      USING (bucket_id = 'wurth_evidencias')
      WITH CHECK (bucket_id = 'wurth_evidencias');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'wurth_evidencias_authenticated_read'
  ) THEN
    CREATE POLICY wurth_evidencias_authenticated_read
      ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'wurth_evidencias');
  END IF;
END $$;

-- ============================================================================
-- 3. Flag master (nasce OFF — dry-run até o Caio ligar)
-- ============================================================================
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'wurth_devolucao_sugestao_enabled',
  false,
  'R1 (silêncio 10d pós-54 em oc 11) e R2 (2ª oc 10) da Würth: com OFF, só registra card_event modo dry_run; com ON, cria todo 44 recomendado + move pra AVH. Nunca lança sozinho. Caio 2026-08-14.'
)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 4. Template do e-mail da R2 (devolução autorizada por 2ª recusa)
--    Destinatário NÃO vai aqui: resolvido pelo cadastro
--    (resolver_email_cobranca_cliente, tipo_uso=logistico) como nos demais.
-- ============================================================================
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'WURTH_DEVOLUCAO_2_RECUSAS',
  'Würth — devolução autorizada por 2ª recusa',
  'R2 Würth (Caio 2026-08-14): NF com duas ocorrências 10 → devolução autorizada por processo, sem nova tratativa. E-mail informa as duas recusas e o prazo de logística reversa.',
  'Devolução autorizada — 2ª recusa de entrega — NF {nf} — {empresa}',
  E'Olá, {primeiro_nome}!\n\nRegistramos a SEGUNDA recusa de recebimento na entrega referente à NF {nf}.\n\nConforme o processo acordado para os casos com duas recusas, a devolução da mercadoria está autorizada e seguirá o prazo de logística reversa, sem necessidade de nova tratativa.\n\nA evidência da recusa pode ser acessada por meio do link abaixo: {link_evidencia}\n\nQualquer informação adicional, estamos à disposição.\n\nObrigado!\n\n{operadora_nome} Sal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'empresa', 'operadora_nome', 'link_evidencia']::text[],
  true
)
ON CONFLICT (id) DO NOTHING;
