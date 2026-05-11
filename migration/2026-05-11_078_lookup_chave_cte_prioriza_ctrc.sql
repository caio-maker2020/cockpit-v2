-- ============================================================================
-- Cockpit v2 — lookup_chave_cte v3: prioriza CTRC do card + fallback mais antigo
-- Data: 2026-05-11
--
-- Bug raiz NF 351960 (Caio 2026-05-11):
-- NF com múltiplos CT-es emitidos (ex: CT-e NORMAL + CT-e de REENTREGA +
-- CT-e COMPLEMENTAR). lookup_chave_cte v2 ordenava por imported_at DESC LIMIT 1
-- → pegava o último importado, sem se importar com o CTRC do card. Quando RPA
-- OPC 455 importava o CT-e de reentrega depois, o resolver sobrescrevia a chave
-- do card pra apontar pro CT-e de reentrega — que SEMPRE finaliza com oc=34
-- ("baixa/entregue"). SSW respondia "DOCUMENTO BAIXADO OU ENTREGUE" no próximo
-- lançamento de ocorrência. NF 351960 ficou travada por 4 dias com email
-- enviado ao cliente + oc=54 falhando.
--
-- Regra raiz Caio 2026-05-11:
-- > CT-e de REENTREGA e CT-e COMPLEMENTAR devem ser DESCONSIDERADOS na
-- > seleção da chave. A tratativa segue SEMPRE no CT-e NORMAL.
--
-- Como identificar o CT-e normal:
--   1. Card tem `ctrc` populado (CTRC original quando o card foi criado).
--      Match exato: nf_chave_cte.ctrc = card.ctrc → chave do CT-e normal.
--   2. Fallback (card sem ctrc OU sem match): ordena por data_emissao ASC.
--      CT-e normal é sempre o PRIMEIRO emitido — reentrega/complementar vêm
--      depois (após a tentativa falhada na entrega original).
--
-- Caso CTRC devolução é OUTRO fenômeno (NFs 20575/194864 — milestone à parte).
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
  ORDER BY
    -- 1ª: match exato pelo CTRC do card (chave do CT-e normal)
    prioridade ASC,
    -- 2ª (fallback sem CTRC): mais antigo é o CT-e normal; reentrega/complementar vêm depois
    data_emissao ASC NULLS LAST,
    imported_at ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;

-- Mantém assinatura antiga (text, text) como wrapper pra não quebrar callers
-- não atualizados. Wrapper chama a nova com p_ctrc=NULL → cai no fallback (mais antigo).
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text);
CREATE OR REPLACE FUNCTION public.lookup_chave_cte(
  p_nf text,
  p_cnpj_pagador text
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
  SELECT * FROM public.lookup_chave_cte(p_nf, p_cnpj_pagador, NULL);
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'Caio 2026-05-11 v3: resolve chave_cte priorizando o CTRC do card '
  '(p_ctrc) — bate o CT-e normal. Fallback (sem p_ctrc OU sem match): '
  'mais antigo por data_emissao (CT-e normal é o primeiro; reentrega e '
  'complementar vêm depois). Bug raiz NF 351960: usar chave de CT-e '
  'reentrega faz SSW retornar "DOCUMENTO BAIXADO OU ENTREGUE" porque '
  'reentrega sempre finaliza com oc=34. Tratativa segue no CT-e normal.';
