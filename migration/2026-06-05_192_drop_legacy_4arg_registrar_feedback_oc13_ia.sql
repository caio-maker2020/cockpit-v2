-- ============================================================================
-- Cockpit v2 — DROP overload legado de registrar_feedback_oc13_ia (4 args)
-- Caio 2026-06-05
--
-- Bug: mig 159 corrigiu a FK violation criando assinatura nova (3 args) que
-- resolve operadores.id via auth.uid(). Mas NÃO dropou o overload antigo de
-- 4 args `(uuid, text, int, text)` criado em mig 149 — Postgres trata como
-- função separada e mantém os dois.
--
-- O Lovable está chamando o overload legado (4 args) → INSERT segue gravando
-- v_user=auth.uid() em corrigido_por → FK violation em agente_oc13_feedback
-- _corrigido_por_fkey. Reportado por Caio 2026-06-05 (DUILIO, NF 975909).
--
-- Fix: dropar o overload legado. Sobra só a versão 3 args correta da mig 159.
-- Lovable precisa ser atualizado pra chamar:
--   .rpc('registrar_feedback_oc13_ia', {
--     p_card_id, p_decisao_correta_codigo_ssw, p_motivo_correcao
--   })
--
-- O p_tipo_feedback (autonoma_errada vs sugestao_errada_explicita) agora é
-- computado dentro da função a partir de cards.analise_oc13_resultado->>'decisao'.
--
-- skill: supabase-postgres-best-practices
--   * DROP FUNCTION IF EXISTS idempotente
--   * Assinatura exata (uuid, text, int, text) pra não dropar a versão correta
--   * GRANT EXECUTE do overload dropado é removido junto pelo Postgres
-- ============================================================================

DROP FUNCTION IF EXISTS public.registrar_feedback_oc13_ia(uuid, text, integer, text);

-- Sanity check: a versão correta (3 args) ainda existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'registrar_feedback_oc13_ia'
      AND pg_get_function_identity_arguments(oid) = 'p_card_id uuid, p_decisao_correta_codigo_ssw integer, p_motivo_correcao text'
  ) THEN
    RAISE EXCEPTION 'mig 192 abortada: registrar_feedback_oc13_ia(uuid,int,text) da mig 159 não está deployada — drop deixaria o sistema sem nenhuma versão';
  END IF;
END $$;
