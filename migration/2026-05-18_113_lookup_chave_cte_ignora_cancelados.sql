-- ============================================================================
-- Cockpit v2 — lookup_chave_cte v5: ignora tipo_documento cancelado/substituto
-- Data: 2026-05-18
--
-- Bug raiz NF 750587 (camada complementar à v4):
-- RPA OPC 455 importou pra NF 750587 a entrada do CT-e SUBSTITUTO PDV393225-7
-- (depois cancelado no SSW com oc=32 OPERACAO CANCELADA). A entrada do CT-e
-- ATIVO PDV373487-1 (oc=54 AUTORIZADO) tinha sumido do nf_chave_cte. Callers
-- pegavam a chave do substituto cancelado → SSW devolvia "DOCUMENTO BAIXADO
-- OU ENTREGUE" (CT-e substituto estava finalizado por cancelamento).
--
-- Defesa v5: lookup IGNORA linhas com tipo_documento marcado como cancelado.
-- Valores esperados em nf_chave_cte.tipo_documento:
--   - 'NORMAL'                 → considerar
--   - NULL ou '' (vazio)       → considerar (RPA antigo não preenchia)
--   - 'SUBSTITUTO_CANCELADO'   → IGNORAR
--   - 'CANCELADO'              → IGNORAR
--
-- v4 (migration 110) já elimina fallback quando p_ctrc passado e não bate.
-- v5 adiciona "linhas marcadas como canceladas nunca são retornadas,
-- mesmo com match exato no CTRC".
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
        WHEN p_ctrc IS NOT NULL AND nfc.ctrc = p_ctrc THEN 0
        WHEN p_ctrc IS NOT NULL THEN 999
        ELSE 1
      END AS prioridade
    FROM public.nf_chave_cte nfc
    WHERE nfc.nf = p_nf
      AND (
        p_cnpj_pagador IS NULL
        OR ltrim(regexp_replace(nfc.cnpj_pagador, '\D', '', 'g'), '0')
         = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
      )
      AND (nfc.tipo_documento IS NULL
           OR upper(nfc.tipo_documento) NOT IN ('CANCELADO', 'SUBSTITUTO_CANCELADO'))
  ) ranked
  WHERE prioridade < 999
  ORDER BY
    prioridade ASC,
    data_emissao ASC NULLS LAST,
    imported_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_nf_chave_cte_ativo
  ON public.nf_chave_cte (nf, cnpj_pagador)
  WHERE tipo_documento IS NULL
     OR upper(tipo_documento) NOT IN ('CANCELADO', 'SUBSTITUTO_CANCELADO');

COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'Caio 2026-05-18 v5: 1 CTRC = 1 chave + ignora linhas tipo_documento '
  'CANCELADO/SUBSTITUTO_CANCELADO. Sem fallback quando p_ctrc passado e '
  'não bate exato (v4). Bug raiz NF 750587: RPA OPC 455 importou apenas '
  'o CT-e substituto que depois foi cancelado, lookup devolvia essa chave '
  'pro executor que falhava com "DOCUMENTO BAIXADO OU ENTREGUE".';
