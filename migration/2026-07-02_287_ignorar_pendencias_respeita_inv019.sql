-- ============================================================================
-- Cockpit v2 — ignorar_pendencias_resposta_cliente respeita INV-019
-- Data: 2026-07-02
--
-- Bug NF 1119469 (card 98338d77-d4ff-4b60-83ad-241ca42632df, Duilio): card com
-- oc de RELACIONAMENTO ≠54 (oc=19, ENTREGA COM FALTA) ficou preso em
-- state='AGUARDANDO_CLIENTE' + lock=false, violando INV-019.
--
-- RAIZ (fato verificado): a RPC ignorar_pendencias_resposta_cliente fazia
-- `UPDATE cards SET state='AGUARDANDO_CLIENTE'` INCONDICIONALMENTE — nunca leu
-- nem checou cod_ultima_ocorrencia. Toda vez que o operador clicava
-- "IGNORAR E SEGUIR" num card de relacionamento ≠54 (oc 19/49/20/11/35/...),
-- a própria RPC CRIAVA a violação de INV-019. O resto do sistema já aplica o
-- guard `oc=54 ⟺ AGUARDANDO_CLIENTE`:
--   - responder-email-cliente/index.ts L296-333 (só oc=54 volta p/ AGUARDANDO_CLIENTE)
--   - sync-bastao Pass A / sweep / watchdog (INV-019, 3 camadas)
--   - verify-cockpit INV-019 (predicado DB)
-- A RPC era o único caminho que ignorava esse guard.
--
-- FIX (ataca a raiz): a RPC passa a decidir o state destino pelo MESMO predicado
-- do INV-019 do /verify-cockpit (inclusive a exclusão de LAG pós-lançamento de 54):
--   (1) oc=54 OU lag pós-54 (lançou 54, Bastão ainda mostra a oc anterior)
--       → AGUARDANDO_CLIENTE (comportamento atual preservado);
--   (2) oc de RELACIONAMENTO ≠54 (3,8,10,11,17,19,20,23,26,28,35,43,49,52) e
--       NÃO é lag → FICA em AGUARDANDO_VALIDACAO_HUMANA + lock=true (AGUARDANDO
--       VOCÊ). Limpa cliente_respondeu_em + ia_sugestao_oc_resposta (sai de
--       CLIENTE RESPONDEU) mas o operador ainda precisa LANÇAR a oc pra destravar.
--       Evento: PendenciasRespostaIgnoradasMantidoEmAguardandoVoce (regra=INV-019);
--   (3) fora de escopo (oc não-relacionamento, ≠54) → AGUARDANDO_CLIENTE
--       (ramo out-of-escopo + CONFLITOS via Pass B — INVARIANTES §INV-019).
--
-- O predicado é EXATAMENTE a negação da condição "stuck" do INV-019: a RPC só
-- deixa o card ir pra AGUARDANDO_CLIENTE quando o INV-019 NÃO o marcaria como
-- violação. Alinhamento total com o self-heal (convergem no mesmo destino).
--
-- Índice: acoes_executadas_ssw tem UNIQUE (card_id, codigo_oc, ctrc) — o EXISTS
-- por (card_id, codigo_oc=54) faz seek nele. RPC roda 1x por clique do operador.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente(
  p_card_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_operador_papel text;
  v_card record;
  v_sugestao_anterior jsonb;
  v_deve_manter_avh boolean;
  v_state_novo text;
  v_lock_novo boolean;
BEGIN
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
  -- oc de RELACIONAMENTO ≠54 E não está em lag pós-lançamento de 54.
  v_deve_manter_avh := (
    v_card.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = p_card_id
        AND a.codigo_oc = 54
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= v_card.bastao_data_ultima_ocorrencia
    )
  );

  IF v_deve_manter_avh THEN
    -- oc de relacionamento ≠54: NÃO pode ir pra AGUARDANDO_CLIENTE (INV-019).
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
        'observacao', 'oc de relacionamento ≠54: card não pode ir pra AGUARDANDO_CLIENTE. Fica em AGUARDANDO VOCÊ (AVH+lock) até a operadora lançar a ocorrência.'
      )
    );
  ELSE
    -- oc=54, lag pós-54, ou fora de escopo → AGUARDANDO_CLIENTE (comportamento
    -- atual preservado). Card volta limpo; próxima resposta re-aciona o ciclo.
    v_state_novo := 'AGUARDANDO_CLIENTE';
    v_lock_novo := false;

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
    -- VOCÊ (oc de relacionamento ≠54 — invariante oc=54 ⟺ AGUARDANDO_CLIENTE).
    'permaneceu_em_aguardando_voce', v_deve_manter_avh,
    'cod_ultima_ocorrencia', v_card.cod_ultima_ocorrencia
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.ignorar_pendencias_resposta_cliente(uuid, text) IS
  'Caio 2026-07-02 v3 (bug NF 1119469): respeita INV-019. Só move p/ '
  'AGUARDANDO_CLIENTE quando oc=54, lag pós-54, ou fora de escopo. Oc de '
  'relacionamento ≠54 (3,8,10,11,17,19,20,23,26,28,35,43,49,52 sem lag) FICA em '
  'AGUARDANDO_VALIDACAO_HUMANA + lock=true — evento '
  'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce. Predicado idêntico ao '
  '/verify-cockpit INV-019.';

-- ============================================================================
-- BACKFILL RETROATIVO — todos os cards já presos por este bug
-- state=AGUARDANDO_CLIENTE + oc de relacionamento ≠54 + NÃO lag pós-54.
-- Move p/ AGUARDANDO_VALIDACAO_HUMANA + lock=true e grava card_event por card
-- (event sourcing — cards é projeção, INV-002). Inclui a NF 1119469.
-- Predicado idêntico ao INV-019 do /verify-cockpit.
-- ============================================================================
WITH presos AS (
  SELECT c.id, c.state AS state_anterior, c.cod_ultima_ocorrencia,
         c.lock_aguardando_validacao AS lock_anterior, c.cliente_respondeu_em
  FROM public.cards c
  WHERE c.state = 'AGUARDANDO_CLIENTE'
    AND c.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
    AND NOT EXISTS (
      SELECT 1 FROM public.acoes_executadas_ssw a
      WHERE a.card_id = c.id
        AND a.codigo_oc = 54
        AND a.sucesso
        AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
            >= c.bastao_data_ultima_ocorrencia
    )
),
upd AS (
  UPDATE public.cards c
  SET state = 'AGUARDANDO_VALIDACAO_HUMANA',
      lock_aguardando_validacao = true,
      cliente_respondeu_em = NULL,
      ia_sugestao_oc_resposta = NULL
  FROM presos p
  WHERE c.id = p.id
  RETURNING c.id, p.state_anterior, p.cod_ultima_ocorrencia,
            p.lock_anterior, p.cliente_respondeu_em
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  u.id,
  'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce',
  'system',
  'migration_287_inv019_backfill',
  jsonb_build_object(
    'motivo', 'backfill retroativo mig 287: AGUARDANDO_CLIENTE com oc de relacionamento ≠54 viola INV-019 (RPC ignorar_pendencias movia sem checar cod_ultima_ocorrencia)',
    'cod_ultima_ocorrencia', u.cod_ultima_ocorrencia,
    'state_anterior', u.state_anterior,
    'state_novo', 'AGUARDANDO_VALIDACAO_HUMANA',
    'lock_anterior', u.lock_anterior,
    'lock_novo', true,
    'cliente_respondeu_em_zerado', u.cliente_respondeu_em,
    'regra', 'INV-019'
  )
FROM upd u;
