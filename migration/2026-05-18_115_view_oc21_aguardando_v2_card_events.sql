-- ============================================================================
-- Cockpit v2 — View v_oc21_aguardando_oc14 v2: fonte da oc=21 vira card_events
-- Data: 2026-05-18
--
-- Caio: "o input da 21 pode ser considerado o próprio lançamento da ocorrência
-- pelo cockpit... o cron pode ser apenas pra verificar a 14"
--
-- Mudança arquitetural: a v1 dependia do historico_ssw ter capturado a oc=21
-- (ou seja, dependia de refresh do SSW). Bug observado: NF 1490882/Duilio teve
-- oc=21 aprovada às 11:38, mas historico_ssw foi puxado às 11:36 → 2 min antes.
-- Card ficava invisível na view até próximo refresh do histórico.
--
-- v2: oc=21 vem direto de card_events (timestamp = momento exato da aprovação
-- via Cockpit, fonte interna garantida). oc=14 continua vindo de historico_ssw.
-- Card pendente aparece IMEDIATAMENTE após aprovação, sem esperar refresh.
--
-- Lógica:
--   data_oc21 = MAX(card_events.created_at) WHERE event_type='AcaoExecutada'
--               AND payload.codigo_ssw='21' AND payload.sucesso='true'
--   tem_oc14_depois = EXISTS oc=14 no historico_ssw com data > data_oc21
-- ============================================================================

DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14 CASCADE;

CREATE VIEW public.v_oc21_aguardando_oc14
WITH (security_invoker = on) AS
WITH oc21_aprovacoes AS (
  -- Última aprovação bem-sucedida de oc=21 por card via Cockpit
  SELECT
    ce.card_id,
    MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND ce.payload->>'codigo_ssw' = '21'
    AND ce.payload->>'sucesso' = 'true'
    AND ce.created_at > now() - interval '60 days'  -- janela razoável (SLA é 24h)
  GROUP BY ce.card_id
),
oc14_no_historico AS (
  -- Datas de oc=14 extraídas do historico_ssw de cada card
  SELECT
    c.id AS card_id,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_oc14,
    h.elem->>'filial' AS filial_oc14
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int = 14
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
pendentes AS (
  SELECT
    o21.card_id,
    c.nf,
    c.ctrc,
    c.responsavel_relacionamento,
    c.base_destino,
    o21.data_oc21,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 60)::int AS minutos_paradas,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 3600, 1) AS horas_paradas,
    (EXTRACT(EPOCH FROM (now() - o21.data_oc21)) <= 24*60*60) AS dentro_sla
  FROM oc21_aprovacoes o21
  JOIN public.cards c ON c.id = o21.card_id
  WHERE c.responsavel_relacionamento IS NOT NULL  -- exclui cards de teste/lixo
    AND c.ctrc IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM oc14_no_historico o14
      WHERE o14.card_id = o21.card_id
        AND o14.data_oc14 > o21.data_oc21
    )
)
SELECT
  p.*,
  -- Filial onde oc=21 foi lançada: vem do próprio Cockpit/operador
  -- (não tem do card_event diretamente; placeholder NULL pra compatibilidade
  -- com prompt Lovable — front usa base_destino se disponível)
  NULL::text AS filial_oc21,
  NULL::text AS usuario_oc21,
  -- Enriquece com info do alerta enviado (se houver)
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

GRANT SELECT ON public.v_oc21_aguardando_oc14 TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_aguardando_oc14 IS
  'Caio 2026-05-18 v2: oc=21 vem de card_events (fonte interna), oc=14 vem '
  'do historico_ssw. Card aparece como pendente IMEDIATAMENTE após aprovação '
  'da oc=21 via Cockpit, sem esperar refresh do SSW. Refresh só é necessário '
  'pra detectar a oc=14 quando chegar.';
