-- =============================================================================
-- v_oc21_aguardando_oc14 — amplia critério: TRANSFERIDO + oc=21 do histórico SSW
--
-- Caio 2026-05-22: NF 2296843 (DUILIO) — está em PRIORIDADES AI como oc=21
-- parada mas NÃO aparecia em v_oc21_aguardando_oc14. Causa raiz:
--   1. Excluía state TRANSFERIDO (estado VÁLIDO pra card oc=21 pós-INBOX)
--   2. Só contava oc=21 vindo de card_events 'AcaoExecutada' (Cockpit)
--
-- Fix:
--   - Remove filtro de TRANSFERIDO (mantém RESOLVIDO/CANCELADO)
--   - UNION: data_oc21 = MAX entre (AcaoExecutada Cockpit) e (histórico SSW)
--   - Preserva TODAS as colunas anteriores (filial_oc21, usuario_oc21,
--     alerta_*) pra não quebrar consumidores
--
-- DROP CASCADE seguro: zero dependentes (sem views/funções derivadas).
-- =============================================================================

DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14 CASCADE;

CREATE VIEW public.v_oc21_aguardando_oc14 AS
WITH historico_eventos AS (
  SELECT
    c.id AS card_id,
    ((h.elem ->> 'codigo')::integer) AS codigo,
    (h.elem ->> 'filial') AS filial,
    (h.elem ->> 'usuario') AS usuario,
    ((
      '20' || split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem ->> 'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem ->> 'data', ' ', 2) || ':00-03'
    ))::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND ((h.elem ->> 'codigo')::integer) = ANY (ARRAY[1, 14, 21, 30, 32])
    AND (h.elem ->> 'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
oc21_via_cockpit AS (
  SELECT ce.card_id, MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND (ce.payload ->> 'codigo_ssw') = '21'
    AND (ce.payload ->> 'sucesso') = 'true'
    AND ce.created_at > now() - interval '60 days'
  GROUP BY ce.card_id
),
oc21_via_historico AS (
  SELECT card_id,
         MAX(data_evento) AS data_oc21,
         -- Pega filial/usuario do evento mais recente
         (array_agg(filial ORDER BY data_evento DESC))[1] AS filial_oc21,
         (array_agg(usuario ORDER BY data_evento DESC))[1] AS usuario_oc21
  FROM historico_eventos
  WHERE codigo = 21 AND data_evento > now() - interval '60 days'
  GROUP BY card_id
),
oc21_aprovacoes AS (
  -- UNION das 2 fontes. Pra cada card, pega o MAIS RECENTE (max).
  SELECT
    card_id,
    MAX(data_oc21) AS data_oc21,
    -- filial/usuario só vem do histórico SSW (Cockpit não preserva)
    MAX(filial_oc21) AS filial_oc21,
    MAX(usuario_oc21) AS usuario_oc21
  FROM (
    SELECT card_id, data_oc21, NULL::text AS filial_oc21, NULL::text AS usuario_oc21
      FROM oc21_via_cockpit
    UNION ALL
    SELECT card_id, data_oc21, filial_oc21, usuario_oc21
      FROM oc21_via_historico
  ) u
  GROUP BY card_id
),
pendentes AS (
  SELECT
    o21.card_id, c.nf, c.ctrc,
    c.responsavel_relacionamento, c.base_destino,
    c.pagador AS pagador_nome,
    c.agent_state ->> 'cnpj_pagador' AS cnpj_pagador,
    c.empresa_cliente, c.nome_cliente,
    o21.data_oc21,
    o21.filial_oc21, o21.usuario_oc21,
    round(EXTRACT(epoch FROM now() - o21.data_oc21) / 60::numeric)::integer AS minutos_paradas,
    round(EXTRACT(epoch FROM now() - o21.data_oc21) / 3600::numeric, 1) AS horas_paradas,
    round(public.dias_uteis_entre(o21.data_oc21, now()), 2) AS dias_uteis_parados,
    public.dias_uteis_entre(o21.data_oc21, now()) <= 1::numeric AS dentro_sla
  FROM oc21_aprovacoes o21
  JOIN public.cards c ON c.id = o21.card_id
  WHERE c.responsavel_relacionamento IS NOT NULL
    AND c.ctrc IS NOT NULL
    AND c.state NOT IN ('RESOLVIDO', 'CANCELADO')
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo = 14
        AND h.data_evento > o21.data_oc21
    )
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo = ANY (ARRAY[1, 30, 32])
        AND h.data_evento > o21.data_oc21
    )
)
SELECT
  p.card_id, p.nf, p.ctrc,
  p.responsavel_relacionamento, p.base_destino,
  p.pagador_nome, p.cnpj_pagador,
  p.empresa_cliente, p.nome_cliente,
  p.data_oc21, p.minutos_paradas, p.horas_paradas,
  p.dias_uteis_parados, p.dentro_sla,
  p.filial_oc21, p.usuario_oc21,
  a.id AS alerta_id,
  a.status AS alerta_status,
  a.base_oc14_esperada AS alerta_base_destino,
  a.destinatario_email AS alerta_destinatario,
  a.enviado_em AS alerta_enviado_em,
  a.mensagem_assunto AS alerta_assunto,
  a.motivo_falha AS alerta_motivo_falha,
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

COMMENT ON VIEW public.v_oc21_aguardando_oc14 IS
  'Cards parados em oc=21 aguardando oc=14. Caio 2026-05-22 (mig 150): inclui '
  'TRANSFERIDO e oc=21 via histórico SSW (não só Cockpit). Consistente com '
  'PRIORIDADES AI (v_oc21_paradas_prioridades).';
