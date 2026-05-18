-- ============================================================================
-- Cockpit v2 — 2º Indicador: Tempo médio oc=21 → oc=14 por base + Alertas SLA
-- Data: 2026-05-18
--
-- Caio: medir quanto tempo cada base SSW leva pra lançar oc=14 (saída pra
-- entrega) após o operador lançar oc=21 (reentrega solicitada). SLA = 24h.
--
-- 2 camadas:
--   Camada 1 — Indicador retrospectivo: agrega pares (21→14) por base
--   Camada 2 — Alerta proativo: cron horário avisa gerente da base se
--              passou 24h sem oc=14
--
-- 4 tabelas + 2 views + 2 cron schedules.
-- ============================================================================

-- ----- 1. Tabela tempo_oc21_para_oc14 (pares capturados) -------------------

CREATE TABLE IF NOT EXISTS public.tempo_oc21_para_oc14 (
  id bigserial PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  data_oc21 timestamptz NOT NULL,
  data_oc14 timestamptz NOT NULL,
  delta_minutos int NOT NULL CHECK (delta_minutos >= 0),
  dentro_sla boolean NOT NULL,
  base_oc14 text NOT NULL,
  usuario_oc14 text NOT NULL,
  base_oc21 text,
  usuario_oc21 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, data_oc21, data_oc14)
);

CREATE INDEX IF NOT EXISTS idx_tempo_oc21_14_base
  ON public.tempo_oc21_para_oc14(base_oc14, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tempo_oc21_14_dentro_sla
  ON public.tempo_oc21_para_oc14(dentro_sla, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tempo_oc21_14_data14
  ON public.tempo_oc21_para_oc14(data_oc14 DESC);

ALTER TABLE public.tempo_oc21_para_oc14 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tempo_oc21_14_select ON public.tempo_oc21_para_oc14;
CREATE POLICY tempo_oc21_14_select ON public.tempo_oc21_para_oc14
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.tempo_oc21_para_oc14 IS
  'Caio 2026-05-18: pares (oc=21, próxima oc=14) capturados do historico_ssw '
  'dos cards. delta_minutos = tempo entre 21 e 14. dentro_sla = delta <= 1440min (24h). '
  'Populado pelo cron processar-tempos-oc21-oc14-daily. UNIQUE evita duplicação.';

-- ----- 2. View agregada por base -------------------------------------------

DROP VIEW IF EXISTS public.v_indicador_tempo_oc21_oc14_base CASCADE;

CREATE VIEW public.v_indicador_tempo_oc21_oc14_base
WITH (security_invoker = on) AS
SELECT
  base_oc14 AS base,
  COUNT(*) AS total_pares,
  ROUND(AVG(delta_minutos))::int AS media_minutos,
  PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY delta_minutos)::int AS p50_minutos,
  PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY delta_minutos)::int AS p95_minutos,
  MIN(delta_minutos) AS min_minutos,
  MAX(delta_minutos) AS max_minutos,
  COUNT(*) FILTER (WHERE dentro_sla) AS dentro_sla,
  COUNT(*) FILTER (WHERE NOT dentro_sla) AS fora_sla,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_sla) / NULLIF(COUNT(*), 0), 1) AS pct_dentro_sla,
  MIN(data_oc14) AS primeira_medicao,
  MAX(data_oc14) AS ultima_medicao
FROM public.tempo_oc21_para_oc14
GROUP BY base_oc14
ORDER BY media_minutos DESC;

GRANT SELECT ON public.v_indicador_tempo_oc21_oc14_base TO authenticated, service_role;

COMMENT ON VIEW public.v_indicador_tempo_oc21_oc14_base IS
  'Agregação por base. media_minutos, p50, p95, % dentro SLA (24h). '
  'security_invoker=on garante RLS (aberta no MVP).';

-- ----- 3. View detalhe (drilldown) -----------------------------------------

DROP VIEW IF EXISTS public.v_tempo_oc21_oc14_detalhe CASCADE;

CREATE VIEW public.v_tempo_oc21_oc14_detalhe
WITH (security_invoker = on) AS
SELECT t.*, c.nf, c.ctrc
FROM public.tempo_oc21_para_oc14 t
JOIN public.cards c ON c.id = t.card_id
ORDER BY t.data_oc14 DESC;

GRANT SELECT ON public.v_tempo_oc21_oc14_detalhe TO authenticated, service_role;

-- ----- 4. Tabela contatos_bases_ssw ----------------------------------------

CREATE TABLE IF NOT EXISTS public.contatos_bases_ssw (
  id bigserial PRIMARY KEY,
  base text NOT NULL UNIQUE,
  nome_contato text NOT NULL,
  email text NOT NULL,
  whatsapp text,
  ativo boolean NOT NULL DEFAULT true,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contatos_bases_ativo
  ON public.contatos_bases_ssw(ativo) WHERE ativo;

ALTER TABLE public.contatos_bases_ssw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contatos_bases_select ON public.contatos_bases_ssw;
CREATE POLICY contatos_bases_select ON public.contatos_bases_ssw
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS contatos_bases_write_gestor ON public.contatos_bases_ssw;
CREATE POLICY contatos_bases_write_gestor ON public.contatos_bases_ssw
  FOR ALL TO authenticated
  USING (public.current_operador_papel() = 'gestor')
  WITH CHECK (public.current_operador_papel() = 'gestor');

COMMENT ON TABLE public.contatos_bases_ssw IS
  'Caio 2026-05-18: cadastro de gerente/responsável por base SSW. Usado pelo '
  'cron processar-alertas-sla-oc21-oc14-horario pra enviar alertas. '
  'CRUD via aba CADASTROS no Cockpit (escopo gestor) — MVP pode usar SQL direto.';

-- ----- 5. Tabela alertas_sla_oc21_oc14 -------------------------------------

CREATE TABLE IF NOT EXISTS public.alertas_sla_oc21_oc14 (
  id bigserial PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  data_oc21 timestamptz NOT NULL,
  base_oc14_esperada text NOT NULL,
  destinatario_email text NOT NULL,
  canal text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  mensagem_assunto text,
  mensagem_html text,
  sugerido_por_ia boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('enviado', 'falhou', 'cancelado_oc14_chegou')),
  motivo_falha text,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, data_oc21)
);

CREATE INDEX IF NOT EXISTS idx_alertas_card
  ON public.alertas_sla_oc21_oc14(card_id, enviado_em DESC);
CREATE INDEX IF NOT EXISTS idx_alertas_base
  ON public.alertas_sla_oc21_oc14(base_oc14_esperada, enviado_em DESC);

ALTER TABLE public.alertas_sla_oc21_oc14 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alertas_select ON public.alertas_sla_oc21_oc14;
CREATE POLICY alertas_select ON public.alertas_sla_oc21_oc14
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.alertas_sla_oc21_oc14 IS
  'Caio 2026-05-18: alertas proativos disparados pra gerente da base quando '
  'card tem oc=21 há >24h sem oc=14. UNIQUE evita spam (1 alerta por par). '
  'Status muda pra cancelado_oc14_chegou se a 14 chegar depois — auditoria.';

-- ----- 6. Cron daily: processar-tempos-oc21-oc14 ---------------------------

SELECT cron.unschedule('processar-tempos-oc21-oc14-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-tempos-oc21-oc14-daily');

SELECT cron.schedule(
  'processar-tempos-oc21-oc14-daily',
  '0 13 * * *',  -- 13h UTC = 10h BRT (1h após processar-acoes-agendadas pra evitar pico)
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-tempos-oc21-oc14',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) AS request_id;
  $$
);

-- ----- 7. Cron horário: processar-alertas-sla-oc21-oc14 --------------------

SELECT cron.unschedule('processar-alertas-sla-oc21-oc14-horario')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'processar-alertas-sla-oc21-oc14-horario');

SELECT cron.schedule(
  'processar-alertas-sla-oc21-oc14-horario',
  '15 * * * *',  -- minuto 15 de toda hora (espaçado dos outros crons)
  $$
  SELECT net.http_post(
    url := 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/processar-alertas-sla-oc21-oc14',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'cron_sync_bastao_key'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 240000
  ) AS request_id;
  $$
);
