-- ============================================================================
-- Cockpit v2 — RPC público pra enfileirar em pgmq
-- Data: 2026-04-29
--
-- PostgREST não expõe a schema `pgmq` direto (e nem deveria — gerenciamento
-- da fila é privilegiado). Esta function wraps `pgmq.send(queue, msg)` numa
-- RPC pública que valida o nome da fila contra um whitelist e SECURITY DEFINER
-- garante execução com permissão de proprietário.
--
-- Edge Functions usam: supabase.rpc('enqueue_to_pgmq', { queue_name, payload })
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_to_pgmq(
  queue_name text,
  payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
DECLARE
  msg_id bigint;
BEGIN
  -- Whitelist das filas conhecidas pra não permitir enfileirar em filas
  -- arbitrárias (ex.: criar fila nova via INSERT).
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;

  msg_id := pgmq.send(queue_name, payload);
  RETURN msg_id;
END;
$$;

-- Service role pode chamar; authenticated não — só Edge Functions
-- enfileiram (gestor não enfileira manual via UI).
REVOKE ALL ON FUNCTION public.enqueue_to_pgmq(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_to_pgmq(text, jsonb) TO service_role;

COMMENT ON FUNCTION public.enqueue_to_pgmq(text, jsonb) IS
  'Wrapper de pgmq.send com whitelist de filas. Usado pelas Edge Functions '
  'pra enfileirar jobs sem expor pgmq schema direto via PostgREST.';
