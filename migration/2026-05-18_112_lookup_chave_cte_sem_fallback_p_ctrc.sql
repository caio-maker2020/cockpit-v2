-- ============================================================================
-- Cockpit v2 — lookup_chave_cte v4: sem fallback quando p_ctrc é passado
-- Data: 2026-05-18
--
-- Regra Caio 2026-05-18 (NF 750587):
-- > A chave CT-e deve ser acionada exatamente pelo número do CTRC no card.
-- > 1 CTRC = 1 chave. Se altera o CTRC, altera a chave.
--
-- Bug raiz NF 750587: lookup_chave_cte v3 fazia FALLBACK por data_emissao ASC
-- quando p_ctrc não batia. Isso devolvia a chave de OUTRO CTRC, fazendo o
-- executor lançar oc no SSW com chave errada → erro "DOCUMENTO BAIXADO OU
-- ENTREGUE".
--
-- Comportamento v4:
--   * Quando p_ctrc IS NOT NULL → retorna SOMENTE match exato. Sem fallback.
--     Caller decide o que fazer (ex: aguardar RPA OPC 455 reimportar).
--   * Quando p_ctrc IS NULL (wrapper 2-arg) → mantém fallback antigo
--     (data_emissao ASC = CT-e normal). Esse caminho é usado APENAS quando
--     o card ainda não tem ctrc resolvido.
-- ============================================================================

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
        WHEN p_ctrc IS NOT NULL AND nfc.ctrc = p_ctrc THEN 0  -- match exato
        WHEN p_ctrc IS NOT NULL THEN 999                      -- com p_ctrc mas não bate → descartar
        ELSE 1                                                -- p_ctrc nulo → tudo elegível
      END AS prioridade
    FROM public.nf_chave_cte nfc
    WHERE nfc.nf = p_nf
      AND (
        p_cnpj_pagador IS NULL
        OR ltrim(regexp_replace(nfc.cnpj_pagador, '\D', '', 'g'), '0')
         = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
      )
  ) ranked
  -- Caio 2026-05-18: quando p_ctrc passado, FILTRA matches sem prioridade=0.
  -- Isso garante "1 CTRC = 1 chave" — sem fallback pra outro CTRC.
  WHERE prioridade < 999
  ORDER BY
    prioridade ASC,
    data_emissao ASC NULLS LAST,
    imported_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'Caio 2026-05-18 v4: 1 CTRC = 1 chave. Se p_ctrc passado e não bate exato '
  'em nf_chave_cte, retorna empty rowset (sem fallback pra outro CTRC). '
  'Wrapper 2-arg (sem p_ctrc) mantém comportamento antigo de fallback por '
  'data_emissao ASC. Substitui v3 (2026-05-11) cujo fallback causou bug NF '
  '750587: chave de PDV393225-7 foi usada num lançamento de PDV373487-1, '
  'SSW devolveu "DOCUMENTO BAIXADO OU ENTREGUE".';
