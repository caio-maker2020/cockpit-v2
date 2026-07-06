-- =============================================================================
-- Agente autônomo de extravios (PART 2) — M1: colunas de estado + kanban NÃO RODOU
--
-- Caio 2026-06-24: o agente D+4 confere no SSW antes de lançar a oc 49. Se acha
-- que algo foi lançado pós-extravio, NÃO roda e marca o card pra uma coluna nova
-- "AUTÔNOMO NÃO RODOU" (substitui a antiga D5 "5+ dias") com a explicação do
-- agente, pro operador verificar/reportar. M1 = só detecta/sinaliza (não lança).
--
-- Ver plano PART 2 + INV (a vir). Reusa v_extravios_kanban (mig 215).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Colunas de estado do agente em cards
--    status: null (não processado) | 'nao_rodou' | 'recomendado' | 'lancou'
-- ----------------------------------------------------------------------------
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS agente_extravio_status     text,
  ADD COLUMN IF NOT EXISTS agente_extravio_motivo     text,
  ADD COLUMN IF NOT EXISTS agente_extravio_checado_em timestamptz,
  ADD COLUMN IF NOT EXISTS agente_extravio_oc_achada  int;

ALTER TABLE public.cards DROP CONSTRAINT IF EXISTS cards_agente_extravio_status_check;
ALTER TABLE public.cards ADD CONSTRAINT cards_agente_extravio_status_check CHECK (
  agente_extravio_status IS NULL
  OR agente_extravio_status IN ('nao_rodou', 'recomendado', 'lancou')
);

COMMENT ON COLUMN public.cards.agente_extravio_status IS
  'Agente extravio D+4: null=não processado, nao_rodou=achou oc pós-extravio no SSW (não lançou), recomendado=pronto pra 49 (validação), lancou=49 lançada. Caio 2026-06-24.';

-- ----------------------------------------------------------------------------
-- 2. v_extravios_kanban — substitui D5 ("5+ dias") por coluna AUTÔNOMO NÃO RODOU.
--    Reproduz mig 215 (mesmo cálculo de dias úteis) e SÓ muda:
--      - coluna_kanban: cap em D4 (4+ vira D4); 'NAO_RODOU' se o agente flaggou
--      - expõe agente_extravio_status / _motivo / _oc_achada / _checado_em pro front
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_extravios_kanban;

CREATE VIEW public.v_extravios_kanban
WITH (security_invoker = on) AS
SELECT
  c.id AS card_id,
  c.nf,
  c.ctrc,
  COALESCE(c.base_destino, c.agent_state->>'unidade_atual') AS base_destino,
  c.empresa_cliente,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.agent_state->>'remetente'    AS remetente,
  c.agent_state->>'destinatario' AS destinatario,
  c.cod_ultima_ocorrencia AS oc_extravio,
  c.agent_state->>'instrucao_ultima_ocorrencia' AS instrucao,
  c.qtde_volumes,
  c.bastao_data_ultima_ocorrencia AS data_lancamento,
  c.assigned_operator_id,
  c.responsavel_relacionamento,
  -- estado do agente autônomo (M1)
  c.agente_extravio_status,
  c.agente_extravio_motivo,
  c.agente_extravio_oc_achada,
  c.agente_extravio_checado_em,
  -- dias úteis decorridos desde o lançamento da oc de extravio
  round(public.dias_uteis_entre(
    (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
    now()
  ), 2) AS dias_uteis,
  -- bucket: NÃO RODOU (agente flaggou) tem coluna própria; senão D1..D4 (4+ vira D4)
  CASE
    WHEN c.agente_extravio_status = 'nao_rodou' THEN 'NAO_RODOU'
    ELSE 'D' || LEAST(4, GREATEST(1, FLOOR(public.dias_uteis_entre(
      (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
      now()
    ))::int))
  END AS coluna_kanban
FROM public.cards c
WHERE c.state = 'EXTRAVIO_MONITORADO'
  AND c.cod_ultima_ocorrencia IN (6, 9, 16)
ORDER BY public.dias_uteis_entre(
  (c.bastao_data_ultima_ocorrencia AT TIME ZONE 'America/Sao_Paulo')::timestamptz,
  now()
) DESC NULLS LAST;

GRANT SELECT ON public.v_extravios_kanban TO authenticated, service_role;

COMMENT ON VIEW public.v_extravios_kanban IS
  'Kanban EXTRAVIOS. Cards state=EXTRAVIO_MONITORADO + oc∈{6,9,16}. coluna_kanban = '
  'D1..D4 (4+ = D4) por dias úteis (dias_uteis_entre) OU NAO_RODOU (agente D+4 achou '
  'oc pós-extravio no SSW). security_invoker=on → RLS de cards. Caio 2026-06-24 (PART 2 M1).';
