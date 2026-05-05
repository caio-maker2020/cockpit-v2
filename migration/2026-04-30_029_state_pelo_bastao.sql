-- ============================================================================
-- Cockpit v2 — State usa responsavel_atual do Bastão como fonte da verdade
-- Data: 2026-04-30
--
-- Contexto: a função state_pela_responsabilidade(cod) (migration 027) usava
-- só o dicionário. Isso falha quando o dicionário classifica uma oc como
-- "Relacionamento" mas na pendência específica o Bastão já passou
-- responsavel_atual='devolucao' (ex: oc=58 "Volume da destroca coletado").
--
-- Caso reportado por Caio em 2026-04-30: NF 127811 estava em PARA FAZER
-- mesmo com responsavel_atual=devolucao. Cliente vê isso, vai cobrar
-- Larissa, ela não tem nada a fazer (Devolução está com a carga).
--
-- Nova hierarquia de decisão:
--   1. responsavel_atual do Bastão é fonte primária (quando preenchido)
--   2. Fallback: dicionário responsabilidade (quando responsavel_atual NULL)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.state_pelo_bastao(
  p_cod int,
  p_responsavel_atual text
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_resp text;
  v_resp_dicionario text;
BEGIN
  -- Normaliza responsavel_atual: lowercase, trim
  v_resp := lower(trim(coalesce(p_responsavel_atual, '')));

  -- Camada 1: Bastão é fonte da verdade quando informa
  IF v_resp = 'cliente' THEN
    RETURN 'AGUARDANDO_CLIENTE';
  ELSIF v_resp = 'relacionamento' THEN
    RETURN 'AGUARDANDO_AGENTE';
  ELSIF v_resp <> '' THEN
    -- devolucao, operacao, indenizacao, ... = qualquer outro setor
    RETURN 'TRANSFERIDO';
  END IF;

  -- Camada 2: fallback no dicionário quando Bastão não informou
  IF p_cod IS NULL THEN
    RETURN 'AGUARDANDO_AGENTE';
  END IF;

  SELECT responsabilidade INTO v_resp_dicionario
  FROM public.ocorrencias_dicionario
  WHERE codigo = p_cod;

  RETURN CASE v_resp_dicionario
    WHEN 'Cliente'        THEN 'AGUARDANDO_CLIENTE'
    WHEN 'Relacionamento' THEN 'AGUARDANDO_AGENTE'
    ELSE                       'TRANSFERIDO'
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.state_pelo_bastao(int, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.state_pelo_bastao(int, text) IS
  'Decide o state do card usando responsavel_atual do Bastão como fonte '
  'primária; faz fallback no dicionário ocorrencias_dicionario.responsabilidade '
  'quando o Bastão não informou. Preferido sobre state_pela_responsabilidade(int) '
  'porque o dicionário é estático e o responsavel_atual do Bastão é dinâmico '
  '(reflete trasferências entre setores em casos onde o codigo não muda).';

-- ============================================================================
-- Backfill: aplicar a nova lógica nos cards "passivos" sem lock
-- ============================================================================

WITH alvo AS (
  SELECT
    c.id,
    c.state AS state_atual,
    c.cod_ultima_ocorrencia,
    c.agent_state->>'responsavel_atual' AS responsavel_atual,
    public.state_pelo_bastao(
      c.cod_ultima_ocorrencia,
      c.agent_state->>'responsavel_atual'
    ) AS state_correto
  FROM public.cards c
  WHERE c.lock_aguardando_validacao = false
    AND c.state IN (
      'AGUARDANDO_AGENTE',
      'AGUARDANDO_CLIENTE',
      'AGUARDANDO_CONTEXTO',
      'AGUARDANDO_VINCULACAO',
      'EM_TRIAGEM',
      'RECEBIDO'
    )
),
movidos AS (
  UPDATE public.cards c
  SET state = a.state_correto
  FROM alvo a
  WHERE c.id = a.id
    AND a.state_correto IS NOT NULL
    AND a.state_correto <> a.state_atual
  RETURNING c.id, a.state_atual, a.state_correto, a.cod_ultima_ocorrencia, a.responsavel_atual
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  id,
  'StateRecalculadoPorResponsavelAtual',
  'system',
  'migration_029',
  jsonb_build_object(
    'state_anterior', state_atual,
    'state_atual', state_correto,
    'cod_ultima_ocorrencia', cod_ultima_ocorrencia,
    'responsavel_atual_bastao', responsavel_atual,
    'motivo', 'Bastão informou responsavel_atual diferente da responsabilidade do dicionário'
  )
FROM movidos;
