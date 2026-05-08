-- ============================================================================
-- Cockpit v2 — evidencia_status + diagnostico + verificada_em em cards
-- Data: 2026-05-07
--
-- Caio 2026-05-07 (incidente das 6 NFs com oc=56 falsa):
-- SEM AÇÃO AUTÔNOMA. Helper `verificarEvidenciaESinalizar` grava o resultado
-- nessas colunas pro front renderizar banner amarelo "IA — VALIDAÇÃO DE
-- EVIDÊNCIA". Larissa lê o diagnóstico, decide manualmente entre as 4
-- propostas normais (21/54+email/44/56).
--
-- evidencia_status:
--   - 'ok_com_foto_correlacionada' → sem banner (silêncio); fluxo normal
--   - 'ok_sem_btn_foto'             → banner sugerindo oc=56 (Operação)
--   - 'ambiguo_foto_em_outra_oc'    → banner pedindo verificação manual
--   - 'scrape_indisponivel'         → banner pedindo Larissa olhar SSW
--
-- evidencia_verificada_em: timestamp de quando Larissa clicou
-- "Marcar como verificado e ocultar" no banner. Se NULL e status != ok,
-- banner fica visível.
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS evidencia_status text
    CHECK (evidencia_status IN (
      'ok_com_foto_correlacionada',
      'ok_sem_btn_foto',
      'ambiguo_foto_em_outra_oc',
      'scrape_indisponivel'
    )),
  ADD COLUMN IF NOT EXISTS evidencia_diagnostico text,
  ADD COLUMN IF NOT EXISTS evidencia_verificada_em timestamptz;

COMMENT ON COLUMN public.cards.evidencia_status IS
  'Caio 2026-05-07: resultado da verificação automática de evidência no SSW. '
  'Front renderiza banner amarelo se status != ok_com_foto_correlacionada AND '
  'evidencia_verificada_em IS NULL. NUNCA dispara ação autônoma — Larissa decide.';

COMMENT ON COLUMN public.cards.evidencia_diagnostico IS
  'Texto humano formatado pelo helper verificar-evidencia, mostrado direto no '
  'banner amarelo do front. Inclui nome da linha SSW onde foto foi achada '
  '(quando ambíguo) ou motivo do scrape ter falhado.';

COMMENT ON COLUMN public.cards.evidencia_verificada_em IS
  'Timestamp do clique em "Marcar como verificado" no banner. Quando NULL, '
  'banner amarelo fica visível.';

CREATE INDEX IF NOT EXISTS idx_cards_evidencia_pendente
  ON public.cards (evidencia_status)
  WHERE evidencia_status IS NOT NULL
    AND evidencia_status <> 'ok_com_foto_correlacionada'
    AND evidencia_verificada_em IS NULL;

COMMENT ON INDEX public.idx_cards_evidencia_pendente IS
  'Caio 2026-05-07: acelera query do front que filtra cards com banner '
  'amarelo de evidência pendente.';
