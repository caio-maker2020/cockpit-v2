-- =============================================================================
-- Fix forward: v_extravios_kanban.dias_uteis volta a ser INTEIRO (regressão).
--
-- Caio 2026-06-24 (NF 135944 MANHUACU oc=6, card mostrava "2.78 dias úteis"):
-- a aba EXTRAVIOS mostra "X dias úteis" no card. Dia útil é unidade discreta —
-- NÃO existe "2.78 dias úteis", só 2 ou 3.
--
-- Regra correta veio da mig 215 (2026-06-18, commit eab8d39): dias_uteis_entre()
-- com AMBOS os lados convertidos pra ::date (midnight a midnight) → conta dias
-- úteis inteiros (seg-sex). A mig 256 recriou a view (trocou D5 por NAO_RODOU) e,
-- apesar do comentário "Reproduz mig 215 (mesmo cálculo)", reescreveu o cálculo
-- inline com timestamp COM HORA + round(,2) → fração (2.78 = 2 dias + ~18h/24h).
--
-- Como a mig 256 já foi aplicada (view quebrada em prod), conserta-se FORWARD:
-- DROP + CREATE com o cálculo correto (muda tipo numeric→int, por isso DROP).
-- Preserva todas as colunas da mig 256 (incl. agente_extravio_* e NAO_RODOU).
--
-- Guard de não-regressão: /verify-cockpit Fase 8 INV-017d
--   select count(*) from v_extravios_kanban where dias_uteis <> floor(dias_uteis); -- = 0
-- =============================================================================

DROP VIEW IF EXISTS public.v_extravios_kanban;

CREATE VIEW public.v_extravios_kanban
WITH (security_invoker = on) AS
SELECT
  base.card_id,
  base.nf,
  base.ctrc,
  base.base_destino,
  base.empresa_cliente,
  base.pagador_nome,
  base.cnpj_pagador,
  base.remetente,
  base.destinatario,
  base.oc_extravio,
  base.instrucao,
  base.qtde_volumes,
  base.data_lancamento,
  base.assigned_operator_id,
  base.responsavel_relacionamento,
  -- estado do agente autônomo (M1)
  base.agente_extravio_status,
  base.agente_extravio_motivo,
  base.agente_extravio_oc_achada,
  base.agente_extravio_checado_em,
  -- dias úteis INTEIROS (mínimo 1) — número exibido no card. du_raw já vem
  -- inteiro do `base` (ambos os lados ::date). NUNCA round(timestamp-com-hora,2).
  GREATEST(1, base.du_raw::int) AS dias_uteis,
  -- bucket: NÃO RODOU (agente flaggou) tem coluna própria; senão D1..D4 (4+ = D4)
  CASE
    WHEN base.agente_extravio_status = 'nao_rodou' THEN 'NAO_RODOU'
    ELSE 'D' || LEAST(4, GREATEST(1, base.du_raw::int))
  END AS coluna_kanban
FROM (
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
    c.agente_extravio_status,
    c.agente_extravio_motivo,
    c.agente_extravio_oc_achada,
    c.agente_extravio_checado_em,
    -- conta dias úteis pela DATA dos dois lados → valor INTEIRO (mig 215).
    -- lançamento: ::date direto (data que o Bastão mandou; NÃO converter via BRT
    -- senão datas puras 00:00 UTC voltam 1 dia). hoje: data BRT do now().
    public.dias_uteis_entre(
      (c.bastao_data_ultima_ocorrencia::date)::timestamptz,
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamptz
    ) AS du_raw
  FROM public.cards c
  WHERE c.state = 'EXTRAVIO_MONITORADO'
    AND c.cod_ultima_ocorrencia IN (6, 9, 16)
) base
ORDER BY base.du_raw DESC NULLS LAST;

GRANT SELECT ON public.v_extravios_kanban TO authenticated, service_role;

COMMENT ON VIEW public.v_extravios_kanban IS
  'Kanban EXTRAVIOS. Cards state=EXTRAVIO_MONITORADO + oc∈{6,9,16}. coluna_kanban = '
  'D1..D4 (4+ = D4) por dias úteis (dias_uteis_entre, AMBOS os lados ::date → INTEIRO) '
  'OU NAO_RODOU (agente D+4 achou oc pós-extravio). security_invoker=on → RLS de cards. '
  'Caio 2026-06-24: fix forward da mig 256 (dias_uteis voltou a ser inteiro; INV-017d).';
