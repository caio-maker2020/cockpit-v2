-- ============================================================================
-- Cockpit v2 — Indicador oc=21→oc=14: dias úteis + pendentes vs finalizadas
-- Data: 2026-05-18
--
-- Caio: "o tempo deve ser computado em dias uteis e nao em horas... se teve
-- a 14 fecha o ciclo da nf e aparece os dias q demorou pra ter a 14...
-- separe nfs PENDENTES e FINALIZADAS (ocorrencias finalizadoras = 01/30/32).
-- cobrar agora só faz sentido para nfs ainda nao tiveram ocorrencia
-- finalizadora e/ou não teve 14."
--
-- Mudanças:
--   1. Função dias_uteis_entre(timestamptz, timestamptz) — exclui sáb/dom
--   2. tempo_oc21_para_oc14 ganha coluna dias_uteis (numeric)
--   3. v_indicador_tempo_oc21_oc14_base agrega por dias úteis
--   4. v_oc21_aguardando_oc14: pendentes (sem 14, sem finalizadora)
--   5. v_oc21_finalizadas: ciclos fechados (com 14 OU com finalizadora 01/30/32)
--
-- Ocorrências finalizadoras (memory project_ocorrencias_finalizadoras):
--   01 = ENTREGA REALIZADA
--   30 = DEVOLUÇÃO COMPROVADA
--   32 = ENTREGA NÃO REALIZADA (definitiva)
-- ============================================================================

-- ----- 1. Função dias_uteis_entre -----------------------------------------
-- Conta dias úteis (seg-sex) entre dois timestamps, fração inclusa.
-- MVP: ignora feriados nacionais (Brasil). Caio pode adicionar depois.
-- IMMUTABLE: mesmo input → mesmo output, sem efeito colateral.

DROP FUNCTION IF EXISTS public.dias_uteis_entre(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.dias_uteis_entre(
  inicio timestamptz,
  fim timestamptz
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      LEAST(inicio, fim) AS dt_ini,
      GREATEST(inicio, fim) AS dt_fim
  ),
  dias_corridos AS (
    SELECT
      d::date AS dia,
      EXTRACT(ISODOW FROM d) AS dow,
      CASE
        WHEN d::date = (SELECT dt_ini FROM bounds)::date
          THEN (SELECT dt_ini FROM bounds)
        ELSE d
      END AS dia_ini,
      CASE
        WHEN d::date = (SELECT dt_fim FROM bounds)::date
          THEN (SELECT dt_fim FROM bounds)
        ELSE d + interval '1 day'
      END AS dia_fim
    FROM bounds,
         generate_series(
           date_trunc('day', dt_ini),
           date_trunc('day', dt_fim),
           interval '1 day'
         ) d
  )
  SELECT COALESCE(
    ROUND(
      SUM(
        CASE
          WHEN dow IN (6,7) THEN 0  -- sábado/domingo
          ELSE EXTRACT(EPOCH FROM (dia_fim - dia_ini)) / 86400.0
        END
      )::numeric, 2
    ),
    0
  )
  FROM dias_corridos;
$$;

COMMENT ON FUNCTION public.dias_uteis_entre(timestamptz, timestamptz) IS
  'Caio 2026-05-18: conta dias úteis (seg-sex) fracionários entre dois '
  'timestamps. Ignora feriados — MVP. Usado no indicador oc=21→oc=14.';

GRANT EXECUTE ON FUNCTION public.dias_uteis_entre(timestamptz, timestamptz)
  TO authenticated, service_role;

-- ----- 2. Coluna dias_uteis em tempo_oc21_para_oc14 -----------------------

ALTER TABLE public.tempo_oc21_para_oc14
  ADD COLUMN IF NOT EXISTS dias_uteis numeric;

-- Backfill com a função recém-criada
UPDATE public.tempo_oc21_para_oc14
SET dias_uteis = public.dias_uteis_entre(data_oc21, data_oc14)
WHERE dias_uteis IS NULL;

-- SLA agora em dias úteis: 1 dia útil = dentro do SLA
-- delta_minutos antigo permanece pra compatibilidade
ALTER TABLE public.tempo_oc21_para_oc14
  ADD COLUMN IF NOT EXISTS dentro_sla_dias_uteis boolean
  GENERATED ALWAYS AS (dias_uteis <= 1) STORED;

CREATE INDEX IF NOT EXISTS idx_tempo_oc21_14_dias_uteis
  ON public.tempo_oc21_para_oc14(dentro_sla_dias_uteis, data_oc14 DESC);

-- ----- 3. View agregada por base (dias úteis) -----------------------------

DROP VIEW IF EXISTS public.v_indicador_tempo_oc21_oc14_base CASCADE;

CREATE VIEW public.v_indicador_tempo_oc21_oc14_base
WITH (security_invoker = on) AS
SELECT
  base_oc14 AS base,
  COUNT(*) AS total_pares,
  ROUND(AVG(dias_uteis), 2) AS media_dias_uteis,
  PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY dias_uteis) AS p50_dias_uteis,
  PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY dias_uteis) AS p95_dias_uteis,
  MIN(dias_uteis) AS min_dias_uteis,
  MAX(dias_uteis) AS max_dias_uteis,
  ROUND(AVG(delta_minutos))::int AS media_minutos,
  COUNT(*) FILTER (WHERE dentro_sla_dias_uteis) AS dentro_sla,
  COUNT(*) FILTER (WHERE NOT dentro_sla_dias_uteis) AS fora_sla,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_sla_dias_uteis)
        / NULLIF(COUNT(*), 0), 1) AS pct_dentro_sla,
  MIN(data_oc14) AS primeira_medicao,
  MAX(data_oc14) AS ultima_medicao
FROM public.tempo_oc21_para_oc14
GROUP BY base_oc14
ORDER BY media_dias_uteis DESC NULLS LAST;

GRANT SELECT ON public.v_indicador_tempo_oc21_oc14_base
  TO authenticated, service_role;

COMMENT ON VIEW public.v_indicador_tempo_oc21_oc14_base IS
  'Caio 2026-05-18 v2: agregação por base em DIAS ÚTEIS. SLA = 1 dia útil. '
  'dentro_sla_dias_uteis = TRUE se par fechou em ≤1 dia útil.';

-- ----- 4. View detalhe (com dias úteis) -----------------------------------

DROP VIEW IF EXISTS public.v_tempo_oc21_oc14_detalhe CASCADE;

CREATE VIEW public.v_tempo_oc21_oc14_detalhe
WITH (security_invoker = on) AS
SELECT
  t.id,
  t.card_id,
  c.nf,
  c.ctrc,
  t.data_oc21,
  t.data_oc14,
  t.dias_uteis,
  t.dentro_sla_dias_uteis,
  t.delta_minutos,
  t.dentro_sla AS dentro_sla_24h,
  t.base_oc14,
  t.usuario_oc14,
  t.base_oc21,
  t.usuario_oc21,
  t.created_at
FROM public.tempo_oc21_para_oc14 t
JOIN public.cards c ON c.id = t.card_id
ORDER BY t.data_oc14 DESC;

GRANT SELECT ON public.v_tempo_oc21_oc14_detalhe
  TO authenticated, service_role;

-- ----- 5. View v_oc21_aguardando_oc14 v3: PENDENTES puros -----------------
-- Cards com oc=21 (via card_events) SEM oc=14 posterior E SEM finalizadora
-- (01/30/32) posterior. Essas são as NFs onde "Cobrar agora" faz sentido.

DROP VIEW IF EXISTS public.v_oc21_aguardando_oc14 CASCADE;

CREATE VIEW public.v_oc21_aguardando_oc14
WITH (security_invoker = on) AS
WITH oc21_aprovacoes AS (
  SELECT
    ce.card_id,
    MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND ce.payload->>'codigo_ssw' = '21'
    AND ce.payload->>'sucesso' = 'true'
    AND ce.created_at > now() - interval '60 days'
  GROUP BY ce.card_id
),
historico_eventos AS (
  -- Eventos do historico_ssw parseados (oc=14 e finalizadoras 01/30/32)
  SELECT
    c.id AS card_id,
    (h.elem->>'codigo')::int AS codigo,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IN (1, 14, 30, 32)
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
pendentes AS (
  SELECT
    o21.card_id,
    c.nf,
    c.ctrc,
    c.responsavel_relacionamento,
    c.base_destino,
    c.pagador AS pagador_nome,
    c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
    c.empresa_cliente,
    c.nome_cliente,
    o21.data_oc21,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 60)::int AS minutos_paradas,
    ROUND(EXTRACT(EPOCH FROM (now() - o21.data_oc21)) / 3600, 1) AS horas_paradas,
    ROUND(public.dias_uteis_entre(o21.data_oc21, now()), 2) AS dias_uteis_parados,
    (public.dias_uteis_entre(o21.data_oc21, now()) <= 1) AS dentro_sla
  FROM oc21_aprovacoes o21
  JOIN public.cards c ON c.id = o21.card_id
  WHERE c.responsavel_relacionamento IS NOT NULL
    AND c.ctrc IS NOT NULL
    -- Sem oc=14 posterior (base ainda não saiu pra entrega)
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo = 14
        AND h.data_evento > o21.data_oc21
    )
    -- Sem finalizadora posterior (card não foi resolvido por outro caminho)
    AND NOT EXISTS (
      SELECT 1 FROM historico_eventos h
      WHERE h.card_id = o21.card_id
        AND h.codigo IN (1, 30, 32)
        AND h.data_evento > o21.data_oc21
    )
)
SELECT
  p.*,
  NULL::text AS filial_oc21,
  NULL::text AS usuario_oc21,
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
  'Caio 2026-05-18 v3: PENDENTES puros — oc=21 lançada via Cockpit, SEM oc=14 '
  'e SEM finalizadora (01/30/32) posterior. Tempo em dias úteis. "Cobrar '
  'agora" só faz sentido aqui.';

-- ----- 6. View v_oc21_finalizadas: ciclos fechados ------------------------
-- NFs onde a 21 foi lançada e DEPOIS veio oc=14 OU finalizadora (01/30/32).
-- Mostra quantos dias úteis demorou. Usado pra histórico de performance.

DROP VIEW IF EXISTS public.v_oc21_finalizadas CASCADE;

CREATE VIEW public.v_oc21_finalizadas
WITH (security_invoker = on) AS
WITH oc21_aprovacoes AS (
  SELECT
    ce.card_id,
    MAX(ce.created_at) AS data_oc21
  FROM public.card_events ce
  WHERE ce.event_type = 'AcaoExecutada'
    AND ce.payload->>'codigo_ssw' = '21'
    AND ce.payload->>'sucesso' = 'true'
    AND ce.created_at > now() - interval '90 days'
  GROUP BY ce.card_id
),
historico_eventos AS (
  SELECT
    c.id AS card_id,
    (h.elem->>'codigo')::int AS codigo,
    h.elem->>'filial' AS filial,
    h.elem->>'usuario' AS usuario,
    (
      '20' || split_part(split_part(h.elem->>'data', ' ', 1), '/', 3) || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 2), 2, '0') || '-' ||
      lpad(split_part(split_part(h.elem->>'data', ' ', 1), '/', 1), 2, '0') || ' ' ||
      split_part(h.elem->>'data', ' ', 2) || ':00-03'
    )::timestamptz AS data_evento
  FROM public.cards c
  CROSS JOIN LATERAL jsonb_array_elements(c.historico_ssw) AS h(elem)
  WHERE c.historico_ssw IS NOT NULL
    AND (h.elem->>'codigo')::int IN (1, 14, 30, 32)
    AND (h.elem->>'data') ~ '^\d{1,2}/\d{1,2}/\d{2} \d{1,2}:\d{2}$'
),
fechamentos AS (
  -- Primeiro evento (14 ou finalizadora) DEPOIS da oc=21
  SELECT DISTINCT ON (o21.card_id, o21.data_oc21)
    o21.card_id,
    o21.data_oc21,
    h.codigo AS codigo_fechamento,
    h.data_evento AS data_fechamento,
    h.filial AS base_fechamento,
    h.usuario AS usuario_fechamento
  FROM oc21_aprovacoes o21
  JOIN historico_eventos h
    ON h.card_id = o21.card_id
   AND h.data_evento > o21.data_oc21
  ORDER BY o21.card_id, o21.data_oc21, h.data_evento ASC
)
SELECT
  f.card_id,
  c.nf,
  c.ctrc,
  c.responsavel_relacionamento,
  c.base_destino,
  c.pagador AS pagador_nome,
  c.agent_state->>'cnpj_pagador' AS cnpj_pagador,
  c.empresa_cliente,
  c.nome_cliente,
  f.data_oc21,
  f.data_fechamento,
  f.codigo_fechamento,
  CASE f.codigo_fechamento
    WHEN 14 THEN 'oc14_saida'
    WHEN 1  THEN 'oc01_entrega_realizada'
    WHEN 30 THEN 'oc30_devolucao_comprovada'
    WHEN 32 THEN 'oc32_entrega_nao_realizada'
    ELSE 'outro'
  END AS tipo_fechamento,
  f.base_fechamento,
  f.usuario_fechamento,
  ROUND(public.dias_uteis_entre(f.data_oc21, f.data_fechamento), 2) AS dias_uteis_para_fechar,
  ROUND(EXTRACT(EPOCH FROM (f.data_fechamento - f.data_oc21)) / 3600, 1) AS horas_para_fechar,
  (public.dias_uteis_entre(f.data_oc21, f.data_fechamento) <= 1) AS dentro_sla_dias_uteis
FROM fechamentos f
JOIN public.cards c ON c.id = f.card_id
WHERE c.responsavel_relacionamento IS NOT NULL
  AND c.ctrc IS NOT NULL
ORDER BY f.data_fechamento DESC;

GRANT SELECT ON public.v_oc21_finalizadas TO authenticated, service_role;

COMMENT ON VIEW public.v_oc21_finalizadas IS
  'Caio 2026-05-18: ciclos oc=21 → fechamento (14, 01, 30 ou 32). Mostra '
  'dias úteis até fechar. tipo_fechamento explica o caminho. SLA = 1 dia útil.';
