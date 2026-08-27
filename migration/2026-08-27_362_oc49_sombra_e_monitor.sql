-- =============================================================================
-- 2026-08-27_362 — SOMBRA da oc 49 (Caio 27/08, caso NF 25021)
-- =============================================================================
-- Por 2 dias, toda decisão da oc 49 ganha uma leitura PARALELA do Sonnet
-- (prompts/agente-oc49-leitura-contextual.md). O par (código × IA) cai aqui e
-- é lido por uma página FORA do Cockpit (vercel-monitor-capacidade), onde o
-- Caio marca quem acertou em cada divergência — a resposta objetiva ao
-- "quanto seria melhor com Sonnet".
--
-- TIPO A da política (docs/POLITICA_MIGRATIONS.md): só cria estrutura nova +
-- seeds idempotentes nascendo DESLIGADOS. O token do monitor NÃO vive no repo
-- (repo público) — é inserido via psql na aplicação.
--
-- Segurança: tabela com RLS ligada e ZERO policies (só service_role/postgres
-- tocam por baixo); acesso do monitor exclusivamente via RPCs SECURITY DEFINER
-- token-gated (o front estático usa a anon key, que sem RPC não enxerga nada).
-- skill: supabase-postgres-best-practices. Idempotente. Sem BEGIN/COMMIT.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.oc49_sombra (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card_id          uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  nf               text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decisao_codigo   jsonb NOT NULL,
  decisao_ia       jsonb NOT NULL,
  diverge          boolean,           -- null = IA falhou nesta rodada
  custo_tokens_in  integer,
  custo_tokens_out integer,
  modelo           text,
  veredito         text CHECK (veredito IN ('ia','codigo','empate','ambos_errados')),
  veredito_em      timestamptz
);

ALTER TABLE public.oc49_sombra ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_oc49_sombra_created ON public.oc49_sombra (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oc49_sombra_diverge ON public.oc49_sombra (diverge) WHERE diverge = true;

-- Flags da fase (nascem OFF — ligar é ato separado com ordem do Caio)
INSERT INTO public.feature_flags (key, enabled, description)
VALUES
  ('oc49_ia_sombra_enabled',  false, 'SOMBRA oc49 (Caio 27/08): Sonnet roda em paralelo a toda decisão da 49 e grava em oc49_sombra. Não muda comportamento.'),
  ('oc49_ia_fallback_enabled', false, 'IA contextual decide a oc 49 quando nenhuma regra/caso dá match (fase pós-sombra, ordem nominal do Caio).')
ON CONFLICT (key) DO NOTHING;

-- Tokens do monitor (valor NUNCA no repo; insert manual via psql na aplicação)
CREATE TABLE IF NOT EXISTS public.monitor_tokens (
  token      text PRIMARY KEY,
  escopo     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.monitor_tokens ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- RPC de leitura do monitor (token-gated; página estática chama com anon key)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.monitor_sombra_oc49(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'oc49_sombra') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;

  SELECT jsonb_build_object(
    'placar', (SELECT jsonb_build_object(
        'total',            count(*),
        'divergem',         count(*) FILTER (WHERE diverge = true),
        'concordam',        count(*) FILTER (WHERE diverge = false),
        'ia_falhou',        count(*) FILTER (WHERE diverge IS NULL),
        'vereditos_ia',     count(*) FILTER (WHERE veredito = 'ia'),
        'vereditos_codigo', count(*) FILTER (WHERE veredito = 'codigo'),
        'vereditos_empate', count(*) FILTER (WHERE veredito = 'empate'),
        'vereditos_ambos_errados', count(*) FILTER (WHERE veredito = 'ambos_errados'),
        'tokens_in',        coalesce(sum(custo_tokens_in), 0),
        'tokens_out',       coalesce(sum(custo_tokens_out), 0)
      ) FROM public.oc49_sombra),
    'casos', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'nf', s.nf, 'card_id', s.card_id,
        'em', to_char(s.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'),
        'codigo', s.decisao_codigo, 'ia', s.decisao_ia,
        'diverge', s.diverge, 'veredito', s.veredito,
        'tokens_in', s.custo_tokens_in, 'tokens_out', s.custo_tokens_out
      ) ORDER BY s.created_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM public.oc49_sombra ORDER BY created_at DESC LIMIT 200) s)
  ) INTO v;
  RETURN v;
END $fn$;

-- ---------------------------------------------------------------------------
-- RPC do veredito ("quem acertou") — mesma cerca de token
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.monitor_sombra_veredito(
  p_token text, p_id bigint, p_veredito text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_tokens
                  WHERE token = p_token AND escopo = 'oc49_sombra') THEN
    RAISE EXCEPTION 'token invalido';
  END IF;
  IF p_veredito NOT IN ('ia','codigo','empate','ambos_errados') THEN
    RAISE EXCEPTION 'veredito invalido';
  END IF;
  UPDATE public.oc49_sombra
     SET veredito = p_veredito, veredito_em = now()
   WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'caso % nao encontrado', p_id; END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'veredito', p_veredito);
END $fn$;

REVOKE ALL ON FUNCTION public.monitor_sombra_oc49(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.monitor_sombra_veredito(text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.monitor_sombra_oc49(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.monitor_sombra_veredito(text, bigint, text) TO anon, authenticated, service_role;
