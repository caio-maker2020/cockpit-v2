-- ============================================================================
-- Cockpit v2 — tokens_evidencia.cod_ocorrencia
-- Data: 2026-05-06
--
-- Bug NF 350898 (2026-05-06): card oc=35 sem foto anexada → email mostrou foto
-- de oc=12 anterior, porque scraper de vercel-r-evidencia/api/r.ts pegava o
-- ÚLTIMO btn_foto do HTML SSW (sem filtro por oc específica). tokens_evidencia
-- só guardava nf+cnpj, não sabia qual oc deveria.
--
-- Fix: armazenar cod_ocorrencia no token. Scraper passa a filtrar btn_foto
-- pela oc específica. Se não acha → /r mostra "indisponível" (não pega outra oc).
-- ============================================================================

ALTER TABLE public.tokens_evidencia
  ADD COLUMN IF NOT EXISTS cod_ocorrencia int;

-- Backfill best-effort: tokens existentes assumem cod_ultima_ocorrencia do card
-- no momento atual. Não é 100% preciso (pode ter mudado), mas é o melhor que dá
-- sem reconstruir histórico. Tokens novos sempre virão com cod_ocorrencia setado.
UPDATE public.tokens_evidencia te
SET cod_ocorrencia = c.cod_ultima_ocorrencia
FROM public.cards c
WHERE te.card_id = c.id AND te.cod_ocorrencia IS NULL;

CREATE INDEX IF NOT EXISTS idx_tokens_evidencia_card_oc
  ON public.tokens_evidencia(card_id, cod_ocorrencia);
