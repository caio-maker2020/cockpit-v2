-- ============================================================================
-- Cockpit v2 — Idempotência de lançamento SSW via portal interno
-- Caio 2026-06-08
--
-- Contexto: migração de WebAPI (que tinha idempotency_key nativa) pra portal
-- interno opção 101 (que NÃO tem). Antes do submit no portal, o envelope
-- `lancarSswPortal` faz INSERT aqui com UNIQUE (card_id, codigo_oc, ctrc):
--
--   * Conflict → ação já executada com sucesso, retorna idempotent_skip
--     sem chamar SSW. Protege contra reexecução do executor (PGMQ redelivery,
--     dupla aprovação acidental, etc).
--
--   * INSERT OK → segue pra Portal. Update da linha com sucesso=true/false
--     + portal_response_excerpt pra forensics.
--
-- Substitui a função do `idempotency_key` SHA-256 que o WebAPI passava no
-- header (e que o SSW rejeitava duplicados). Agora a responsabilidade fica
-- no Cockpit.
--
-- skill: supabase-postgres-best-practices
--   * RLS service_role only (nenhum operador precisa enxergar)
--   * UNIQUE composto cobre dedup. PK uuid pra audit/foreign-key futura
--   * Sem trigger updated_at (linha é write-once então finalize com UPDATE)
--   * Sem índice extra: lookup é sempre via UNIQUE (card_id, codigo_oc, ctrc)
-- ============================================================================

CREATE TABLE public.acoes_executadas_ssw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  codigo_oc int NOT NULL,
  ctrc text NOT NULL,
  todo_id uuid REFERENCES public.todos(id) ON DELETE SET NULL,
  payload_hash text,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  sucesso boolean,                  -- null = em voo, true/false = final
  portal_response_excerpt text,     -- primeiros ~500 chars do HTML pós-submit
  motivo_erro text,                 -- preenchido se sucesso=false
  UNIQUE (card_id, codigo_oc, ctrc)
);

COMMENT ON TABLE public.acoes_executadas_ssw IS
  'Idempotência de lançamento SSW via portal interno. INSERT antes do submit, UPDATE depois. UNIQUE (card_id, codigo_oc, ctrc) impede duplicar lançamento.';

ALTER TABLE public.acoes_executadas_ssw ENABLE ROW LEVEL SECURITY;

-- Operadores e anon NÃO acessam. Só service_role.
CREATE POLICY acoes_executadas_ssw_service_only ON public.acoes_executadas_ssw
  AS RESTRICTIVE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

GRANT SELECT, INSERT, UPDATE ON public.acoes_executadas_ssw TO service_role;
