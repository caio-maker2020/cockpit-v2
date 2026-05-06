-- ============================================================================
-- Cockpit v2 — Bucket Storage pra anexos de email + tabela de metadados
-- Data: 2026-05-06
--
-- Caio 2026-05-06: Larissa quer anexar arquivos no email enviado pelo Cockpit
-- (aba RESPOSTA + modal de aprovação de oc=54+email).
--
-- Limites: 10MB por arquivo, 25MB total (limite Gmail), até 5 anexos.
-- Tipos aceitos: PDF, imagem, Word, Excel, CSV, TXT.
-- Retenção: arquivos são DELETADOS imediatamente após envio bem-sucedido
-- (privacidade máxima — Caio decisão).
-- ============================================================================

-- ============================================================================
-- 1. Bucket Storage privado
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'email_anexos',
  'email_anexos',
  false,  -- privado, só service role acessa
  10485760,  -- 10MB por arquivo
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Policies: só service_role escreve. Authenticated lê os próprios uploads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_anexos_service_role_all'
  ) THEN
    CREATE POLICY email_anexos_service_role_all
      ON storage.objects
      FOR ALL TO service_role
      USING (bucket_id = 'email_anexos')
      WITH CHECK (bucket_id = 'email_anexos');
  END IF;
END $$;

-- ============================================================================
-- 2. Tabela email_anexos — metadados (1 row por arquivo)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.email_anexos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  todo_id uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES public.operadores(id),
  storage_path text NOT NULL,  -- path dentro do bucket email_anexos
  filename text NOT NULL,       -- nome original do arquivo
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  enviado_em timestamptz,        -- preenchido quando email vai
  deletado_em timestamptz        -- preenchido pós-envio (storage limpo)
);

CREATE INDEX IF NOT EXISTS idx_email_anexos_card_id
  ON public.email_anexos(card_id);
CREATE INDEX IF NOT EXISTS idx_email_anexos_todo_id
  ON public.email_anexos(todo_id);
CREATE INDEX IF NOT EXISTS idx_email_anexos_pendentes
  ON public.email_anexos(uploaded_at)
  WHERE enviado_em IS NULL AND deletado_em IS NULL;

ALTER TABLE public.email_anexos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_anexos_service_only ON public.email_anexos;
CREATE POLICY email_anexos_service_only
  ON public.email_anexos
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS email_anexos_select_auth ON public.email_anexos;
CREATE POLICY email_anexos_select_auth
  ON public.email_anexos
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.email_anexos IS
  'Caio 2026-05-06: anexos de email uploaded pela operadora antes de aprovar '
  'o todo. Arquivo bruto fica em storage.email_anexos. Pós-envio, executor '
  'deleta do storage e seta deletado_em (privacidade).';

-- ============================================================================
-- 3. Cleanup de anexos órfãos (uploaded mas nunca enviados após 24h)
-- Cron diário deleta entries antigas pra evitar acumulo de uploads abandonados.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cleanup_email_anexos_orfaos()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deletado int := 0;
  v_anexo record;
BEGIN
  FOR v_anexo IN
    SELECT id, storage_path FROM public.email_anexos
    WHERE enviado_em IS NULL
      AND deletado_em IS NULL
      AND uploaded_at < now() - interval '24 hours'
  LOOP
    -- Deleta do bucket
    DELETE FROM storage.objects
    WHERE bucket_id = 'email_anexos' AND name = v_anexo.storage_path;
    -- Marca como deletado
    UPDATE public.email_anexos
    SET deletado_em = now()
    WHERE id = v_anexo.id;
    v_deletado := v_deletado + 1;
  END LOOP;
  RETURN v_deletado;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_email_anexos_orfaos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_email_anexos_orfaos() TO service_role;
