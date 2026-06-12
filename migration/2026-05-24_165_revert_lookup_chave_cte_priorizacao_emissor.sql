-- ============================================================================
-- Cockpit v2 — REVERT mig 164: lookup_chave_cte volta sem priorização Sal Express
-- Caio 2026-05-24
--
-- MOTIVO DO REVERT: a premissa da mig 164 estava errada.
-- CNPJ 86392529xxx é AMPLA, EMPRESA DO MESMO GRUPO Sal Express. Login SSW
-- compartilhado aceita lançamento de oc em CT-es de ambas (Sal Express e
-- AMPLA). A mig 164 estava bloqueando ações VÁLIDAS — quebrou NF 612253
-- (cliente OVD) e potencialmente 115k cards.
--
-- Restaura `lookup_chave_cte` ao comportamento da mig 113 + mig 112
-- (filtro de CANCELADO/SUBSTITUTO_CANCELADO mantido). Sem priorização
-- por emissor. Ordem original: prioridade_ctrc → data_emissao ASC → imported_at ASC.
--
-- A coluna `cnpj_emissor` em nf_chave_cte (adicionada na mig 164) FICA —
-- é meramente informacional/derivada, não atrapalha. Pode ser útil pra
-- relatórios futuros.
--
-- Os índices parciais (idx_nf_chave_cte_emissor_sal, idx_nf_chave_cte_emissor)
-- também ficam — não atrapalham, e o `_emissor_sal` pode acelerar lookups
-- futuros se algum caso de uso surgir.
--
-- O pré-check no executor (linhas 357-376) já foi removido em deploy anterior.
--
-- skill: supabase-postgres-best-practices
--   * DROP + CREATE pra restaurar signature antiga (sem cnpj_emissor no return)
--     evitaria mudar callers, mas mantemos cnpj_emissor no return pra não
--     forçar re-deploy de callers que já vieram em produção via mig 164.
-- ============================================================================

DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text, text);
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text);

-- Restaura lógica da mig 113 (sem priorização emissor, data_emissao ASC).
-- Mantém cnpj_emissor no return pra não quebrar callers — eles ignoram a coluna.
CREATE OR REPLACE FUNCTION public.lookup_chave_cte(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_ctrc text DEFAULT NULL
) RETURNS TABLE(
  chave_cte text,
  cnpj_remetente text,
  cnpj_destinatario text,
  ctrc text,
  data_emissao date,
  cnpj_emissor text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT chave_cte, cnpj_remetente, cnpj_destinatario, ctrc, data_emissao, cnpj_emissor
  FROM (
    SELECT
      nfc.chave_cte,
      nfc.cnpj_remetente,
      nfc.cnpj_destinatario,
      nfc.ctrc,
      nfc.data_emissao,
      nfc.imported_at,
      nfc.cnpj_emissor,
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

COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'v7 Caio 2026-05-24: REVERT mig 164. Volta lógica mig 113 (sem priorização '
  'emissor — Sal Express e AMPLA são mesmo grupo, ambos aceitos). Mantém '
  'cnpj_emissor no return como info derivada. Filtro CANCELADO/SUBSTITUTO_CANCELADO '
  'preservado.';
