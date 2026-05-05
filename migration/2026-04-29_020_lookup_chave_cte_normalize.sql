-- ============================================================================
-- Cockpit v2 — lookup_chave_cte tolerante a formatação de CNPJ/CPF
-- Data: 2026-04-29
--
-- Bug observado: SSW exporta CPF como 14 dígitos zero-padded ("00013648530607")
-- na tabela nf_chave_cte (vem do RPA OPC 455), mas o SSW tracking API devolve
-- o mesmo CPF como 11 dígitos crus ("13648530607"). Compare exato dos dois
-- não bate → lookup_chave_cte retorna empty → vinculador grava chave_cte=null
-- → executor não consegue lançar ocorrência sem chave fiscal.
--
-- Fix: normalizar ambos os lados — só dígitos e sem zeros à esquerda.
-- Cobre os 4 casos:
--   banco "00013648530607" vs param "13648530607"  ✓
--   banco "13648530607"    vs param "00013648530607" ✓
--   banco "21280493000130" vs param "21280493000130" ✓ (CNPJ normal)
--   banco com máscara "21.280.493/0001-30" vs param sem ✓
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
    AND (
      p_cnpj_pagador IS NULL
      OR ltrim(regexp_replace(cnpj_pagador,   '\D', '', 'g'), '0')
       = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
    )
  ORDER BY imported_at DESC
  LIMIT 1;
$$;

-- Re-grant porque CREATE OR REPLACE preserva permissões, mas se mudou a
-- assinatura (não é o caso aqui) o GRANT cai. Defensivo.
GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chave_cte(text, text) IS
  'Busca chave CT-e por NF + cnpj_pagador. Comparação tolerante a formatação: '
  'remove pontuação e zeros à esquerda dos 2 lados. Necessário porque SSW exporta '
  'CPFs zero-padded a 14 dígitos no OPC 455 mas devolve crus na tracking API.';
