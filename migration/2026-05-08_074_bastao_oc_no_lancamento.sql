-- ============================================================================
-- Cockpit v2 — Snapshot da oc do Bastão no momento do lançamento Cockpit
-- Data: 2026-05-08
--
-- Bug raiz Caio 2026-05-08:
-- Pass G v1 usava `Bastão.updated_at >= acao_executada_em` pra detectar
-- "Bastão avançou pra outra oc". Falso positivo: RPA Bastão refaz a row
-- (delete+insert) a cada ciclo — updated_at fica trivialmente recente mesmo
-- com oc velha. Casos: NF 23319 (oc=23 desde 2026-05-06), NF 23315, 11236,
-- 196594, 1076453 — todos liberados errado.
--
-- Pass G v2 trocou pra `data_ultima_ocorrencia >= DATE(acao_executada_em)`.
-- Falso positivo aí também: NF 1078124 lançou oc=55 hoje, Bastão tinha oc=20
-- com data hoje (mas de antes do lançamento) — ainda assim libera.
--
-- Solução definitiva (v3): snapshot da oc do Bastão NO MOMENTO do lançamento.
-- Pass G compara: se Bastão.oc != snapshot → mudou de verdade desde o
-- lançamento; libera. Senão é mesma oc velha re-tocada pelo RPA.
--
-- Coluna armazena qual oc o Bastão tinha quando Cockpit lançou. Backfill
-- pra cards já presos: snapshot = current Bastão.oc (são presos justamente
-- porque Bastão NÃO avançou; current = launch-time state).
-- ============================================================================

ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS bastao_oc_no_lancamento int;

COMMENT ON COLUMN public.cards.bastao_oc_no_lancamento IS
  'Caio 2026-05-08: oc que o Bastão tinha quando Cockpit lançou ação. '
  'Pass G usa pra distinguir "Bastão avançou de verdade" (oc atual != snapshot) '
  'de "RPA só refrescou a row" (oc atual == snapshot). Setado pelo executor '
  'no instante do StateTransicaoPosSucesso. Limpo (NULL) ao sair de ACAO_EXECUTADA.';
