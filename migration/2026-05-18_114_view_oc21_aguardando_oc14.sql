-- ============================================================================
-- Cockpit v2 — View v_oc21_aguardando_oc14: cards com oc=21 SEM oc=14 ainda
-- Data: 2026-05-18
--
-- Caio: o indicador agregado v_indicador_tempo_oc21_oc14_base só mostra pares
-- COMPLETOS (21 já teve 14 depois). Cards com 21 aguardando 14 ficam
-- invisíveis no front. Esta view expõe os pendentes.
--
-- Lógica:
--   1. Pra cada card com historico_ssw, extrai TODAS as oc=21 e oc=14 com data
--   2. Pra cada oc=21, checa se tem oc=14 com data > data_oc21
--   3. Se NÃO tem: linha pendente. Calcula horas_paradas (now - data_oc21)
--   4. Enriquece com info do alerta enviado (se houver) via LEFT JOIN
-- ============================================================================

DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14 CASCADE;

CREATE VIEW public.v_oc21_aguardando_oc14
WITH (security_invoker = on) AS
WITH eventos AS (
  -- Expande historico_ssw em linhas, filtra só oc=21 e oc=14
  SELECT
    c.id AS card_id,
    c.nf,
    c.ctrc,
    c.responsavel_relacionamento,
    c.base_destino,
    (h.elem->>'codigo')::int AS codigo,
    h.elem->>'data' AS data_str,
    h.elem->>'filial' AS filial,
    h.elem->>'usuario' AS usuario,
    -- Parse dd/mm/yy HH:MM → timestamptz (BRT → UTC: soma 3h)
    CASE
      WHEN h.elem->>'data' ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$' THEN
        (
          '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
          lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
          lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
          split_part(h.elem->>'data', ' ', 2) || ':00-03'
        )::timestamptz
      ELSE NULL
    END AS data_parsed
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IN (14, 21)
),
oc21s AS (
  SELECT * FROM eventos WHERE codigo = 21 AND data_parsed IS NOT NULL
),
oc14s AS (
  SELECT card_id, data_parsed FROM eventos WHERE codigo = 14 AND data_parsed IS NOT NULL
),
pendentes AS (
  -- oc=21 que NÃO tem oc=14 com data posterior
  SELECT
    o21.card_id,
    o21.nf,
    o21.ctrc,
    o21.responsavel_relacionamento,
    o21.base_destino,
    o21.data_parsed AS data_oc21,
    o21.filial AS filial_oc21,
    o21.usuario AS usuario_oc21,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_parsed)) / 60)::int AS minutos_paradas,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_parsed)) / 3600, 1) AS horas_paradas,
    (EXTRACT(EPOCH FROM (now() - o21.data_parsed)) <= 24*60*60) AS dentro_sla
  FROM oc21s o21
  WHERE NOT EXISTS (
    SELECT 1 FROM oc14s o14
    WHERE o14.card_id = o21.card_id
      AND o14.data_parsed > o21.data_parsed
  )
)
SELECT
  p.*,
  -- Enriquece com info do alerta enviado (se houver)
  a.id AS alerta_id,
  a.status AS alerta_status,
  a.base_oc14_esperada AS alerta_base_destino,
  a.destinatario_email AS alerta_destinatario,
  a.enviado_em AS alerta_enviado_em,
  a.mensagem_assunto AS alerta_assunto,
  a.motivo_falha AS alerta_motivo_falha,
  -- Classificação do status pra renderização no front
  CASE
    WHEN a.id IS NOT NULL AND a.status = 'enviado' THEN 'alerta_enviado'
    WHEN a.id IS NOT NULL AND a.status = 'falhou' THEN 'alerta_falhou'
    WHEN p.dentro_sla THEN 'aguardando_dentro_sla'
    ELSE 'fora_sla_sem_alerta'
  END AS status_visual
FROM pendentes p
LEFT JOIN public.alertas_sla_oc21_oc14 a
  ON a.card_id = p.card_id AND a.data_oc21 = p.data_oc21
ORDER BY p.minutos_paradas DESC;

GRANT SELECT ON public.v_oc21_aguardando_oc14 TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_aguardando_oc14 IS
  'Caio 2026-05-18: cards com oc=21 lançada mas sem oc=14 ainda. Visível na '
  'aba INDICADORES > 2º card > bloco "Aguardando oc=14". Inclui horas paradas, '
  'classificação SLA, e status do alerta (se já foi enviado). status_visual: '
  'alerta_enviado | alerta_falhou | aguardando_dentro_sla | fora_sla_sem_alerta.';
