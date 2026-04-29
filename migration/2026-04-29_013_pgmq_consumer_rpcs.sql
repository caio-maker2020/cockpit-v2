-- ============================================================================
-- Cockpit v2 — RPCs pra consumers de pgmq (triador, vinculador, executor)
-- Data: 2026-04-29
--
-- Edge Functions consomem fila via:
--   1. read_from_pgmq(queue, vt_seconds, qty)  → pega N msgs com lock
--   2. delete_from_pgmq(queue, msg_id)         → confirma processamento
--   3. archive_to_dead_letter(queue, msg_id, motivo) → manda pra fila DL
--
-- Pattern: read com visibility timeout → processa → delete em sucesso, OU
-- deixa expirar pra retry, OU archive em falha permanente.
-- ============================================================================

-- ============================================================================
-- 1. read_from_pgmq — lê N mensagens com visibility timeout
-- ============================================================================
CREATE OR REPLACE FUNCTION public.read_from_pgmq(
  queue_name text,
  vt_seconds integer DEFAULT 60,
  qty integer DEFAULT 10
) RETURNS TABLE(
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;

  RETURN QUERY
  SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  FROM pgmq.read(queue_name, vt_seconds, qty) AS m;
END;
$$;

REVOKE ALL ON FUNCTION public.read_from_pgmq(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_from_pgmq(text, integer, integer) TO service_role;

-- ============================================================================
-- 2. delete_from_pgmq — remove msg da fila após processamento OK
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_from_pgmq(
  queue_name text,
  msg_id bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;

  RETURN pgmq.delete(queue_name, msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_from_pgmq(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_from_pgmq(text, bigint) TO service_role;

-- ============================================================================
-- 3. archive_to_dead_letter — falha permanente, move pra fila dead_letter
-- ============================================================================
CREATE OR REPLACE FUNCTION public.archive_to_dead_letter(
  source_queue text,
  source_msg_id bigint,
  motivo text,
  original_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
DECLARE
  dl_msg_id bigint;
BEGIN
  -- Enfileira nova msg em dead_letter com contexto
  dl_msg_id := pgmq.send('dead_letter', jsonb_build_object(
    'source_queue', source_queue,
    'source_msg_id', source_msg_id,
    'motivo', motivo,
    'archived_at', now(),
    'original_payload', original_payload
  ));

  -- Apaga da fila original
  PERFORM pgmq.delete(source_queue, source_msg_id);

  RETURN dl_msg_id;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_to_dead_letter(text, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_to_dead_letter(text, bigint, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.read_from_pgmq IS
  'Lê N msgs de uma fila pgmq com visibility timeout. Worker pega, processa, '
  'e chama delete_from_pgmq em sucesso OU deixa o vt expirar pra retry.';
