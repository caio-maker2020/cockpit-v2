-- ============================================================================
-- Cockpit v2 — Adiciona import_session em nf_chave_cte (full-replace seguro)
-- Data: 2026-04-29
--
-- Premissa nova (Caio): RPA é fonte de verdade. Cada execução do RPA =
-- "tudo que existe nos últimos 180 dias HOJE". Se uma chave saiu da janela,
-- some do banco no próximo run.
--
-- Implementação atômica e segura:
--   1. RPA gera 1 session_id único por execução (ex.: ISO timestamp)
--   2. Cada POST de batch envia header X-Import-Session: <id>
--   3. Edge Function grava import_session em cada row inserida (upsert
--      atualiza o campo mesmo em duplicate — chaves que continuam vindas
--      ganham session novo)
--   4. Após último batch, RPA chama /finalize-import-chaves
--   5. Finalize deleta WHERE import_session != current — sobra só o atual
--
-- Vantagens:
--   - Durante o upload, banco tem AMBOS (velho + novo) — vinculador acha
--     chave normal, sem janela de zero-data.
--   - Se RPA falha no meio (network), finalize não roda, sessions anteriores
--     ficam intactas. Próxima execução tenta de novo.
--   - "Apaga o que saiu da janela" é automático (chaves antigas não vêm
--     no novo session, são apagadas no finalize).
-- ============================================================================

ALTER TABLE public.nf_chave_cte
  ADD COLUMN import_session text;

CREATE INDEX idx_nf_chave_cte_import_session
  ON public.nf_chave_cte(import_session)
  WHERE import_session IS NOT NULL;

COMMENT ON COLUMN public.nf_chave_cte.import_session IS
  'ID único da execução do RPA que populou esta linha. Após finalize, '
  'apenas o session atual sobra no banco. Permite full-replace seguro.';

-- RPC pra finalize. Service role only.
CREATE OR REPLACE FUNCTION public.finalize_import_chaves_cte(
  p_current_session text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
  v_kept bigint;
BEGIN
  IF p_current_session IS NULL OR length(trim(p_current_session)) = 0 THEN
    RAISE EXCEPTION 'session id obrigatório';
  END IF;

  WITH del AS (
    DELETE FROM public.nf_chave_cte
    WHERE import_session IS DISTINCT FROM p_current_session
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  SELECT count(*) INTO v_kept
  FROM public.nf_chave_cte
  WHERE import_session = p_current_session;

  RETURN jsonb_build_object(
    'session', p_current_session,
    'deleted_old_sessions', v_deleted,
    'kept_current_session', v_kept,
    'finalized_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_import_chaves_cte(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_import_chaves_cte(text) TO service_role;
