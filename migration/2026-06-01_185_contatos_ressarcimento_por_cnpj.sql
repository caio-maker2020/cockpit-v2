-- ============================================================================
-- Cockpit v2 — contatos_escalonamento: roteamento por CNPJ pagador
-- Caio 2026-06-01
--
-- CONTEXTO: cargo='time_ressarcimento' precisa rotear pra analista específica
-- (Thiago/Mariana/Luciana) conforme cnpj_pagador do card — padrão idêntico
-- ao operadores.carteira (array de CNPJs). Sem isso, edge cobrar-ressarcimento-wpp
-- mandava pra TODOS contatos com cargo='time_ressarcimento', em vez do analista
-- responsável pelo cliente.
--
-- skill: supabase-postgres-best-practices
--   * cnpjs_pagador text[] — NULL = global (fallback genérico)
--   * GIN index parcial — só pros contatos ativos do cargo time_ressarcimento
--     (lookup do agente oc=49 Caso 1c)
--   * GIN suporta `cnpjs_pagador && ARRAY[$1]` (intersection) em O(log n)
--
-- Lookup esperado na edge:
--   SELECT * FROM contatos_escalonamento
--   WHERE cargo='time_ressarcimento' AND ativo
--     AND (cnpjs_pagador IS NULL OR cnpjs_pagador && ARRAY[$1]::text[])
--   ORDER BY cnpjs_pagador NULLS LAST  -- específico ganha de global
--   LIMIT 1
-- ============================================================================

ALTER TABLE public.contatos_escalonamento
  ADD COLUMN IF NOT EXISTS cnpjs_pagador text[] DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_contatos_escal_ressarcimento_cnpjs
  ON public.contatos_escalonamento USING gin (cnpjs_pagador)
  WHERE ativo AND cargo = 'time_ressarcimento';

COMMENT ON COLUMN public.contatos_escalonamento.cnpjs_pagador IS
  'Caio 2026-06-01: lista de CNPJs cuja cobrança de ressarcimento vai pra '
  'esse contato. NULL = global (fallback). Padrão semelhante a operadores.carteira. '
  'Usado pelo agente oc=49 Caso 1c (extravio sem qtd) via edge cobrar-ressarcimento-wpp.';
