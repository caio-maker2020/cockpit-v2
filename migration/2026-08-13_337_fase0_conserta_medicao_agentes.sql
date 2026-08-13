-- =============================================================================
-- 2026-08-13_337_fase0_conserta_medicao_agentes.sql
--
-- FASE 0 do placar de agentes (Caio 2026-08-13). Definição canônica travada:
--   agente sugeriu X · operador fez X  → ACERTO
--   agente sugeriu X · operador fez Y  → ERRO
-- O operador é a verdade. O loop de melhoria roda sobre o ERRO.
--
-- Antes desta migration o placar estava errado NAS DUAS DIREÇÕES (medido em
-- produção, 60 dias):
--   • agente-oc13-autonomo ........ exibia 4,5% · real ~55%
--   • agente-sugere-ocs-padrao ..... exibia 79,9% · real ~68% (amostra enviesada)
--   • interpretador-resposta-cliente exibia 67,1% · real ~49%
--
-- Esta migration corrige 3 dos 4 defeitos (o 4º é no executor, em TS):
--
--  (1) oc13 só media ERRO. A RPC tinha `IF p_codigo_aprovado = 54 RETURN NULL`,
--      ou seja: quando o operador CONCORDAVA, nada era gravado. E só o ramo
--      `sugerir_54_email` era medido — 21_cancel e 56 ficavam fora.
--      Prova: `sugestao_certa_implicita` = 0 linhas em toda a história;
--      83 cards com sugestão 54+email e oc 54 lançada nunca viraram acerto.
--
--  (2) oc 49 fora do escopo. O agente ANALISA oc 49 (417 cards em 60d) mas a
--      RPC filtrava `NOT IN (10,11,19,35)` → 0 sinal implícito. Pior: a RPC
--      explícita de ERRO tinha o mesmo filtro (RAISE) enquanto a de ACERTO não
--      tinha guard nenhum — canal de erro fechado, de acerto aberto = viés.
--
--  (3) Trava "1 feedback implícito por CARD". O card recebe mais de uma
--      sugestão ao longo da vida (a oc avança e o agente re-analisa); só a
--      primeira virava par. Agora a chave é (card, oc do card, sugestão).
--
-- NÃO altera a view v_agent_feedback_unificado — a aba Aprendizado e os chats
-- continuam lendo exatamente o mesmo contrato. Só passa a haver mais linhas
-- (e linhas de ACERTO onde antes só havia erro).
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) oc13: mede os DOIS lados e TODOS os ramos que sugerem
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_feedback_oc13_implicito(
  p_card_id uuid,
  p_codigo_aprovado integer
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_id uuid;
  v_decisao_ia jsonb;
  v_decisao_tipo text;
  v_oc_sugerida int;
  v_tipo text;
BEGIN
  SELECT analise_oc13_resultado INTO v_decisao_ia
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  -- Análise que falhou não é sugestão: vira abstenção na view (chave erro_msg),
  -- nunca erro do agente.
  IF v_decisao_ia ? 'erro_msg' THEN
    RETURN NULL;
  END IF;

  v_decisao_tipo := v_decisao_ia->>'decisao';
  IF v_decisao_tipo IS NULL THEN
    RETURN NULL;
  END IF;

  -- Ramo autônomo: o agente executa sozinho, não existe decisão humana pra
  -- comparar. Contar como acerto seria o agente se auto-avaliando.
  IF v_decisao_tipo = 'autonoma' THEN
    RETURN NULL;
  END IF;

  -- Código que o agente sugeriu. Prefere o acao_key (mais preciso); cai no
  -- mapeamento do `decisao` quando ausente (metade dos casos não tem o campo).
  v_oc_sugerida := NULLIF(split_part(v_decisao_ia->>'proposta_destacada_acao', ':', 2), '')::int;
  IF v_oc_sugerida IS NULL THEN
    v_oc_sugerida := CASE v_decisao_tipo
      WHEN 'sugerir_54_email'  THEN 54
      WHEN 'sugerir_21_cancel' THEN 21
      WHEN 'sugerir_56'        THEN 56
      ELSE NULL
    END;
  END IF;

  IF v_oc_sugerida IS NULL THEN
    RETURN NULL;  -- ramo novo/desconhecido: não inventa veredito
  END IF;

  -- ✅ Caio 2026-08-13: grava ACERTO e ERRO (antes só erro — ver cabeçalho).
  IF p_codigo_aprovado = v_oc_sugerida THEN
    v_tipo := 'sugestao_certa_implicita';
  ELSE
    v_tipo := 'sugestao_errada_implicita';
  END IF;

  -- Idempotência por PAR (card + sugestão), não por card: o agente re-analisa
  -- quando a oc avança, e cada sugestão nova é um par novo.
  IF EXISTS (
    SELECT 1 FROM public.agente_oc13_feedback
    WHERE card_id = p_card_id
      AND tipo_feedback LIKE 'sugestao_%_implicita'
      AND COALESCE(
            NULLIF(split_part(decisao_ia->>'proposta_destacada_acao', ':', 2), '')::int,
            CASE decisao_ia->>'decisao'
              WHEN 'sugerir_54_email'  THEN 54
              WHEN 'sugerir_21_cancel' THEN 21
              WHEN 'sugerir_56'        THEN 56
            END
          ) IS NOT DISTINCT FROM v_oc_sugerida
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agente_oc13_feedback (
    card_id, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_tipo, v_decisao_ia,
    CASE WHEN v_tipo = 'sugestao_errada_implicita' THEN p_codigo_aprovado ELSE NULL END,
    NULL, NULL, 'executor (implícito)'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2)+(3) ocs-padrao: escopo inclui oc 49; idempotência por PAR
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_feedback_ocs_padrao_implicito(
  p_card_id uuid,
  p_codigo_aprovado integer
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_proposta_destacada int;
  v_tipo text;
BEGIN
  SELECT analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RETURN NULL;
  END IF;

  -- Escopo = as ocs que o agente REALMENTE analisa. A 49 estava de fora por
  -- omissão: 417 cards analisados em 60d geraram 0 sinal implícito.
  -- Regra: ampliou o escopo do processador → amplie aqui (guard no verify).
  IF v_codigo_oc NOT IN (10, 11, 19, 35, 49) THEN
    RETURN NULL;
  END IF;

  v_proposta_destacada := (v_decisao_ia->>'proposta_destacada')::int;
  IF v_proposta_destacada IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_codigo_aprovado = v_proposta_destacada THEN
    v_tipo := 'sugestao_certa_implicita';
  ELSE
    v_tipo := 'sugestao_errada_implicita';
  END IF;

  -- Idempotência por PAR (card + oc do card + sugestão). Antes era 1 por card:
  -- o card recebe ~1,6 sugestões ao longo da vida e só a 1ª virava par.
  IF EXISTS (
    SELECT 1 FROM public.agente_ocs_padrao_feedback
    WHERE card_id = p_card_id
      AND tipo_feedback LIKE 'sugestao_%_implicita'
      AND codigo_oc_card IS NOT DISTINCT FROM v_codigo_oc
      AND (decisao_ia->>'proposta_destacada')::int IS NOT DISTINCT FROM v_proposta_destacada
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, v_tipo, v_decisao_ia,
    CASE WHEN v_tipo = 'sugestao_errada_implicita' THEN p_codigo_aprovado ELSE NULL END,
    NULL, NULL, 'executor (implícito)'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2b) ocs-padrao EXPLÍCITO: mesma correção de escopo + fecha a assimetria
--
-- Hoje `registrar_feedback_ocs_padrao_ia` (IA ERROU) tem o filtro de escopo e
-- levanta exceção fora dele, enquanto `registrar_acerto_ocs_padrao_ia` (IA
-- ACERTOU) não tem guard nenhum. Em oc 49 o operador CONSEGUE dizer "acertou" e
-- NÃO consegue dizer "errou" — viés embutido a favor do agente.
-- Também adiciona `assert_pode_executar()` (trava do modo visualização, mig 324),
-- que só existia na RPC do interpretador.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_feedback_ocs_padrao_ia(
  p_card_id uuid,
  p_decisao_correta_codigo_ssw integer,
  p_motivo_correcao text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_user uuid;
  v_operador_id uuid;
  v_nome text;
  v_id uuid;
  v_decisao_ia jsonb;
  v_codigo_oc int;
  v_assigned uuid;
  v_pagador text;
  v_segmento text;
  v_motivo_limpo text;
BEGIN
  PERFORM public.assert_pode_executar();

  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Operador não autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT id, nome INTO v_operador_id, v_nome
  FROM public.operadores WHERE user_id = v_user LIMIT 1;
  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador % não cadastrado em public.operadores', v_user USING ERRCODE = '42501';
  END IF;

  SELECT assigned_operator_id, pagador, segmento_codigo, analise_padrao_resultado, cod_ultima_ocorrencia
    INTO v_assigned, v_pagador, v_segmento, v_decisao_ia, v_codigo_oc
  FROM public.cards WHERE id = p_card_id;

  IF v_decisao_ia IS NULL THEN
    RAISE EXCEPTION 'Card % não tem análise IA padrão — feedback inaplicável', p_card_id USING ERRCODE = 'P0002';
  END IF;

  -- escopo espelha a RPC implícita (inclui 49)
  IF v_codigo_oc NOT IN (10, 11, 19, 35, 49) THEN
    RAISE EXCEPTION 'Card % oc=% fora do escopo do agente padrão', p_card_id, v_codigo_oc USING ERRCODE = '22023';
  END IF;

  IF NOT public.card_visivel_pelo_operador_atual(v_assigned, v_pagador, v_segmento) THEN
    RAISE EXCEPTION 'Sem permissão pra registrar feedback neste card' USING ERRCODE = '42501';
  END IF;

  v_motivo_limpo := NULLIF(trim(COALESCE(p_motivo_correcao,'')), '');
  IF v_motivo_limpo IS NOT NULL AND length(v_motivo_limpo) < 10 THEN
    RAISE EXCEPTION 'Motivo da correção precisa ter ao menos 10 caracteres' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.agente_ocs_padrao_feedback (
    card_id, codigo_oc_card, tipo_feedback, decisao_ia, decisao_correta_codigo_ssw,
    motivo_correcao, corrigido_por, corrigido_por_nome
  ) VALUES (
    p_card_id, v_codigo_oc, 'sugestao_errada_explicita', v_decisao_ia, p_decisao_correta_codigo_ssw,
    v_motivo_limpo, v_operador_id, v_nome
  )
  RETURNING id INTO v_id;

  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  VALUES (
    p_card_id, 'FeedbackAgenteOcsPadrao', 'operator', v_user::text,
    jsonb_build_object(
      'feedback_id', v_id,
      'codigo_oc_card', v_codigo_oc,
      'tipo_feedback', 'sugestao_errada_explicita',
      'decisao_correta_codigo_ssw', p_decisao_correta_codigo_ssw,
      'motivo_correcao', v_motivo_limpo,
      'corrigido_por_nome', v_nome
    )
  );

  RETURN v_id;
END;
$function$;

commit;
