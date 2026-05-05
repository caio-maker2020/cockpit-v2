-- ============================================================================
-- Cockpit v2 — Aceitar RPS (50 dígitos) em nf_chave_cte + flag visual
-- Data: 2026-05-04
--
-- Caso real (NF 59938 INOVAMED): origem e destino na mesma cidade (Pouso
-- Alegre → Pouso Alegre). SSW emite RPS (Recibo Provisório de Serviço)
-- em vez de CT-e tradicional. Chave RPS tem 50 dígitos (não 44).
--
-- Mudanças:
--   1. nf_chave_cte aceita chave de 44 (CT-e) OU 50 (RPS)
--   2. Coluna tipo_documento (auxiliar, populada pelo length)
--   3. cards.sem_chave_cte (flag visual): card fica em PARA FAZER sem
--      propostas porque não acha chave. Frontend mostra badge "⚠️ sem chave"
-- ============================================================================

-- 1. Relaxa constraint de chave_cte
ALTER TABLE public.nf_chave_cte
  DROP CONSTRAINT IF EXISTS nf_chave_cte_chave_cte_check;

ALTER TABLE public.nf_chave_cte
  ADD CONSTRAINT nf_chave_cte_chave_cte_check
  CHECK (length(chave_cte) IN (44, 50) AND chave_cte ~ '^\d+$');

-- 2. Coluna auxiliar: tipo_documento ('cte' pra 44, 'rps' pra 50)
ALTER TABLE public.nf_chave_cte
  ADD COLUMN IF NOT EXISTS tipo_documento text;

-- Backfill: tudo existente é cte (44 dígitos)
UPDATE public.nf_chave_cte
SET tipo_documento = CASE
  WHEN length(chave_cte) = 44 THEN 'cte'
  WHEN length(chave_cte) = 50 THEN 'rps'
  ELSE 'desconhecido'
END
WHERE tipo_documento IS NULL;

COMMENT ON COLUMN public.nf_chave_cte.tipo_documento IS
  'cte (44 dígitos, transporte interestadual/intermunicipal) ou rps (50, intra-cidade). Inferido pelo length.';

-- 3. Flag em cards: sem_chave_cte
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS sem_chave_cte boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_cards_sem_chave_cte
  ON public.cards(sem_chave_cte)
  WHERE sem_chave_cte = true;

COMMENT ON COLUMN public.cards.sem_chave_cte IS
  'true quando proporAutoAcaoSeAplicavel não conseguiu achar chave fiscal pra essa NF (RPA OPC 455 não importou OU NF é RPS sem chave em nf_chave_cte). Frontend mostra badge ⚠️ pra Larissa investigar caso a caso. Limpado quando chave aparece.';
