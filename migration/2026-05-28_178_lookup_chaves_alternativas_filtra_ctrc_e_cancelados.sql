-- ============================================================================
-- Cockpit v2 — lookup_chaves_cte_alternativas v2: filtra por p_ctrc + ignora
-- linhas tipo_documento CANCELADO/SUBSTITUTO_CANCELADO.
-- Data: 2026-05-28
-- skill: supabase-postgres-best-practices
--
-- BUG RAIZ NF 142371 (Caio 2026-05-28):
--   Mesma NF tinha 2 CTRCs em nf_chave_cte: OVD396328-4 (ATIVO, correto, no card)
--   e OVD399372-8 (CANCELADO no SSW). Executor caiu no fallback DOCUMENTO
--   CANCELADO e essa RPC devolveu OVD399372-8 como alternativa. Executor
--   reusou e sobrescreveu agent_state.chave_cte pro cancelado → tentativa
--   seguinte de lançamento (oc=54) retornou "DOCUMENTO BAIXADO OU ENTREGUE".
--
-- REGRA CRÍTICA (CLAUDE.md): "O CTRC correto é SEMPRE o que está registrado
-- no card da tratativa. Qualquer outro CTRC encontrado via busca por NF deve
-- ser ignorado."
--
-- Mudanças v2:
--   1. Aceita p_ctrc opcional. Se passado, filtra `ctrc = p_ctrc` exato (ou
--      normaliza upper/trim). Sem fallback pra outros CTRCs.
--   2. Ignora linhas com `tipo_documento` ∈ ('CANCELADO','SUBSTITUTO_CANCELADO').
--   3. Backward compat: p_ctrc NULL mantém comportamento antigo (limit 10
--      por imported_at DESC) — mas filtra cancelados.
--
-- A defesa principal é o guard TS `validarChaveCteCorrespondeCtrcDoCard` em
-- _shared/validar-chave-cte-card.ts. Esta migration é defense-in-depth: se
-- alguém esquecer o guard num caller futuro, a RPC já não devolve lixo.
--
-- skill checklist:
--   - SECURITY DEFINER + SET search_path = public ✓
--   - GRANT EXECUTE explícito ✓
--   - índice existente idx_nf_chave_cte_ativo (mig 113) já cobre filtro
--     parcial pelo tipo_documento ✓
-- ============================================================================

-- Dropa a v1 (3 args) pra evitar sobrecarga acidental — caller poderia
-- chamar a antiga sem p_ctrc e voltar a devolver CTRC errado.
DROP FUNCTION IF EXISTS public.lookup_chaves_cte_alternativas(text, text, text);

CREATE OR REPLACE FUNCTION public.lookup_chaves_cte_alternativas(
  p_nf text,
  p_cnpj_pagador text DEFAULT NULL,
  p_chave_excluir text DEFAULT NULL,
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
  FROM public.nf_chave_cte
  WHERE nf = p_nf
    AND (
      p_cnpj_pagador IS NULL
      OR ltrim(regexp_replace(cnpj_pagador,   '\D', '', 'g'), '0')
       = ltrim(regexp_replace(p_cnpj_pagador, '\D', '', 'g'), '0')
    )
    AND (p_chave_excluir IS NULL OR chave_cte <> p_chave_excluir)
    -- Caio 2026-05-28 (NF 142371): match exato em CTRC quando passado.
    AND (
      p_ctrc IS NULL
      OR upper(btrim(ctrc)) = upper(btrim(p_ctrc))
    )
    -- Caio 2026-05-28: nunca devolver linhas canceladas.
    AND (tipo_documento IS NULL
         OR upper(tipo_documento) NOT IN ('CANCELADO', 'SUBSTITUTO_CANCELADO'))
  ORDER BY imported_at DESC
  LIMIT 10;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chaves_cte_alternativas(text, text, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chaves_cte_alternativas(text, text, text, text) IS
  'Caio 2026-05-28 v2: retorna chaves CT-E alternativas filtrando por p_ctrc '
  '(match exato quando passado) e ignorando tipo_documento '
  'CANCELADO/SUBSTITUTO_CANCELADO. Bug raiz NF 142371: v1 devolvia CTRC '
  'cancelado como alternativa e executor reusava. Defense in depth — guard TS '
  'em _shared/validar-chave-cte-card.ts é a barreira principal.';
