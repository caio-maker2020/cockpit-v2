-- 2026-07-23_311 — Resposta dispara sugestão de mudança NA HORA (F6)
--
-- Caio: "não precisa esperar a manhã — assim que a Isadora responder, o
-- agente-chefe interpreta e já sobe a sugestão". A RPC de resposta agora
-- dispara (fire-and-forget via pg_net, mesmo padrão dos crons) o modo
-- 'ajustes' do agente-aprendizado, que gera a proposta na fila e envia o
-- e-mail "O agente chefe sugeriu uma mudança…". Falha do disparo NUNCA
-- quebra o registro da resposta (EXCEPTION engolida). O cron diário
-- continua como rede de segurança pra qualquer disparo perdido.

BEGIN;

CREATE OR REPLACE FUNCTION public.responder_pergunta_aprendizado(
  p_pergunta_id uuid,
  p_opcao text,
  p_texto text DEFAULT NULL,
  p_respostas jsonb DEFAULT NULL,
  p_imagens text[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pergunta public.learning_log%ROWTYPE;
  v_operador_id uuid;
  v_resposta_id uuid;
  v_resumo text;
  v_followups text;
  v_key text;
BEGIN
  IF coalesce((SELECT public.current_operador_papel()), '') <> 'gestor' THEN
    RAISE EXCEPTION 'Só gestor pode responder perguntas do aprendizado';
  END IF;
  IF p_opcao IS NULL OR length(trim(p_opcao)) < 2 THEN
    RAISE EXCEPTION 'Escolha uma opção de resposta';
  END IF;

  v_operador_id := public.current_operador_id();

  SELECT * INTO v_pergunta
  FROM public.learning_log
  WHERE id = p_pergunta_id AND tipo = 'pergunta' AND status = 'aberto'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pergunta não encontrada ou já respondida';
  END IF;

  SELECT string_agg(
           coalesce(r->>'pergunta', '?') || ' → ' ||
           coalesce(r->>'resposta', '(sem resposta)'),
           ' | '
         )
  INTO v_followups
  FROM jsonb_array_elements(coalesce(p_respostas, '[]'::jsonb)) AS r;

  v_resumo := trim(p_opcao)
    || coalesce(' | ' || nullif(v_followups, ''), '')
    || coalesce(' — ' || nullif(trim(p_texto), ''), '')
    || CASE WHEN coalesce(array_length(p_imagens, 1), 0) > 0
            THEN ' 📎 ' || array_length(p_imagens, 1) || ' print(s)'
            ELSE '' END;

  INSERT INTO public.learning_log (
    agente, tipo, severidade, titulo, resumo, status,
    parent_id, revisado_por, revisado_em, agente_alvo, detalhes
  ) VALUES (
    'agente-aprendizado', 'resposta_admin', 'info',
    'Resposta: ' || left(v_pergunta.titulo, 180),
    left(v_resumo, 2000),
    'observacao',
    p_pergunta_id, v_operador_id, now(), v_pergunta.agente_alvo,
    jsonb_build_object(
      'opcao', trim(p_opcao),
      'texto', nullif(trim(coalesce(p_texto, '')), ''),
      'respostas_estruturadas', coalesce(p_respostas, '[]'::jsonb),
      'imagens', to_jsonb(coalesce(p_imagens, '{}'::text[])),
      'chave_padrao', v_pergunta.detalhes->>'chave_padrao'
    )
  ) RETURNING id INTO v_resposta_id;

  UPDATE public.learning_log
  SET status = 'respondido',
      revisado_por = v_operador_id,
      revisado_em = now(),
      motivo_decisao = left(v_resumo, 500)
  WHERE id = p_pergunta_id;

  -- Dispara o agente-chefe AGORA (fire-and-forget; nunca quebra a resposta)
  BEGIN
    SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets WHERE name = 'cron_prioridades_ai_key';
    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/agente-aprendizado',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_key,
          'apikey', v_key,
          'Content-Type', 'application/json'
        ),
        body := '{"modo":"ajustes"}'::jsonb,
        timeout_milliseconds := 30000
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'disparo do agente-aprendizado falhou (resposta segue): %', SQLERRM;
  END;

  RETURN v_resposta_id;
END;
$$;

COMMIT;
