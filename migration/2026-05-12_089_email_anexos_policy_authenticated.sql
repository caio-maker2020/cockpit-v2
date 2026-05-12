-- ============================================================================
-- Cockpit v2 — Policy de leitura em storage.objects pra bucket email_anexos
-- Data: 2026-05-12
--
-- Caio 2026-05-12: front Lovable mostra anexos inbound do cliente no card e
-- precisa gerar signedUrl pra Larissa baixar. Hoje bucket `email_anexos` só
-- tem policy pra service_role → operadora autenticada recebe 401/403 →
-- "Não consegui gerar o link".
--
-- Fix: policy SELECT em storage.objects pra authenticated quando o objeto
-- pertence a um anexo (email_anexos) cujo card o operador tem acesso.
-- Padrão consistente com tracking_credentials/contatos_cliente (mig 076):
-- gestor vê tudo, operador vê só dos cards atribuídos a ele.
--
-- Service_role policy existente continua valendo (executor consome anexos
-- pra mandar pro SSW como imagem — esse caminho não muda).
-- ============================================================================

CREATE POLICY email_anexos_select_authenticated
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'email_anexos'
    AND EXISTS (
      SELECT 1
      FROM public.email_anexos ea
      LEFT JOIN public.cards c ON c.id = ea.card_id
      WHERE ea.storage_path = storage.objects.name
        AND (
          -- Gestor vê tudo
          public.current_operador_papel() = 'gestor'
          -- OU operador atribuído ao card
          OR c.assigned_operator_id = public.current_operador_id()
        )
    )
  );

COMMENT ON POLICY email_anexos_select_authenticated ON storage.objects IS
  'Caio 2026-05-12: gestor vê todos anexos; operador vê só dos cards que '
  'são dele (assigned_operator_id). Necessário pra Larissa baixar anexos '
  'inbound do cliente e anexos outbound enviados.';
