-- ============================================================================
-- Cockpit v2 — nf_chave_cte.cnpj_emissor + lookup prioriza Sal Express
-- Caio 2026-05-24
--
-- BUG (NF 23516, 71285 e família):
--   Quando o RPA OPC 455 importa CT-es pra uma NF, ele traz TUDO que enxerga
--   no SSW — incluindo CT-es emitidos por TRANSPORTADORAS PARCEIRAS (CNPJ
--   86392529xxx) que aparecem na visão consolidada do SSW.
--
--   Ao tentar lança uma oc (54, 21, etc) via API SSW logado como Sal Express
--   (CNPJ 21280493xxx), o SSW recusa: "DOCUMENTO BAIXADO OU ENTREGUE" — não
--   porque o documento esteja baixado, mas porque **NÃO PODEMOS LANÇAR OC EM
--   CT-E QUE NÃO É NOSSO**. SSW retorna mensagem genérica enganosa.
--
--   Pior: executor envia email da oc=54 ANTES de tentar lança a oc no SSW.
--   Quando oc falha, email já foi pro cliente. Card fica em estado bizarro,
--   cliente vê email sem oc no portal. Acumulou.
--
-- Diagnóstico no banco (2026-05-24):
--   - 21280493xxx (Sal Express, várias filiais): 563.479 CT-es
--   - 86392529xxx (parceira/consórcio):          115.463 CT-es
--   NF 23516: CT-e mais recente é da parceira (POA398466-4, cnpj_emissor
--   86392529000113). NF 71285: CT-e é Sal Express (causa diferente,
--   investigada separadamente).
--
-- FIX:
--   1. nf_chave_cte ganha coluna gerada `cnpj_emissor` = posições 7-20 da
--      chave_cte (CNPJ do emissor — formato padrão CT-e SEFAZ 44 dígitos).
--   2. lookup_chave_cte preferencia CT-es de emissores Sal Express (CNPJ
--      começando com 21280493). Não exclui outros — eles ainda podem ser
--      retornados se forem a única opção — mas vai pro final do ranking.
--   3. Backfill já roda automático via GENERATED ALWAYS.
--
-- Pre-check no executor (separado, vai em deploy de edge function junto):
--   - Antes de mandar email + lança oc, valida `chave_cte.cnpj_emissor`
--     contra whitelist Sal Express. Se mismatch, falha com erro claro pra
--     Larissa: "carga emitida por transportadora parceira (CNPJ X), não dá
--     pra lança oc via Sal Express. Trate manualmente ou repasse."
--     Email NÃO é enviado.
--
-- skill: supabase-postgres-best-practices
--   * GENERATED ALWAYS STORED (não recalcula em cada query)
--   * Index parcial pra Sal Express vs outros emitters (acelera lookup)
-- ============================================================================

-- 1. Coluna gerada cnpj_emissor (extrai do chave_cte)
ALTER TABLE public.nf_chave_cte
  ADD COLUMN IF NOT EXISTS cnpj_emissor text GENERATED ALWAYS AS (
    CASE
      WHEN chave_cte IS NOT NULL AND length(chave_cte) = 44
        THEN substring(chave_cte FROM 7 FOR 14)
      ELSE NULL
    END
  ) STORED;

-- 2. Index parcial pra acelerar lookups por (nf, cnpj_pagador) + ordenação por emissor
CREATE INDEX IF NOT EXISTS idx_nf_chave_cte_emissor_sal
  ON public.nf_chave_cte (nf, cnpj_pagador)
  WHERE cnpj_emissor LIKE '21280493%';

CREATE INDEX IF NOT EXISTS idx_nf_chave_cte_emissor
  ON public.nf_chave_cte (cnpj_emissor)
  WHERE cnpj_emissor IS NOT NULL;

COMMENT ON COLUMN public.nf_chave_cte.cnpj_emissor IS
  'Caio 2026-05-24: CNPJ emissor extraído da chave SEFAZ (posições 7-20). '
  'Usado pra distinguir CT-es Sal Express (21280493xxx) de parceiras '
  '(86392529xxx) — SSW só aceita lança oc em CT-e que pertence ao login.';


-- 3. lookup_chave_cte: prefere emissor Sal Express. Mantém retrocompat
--    (mesmo signature). Quando há CT-e Sal Express E parceira pra mesma
--    (nf, pagador), Sal Express ganha. Quando só tem parceira, retorna ela
--    mas o caller deve validar `cnpj_emissor` antes de tentar lança oc.
--
-- DROP necessário porque o return type mudou (adicionei cnpj_emissor).
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text, text);
DROP FUNCTION IF EXISTS public.lookup_chave_cte(text, text);

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
  cnpj_emissor text   -- ← NOVO: expõe pro caller validar
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
      END AS prioridade_ctrc,
      -- NOVO: Sal Express tem prioridade. Parceira vai pro fundo.
      CASE
        WHEN nfc.cnpj_emissor LIKE '21280493%' THEN 0
        ELSE 1
      END AS prioridade_emissor
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
  WHERE prioridade_ctrc < 999
  ORDER BY
    prioridade_ctrc ASC,         -- p_ctrc match wins
    prioridade_emissor ASC,      -- Sal Express > parceira
    data_emissao DESC NULLS LAST, -- mais recente vence (mudança! antes era ASC)
    imported_at DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.lookup_chave_cte(text, text, text) IS
  'v6 Caio 2026-05-24: expõe cnpj_emissor + prioriza Sal Express (21280493xxx) '
  'sobre parceira (86392529xxx) no ranking. p_ctrc match continua dominante. '
  'data_emissao ordenação agora DESC (mais recente vence empate) — antes era '
  'ASC que favorecia CT-es antigos quando p_ctrc não era passado.';

-- Wrapper retrocompat sem p_ctrc (mantém)
CREATE OR REPLACE FUNCTION public.lookup_chave_cte(p_nf text, p_cnpj_pagador text)
RETURNS TABLE(
  chave_cte text, cnpj_remetente text, cnpj_destinatario text,
  ctrc text, data_emissao date, cnpj_emissor text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.lookup_chave_cte(p_nf, p_cnpj_pagador, NULL);
$$;
GRANT EXECUTE ON FUNCTION public.lookup_chave_cte(text, text) TO authenticated, service_role;
