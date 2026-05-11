-- ============================================================================
-- Cockpit v2 — Remove wrapper 2-arg de lookup_chave_cte
-- Data: 2026-05-11
--
-- A migration 078 criou um wrapper 2-arg que coexiste com a função 3-arg
-- (p_ctrc default NULL). PostgREST não consegue escolher entre as 2 quando
-- callers chamam com apenas (p_nf, p_cnpj_pagador) — erro 42725 "function is
-- not unique". Solução: dropar o wrapper. A função 3-arg com DEFAULT NULL
-- aceita 2 ou 3 args nomeados — basta callers nomearem (que já fazem).
-- ============================================================================

DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text);

-- Garante que só existe uma signature (3-arg com default no último).
-- Re-deploy idempotente da função correta.
CREATE OR REPLACE FUNCTION public.lookup_chave_cte(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_ctrc text DEFAULT NULL
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
  FROM (
    SELECT
      nfc.chave_cte,
      nfc.cnpj_remetente,
      nfc.cnpj_destinatario,
      nfc.ctrc,
      nfc.data_emissao,
      nfc.imported_at,
      CASE
        WHEN p_ctrc IS NOT NULL AND nfc.ctrc = p_ctrc THEN 0
        ELSE 1
      END AS prioridade
    FROM public.nf_chave_cte nfc
    WHERE nfc.nf = p_nf
      AND (
        p_cnpj_pagador IS NULL
        OR ltrim(regexp_replace(nfc.cnpj_pagador, '\D', '', 'g'), '0')
         = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
      )
  ) ranked
  ORDER BY prioridade ASC, data_emissao ASC NULLS LAST, imported_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;
