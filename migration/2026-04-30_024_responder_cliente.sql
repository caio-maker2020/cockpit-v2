-- ============================================================================
-- Cockpit v2 — Suporte a "responder cliente" via card
-- Data: 2026-04-30
--
-- Reaproveita a tabela `todos` (já existe). Novo "tipo" de proposta:
--   proposta_payload = {
--     "tool": "responder_cliente",
--     "args": {
--       "canal": "email" | "whatsapp",
--       "destinatario": "joao@cliente.com.br" | "5531999...",
--       "subject": "Re: insucesso 894667"  // só pra email
--     },
--     "texto_sugerido": "...",   // gerado pelo redator (Sonnet 4.6)
--     "rationale": "...",
--     "modelo_usado": "claude-sonnet-4-6",
--     "gerado_em": "2026-04-30T..."
--   }
--
-- Quando Larissa edita inline, frontend faz UPDATE direto em
-- proposta_payload->texto_sugerido (RLS permite).
--
-- Quando clica Enviar, frontend chama RPC enviar_resposta_cliente que:
--   1. Valida (todo é tipo responder_cliente, status pendente, lock OK)
--   2. Pega texto final do payload atualizado
--   3. Enfileira em pgmq.agent_executor com tag específica de envio
--   4. Marca todo.status='enviando'
--   5. Edge Function executor (ou um envio dedicado) consome e dispara Postmark
--   6. Em sucesso, marca todo.status='enviado' + grava card_event RespostaEnviada
--
-- Pra esta primeira versão, vou criar uma fila própria pgmq.respostas_envio
-- pra separar do executor de SSW. Edge Function nova `enviar-resposta` consome.
-- ============================================================================

-- Cria fila pgmq dedicada (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = 'respostas_envio') THEN
    PERFORM pgmq.create('respostas_envio');
  END IF;
END $$;

-- Atualiza o whitelist nas RPCs existentes — PRESERVANDO os DEFAULTs originais
-- (postgres não permite remover defaults via CREATE OR REPLACE).
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
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  msg_id := pgmq.send(queue_name, payload);
  RETURN msg_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_to_pgmq(text, jsonb) TO service_role;

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
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  RETURN QUERY
  SELECT m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  FROM pgmq.read(queue_name, vt_seconds, qty) AS m;
END;
$$;

GRANT EXECUTE ON FUNCTION public.read_from_pgmq(text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_from_pgmq(
  queue_name text,
  msg_id bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public
AS $$
BEGIN
  IF queue_name NOT IN ('agent_intake', 'agent_specialist', 'agent_executor', 'respostas_envio', 'dead_letter') THEN
    RAISE EXCEPTION 'Fila desconhecida: %', queue_name;
  END IF;
  RETURN pgmq.delete(queue_name, msg_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_from_pgmq(text, bigint) TO service_role;

-- ============================================================================
-- Coluna nova em operadores: email pessoal pra envio (From) e roteamento.
-- Quando escalar pros 11 operadores, cada um tem seu email — From muda
-- conforme card.assigned_operator_id.
-- ============================================================================
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS email_relacionamento text;

COMMENT ON COLUMN public.operadores.email_relacionamento IS
  'Email pessoal do operador (ex: relacionamento.farmaceutico@salexpress.com.br). '
  'Usado pelo enviar-resposta como From + pelo ingestor pra rotear emails que '
  'caíram no inbound do Postmark via OriginalRecipient. Sender Signature precisa '
  'estar Verified no Postmark pra cada email cadastrado aqui.';

-- Backfill: Larissa (única operadora hoje) recebe o email do cockpit
UPDATE public.operadores
SET email_relacionamento = 'relacionamento.farmaceutico@salexpress.com.br'
WHERE upper(nome) = 'LARISSA' AND email_relacionamento IS NULL;

-- ============================================================================
-- RPC: enviar_resposta_cliente — chamado pelo botão "Enviar" no painel Resposta
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enviar_resposta_cliente(
  p_todo_id uuid,
  p_texto_final text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_operador_email text;
  v_operador_nome text;
  v_todo record;
  v_card record;
  v_canal text;
  v_destinatario text;
  v_subject text;
  v_msg_id bigint;
BEGIN
  IF p_texto_final IS NULL OR length(trim(p_texto_final)) < 5 THEN
    RAISE EXCEPTION 'Texto final obrigatório (mínimo 5 chars)';
  END IF;

  SELECT id, papel, email_relacionamento, nome
  INTO v_operador_id, v_operador_papel, v_operador_email, v_operador_nome
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_operador_email IS NULL THEN
    RAISE EXCEPTION 'Operador % não tem email_relacionamento configurado', v_operador_nome;
  END IF;

  SELECT id, card_id, action_id, proposta_payload, status INTO v_todo
  FROM public.todos WHERE id = p_todo_id;

  IF v_todo.id IS NULL THEN
    RAISE EXCEPTION 'Todo % não encontrado', p_todo_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_todo.status NOT IN ('pendente', 'rascunho') THEN
    RAISE EXCEPTION 'Todo % em status=% não pode mais enviar', p_todo_id, v_todo.status;
  END IF;

  IF (v_todo.proposta_payload ->> 'tool') <> 'responder_cliente' THEN
    RAISE EXCEPTION 'Todo % não é tipo responder_cliente (tool=%)',
      p_todo_id, (v_todo.proposta_payload ->> 'tool');
  END IF;

  SELECT id, assigned_operator_id, nf, ctrc, remetente_inicial, canal_origem
  INTO v_card FROM public.cards WHERE id = v_todo.card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', v_todo.card_id;
  END IF;

  IF v_operador_papel <> 'gestor' AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra enviar resposta no card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_canal := COALESCE(v_todo.proposta_payload -> 'args' ->> 'canal', v_card.canal_origem);
  v_destinatario := COALESCE(
    v_todo.proposta_payload -> 'args' ->> 'destinatario',
    v_card.remetente_inicial
  );
  v_subject := v_todo.proposta_payload -> 'args' ->> 'subject';

  IF v_destinatario IS NULL OR length(trim(v_destinatario)) = 0 THEN
    RAISE EXCEPTION 'Card % sem destinatário pra responder', v_card.id;
  END IF;

  -- Atualiza texto final no payload + status
  UPDATE public.todos
  SET proposta_payload = jsonb_set(
        proposta_payload,
        '{texto_final}',
        to_jsonb(p_texto_final),
        true
      ),
      status = 'enviando',
      approved_by = v_operador_id,
      approved_at = now()
  WHERE id = p_todo_id;

  -- Evento de auditoria — antes do envio (caso Postmark falhe, ainda tem rastro)
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_todo.card_id, 'RespostaEnviadaSolicitada', 'operator', v_operador_id::text,
    jsonb_build_object(
      'todo_id', p_todo_id,
      'canal', v_canal,
      'destinatario', v_destinatario,
      'from_email', v_operador_email,
      'texto_preview', left(p_texto_final, 200)
    )
  );

  -- Enfileira pra Edge Function enviar-resposta consumir
  v_msg_id := pgmq.send('respostas_envio', jsonb_build_object(
    'todo_id', p_todo_id,
    'card_id', v_todo.card_id,
    'canal', v_canal,
    'from_email', v_operador_email,
    'from_name', v_operador_nome,
    'destinatario', v_destinatario,
    'subject', v_subject,
    'texto', p_texto_final,
    'operador_id', v_operador_id
  ));

  RETURN jsonb_build_object(
    'ok', true, 'todo_id', p_todo_id, 'card_id', v_todo.card_id,
    'pgmq_msg_id', v_msg_id, 'canal', v_canal
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enviar_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enviar_resposta_cliente(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.enviar_resposta_cliente IS
  'Chamada pelo botão "Enviar" no painel Resposta do card. Atualiza texto '
  'final no todo + enfileira em pgmq.respostas_envio. Edge Function '
  'enviar-resposta consome e dispara Postmark transactional. Em fase '
  'de preparação (ENVIO_DESABILITADO=true), Edge Function recusa o envio.';
