-- 2026-07-17_302 — Loop de Aprendizado (F2, iteração 2): v_sinal_ouro_casos
--
-- Caso-a-caso do Sinal de Ouro COM o raciocínio da IA (decisao_ia — inclui
-- observacao_orquestrador, motivo_extraido, confianca, foto_classificacao)
-- pro painel mostrar "POR QUE o agente sugeriu" e alimentar as perguntas
-- direcionadas do agente-chefe. Linha do tempo vem de v_card_events_legivel
-- (já existente) — zero chamadas novas ao SSW.

BEGIN;

CREATE VIEW public.v_sinal_ouro_casos
WITH (security_invoker = on) AS
WITH base AS (
  SELECT
    'agente-sugere-ocs-padrao'::text AS agent_name,
    f.card_id,
    f.corrigido_em AS decidido_em,
    CASE
      WHEN f.tipo_feedback = 'caso_nao_reconhecido'   THEN 'abstencao'
      WHEN f.tipo_feedback LIKE 'sugestao_certa%'     THEN 'seguida'
      ELSE 'corrigida'
    END AS veredito,
    f.codigo_oc_card AS oc_card,
    CASE WHEN f.decisao_ia->>'proposta_destacada' ~ '^\d+$'
         THEN (f.decisao_ia->>'proposta_destacada')::int END AS oc_sugerida,
    f.decisao_correta_codigo_ssw AS oc_executada,
    f.motivo_correcao,
    f.corrigido_por_nome,
    f.decisao_ia
  FROM public.agente_ocs_padrao_feedback f

  UNION ALL

  SELECT
    'agente-oc13-autonomo', f.card_id, f.corrigido_em,
    CASE
      WHEN f.decisao_ia ? 'erro_msg'              THEN 'abstencao'
      WHEN f.tipo_feedback LIKE 'sugestao_certa%' THEN 'seguida'
      ELSE 'corrigida'
    END,
    13,
    CASE WHEN split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2) ~ '^\d+$'
         THEN split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2)::int END,
    f.decisao_correta_codigo_ssw, f.motivo_correcao, f.corrigido_por_nome, f.decisao_ia
  FROM public.agente_oc13_feedback f

  UNION ALL

  SELECT
    'interpretador-resposta-cliente', f.card_id, f.corrigido_em,
    CASE WHEN f.tipo_feedback LIKE 'acertou%' THEN 'seguida' ELSE 'corrigida' END,
    f.oc_card_no_momento, f.oc_sugerida_pela_ia, f.decisao_correta_codigo_ssw,
    f.motivo_correcao, f.corrigido_por_nome, f.decisao_ia
  FROM public.interpretador_resposta_cliente_feedback f
)
SELECT
  b.*,
  c.nf,
  c.empresa_cliente,
  c.responsavel_relacionamento AS operador_card,
  c.cod_ultima_ocorrencia,
  c.state
FROM base b
LEFT JOIN public.cards c ON c.id = b.card_id;

COMMENT ON VIEW public.v_sinal_ouro_casos IS
  'Caso-a-caso do Sinal de Ouro com decisao_ia (o porquê da sugestão). Fonte das perguntas direcionadas e do detalhe por caso no painel Aprendizado.';

COMMIT;
