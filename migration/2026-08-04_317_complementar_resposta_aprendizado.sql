-- 2026-08-04_317 — Loop de Aprendizado: complementar uma resposta já enviada
--
-- Lacuna real (Isadora, relatada 30/07): depois de enviar a resposta, a
-- pergunta sai da fila e NÃO havia como anexar o print esquecido nem
-- acrescentar a exceção que só apareceu depois. Como o agente-chefe NUNCA
-- repete uma pergunta já respondida (dedup por chave_padrao), uma resposta
-- incompleta virava teto permanente daquela regra.
--
-- Esta RPC deixa a gestão COMPLEMENTAR: grava o complemento como novo
-- registro ligado à mesma pergunta (memória institucional continua
-- append-only) e REABRE a proposta de melhoria correspondente, para que a
-- regra enriquecida passe de novo por aprovação + replay antes de virar PR.
-- Aditiva e inerte: só o front da branch chama; produção não usa ainda.

BEGIN;

CREATE OR REPLACE FUNCTION public.complementar_resposta_aprendizado(
  p_resposta_id uuid,
  p_texto text DEFAULT NULL,
  p_imagens text[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resposta public.learning_log%ROWTYPE;
  v_operador_id uuid;
  v_complemento_id uuid;
  v_tem_texto boolean;
  v_qtd_img integer;
  v_resumo text;
  v_key text;
BEGIN
  IF coalesce((SELECT public.current_operador_papel()), '') <> 'gestor' THEN
    RAISE EXCEPTION 'Só gestor pode complementar respostas do aprendizado';
  END IF;

  v_tem_texto := length(trim(coalesce(p_texto, ''))) >= 3;
  v_qtd_img := coalesce(array_length(p_imagens, 1), 0);
  IF NOT v_tem_texto AND v_qtd_img = 0 THEN
    RAISE EXCEPTION 'Complemento vazio: escreva algo ou anexe um print';
  END IF;

  SELECT * INTO v_resposta
  FROM public.learning_log
  WHERE id = p_resposta_id AND tipo = 'resposta_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resposta não encontrada';
  END IF;

  v_operador_id := public.current_operador_id();
  v_resumo := coalesce(nullif(trim(p_texto), ''), '(complemento só com print)')
    || CASE WHEN v_qtd_img > 0 THEN ' 📎 ' || v_qtd_img || ' print(s)' ELSE '' END;

  -- 1. O complemento entra como registro novo, ligado à MESMA pergunta.
  INSERT INTO public.learning_log (
    agente, tipo, severidade, titulo, resumo, status,
    parent_id, revisado_por, revisado_em, agente_alvo, detalhes
  ) VALUES (
    'agente-aprendizado', 'resposta_admin', 'info',
    'Complemento: ' || left(coalesce(v_resposta.titulo, ''), 170),
    left(v_resumo, 2000),
    'observacao',
    v_resposta.parent_id, v_operador_id, now(), v_resposta.agente_alvo,
    jsonb_build_object(
      'complemento_de', p_resposta_id,
      'texto', nullif(trim(coalesce(p_texto, '')), ''),
      'imagens', to_jsonb(coalesce(p_imagens, '{}'::text[])),
      'chave_padrao', v_resposta.detalhes->>'chave_padrao',
      'opcao', v_resposta.detalhes->>'opcao'
    )
  ) RETURNING id INTO v_complemento_id;

  -- 2. A proposta de melhoria da resposta original volta pra fila de
  --    aprovação com a regra enriquecida (re-aprovar → re-testar no replay).
  UPDATE public.learning_log
  SET status = 'aberto',
      resumo = left(coalesce(resumo, '') || E'\n\nCOMPLEMENTO da gestão: ' || v_resumo, 4000),
      revisado_por = NULL,
      revisado_em = NULL
  WHERE tipo = 'ajuste_sugerido'
    AND parent_id = p_resposta_id
    AND status IN ('aberto', 'aprovado');

  -- 3. Dispara o agente-chefe (fire-and-forget) — se ainda não havia
  --    proposta pra essa resposta, ele cria agora com o texto completo.
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
    RAISE WARNING 'disparo do agente-aprendizado falhou (complemento segue): %', SQLERRM;
  END;

  RETURN v_complemento_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complementar_resposta_aprendizado(uuid, text, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complementar_resposta_aprendizado(uuid, text, text[])
  TO authenticated, service_role;

COMMIT;
