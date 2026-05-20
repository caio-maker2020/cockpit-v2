-- =============================================================================
-- cnpjs_excluidos_cockpit: blacklist de pagadores que NÃO devem virar card
--
-- Caio 2026-05-20: caso AMPLA SLI TRANS C. (cnpj 21280493000130). Não é
-- cliente da Sal Express — é transportadora. Vinha caindo pra LARISSA via
-- cascata fallback (sem carteira específica). Mecanismo permanente pra excluir.
--
-- Uso:
--   1. INSERT do CNPJ a excluir nesta tabela
--   2. Soft-cancela cards existentes desse CNPJ (state=CANCELADO + cancel todos)
--   3. Pass A do sync-bastao SKIPA criação/atualização de cards desse CNPJ
--      (edit separada em sync-bastao/index.ts)
--
-- RLS service-only (sem UI por enquanto — Caio gerencia direto). Idempotente.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cnpjs_excluidos_cockpit (
  cnpj_pagador text PRIMARY KEY,
  nome_cliente text,
  motivo text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cnpjs_excluidos_digits CHECK (cnpj_pagador ~ '^\d{14}$')
);

CREATE INDEX IF NOT EXISTS idx_cnpjs_excluidos_ativo
  ON public.cnpjs_excluidos_cockpit(ativo) WHERE ativo;

ALTER TABLE public.cnpjs_excluidos_cockpit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cnpjs_excluidos_service_only ON public.cnpjs_excluidos_cockpit;
CREATE POLICY cnpjs_excluidos_service_only
  ON public.cnpjs_excluidos_cockpit
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.cnpjs_excluidos_cockpit IS
  'Blacklist de cnpj_pagador que NÃO devem virar card no Cockpit. '
  'Pass A do sync-bastao consulta antes de upsert. Caso âncora: AMPLA SLI '
  'TRANS C. (21280493000130) — transportadora, não cliente. Caio 2026-05-20.';

-- Insere o caso âncora
INSERT INTO public.cnpjs_excluidos_cockpit (cnpj_pagador, nome_cliente, motivo)
VALUES (
  '21280493000130',
  'AMPLA SLI TRANS C.',
  'Transportadora, não cliente. Caía pra LARISSA via fallback de cascata (sem carteira). Caio decidiu excluir definitivo 2026-05-20.'
)
ON CONFLICT (cnpj_pagador) DO UPDATE SET
  ativo = true,
  motivo = EXCLUDED.motivo,
  updated_at = now();
