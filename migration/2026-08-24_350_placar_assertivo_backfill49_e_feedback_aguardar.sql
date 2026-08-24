-- =============================================================================
-- 2026-08-24_350_placar_assertivo_backfill49_e_feedback_aguardar.sql
--
-- ASSERTIVIDADE DO PLACAR (Caio 24/08, NFs 1502332/685013). Duas peças:
--
-- 1. BACKFILL da oc 49: a régua da 49 nasceu em 13/08 (mig 337, Fase 0) SEM
--    retroativo — 1.749 decisões com recomendação destacada (jun→13/08) nunca
--    viraram par, ~1.015 delas SEGUIDAS perfeitas (medido 24/08). O trilho
--    primário é imutável (card_events AgenteOcsPadraoDecisao + lançamentos em
--    acoes_executadas_ssw) — o backfill reconstrói os pares de lá, com a MESMA
--    regra de pareamento da régua viva: decisão × primeiro lançamento
--    posterior (janela 7d, antes da próxima decisão), 1 par por
--    (card, proposta_destacada) — idempotência idêntica à da RPC.
--    O espelho trg_espelhar_ocs_padrao propaga pra agent_feedback usando
--    corrigido_em como created_at (data HISTÓRICA correta) e resolve o
--    operador via todos.approved_by (padrão mig 346).
--
-- 2. FEEDBACK DO "AGUARDAR": ignorar_pendencias_resposta_cliente passa a
--    registrar o par implícito do interpretador ANTES de limpar a sugestão —
--    "sugeriu aguardar e o operador aguardou" vira SEGUIDA (hoje era
--    invisível; só o lado "agiu" era medido, penalizando o agente).
--
-- SEM begin/commit interno (lição da mig 337). Idempotente.
-- =============================================================================

-- ─── 1. Backfill oc 49 (pré-régua de 13/08) ─────────────────────────────────
insert into public.agente_ocs_padrao_feedback
  (card_id, codigo_oc_card, tipo_feedback, decisao_ia,
   decisao_correta_codigo_ssw, corrigido_em)
select
  d.card_id,
  49,
  case when l.codigo_oc = d.destacada
       then 'sugestao_certa_implicita' else 'sugestao_errada_implicita' end,
  d.decisao,
  case when l.codigo_oc = d.destacada then null else l.codigo_oc end,
  l.iniciado_em
from (
  -- 1 decisão por (card, destacada): a PRIMEIRA (mesma idempotência da RPC)
  select distinct on (e.card_id, (e.payload->'decisao'->>'proposta_destacada')::int)
         e.card_id,
         e.created_at as decidido_em,
         (e.payload->'decisao'->>'proposta_destacada')::int as destacada,
         e.payload->'decisao' as decisao
  from public.card_events e
  where e.event_type = 'AgenteOcsPadraoDecisao'
    and e.payload->'decisao'->>'caso_oc49' is not null
    and (e.payload->'decisao'->>'proposta_destacada') ~ '^\d+$'
    and e.created_at >= '2026-06-01'
    and e.created_at < '2026-08-13'
  order by e.card_id, (e.payload->'decisao'->>'proposta_destacada')::int, e.created_at
) d
cross join lateral (
  -- primeiro lançamento bem-sucedido APÓS a decisão (janela 7d)
  select a.codigo_oc, a.iniciado_em
  from public.acoes_executadas_ssw a
  where a.card_id = d.card_id and a.sucesso
    and a.iniciado_em > d.decidido_em
    and a.iniciado_em < d.decidido_em + interval '7 days'
  order by a.iniciado_em
  limit 1
) l
where not exists (
  -- idempotência da RPC viva: 1 par implícito por (card, oc_card 49, destacada)
  select 1 from public.agente_ocs_padrao_feedback f
  where f.card_id = d.card_id
    and f.tipo_feedback like 'sugestao\_%\_implicita' escape '\'
    and f.codigo_oc_card is not distinct from 49
    and (f.decisao_ia->>'proposta_destacada')::int is not distinct from d.destacada
);

-- ─── 2. "Aguardar" vira par medido no ignorar ───────────────────────────────
CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente(p_card_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_sugestao_anterior jsonb;
  v_deve_manter_avh boolean;
  v_state_novo text;
  v_lock_novo boolean;
BEGIN
  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)
  SELECT id, papel INTO v_operador_id, v_operador_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, assigned_operator_id, state, lock_aguardando_validacao,
         cliente_respondeu_em, ia_sugestao_oc_resposta,
         cod_ultima_ocorrencia, bastao_data_ultima_ocorrencia
  INTO v_card FROM public.cards WHERE id = p_card_id;

  IF v_card.id IS NULL THEN
    RAISE EXCEPTION 'Card % não encontrado', p_card_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_operador_papel <> 'gestor'
     AND v_card.assigned_operator_id IS DISTINCT FROM v_operador_id THEN
    RAISE EXCEPTION 'Sem permissão pra ignorar pendências do card %', v_card.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_card.state <> 'AGUARDANDO_VALIDACAO_HUMANA' THEN
    RAISE EXCEPTION 'Só funciona quando card está em CLIENTE RESPONDEU (state atual: %)', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_card.cliente_respondeu_em IS NULL THEN
    RAISE EXCEPTION 'Card % não tem resposta de cliente pra ignorar', v_card.id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock aqui é lock de VALIDAÇÃO HUMANA (vinculador setou quando cliente
  -- respondeu), não de execução. O lock de execução real está no state.
  IF v_card.state IN ('EXECUTANDO_ACAO', 'EM_EXECUCAO_AUTOMATICA', 'ACAO_EXECUTADA') THEN
    RAISE EXCEPTION 'Card está em execução de ação (state=%). Aguarde finalizar.', v_card.state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_sugestao_anterior := v_card.ia_sugestao_oc_resposta;

  -- GUARD INV-019 (fato verificado — bug NF 1119469): predicado IDÊNTICO ao
  -- /verify-cockpit. O card só PODE deixar de ir pra AGUARDANDO_CLIENTE quando é
  -- oc de RELACIONAMENTO ≠{54,59} E não está em lag pós-lançamento de cliente.
  -- Caio 2026-07-13 (separação 54/59): a exceção de lag reconhece lançamento de
  -- 54 OU 59 (ambas põem o card em AGUARDANDO_CLIENTE). Sem o 59, um card cujo
  -- Cockpit lançou 59 e cujo Bastão ainda laga na oc anterior ficaria preso em AVH.
  v_deve_manter_avh := (
    v_card.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = p_card_id
        AND a.codigo_oc IN (54,59)
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= v_card.bastao_data_ultima_ocorrencia
    )
  );

  IF v_deve_manter_avh THEN
    -- oc de relacionamento ≠{54,59}: NÃO pode ir pra AGUARDANDO_CLIENTE (INV-019).
    -- Fica em AGUARDANDO VOCÊ (AVH+lock). Limpa os sinais de "cliente respondeu"
    -- pra sair da aba CLIENTE RESPONDEU, mas o operador ainda precisa LANÇAR a oc.
    v_state_novo := 'AGUARDANDO_VALIDACAO_HUMANA';
    v_lock_novo := true;

    UPDATE public.cards
    SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
        lock_aguardando_validacao = true,
        cliente_respondeu_em = NULL,
        ia_sugestao_oc_resposta = NULL
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      p_card_id,
      'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce',
      'operator',
      v_operador_id::text,
      jsonb_build_object(
        'motivo', coalesce(p_motivo, '(sem motivo informado)'),
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_VALIDACAO_HUMANA',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'lock_novo', true,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior,
        'regra', 'INV-019',
        'observacao', 'oc de relacionamento ≠{54,59}: card não pode ir pra AGUARDANDO_CLIENTE. Fica em AGUARDANDO VOCÊ (AVH+lock) até a operadora lançar a ocorrência.'
      )
    );
  ELSE
    -- oc∈{54,59}, lag pós-cliente, ou fora de escopo → AGUARDANDO_CLIENTE
    -- (comportamento atual preservado). Card volta limpo; próxima resposta re-aciona.
    v_state_novo := 'AGUARDANDO_CLIENTE';
    v_lock_novo := false;

    -- REGRA Caio 2026-08-24 (NF 1502332): "operador decidiu aguardar" é uma
    -- decisão de verdade — registra o par implícito ANTES de limpar a sugestão
    -- viva. Se a IA sugeriu a própria oc do card (54/59 = manter aguardando),
    -- o ignorar é SEGUIDA (aguardou junto); se sugeriu outra oc e o operador
    -- preferiu aguardar, vira corrigida com decisão real = a oc mantida.
    -- Telemetria NUNCA derruba o fluxo (mesma regra de ouro do executor).
    BEGIN
      IF v_sugestao_anterior IS NOT NULL THEN
        PERFORM public.registrar_feedback_interpretador_resposta_implicito(
          p_card_id, v_card.cod_ultima_ocorrencia);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- feedback é colateral
    END;

    UPDATE public.cards
    SET state = 'AGUARDANDO_CLIENTE',
        lock_aguardando_validacao = false,
        cliente_respondeu_em = NULL,
        ia_sugestao_oc_resposta = NULL
    WHERE id = p_card_id;

    INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
    VALUES (
      p_card_id,
      'PendenciasRespostaIgnoradas',
      'operator',
      v_operador_id::text,
      jsonb_build_object(
        'motivo', coalesce(p_motivo, '(sem motivo informado)'),
        'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia,
        'state_anterior', 'AGUARDANDO_VALIDACAO_HUMANA',
        'state_novo', 'AGUARDANDO_CLIENTE',
        'lock_anterior', v_card.lock_aguardando_validacao,
        'cliente_respondeu_em_zerado', v_card.cliente_respondeu_em,
        'ia_sugestao_anterior', v_sugestao_anterior
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'card_id', p_card_id,
    'state_novo', v_state_novo,
    'lock_novo', v_lock_novo,
    -- front usa isso pra avisar a operadora que o card NÃO saiu de AGUARDANDO
    -- VOCÊ (oc de relacionamento ≠{54,59} — invariante oc de cliente ⟺ AGUARDANDO_CLIENTE).
    'permaneceu_em_aguardando_voce', v_deve_manter_avh,
    'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
  );
END;
$function$;
