-- =============================================================================
-- 2026-08-28_367 — oc43 REGRA V2 (extravio monitorado com relógio original)
--                  + PAINEL de ações autônomas executadas
-- =============================================================================
-- Plano aprovado Caio 28/08:
--   1. Flag oc43_regra_v2_enabled (nasce OFF — 24h de sombra antes de virar);
--   2. v_extravios_kanban v3: card pós-43 devolvido ao trilho
--      (state=EXTRAVIO_MONITORADO + agent_state.extravio_retomado_pos43) entra
--      no kanban com oc_extravio e DIAS contados da DATA DO EXTRAVIO ORIGINAL
--      (B4) — não da 43. Parse do formato SSW 'DD/MM/YY HH24:MI' com fallback
--      seguro pra bastao_data quando o parse falhar;
--   3. RPC painel_acoes_autonomas(): a visão "o robô agiu" pedida pelo Caio —
--      janela de veto + agente oc43 + agente de extravio (relancar-54 fica
--      fora: dormente). Operador vê SÓ os seus; papel=gestor (Caio/João/
--      Isadora) vê todos com filtro. SECURITY DEFINER com search_path fixo e
--      identidade via auth.uid() → operadores.user_id.
-- skill: supabase-postgres-best-practices. Idempotente. Sem BEGIN/COMMIT.
-- =============================================================================

INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('oc43_regra_v2_enabled', false,
        'Regra v2 da automação oc43 (Caio 28/08): extravio→monitorado c/ relógio original; relança a última oc herdando instrução; 55 só operacional. OFF = sombra (loga v1×v2).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- v_extravios_kanban v3 — inclui o card pós-43 devolvido (B4)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_extravios_kanban AS
 SELECT card_id, nf, ctrc, base_destino, empresa_cliente, pagador_nome,
    cnpj_pagador, remetente, destinatario, oc_extravio, instrucao, qtde_volumes,
    data_lancamento, assigned_operator_id, responsavel_relacionamento,
    agente_extravio_status, agente_extravio_motivo, agente_extravio_oc_achada,
    agente_extravio_checado_em,
    GREATEST(1, (du_raw)::integer) AS dias_uteis,
        CASE
            WHEN (agente_extravio_status = 'nao_rodou'::text) THEN 'NAO_RODOU'::text
            ELSE ('D'::text || LEAST(4, GREATEST(1, (du_raw)::integer)))
        END AS coluna_kanban
   FROM ( SELECT c.id AS card_id,
            c.nf,
            c.ctrc,
            COALESCE(c.base_destino, (c.agent_state ->> 'unidade_atual'::text)) AS base_destino,
            c.empresa_cliente,
            c.pagador AS pagador_nome,
            (c.agent_state ->> 'cnpj_pagador'::text) AS cnpj_pagador,
            (c.agent_state ->> 'remetente'::text) AS remetente,
            (c.agent_state ->> 'destinatario'::text) AS destinatario,
            -- pós-43 devolvido (B4): a oc DO EXTRAVIO vem da marca, não da 43
            CASE WHEN c.cod_ultima_ocorrencia = 43
                      AND (c.agent_state ? 'extravio_retomado_pos43')
                 THEN ((c.agent_state -> 'extravio_retomado_pos43' ->> 'oc'))::integer
                 ELSE c.cod_ultima_ocorrencia END AS oc_extravio,
            (c.agent_state ->> 'instrucao_ultima_ocorrencia'::text) AS instrucao,
            c.qtde_volumes,
            c.bastao_data_ultima_ocorrencia AS data_lancamento,
            c.assigned_operator_id,
            c.responsavel_relacionamento,
            c.agente_extravio_status,
            c.agente_extravio_motivo,
            c.agente_extravio_oc_achada,
            c.agente_extravio_checado_em,
            dias_uteis_entre(
              -- B4: relógio da DATA ORIGINAL do extravio quando devolvido pós-43
              CASE WHEN c.cod_ultima_ocorrencia = 43
                        AND (c.agent_state -> 'extravio_retomado_pos43' ->> 'data_original') ~ '^\d{2}/\d{2}/\d{2} \d{1,2}:\d{2}'
                   THEN to_timestamp((c.agent_state -> 'extravio_retomado_pos43' ->> 'data_original'), 'DD/MM/YY HH24:MI')
                   ELSE (c.bastao_data_ultima_ocorrencia)::timestamp with time zone END,
              (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date)::timestamp with time zone
            ) AS du_raw
           FROM cards c
          WHERE c.state = 'EXTRAVIO_MONITORADO'::text
            AND (c.cod_ultima_ocorrencia = ANY (ARRAY[6, 9, 16])
                 OR (c.cod_ultima_ocorrencia = 43 AND (c.agent_state ? 'extravio_retomado_pos43')))) base
  ORDER BY du_raw DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- Painel de ações autônomas executadas (Caio 28/08)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.painel_acoes_autonomas(
  p_operador_id uuid DEFAULT NULL,   -- filtro do gestor (null = todos)
  p_dias int DEFAULT 7,
  p_limit int DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_op_id uuid; v_papel text; v jsonb;
  v_filtro uuid;
BEGIN
  SELECT id, papel INTO v_op_id, v_papel FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid();
  END IF;
  -- Operador comum: SEMPRE só os próprios cards (ignora p_operador_id).
  -- Gestor (Caio/João/Isadora): todos, com filtro opcional.
  v_filtro := CASE WHEN v_papel = 'gestor' THEN p_operador_id ELSE v_op_id END;

  WITH fontes AS (
    SELECT ce.card_id, ce.created_at,
           CASE
             WHEN ce.event_type = 'AgenteOc43Lancou' THEN 'agente_oc43'
             WHEN ce.event_type = 'AgenteExtravioLancou49' THEN 'agente_extravio'
             ELSE 'janela_veto'
           END AS fonte,
           ce.payload
      FROM public.card_events ce
     WHERE ce.created_at > now() - make_interval(days => GREATEST(1, LEAST(90, p_dias)))
       AND (
         ce.event_type IN ('AgenteOc43Lancou', 'AgenteExtravioLancou49')
         OR (ce.event_type = 'AutoAprovacaoPermitida'
             AND coalesce(ce.payload->>'regra','') LIKE 'veto_janela%')
       )
  )
  SELECT jsonb_build_object(
    'papel', v_papel,
    'placar', (SELECT coalesce(jsonb_object_agg(fonte, n), '{}'::jsonb)
      FROM (SELECT f.fonte, count(*) n
              FROM fontes f JOIN public.cards c ON c.id = f.card_id
             WHERE (v_filtro IS NULL OR c.assigned_operator_id = v_filtro)
             GROUP BY f.fonte) t),
    'acoes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'nf', c.nf, 'card_id', c.id, 'fonte', f.fonte,
        'operador', o.nome,
        'em', to_char(f.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'),
        'detalhe', CASE
          WHEN f.fonte = 'janela_veto' THEN coalesce(f.payload->>'acao_key', f.payload->>'regra')
          WHEN f.fonte = 'agente_oc43' THEN 'oc '||coalesce(f.payload->>'codigo_ssw', f.payload->>'acao', '?')
          ELSE 'oc 49 (prazo de perdas)'
        END
      ) ORDER BY f.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM fontes ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(1000, p_limit))) f
      JOIN public.cards c ON c.id = f.card_id
      LEFT JOIN public.operadores o ON o.id = c.assigned_operator_id
     WHERE (v_filtro IS NULL OR c.assigned_operator_id = v_filtro)),
    'operadores', CASE WHEN v_papel = 'gestor'
      THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome) ORDER BY nome), '[]'::jsonb)
              FROM public.operadores WHERE ativo AND cockpit_ativo)
      ELSE '[]'::jsonb END
  ) INTO v;
  RETURN v;
END $fn$;

REVOKE ALL ON FUNCTION public.painel_acoes_autonomas(uuid, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_acoes_autonomas(uuid, int, int) TO authenticated, service_role;
