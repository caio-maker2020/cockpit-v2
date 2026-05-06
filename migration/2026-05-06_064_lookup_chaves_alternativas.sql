-- ============================================================================
-- Cockpit v2 — lookup_chaves_cte_alternativas pra fallback de DOCUMENTO CANCELADO
-- Data: 2026-05-06
--
-- Bug NF 63416 (Caio 2026-05-06): mesma NF tem 2 CT-Es emitidos pro mesmo
-- cnpj_pagador. Sistema escolheu a chave mais recente (lookup_chave_cte
-- ordena por imported_at DESC LIMIT 1), mas essa foi CANCELADA pelo emissor
-- no SSW. Toda tentativa de lançar oc retornava HTTP 400 "DOCUMENTO CANCELADO".
-- A outra chave (mais antiga, mesmo CT-E re-emitido) está ATIVA.
--
-- Fix: nova RPC retorna múltiplas chaves alternativas pra a NF, excluindo
-- uma dada. Executor consulta isso quando SSW retorna "DOCUMENTO CANCELADO"
-- e retenta com a próxima chave.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lookup_chaves_cte_alternativas(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_chave_excluir text DEFAULT NULL
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
    AND (
      p_cnpj_pagador IS NULL
      OR ltrim(regexp_replace(cnpj_pagador,   '\D', '', 'g'), '0')
       = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
    )
    AND (p_chave_excluir IS NULL OR chave_cte <> p_chave_excluir)
  ORDER BY imported_at DESC
  LIMIT 10;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chaves_cte_alternativas(text, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chaves_cte_alternativas IS
  'Caio 2026-05-06: retorna chaves CT-E alternativas pra mesma NF + cnpj '
  'excluindo uma dada. Usado pelo executor quando SSW retorna "DOCUMENTO '
  'CANCELADO" — retenta com a próxima chave válida da fila.';
