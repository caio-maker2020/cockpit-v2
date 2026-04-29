-- ============================================================================
-- Cockpit v2 — Tabela nf_chave_cte (mapping NF → chave fiscal CT-e 44 digitos)
-- Data: 2026-04-29
--
-- Premissa: chave CT-e é IMUTÁVEL — uma vez emitida, nunca muda. Logo:
--   - PRIMARY KEY na chave_cte (deduplica natural)
--   - INSERT ON CONFLICT (chave_cte) DO NOTHING — RPA manda full diario,
--     banco descarta o que já existe
--   - Sem precisar de UPDATE / sync de timestamps
--
-- Volume estimado: 10k linhas/dia. Indices abaixo cobrem os 2 lookups
-- principais do vinculador (por nf+pagador, e por ctrc).
-- ============================================================================

CREATE TABLE public.nf_chave_cte (
  chave_cte text PRIMARY KEY CHECK (length(chave_cte) = 44 AND chave_cte ~ '^\d+$'),
  nf text NOT NULL,
  cnpj_pagador text NOT NULL,
  cnpj_remetente text,
  cnpj_destinatario text,
  ctrc text,
  serie_nfe text,
  data_emissao date,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_via text NOT NULL DEFAULT 'rpa_opc455'
);

-- Lookup principal: vinculador busca por (nf, cnpj_pagador)
CREATE INDEX idx_nf_chave_cte_nf_pagador
  ON public.nf_chave_cte(nf, cnpj_pagador);

-- Lookup secundário: por CTRC (caso operador busque pelo número de conhecimento)
CREATE INDEX idx_nf_chave_cte_ctrc
  ON public.nf_chave_cte(ctrc)
  WHERE ctrc IS NOT NULL;

-- Sync incremental: detecta o que foi importado recentemente
CREATE INDEX idx_nf_chave_cte_imported_at
  ON public.nf_chave_cte(imported_at DESC);

-- ============================================================================
-- RLS — service_role escreve (RPA + Edge Functions); operador/gestor lê
-- ============================================================================
ALTER TABLE public.nf_chave_cte ENABLE ROW LEVEL SECURITY;

CREATE POLICY nf_chave_cte_select_authenticated ON public.nf_chave_cte
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- RPC pra lookup eficiente (vinculador chama)
-- Retorna chave_cte + dados auxiliares usados pra montar o todo de reentrega
-- ============================================================================
CREATE OR REPLACE FUNCTION public.lookup_chave_cte(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL
) RETURNS TABLE(
  chave_cte text,
  cnpj_remetente text,
  cnpj_destinatario text,
  ctrc text,
  data_emissao date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT chave_cte, cnpj_remetente, cnpj_destinatario, ctrc, data_emissao
  FROM public.nf_chave_cte
  WHERE nf = p_nf
    AND (p_cnpj_pagador IS NULL OR cnpj_pagador = p_cnpj_pagador)
  ORDER BY imported_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text) TO authenticated, service_role;

COMMENT ON TABLE public.nf_chave_cte IS
  'Espelho parcial do relatório OPC 455 do SSW. RPA carrega ~10k linhas/dia '
  'via INSERT ON CONFLICT (chave_cte) DO NOTHING. Vinculador busca '
  'lookup_chave_cte(nf, cnpj_pagador) ao criar card pra popular agent_state.chave_cte.';
